use crate::clef_head::{ClefDecision, ClefQuestion, ClefSchemaHead};
use crate::repe_sensor::{RepeProbeTelemetry, RepeSensor};
use anyhow::Result;
use mlx_rs::{Array, ops::*};

/// Trait representing a single Qwen Transformer Decoder Block in `mlx-rs`,
/// supporting an optional LoRA scale factor (`0.0` during normal agent generation,
/// `1.0` when running the fine-tuned Clef judge prefill).
pub trait QwenDecoderLayer {
    fn forward(&mut self, h: &Array, lora_scale: f32) -> Result<Array>;

    /// Ask the layer to keep its attention probabilities.
    ///
    /// The probabilities are needed for the provenance reading: how much of
    /// the tool call's attention landed on the UNTRUSTED part of the
    /// context. Keeping them costs one [B, H, S, S] copy per pass, so it is
    /// off by default and switched on only for the probe layer.
    fn set_attention_capture(&mut self, _on: bool) {}

    /// Take the attention probabilities kept by the last forward pass.
    fn take_attention_probs(&mut self) -> Option<Array> {
        None
    }

    /// Run the layer against a shared KV cache.
    ///
    /// The new tokens are appended to the layer's own cache and the attention
    /// runs over the full cached length; `position_offset` is the position
    /// of the first new token and must equal the current cache length.
    ///
    /// The default implementation keeps no cache and simply runs the layer,
    /// so an implementor that does not support caching still compiles and
    /// still behaves correctly — it just pays the full-attention cost.
    fn forward_cached(&mut self, h: &Array, _position_offset: usize) -> Result<Array> {
        self.forward(h, 0.0)
    }

    /// Drop every cache entry beyond `length`.
    ///
    /// The rollback primitive: the layers above the probe layer wrote their
    /// entries for an offending token from the unclamped residual, so they
    /// have to be dropped and recomputed from the clamped one.
    fn truncate_cache(&mut self, _length: usize) -> Result<()> {
        Ok(())
    }

    /// The number of positions the layer's shared KV cache holds.
    fn cache_len(&self) -> usize {
        0
    }
}

/// Output of a hooked forward pass through the Qwen + Clef backbone
pub struct HookedForwardOutput {
    pub h_final: Array,
    pub repe_telemetry: Option<RepeProbeTelemetry>,
    pub clef_decisions: Option<Vec<ClefDecision>>,
    /// The probe layer's attention probabilities [B, H, S, S], when the
    /// caller asked for them.
    ///
    /// They carry the provenance reading: how much of the tool call's
    /// attention landed on the untrusted part of the context.
    pub attention_probs: Option<Array>,
}

/// Wraps a local MLX Qwen model, the inline middle-layer `RepeSensor`, and the final-layer `ClefSchemaHead`.
pub struct HookedQwenClefEngine<L: QwenDecoderLayer> {
    pub embed_tokens: Array, // [vocab_size, d_model]
    pub layers: Vec<L>,
    pub final_norm_weight: Array,
    pub repe_sensor: RepeSensor,
    /// `None` when no trained joint head was supplied for this backbone. The
    /// head is never fabricated: an untrained head cannot judge anything, and
    /// publishing its output as a distribution would be fake telemetry.
    pub clef_head: Option<ClefSchemaHead>,
    /// Whether the probe layer keeps its attention probabilities.
    ///
    /// Off by default: they are [B, H, S, S]. The proxy switches them on for
    /// the intercepted call, where the provenance reading needs them.
    pub capture_attention: bool,
}

/// Object-safe view of the hooked engine, so the proxy can hold one engine
/// implementation without caring whether the backbone is real or synthetic.
pub trait GuardableEngine {
    fn run_hooked(
        &mut self,
        input_ids: &Array,
        enable_clef_lora: bool,
        lock_as_user_anchor: bool,
        clef_questions: Option<(&[ClefQuestion], &[Array])>,
        probe_span_start: Option<usize>,
    ) -> Result<HookedForwardOutput>;

    fn target_layer(&self) -> usize;

    /// The residual width the sensor was calibrated against.
    fn d_model(&self) -> i32;

    /// The embedding table's vocabulary — token ids are clamped to it.
    fn vocab_size(&self) -> i32;

    /// The harm-cosine threshold measured during calibration.
    fn calibrated_harm_threshold(&self) -> Option<f32>;

    /// The drift-cosine threshold measured during calibration.
    fn calibrated_drift_threshold(&self) -> Option<f32>;

    /// The harm threshold expressed as an excess over the per-session baseline.
    fn calibrated_harm_excess_threshold(&self) -> Option<f32>;

    /// The benign baseline measured at calibration time against the matched
    /// panel, when the artifact provides one.
    fn static_benign_baseline(&self) -> Option<f32>;

    /// The compliance-conditioned excess thresholds: (obeys, violates).
    fn compliance_excess_thresholds(&self) -> (Option<f32>, Option<f32>);

    /// Whether the Clef head carries trained weights.
    fn clef_head_calibrated(&self) -> bool;

    /// The harm cosine measured at each decoder layer during the last pass.
    fn layer_profile(&self) -> &[f32];

    /// The projection of the last inspected state onto the PCA basis.
    fn pca_coordinates(&self) -> Vec<f32>;

    /// The number of decoder layers in the backbone.
    fn num_layers(&self) -> usize;

    /// Ask the engine to keep the probe layer's attention probabilities.
    ///
    /// Off by default: they are [B, H, S, S], which is large. The proxy
    /// switches them on for the intercepted call, where the provenance
    /// reading is needed.
    fn set_capture_attention(&mut self, _on: bool) {}
}

impl<L: QwenDecoderLayer> GuardableEngine for HookedQwenClefEngine<L> {
    fn run_hooked(
        &mut self,
        input_ids: &Array,
        enable_clef_lora: bool,
        lock_as_user_anchor: bool,
        clef_questions: Option<(&[ClefQuestion], &[Array])>,
        probe_span_start: Option<usize>,
    ) -> Result<HookedForwardOutput> {
        self.forward_hooked(
            input_ids,
            enable_clef_lora,
            lock_as_user_anchor,
            clef_questions,
            probe_span_start,
        )
    }

    fn target_layer(&self) -> usize {
        self.repe_sensor.target_layer
    }

    fn d_model(&self) -> i32 {
        self.repe_sensor.v_harm.shape()[0]
    }

    fn vocab_size(&self) -> i32 {
        self.embed_tokens.shape()[0]
    }

    fn calibrated_harm_threshold(&self) -> Option<f32> {
        self.repe_sensor.calibrated_harm_threshold
    }

    fn calibrated_drift_threshold(&self) -> Option<f32> {
        self.repe_sensor.calibrated_drift_threshold
    }

    fn calibrated_harm_excess_threshold(&self) -> Option<f32> {
        self.repe_sensor.calibrated_harm_excess_threshold
    }

    fn static_benign_baseline(&self) -> Option<f32> {
        self.repe_sensor.static_benign_baseline
    }

    fn compliance_excess_thresholds(&self) -> (Option<f32>, Option<f32>) {
        (
            self.repe_sensor.harm_excess_threshold_obeys,
            self.repe_sensor.harm_excess_threshold_violates,
        )
    }

    fn clef_head_calibrated(&self) -> bool {
        self.clef_head.as_ref().map(|h| h.calibrated).unwrap_or(false)
    }

    fn layer_profile(&self) -> &[f32] {
        &self.repe_sensor.layer_profile
    }

    fn pca_coordinates(&self) -> Vec<f32> {
        self.repe_sensor.last_pca_coords.clone()
    }

    fn num_layers(&self) -> usize {
        self.layers.len()
    }

    fn set_capture_attention(&mut self, on: bool) {
        self.capture_attention = on;
    }
}

impl<L: QwenDecoderLayer> HookedQwenClefEngine<L> {
    /// Runs the Qwen decoder stack while intercepting `self.repe_sensor.target_layer`
    /// and optionally evaluating the non-autoregressive Clef head on `h_final`.
    pub fn forward_hooked(
        &mut self,
        input_ids: &Array, // [1, seq_len]
        enable_clef_lora: bool,
        lock_as_user_anchor: bool,
        clef_questions: Option<(&[ClefQuestion], &[Array])>,
        probe_span_start: Option<usize>,
    ) -> Result<HookedForwardOutput> {
        let lora_scale = if enable_clef_lora { 1.0 } else { 0.0 };

        // 1. Token embedding lookup: [1, seq_len, d_model]
        let mut h = self.embed_tokens.take_axis(input_ids, 0)?;
        let mut repe_telemetry = None;
        let mut attention_probs = None;

        // The per-layer profile belongs to this pass only.
        self.repe_sensor.layer_profile.clear();

        // 2. Iterate through Qwen decoder blocks and trigger the RepE hook at `target_layer`
        let hook_layer = self.repe_sensor.target_layer;
        for (layer_idx, layer) in self.layers.iter_mut().enumerate() {
            // The provenance reading needs the probe layer's attention
            // distribution, so it is captured on the way through.
            let capture_here = self.capture_attention && layer_idx == hook_layer;
            if capture_here {
                layer.set_attention_capture(true);
            }
            h = layer.forward(&h, lora_scale)?;
            if capture_here {
                attention_probs = layer.take_attention_probs();
            }

            // Record the harm cosine at every layer for the telemetry profile.
            if lock_as_user_anchor {
                let _ = self.repe_sensor.probe_cosine(&h, None)?;
            } else {
                let cosine = self.repe_sensor.probe_cosine(&h, probe_span_start)?;
                self.repe_sensor.layer_profile.push(cosine);
            }

            if layer_idx == hook_layer {
                if lock_as_user_anchor {
                    self.repe_sensor.record_user_anchor(&h)?;
                } else {
                    // <--- INLINE REPE INTERCEPTION HAPPENS RIGHT HERE --->
                    let telemetry = self
                        .repe_sensor
                        .inspect_and_maybe_clamp(&mut h, probe_span_start)?;
                    repe_telemetry = Some(telemetry);
                }
            }
        }

        // 3. Final RMSNorm over the backbone hidden state
        let h_final = Self::rms_norm(&h, &self.final_norm_weight, 1e-6)?;

        // 4. If evaluating a `<tool_call>`, run the fine-tuned Clef head on `h_final`.
        //    With no trained head loaded there is nothing to evaluate — the
        //    questions are reported as unavailable rather than answered.
        let clef_decisions = match (&self.clef_head, clef_questions) {
            (Some(head), Some((questions, opt_embs))) => {
                Some(head.evaluate(&h_final, questions, opt_embs)?)
            }
            _ => None,
        };

        Ok(HookedForwardOutput {
            h_final,
            repe_telemetry,
            clef_decisions,
            attention_probs,
        })
    }

    fn rms_norm(x: &Array, weight: &Array, eps: f32) -> Result<Array> {
        let xf = x.as_type::<f32>()?;
        let variance = mean_axes(&multiply(&xf, &xf)?, &[-1], true)?;
        let inv_rms = rsqrt(&add(&variance, &Array::from_f32(eps))?)?;
        let normed = multiply(&xf, &inv_rms)?;
        Ok(multiply(&normed, &weight.as_type::<f32>()?)?)
    }
}

/// An engine whose backbone runs in mlx_lm (`tools/backbone_server.py`).
///
/// The hand-written Rust decoder drifted from the reference (it dropped the
/// Qwen2 q/k/v biases), so the model's forward pass is delegated to the
/// library the calibration itself runs on. Only the residual states cross
/// the socket; every reading is still computed by the same `RepeSensor`.
///
/// The provenance reading needs attention probabilities, which mlx_lm's
/// fused attention does not expose, so `attention_probs` is always `None`
/// and the ratio is reported as unavailable rather than invented.
pub struct RemoteBackboneEngine {
    pub addr: String,
    pub repe_sensor: RepeSensor,
    pub num_layers: usize,
    pub vocab_size: i32,
}

impl RemoteBackboneEngine {
    fn fetch(&self, ids: &[u32]) -> Result<(Vec<Array>, Array)> {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(&self.addr)
            .map_err(|e| anyhow::anyhow!("backbone server {} unreachable: {e}", self.addr))?;
        let mut req = Vec::with_capacity(4 + 4 * ids.len());
        req.extend_from_slice(&(ids.len() as u32).to_le_bytes());
        for id in ids {
            req.extend_from_slice(&id.to_le_bytes());
        }
        s.write_all(&req)?;
        let mut hdr = [0u8; 12];
        s.read_exact(&mut hdr)?;
        let dim = |i: usize| u32::from_le_bytes(hdr[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
        let (l, seq, d) = (dim(0), dim(1), dim(2));
        let mut body = vec![0u8; (l + 1) * seq * d * 4];
        s.read_exact(&mut body)?;
        let floats: Vec<f32> = body
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
            .collect();
        let shape = [1, seq as i32, d as i32];
        let per = seq * d;
        let layers = (0..l)
            .map(|i| Array::from_slice(&floats[i * per..(i + 1) * per], &shape))
            .collect();
        let final_state = Array::from_slice(&floats[l * per..], &shape);
        Ok((layers, final_state))
    }
}

impl GuardableEngine for RemoteBackboneEngine {
    fn run_hooked(
        &mut self,
        input_ids: &Array,
        _enable_clef_lora: bool,
        lock_as_user_anchor: bool,
        _clef_questions: Option<(&[ClefQuestion], &[Array])>,
        probe_span_start: Option<usize>,
    ) -> Result<HookedForwardOutput> {
        let ids: Vec<u32> = input_ids
            .as_type::<i32>()?
            .as_slice::<i32>()
            .iter()
            .map(|&v| v as u32)
            .collect();
        let (layers, h_final) = self.fetch(&ids)?;
        self.repe_sensor.layer_profile.clear();
        let hook_layer = self.repe_sensor.target_layer;
        let mut repe_telemetry = None;
        for (idx, h) in layers.into_iter().enumerate() {
            let mut h = h;
            if lock_as_user_anchor {
                if idx == hook_layer {
                    self.repe_sensor.record_user_anchor(&h)?;
                }
                continue;
            }
            let cosine = self.repe_sensor.probe_cosine(&h, probe_span_start)?;
            self.repe_sensor.layer_profile.push(cosine);
            if idx == hook_layer {
                // Reading only: a clamp here would edit a copy nothing decodes from.
                repe_telemetry = Some(
                    self.repe_sensor
                        .inspect_and_maybe_clamp(&mut h, probe_span_start)?,
                );
            }
        }
        Ok(HookedForwardOutput {
            h_final,
            repe_telemetry,
            clef_decisions: None,
            attention_probs: None,
        })
    }
    fn target_layer(&self) -> usize { self.repe_sensor.target_layer }
    fn d_model(&self) -> i32 { self.repe_sensor.v_harm.shape()[0] }
    fn vocab_size(&self) -> i32 { self.vocab_size }
    fn calibrated_harm_threshold(&self) -> Option<f32> { self.repe_sensor.calibrated_harm_threshold }
    fn calibrated_drift_threshold(&self) -> Option<f32> { self.repe_sensor.calibrated_drift_threshold }
    fn calibrated_harm_excess_threshold(&self) -> Option<f32> { self.repe_sensor.calibrated_harm_excess_threshold }
    fn static_benign_baseline(&self) -> Option<f32> { self.repe_sensor.static_benign_baseline }
    fn compliance_excess_thresholds(&self) -> (Option<f32>, Option<f32>) {
        (self.repe_sensor.harm_excess_threshold_obeys, self.repe_sensor.harm_excess_threshold_violates)
    }
    fn clef_head_calibrated(&self) -> bool { false }
    fn layer_profile(&self) -> &[f32] { &self.repe_sensor.layer_profile }
    fn pca_coordinates(&self) -> Vec<f32> { self.repe_sensor.last_pca_coords.clone() }
    fn num_layers(&self) -> usize { self.num_layers }
    fn set_capture_attention(&mut self, _on: bool) {}
}
