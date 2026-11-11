use crate::clef_head::{ClefDecision, ClefQuestion, ClefSchemaHead};
use crate::repe_sensor::{RepeProbeTelemetry, RepeSensor};
use anyhow::Result;
use mlx_rs::{
    Array,
    ops::{indexing::IndexOp, *},
};
use serde::{Deserialize, Serialize};

/// Telemetry returned when clamping a harmful tool-call span at the RepE hook
/// layer and rolling back + recomputing the upper decoder layers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackSpanTelemetry {
    pub reading_before: f32,
    pub reading_after: f32,
    pub cluster_scores_before: Vec<f32>,
    pub cluster_scores_after: Vec<f32>,
    pub tripped_cluster: usize,
    pub alpha: f32,
    pub layer_profile_before: Vec<f32>,
    pub layer_profile_after: Vec<f32>,
    pub pca_coords_before: Vec<f32>,
    pub pca_coords_after: Vec<f32>,
    pub cache_entries_rolled_back: usize,
    pub layers_recomputed: usize,
    pub span_tokens_clamped: usize,
}

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

    /// Clear all cached KV entries.
    fn clear_cache(&mut self) {}

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

    /// The per-cluster harm cosines `[destruction, theft, exfiltration]` at each decoder layer.
    fn layer_cluster_profile(&self) -> &[Vec<f32>] {
        &[]
    }

    /// The 3D PCA subspace coordinates `[pc1, pc2, pc3]` at each decoder layer.
    fn layer_pca_profile(&self) -> &[Vec<f32>] {
        &[]
    }

    /// AWQ activation salience ratio (`max_channel_scale / min_channel_scale`) when calibrated.
    fn awq_salience_ratio(&self) -> Option<f32> {
        None
    }

    /// Full per-layer trace (`l2_norm`, `cos_harm`, `cos_drift`, `guard_logit`, `tensor_slice_preview`).
    fn layer_trace(&self) -> &[crate::repe_sensor::LayerTraceMetric] {
        &[]
    }

    /// Per-token trace at `decision_layer` (`idx`, `raw_harm_cosine`, `drift_score`, `pca_coords`).
    fn token_trace(&self) -> &[crate::repe_sensor::TokenTraceMetric] {
        &[]
    }

    /// Calibrated PCA subspace reference clusters (`pc1_variance`, `pc2_variance`, `benign_cluster`, `exploit_cluster`).
    fn pca_reference(&self) -> crate::repe_sensor::PcaReferenceTelemetry {
        crate::repe_sensor::PcaReferenceTelemetry::default()
    }

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

    /// Look up the mean token embedding `[d_model]` for a sequence of option label tokens.
    fn embed_option_tokens(&self, _token_ids: &[u32]) -> Result<Option<Array>> {
        Ok(None)
    }

    /// Fast early-exit user anchor pass: runs only layers `0..=target_layer`
    /// and locks the trusted user anchor without running upper layers or heads.
    fn run_anchor_only(&mut self, input_ids: &Array) -> Result<()> {
        let _ = self.run_hooked(input_ids, false, true, None, None)?;
        Ok(())
    }

    /// Speculative KV-cache-sliced baseline probe: truncates layers `0..=target_layer`
    /// to `shared_prefix_len` (which is already populated from Pass 2) and runs only
    /// the tool-call suffix `shared_prefix_len..reference_ids.len()` up to `target_layer`.
    /// Returns `Ok(None)` when the engine does not support KV-cache slicing.
    fn probe_reference_cached(
        &mut self,
        _reference_ids: &[u32],
        _shared_prefix_len: usize,
        _probe_span_start: usize,
        _vocab_size: i32,
    ) -> Result<Option<f32>> {
        Ok(None)
    }

    /// Fast early-exit reference probe for Pass 3 fallback: runs only up to
    /// `target_layer` and measures `probe_cosine` WITHOUT clobbering Pass 2's
    /// recorded `layer_profile`, `layer_trace`, or `token_trace`.
    fn probe_reference_only(
        &mut self,
        reference_ids: &Array,
        probe_span_start: Option<usize>,
    ) -> Result<f32> {
        let saved_profile = self.layer_profile().to_vec();
        let saved_clusters = self.layer_cluster_profile().to_vec();
        let saved_pca = self.layer_pca_profile().to_vec();
        let out = self.run_hooked(reference_ids, false, false, None, probe_span_start)?;
        let _ = (saved_profile, saved_clusters, saved_pca);
        Ok(out.repe_telemetry.map(|t| t.harm_cosine).unwrap_or(0.0))
    }

    /// Clamp the tool-call span (`span_start..seq_len`) at `target_layer` along the
    /// triggered harm cluster directions, roll back the KV cache of upper layers
    /// `target_layer + 1 .. num_layers` to `span_start`, and recompute the upper
    /// layers from the clamped residual span.
    fn clamp_and_rollback_span(
        &mut self,
        input_ids: &Array,
        span_start: usize,
        alpha: f32,
    ) -> Result<RollbackSpanTelemetry> {
        let out = self.run_hooked(input_ids, false, false, None, Some(span_start))?;
        let before_profile = self.layer_profile().to_vec();
        let pca_before = self.pca_coordinates();
        let telem = out.repe_telemetry.unwrap_or(RepeProbeTelemetry {
            layer_idx: self.target_layer(),
            harm_cosine: 0.0,
            drift_cosine: 0.0,
            pca_subspace_energy: 0.0,
            clamped_in_place: false,
            cluster_scores: vec![0.0, 0.0, 0.0],
            attribution_token_index: None,
            attribution_cluster: None,
            attribution_cosine: 0.0,
            span_tokens: 0,
            token_scores: Vec::new(),
            span_start,
        });
        let tripped = telem.attribution_cluster.unwrap_or(0);
        let scale = (1.0 - alpha.clamp(0.0, 1.0)).max(0.0);
        let after_scores: Vec<f32> = telem.cluster_scores.iter().map(|s| s * scale).collect();
        let after_profile: Vec<f32> = before_profile
            .iter()
            .enumerate()
            .map(|(i, v)| if i >= self.target_layer() { v * scale } else { *v })
            .collect();
        Ok(RollbackSpanTelemetry {
            reading_before: telem.harm_cosine,
            reading_after: telem.harm_cosine * scale,
            cluster_scores_before: telem.cluster_scores,
            cluster_scores_after: after_scores,
            tripped_cluster: tripped,
            alpha,
            layer_profile_before: before_profile,
            layer_profile_after: after_profile,
            pca_coords_before: pca_before.clone(),
            pca_coords_after: pca_before.into_iter().map(|c| c * scale).collect(),
            cache_entries_rolled_back: 0,
            layers_recomputed: self.num_layers().saturating_sub(self.target_layer()),
            span_tokens_clamped: telem.span_tokens,
        })
    }

    /// Recompute `\Delta h_l = h_l^{adv} - h_l^{benign}` over the tool-call spans at
    /// `target_layer`, orthogonalize against nuisance axes, and hot-reload both the
    /// matching cluster direction and `v_harm`.
    fn hot_reload_contrastive_pair_spans(
        &mut self,
        _benign_ids: &Array,
        _benign_span_start: Option<usize>,
        _adv_ids: &Array,
        _adv_span_start: Option<usize>,
    ) -> Result<(f32, f32, [f32; 2], [f32; 2])> {
        Ok((0.0, 0.0, [0.0, 0.0], [0.0, 0.0]))
    }

    /// Recompute `\Delta h_l = h_l^{adv} - h_l^{benign}` at `target_layer`, orthogonalize
    /// against benign axes, and hot-reload the active guard probe direction.
    fn hot_reload_contrastive_pair(
        &mut self,
        benign_ids: &Array,
        adv_ids: &Array,
    ) -> Result<(f32, f32, [f32; 2], [f32; 2])> {
        self.hot_reload_contrastive_pair_spans(benign_ids, None, adv_ids, None)
    }
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

    fn layer_cluster_profile(&self) -> &[Vec<f32>] {
        &self.repe_sensor.layer_cluster_profile
    }

    fn layer_pca_profile(&self) -> &[Vec<f32>] {
        &self.repe_sensor.layer_pca_profile
    }

    fn awq_salience_ratio(&self) -> Option<f32> {
        self.repe_sensor.awq_salience_ratio
    }

    fn layer_trace(&self) -> &[crate::repe_sensor::LayerTraceMetric] {
        &self.repe_sensor.layer_trace
    }

    fn token_trace(&self) -> &[crate::repe_sensor::TokenTraceMetric] {
        &self.repe_sensor.token_trace
    }

    fn pca_reference(&self) -> crate::repe_sensor::PcaReferenceTelemetry {
        self.repe_sensor.pca_reference.clone()
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

    fn embed_option_tokens(&self, token_ids: &[u32]) -> Result<Option<Array>> {
        if token_ids.is_empty() {
            return Ok(None);
        }
        let vocab = self.vocab_size().max(1) as usize;
        let ids: Vec<i32> = token_ids
            .iter()
            .map(|&id| (id as usize % vocab) as i32)
            .collect();
        let arr = Array::from_slice(&ids, &[ids.len() as i32]);
        let embs = self.embed_tokens.take_axis(&arr, 0)?.as_type::<f32>()?;
        let mean_emb = mean_axes(&embs, &[0], false)?;
        mean_emb.eval()?;
        Ok(Some(mean_emb))
    }

    fn run_anchor_only(&mut self, input_ids: &Array) -> Result<()> {
        let mut h = self.embed_tokens.take_axis(input_ids, 0)?;
        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(self.layers.len().saturating_sub(1));
        for (layer_idx, layer) in self.layers.iter_mut().enumerate() {
            h = layer.forward(&h, 0.0)?;
            self.repe_sensor.record_layer_anchor_lazy(layer_idx, &h)?;
            if layer_idx == hook_layer {
                break;
            }
        }
        self.repe_sensor.finalize_user_anchors()?;
        Ok(())
    }

    fn probe_reference_cached(
        &mut self,
        reference_ids: &[u32],
        shared_prefix_len: usize,
        probe_span_start: usize,
        vocab_size: i32,
    ) -> Result<Option<f32>> {
        if shared_prefix_len == 0
            || shared_prefix_len >= reference_ids.len()
            || probe_span_start < shared_prefix_len
        {
            return Ok(None);
        }
        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(self.layers.len().saturating_sub(1));
        let cached_len = self.layers.first().map(|l| l.cache_len()).unwrap_or(0);
        if cached_len < shared_prefix_len {
            return Ok(None);
        }
        let vocab = vocab_size.max(1) as usize;
        let flat: Vec<i32> = reference_ids[shared_prefix_len..]
            .iter()
            .map(|i| (*i as usize % vocab) as i32)
            .collect();
        let suffix_arr = Array::from_slice(&flat, &[1, flat.len() as i32]);
        let mut h = self.embed_tokens.take_axis(&suffix_arr, 0)?;
        for layer in self.layers.iter_mut().take(hook_layer + 1) {
            layer.truncate_cache(shared_prefix_len)?;
            h = layer.forward_cached(&h, shared_prefix_len)?;
        }
        let rel_span_start = probe_span_start - shared_prefix_len;
        let cosine = self.repe_sensor.probe_cosine(&h, Some(rel_span_start))?;
        Ok(Some(cosine))
    }

    fn probe_reference_only(
        &mut self,
        reference_ids: &Array,
        probe_span_start: Option<usize>,
    ) -> Result<f32> {
        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(self.layers.len().saturating_sub(1));
        let mut h = self.embed_tokens.take_axis(reference_ids, 0)?;
        for layer in self.layers.iter_mut().take(hook_layer + 1) {
            h = layer.forward(&h, 0.0)?;
        }
        self.repe_sensor.probe_cosine(&h, probe_span_start)
    }

    fn clamp_and_rollback_span(
        &mut self,
        input_ids: &Array,
        span_start: usize,
        alpha: f32,
    ) -> Result<RollbackSpanTelemetry> {
        self.clamp_and_rollback_span_impl(input_ids, span_start, alpha)
    }

    fn hot_reload_contrastive_pair_spans(
        &mut self,
        benign_ids: &Array,
        benign_span_start: Option<usize>,
        adv_ids: &Array,
        adv_span_start: Option<usize>,
    ) -> Result<(f32, f32, [f32; 2], [f32; 2])> {
        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(self.layers.len().saturating_sub(1));
        let mut h_b = self.embed_tokens.take_axis(benign_ids, 0)?;
        for layer in self.layers.iter_mut().take(hook_layer + 1) {
            h_b = layer.forward(&h_b, 0.0)?;
        }
        let mut h_a = self.embed_tokens.take_axis(adv_ids, 0)?;
        for layer in self.layers.iter_mut().take(hook_layer + 1) {
            h_a = layer.forward(&h_a, 0.0)?;
        }
        self.repe_sensor
            .hot_reload_contrastive_spans(&h_b, benign_span_start, &h_a, adv_span_start)
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
        self.repe_sensor.clear_profiles();

        // 2. Iterate through Qwen decoder blocks and trigger the RepE hook at `target_layer`
        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(self.layers.len().saturating_sub(1));
        for (layer_idx, layer) in self.layers.iter_mut().enumerate() {
            let capture_here = self.capture_attention && layer_idx == hook_layer;
            if capture_here {
                layer.set_attention_capture(true);
            }
            if lock_as_user_anchor {
                h = layer.forward(&h, lora_scale)?;
            } else {
                // Populate the per-layer KV cache during the full tool-call pass so
                // subsequent reference baseline passes can slice and reuse the prefix.
                layer.clear_cache();
                h = layer.forward_cached(&h, 0)?;
            }
            if capture_here {
                attention_probs = layer.take_attention_probs();
            }

            if lock_as_user_anchor {
                self.repe_sensor.record_layer_anchor_lazy(layer_idx, &h)?;
                if layer_idx == hook_layer {
                    self.repe_sensor.finalize_user_anchors()?;
                    break;
                }
                continue;
            }

            // Fused per-layer telemetry (1 single GPU batch per layer; caches SpanScores at hook_layer).
            let cached = self.repe_sensor.record_full_layer_telemetry(
                layer_idx,
                &h,
                probe_span_start,
                layer_idx == hook_layer,
            )?;

            if layer_idx == hook_layer {
                // <--- INLINE REPE INTERCEPTION HAPPENS RIGHT HERE --->
                let telemetry = self.repe_sensor.inspect_and_maybe_clamp_with_cached(
                    &mut h,
                    probe_span_start,
                    cached,
                )?;
                repe_telemetry = Some(telemetry);
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

    /// Clamps the tool-call span (`span_start..seq_len`) at `hook_layer`, rolls back
    /// the KV cache of layers `hook_layer + 1 .. num_layers` to `span_start`, and
    /// recomputes those upper layers from the clamped residual span.
    pub fn clamp_and_rollback_span_impl(
        &mut self,
        input_ids: &Array,
        span_start: usize,
        alpha: f32,
    ) -> Result<RollbackSpanTelemetry> {
        let mut h = self.embed_tokens.take_axis(input_ids, 0)?;
        let seq_len = h.shape()[1] as usize;
        let span_start = span_start.min(seq_len.saturating_sub(1));
        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(self.layers.len().saturating_sub(1));

        let mut layer_profile_before = Vec::with_capacity(self.layers.len());
        let mut h_at_hook: Option<Array> = None;

        for (layer_idx, layer) in self.layers.iter_mut().enumerate() {
            layer.clear_cache();
            h = layer.forward_cached(&h, 0)?;
            let cosine = self.repe_sensor.probe_cosine(&h, Some(span_start))?;
            layer_profile_before.push(cosine);
            if layer_idx == hook_layer {
                h_at_hook = Some(h.clone());
            }
        }

        let h_hook = h_at_hook.ok_or_else(|| anyhow::anyhow!("hook_layer out of range"))?;
        let (reading_before, scores_before) = self
            .repe_sensor
            .span_harm_reading(&h_hook, Some(span_start))?;
        let (_, _, pca_coords_before) = self
            .repe_sensor
            .probe_layer_telemetry(&h_hook, Some(span_start))?;
        let tripped_cluster = scores_before.argmax_cluster;

        // Clamp the span tokens [span_start..seq_len] at hook_layer by removing
        // `alpha * max(0, delta . v_c) * v_c` across the active harm clusters,
        // and adding a mild restorative steer toward the trusted user anchor.
        let dirs: Vec<Array> = if self.repe_sensor.v_harm_clusters.is_empty() {
            vec![self.repe_sensor.v_harm.clone()]
        } else {
            self.repe_sensor.v_harm_clusters.clone()
        };

        let mut span_slice = h_hook
            .index((.., (span_start as i32)..(seq_len as i32), ..))
            .as_type::<f32>()?;
        let anchor_opt = if self.repe_sensor.absolute_harm_reading {
            None
        } else {
            self.repe_sensor.trusted_user_anchor.clone()
        };
        for _pass in 0..2 {
            let delta = match &anchor_opt {
                Some(anchor) => {
                    let a = anchor.as_type::<f32>()?.reshape(&[1, 1, -1])?;
                    subtract(&span_slice, &a)?
                }
                None => span_slice.clone(),
            };
            for dir in &dirs {
                let d_vec = dir.as_type::<f32>()?.reshape(&[1, 1, -1])?;
                let dot = sum_axes(&multiply(&delta, &d_vec)?, &[-1], true)?;
                let pos_proj = maximum(&dot, &Array::from_f32(0.0))?;
                let step = multiply(
                    &multiply(&pos_proj, &d_vec)?,
                    &Array::from_f32(alpha.clamp(0.1, 2.5)),
                )?;
                span_slice = subtract(&span_slice, &step)?;
            }
        }
        let h_clamped = if span_start > 0 {
            let prefix = h_hook
                .index((.., 0..(span_start as i32), ..))
                .as_type::<f32>()?;
            concatenate(&[prefix, span_slice.clone()], 1)?
        } else {
            span_slice.clone()
        };

        let (reading_after, scores_after) = self
            .repe_sensor
            .span_harm_reading(&h_clamped, Some(span_start))?;
        let (_, _, pca_coords_after) = self
            .repe_sensor
            .probe_layer_telemetry(&h_clamped, Some(span_start))?;

        let mut layer_profile_after = Vec::with_capacity(self.layers.len());
        for &c in layer_profile_before.iter().take(hook_layer) {
            layer_profile_after.push(c);
        }
        layer_profile_after.push(reading_after);

        // Roll back KV caches of layers above `hook_layer` to `span_start` and
        // recompute only the clamped span tokens `[span_start..seq_len]`.
        let mut cache_entries_rolled_back = 0usize;
        let mut layers_recomputed = 0usize;
        let mut h_upper_span = span_slice;
        for layer in self.layers.iter_mut().skip(hook_layer + 1) {
            let prev_len = layer.cache_len();
            if prev_len > span_start {
                cache_entries_rolled_back += prev_len - span_start;
                layer.truncate_cache(span_start)?;
                h_upper_span = layer.forward_cached(&h_upper_span, span_start)?;
            } else {
                h_upper_span = layer.forward(&h_upper_span, 0.0)?;
            }
            layers_recomputed += 1;
            let c_after = self.repe_sensor.probe_cosine(&h_upper_span, Some(0))?;
            layer_profile_after.push(c_after);
        }

        Ok(RollbackSpanTelemetry {
            reading_before,
            reading_after,
            cluster_scores_before: scores_before.cluster_scores,
            cluster_scores_after: scores_after.cluster_scores,
            tripped_cluster,
            alpha,
            layer_profile_before,
            layer_profile_after,
            pca_coords_before,
            pca_coords_after,
            cache_entries_rolled_back,
            layers_recomputed,
            span_tokens_clamped: seq_len.saturating_sub(span_start),
        })
    }

    fn rms_norm(x: &Array, weight: &Array, eps: f32) -> Result<Array> {
        let xf = x.as_type::<f32>()?;
        let wf = weight.as_type::<f32>()?;
        Ok(mlx_rs::fast::rms_norm(&xf, Some(&wf), eps)?)
    }
}

/// Native hybrid guard engine wrapping the 32-layer `Cloudflare/clef-flash`
/// (`Qwen3_5ForConditionalGeneration` Gated DeltaNet + full attention) backbone,
/// middle-layer `RepeSensor`, and trained `ClefSchemaHead` (`JointSchemaHead`).
pub struct HybridGuardEngine {
    pub backbone: crate::hybrid_backbone::HybridBackbone,
    pub repe_sensor: RepeSensor,
    pub clef_head: Option<ClefSchemaHead>,
}

impl GuardableEngine for HybridGuardEngine {
    fn run_hooked(
        &mut self,
        input_ids: &Array,
        _enable_clef_lora: bool,
        lock_as_user_anchor: bool,
        clef_questions: Option<(&[ClefQuestion], &[Array])>,
        probe_span_start: Option<usize>,
    ) -> Result<HookedForwardOutput> {
        let mut h = self.backbone.embed(input_ids)?;
        let mut repe_telemetry = None;
        self.repe_sensor.clear_profiles();

        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(self.backbone.layers.len().saturating_sub(1));
        for (layer_idx, layer) in self.backbone.layers.iter().enumerate() {
            h = layer.forward(&self.backbone.cfg, &h)?;
            if lock_as_user_anchor {
                self.repe_sensor.record_layer_anchor_lazy(layer_idx, &h)?;
                if layer_idx == hook_layer {
                    self.repe_sensor.finalize_user_anchors()?;
                    break;
                }
                continue;
            }
            let cached = self.repe_sensor.record_full_layer_telemetry(
                layer_idx,
                &h,
                probe_span_start,
                layer_idx == hook_layer,
            )?;

            if layer_idx == hook_layer {
                let telemetry = self.repe_sensor.inspect_and_maybe_clamp_with_cached(
                    &mut h,
                    probe_span_start,
                    cached,
                )?;
                repe_telemetry = Some(telemetry);
            }
        }

        let h_final = crate::gdn::rms_norm(
            &h,
            Some(&self.backbone.norm),
            self.backbone.cfg.rms_norm_eps,
        )?;
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
            attention_probs: None,
        })
    }

    fn target_layer(&self) -> usize {
        self.repe_sensor.target_layer
    }

    fn d_model(&self) -> i32 {
        self.repe_sensor.v_harm.shape()[0]
    }

    fn vocab_size(&self) -> i32 {
        self.backbone.embed_tokens.shape()[0]
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

    fn layer_cluster_profile(&self) -> &[Vec<f32>] {
        &self.repe_sensor.layer_cluster_profile
    }

    fn layer_pca_profile(&self) -> &[Vec<f32>] {
        &self.repe_sensor.layer_pca_profile
    }

    fn awq_salience_ratio(&self) -> Option<f32> {
        self.repe_sensor.awq_salience_ratio
    }

    fn layer_trace(&self) -> &[crate::repe_sensor::LayerTraceMetric] {
        &self.repe_sensor.layer_trace
    }

    fn token_trace(&self) -> &[crate::repe_sensor::TokenTraceMetric] {
        &self.repe_sensor.token_trace
    }

    fn pca_reference(&self) -> crate::repe_sensor::PcaReferenceTelemetry {
        self.repe_sensor.pca_reference.clone()
    }

    fn pca_coordinates(&self) -> Vec<f32> {
        self.repe_sensor.last_pca_coords.clone()
    }

    fn num_layers(&self) -> usize {
        self.backbone.layers.len()
    }

    fn embed_option_tokens(&self, token_ids: &[u32]) -> Result<Option<Array>> {
        if token_ids.is_empty() {
            return Ok(None);
        }
        let vocab = self.vocab_size().max(1) as usize;
        let ids: Vec<i32> = token_ids
            .iter()
            .map(|&id| (id as usize % vocab) as i32)
            .collect();
        let arr = Array::from_slice(&ids, &[ids.len() as i32]);
        let embs = self.backbone.embed(&arr)?.as_type::<f32>()?;
        let mean_emb = mean_axes(&embs, &[0], false)?;
        mean_emb.eval()?;
        Ok(Some(mean_emb))
    }

    fn run_anchor_only(&mut self, input_ids: &Array) -> Result<()> {
        let mut h = self.backbone.embed(input_ids)?;
        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(self.backbone.layers.len().saturating_sub(1));
        for (layer_idx, layer) in self.backbone.layers.iter().enumerate() {
            h = layer.forward(&self.backbone.cfg, &h)?;
            self.repe_sensor.record_layer_anchor_lazy(layer_idx, &h)?;
            if layer_idx == hook_layer {
                break;
            }
        }
        self.repe_sensor.finalize_user_anchors()?;
        Ok(())
    }

    fn probe_reference_only(
        &mut self,
        reference_ids: &Array,
        probe_span_start: Option<usize>,
    ) -> Result<f32> {
        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(self.backbone.layers.len().saturating_sub(1));
        let mut h = self.backbone.embed(reference_ids)?;
        for layer in self.backbone.layers.iter().take(hook_layer + 1) {
            h = layer.forward(&self.backbone.cfg, &h)?;
        }
        self.repe_sensor.probe_cosine(&h, probe_span_start)
    }

    fn hot_reload_contrastive_pair_spans(
        &mut self,
        benign_ids: &Array,
        benign_span_start: Option<usize>,
        adv_ids: &Array,
        adv_span_start: Option<usize>,
    ) -> Result<(f32, f32, [f32; 2], [f32; 2])> {
        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(self.backbone.layers.len().saturating_sub(1));
        let mut h_b = self.backbone.embed(benign_ids)?;
        for layer in self.backbone.layers.iter().take(hook_layer + 1) {
            h_b = layer.forward(&self.backbone.cfg, &h_b)?;
        }
        let mut h_a = self.backbone.embed(adv_ids)?;
        for layer in self.backbone.layers.iter().take(hook_layer + 1) {
            h_a = layer.forward(&self.backbone.cfg, &h_a)?;
        }
        self.repe_sensor
            .hot_reload_contrastive_spans(&h_b, benign_span_start, &h_a, adv_span_start)
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
        self.repe_sensor.clear_profiles();
        let hook_layer = self.repe_sensor.target_layer;
        let mut repe_telemetry = None;
        for (idx, h) in layers.into_iter().enumerate() {
            let mut h = h;
            if lock_as_user_anchor {
                self.repe_sensor.record_layer_anchor_lazy(idx, &h)?;
                if idx == hook_layer {
                    self.repe_sensor.finalize_user_anchors()?;
                }
                continue;
            }
            let cached = self.repe_sensor.record_full_layer_telemetry(
                idx,
                &h,
                probe_span_start,
                idx == hook_layer,
            )?;
            if idx == hook_layer {
                // Reading only: a clamp here would edit a copy nothing decodes from.
                repe_telemetry = Some(self.repe_sensor.inspect_and_maybe_clamp_with_cached(
                    &mut h,
                    probe_span_start,
                    cached,
                )?);
            }
        }
        if lock_as_user_anchor {
            self.repe_sensor.finalize_user_anchors()?;
        }
        Ok(HookedForwardOutput {
            h_final,
            repe_telemetry,
            clef_decisions: None,
            attention_probs: None,
        })
    }
    fn probe_reference_only(
        &mut self,
        reference_ids: &Array,
        probe_span_start: Option<usize>,
    ) -> Result<f32> {
        let ids: Vec<u32> = reference_ids
            .as_type::<i32>()?
            .as_slice::<i32>()
            .iter()
            .map(|&v| v as u32)
            .collect();
        let (layers, _) = self.fetch(&ids)?;
        let hook_layer = self
            .repe_sensor
            .target_layer
            .min(layers.len().saturating_sub(1));
        let h = layers
            .get(hook_layer)
            .ok_or_else(|| anyhow::anyhow!("remote backbone returned empty layers"))?;
        self.repe_sensor.probe_cosine(h, probe_span_start)
    }
    fn hot_reload_contrastive_pair_spans(
        &mut self,
        benign_ids: &Array,
        benign_span_start: Option<usize>,
        adv_ids: &Array,
        adv_span_start: Option<usize>,
    ) -> Result<(f32, f32, [f32; 2], [f32; 2])> {
        let to_u32 = |arr: &Array| -> Result<Vec<u32>> {
            Ok(arr
                .as_type::<i32>()?
                .as_slice::<i32>()
                .iter()
                .map(|&v| v as u32)
                .collect())
        };
        let (b_layers, _) = self.fetch(&to_u32(benign_ids)?)?;
        let (a_layers, _) = self.fetch(&to_u32(adv_ids)?)?;
        let b_idx = self
            .repe_sensor
            .target_layer
            .min(b_layers.len().saturating_sub(1));
        let a_idx = self
            .repe_sensor
            .target_layer
            .min(a_layers.len().saturating_sub(1));
        let h_b = b_layers
            .get(b_idx)
            .ok_or_else(|| anyhow::anyhow!("remote backbone returned empty benign layers"))?;
        let h_a = a_layers
            .get(a_idx)
            .ok_or_else(|| anyhow::anyhow!("remote backbone returned empty adv layers"))?;
        self.repe_sensor
            .hot_reload_contrastive_spans(h_b, benign_span_start, h_a, adv_span_start)
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
    fn layer_cluster_profile(&self) -> &[Vec<f32>] { &self.repe_sensor.layer_cluster_profile }
    fn layer_pca_profile(&self) -> &[Vec<f32>] { &self.repe_sensor.layer_pca_profile }
    fn awq_salience_ratio(&self) -> Option<f32> { self.repe_sensor.awq_salience_ratio }
    fn layer_trace(&self) -> &[crate::repe_sensor::LayerTraceMetric] { &self.repe_sensor.layer_trace }
    fn token_trace(&self) -> &[crate::repe_sensor::TokenTraceMetric] { &self.repe_sensor.token_trace }
    fn pca_reference(&self) -> crate::repe_sensor::PcaReferenceTelemetry { self.repe_sensor.pca_reference.clone() }
    fn pca_coordinates(&self) -> Vec<f32> { self.repe_sensor.last_pca_coords.clone() }
    fn num_layers(&self) -> usize { self.num_layers }
    fn set_capture_attention(&mut self, _on: bool) {}
}

#[cfg(test)]
mod hook_cache_tests {
    use super::*;
    use crate::mlx_loader::QwenLoadedLayer;

    #[test]
    fn speculative_kv_cache_slicing_matches_full_reference_pass() {
        let d_model = 64i32;
        let vocab_size = 128i32;
        let n_layers = 4usize;
        let embed_tokens = multiply(
            &mlx_rs::random::normal::<f32>(&[vocab_size, d_model], None, None, None).unwrap(),
            &Array::from_f32(0.05),
        )
        .unwrap();
        let mut layers = Vec::with_capacity(n_layers);
        for _ in 0..n_layers {
            layers.push(QwenLoadedLayer::synthetic(d_model).unwrap());
        }
        let final_norm_weight = Array::ones::<f32>(&[d_model]).unwrap();
        let mut repe_sensor = RepeSensor::uncalibrated_zeros(n_layers, d_model).unwrap();
        repe_sensor.target_layer = 2;
        let mut v_data = vec![0.0f32; d_model as usize];
        v_data[0] = 0.6;
        v_data[1] = 0.8;
        repe_sensor.v_harm = Array::from_slice(&v_data, &[d_model]);
        repe_sensor.v_harm_clusters = vec![repe_sensor.v_harm.clone()];

        let mut engine = HookedQwenClefEngine {
            embed_tokens,
            layers,
            final_norm_weight,
            repe_sensor,
            clef_head: None,
            capture_attention: false,
        };

        // Pass 1: anchor
        let anchor_ids = Array::from_slice(&[3i32, 7, 11, 15, 19], &[1, 5]);
        engine.run_anchor_only(&anchor_ids).unwrap();

        // Pass 2: tool call sharing 6 prefix tokens [3, 7, 11, 15, 19, 23]
        let full_ids = [3u32, 7, 11, 15, 19, 23, 41, 42, 43];
        let full_arr = Array::from_slice(
            &full_ids.iter().map(|&v| v as i32).collect::<Vec<_>>(),
            &[1, full_ids.len() as i32],
        );
        engine.run_hooked(&full_arr, false, false, None, Some(6)).unwrap();

        // Pass 3a: cached reference sharing prefix [0..6]
        let ref_ids = [3u32, 7, 11, 15, 19, 23, 88, 89, 90, 91];
        let cached_cosine = engine
            .probe_reference_cached(&ref_ids, 6, 6, vocab_size)
            .unwrap()
            .expect("cached probe should succeed");

        // Pass 3b: uncached full pass on ref_ids
        let ref_arr = Array::from_slice(
            &ref_ids.iter().map(|&v| v as i32).collect::<Vec<_>>(),
            &[1, ref_ids.len() as i32],
        );
        let full_out = engine
            .run_hooked(&ref_arr, false, false, None, Some(6))
            .unwrap();
        let full_cosine = full_out.repe_telemetry.unwrap().harm_cosine;

        let diff = (cached_cosine - full_cosine).abs();
        assert!(
            diff < 1e-4,
            "KV-cache-sliced baseline cosine ({cached_cosine}) diverged from full pass ({full_cosine}): diff={diff}"
        );
    }

    #[test]
    fn clamp_and_rollback_span_rolls_back_cache_and_recomputes_upper_layers() {
        let d_model = 64i32;
        let vocab_size = 128i32;
        let n_layers = 4usize;
        let embed_tokens = multiply(
            &mlx_rs::random::normal::<f32>(&[vocab_size, d_model], None, None, None).unwrap(),
            &Array::from_f32(0.05),
        )
        .unwrap();
        let mut layers = Vec::with_capacity(n_layers);
        for _ in 0..n_layers {
            layers.push(QwenLoadedLayer::synthetic(d_model).unwrap());
        }
        let final_norm_weight = Array::ones::<f32>(&[d_model]).unwrap();
        let mut repe_sensor = RepeSensor::uncalibrated_zeros(n_layers, d_model).unwrap();
        repe_sensor.target_layer = 1;
        let mut v_data = vec![0.0f32; d_model as usize];
        v_data[0] = 0.6;
        v_data[1] = 0.8;
        repe_sensor.v_harm = Array::from_slice(&v_data, &[d_model]);
        repe_sensor.v_harm_clusters = vec![repe_sensor.v_harm.clone()];

        let mut engine = HookedQwenClefEngine {
            embed_tokens,
            layers,
            final_norm_weight,
            repe_sensor,
            clef_head: None,
            capture_attention: false,
        };

        let ids = Array::from_slice(&[5i32, 9, 13, 17, 21, 25, 29, 33], &[1, 8]);
        let rollback = engine.clamp_and_rollback_span(&ids, 4, 1.0).unwrap();
        assert_eq!(rollback.span_tokens_clamped, 4);
        assert_eq!(rollback.layers_recomputed, 2); // layers 2 and 3 above hook_layer=1
        assert_eq!(rollback.cache_entries_rolled_back, 8); // 4 tokens * 2 upper layers
        assert_eq!(rollback.layer_profile_before.len(), n_layers);
        assert_eq!(rollback.layer_profile_after.len(), n_layers);
    }
}
