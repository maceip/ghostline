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
