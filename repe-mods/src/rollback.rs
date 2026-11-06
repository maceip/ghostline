//! Speculative activation rollback.
//!
//! The guard's 403 path answers a dangerous tool call with a refusal. This
//! module answers it with a *different completion*: the model writes the tool
//! call itself, the RepE sensor watches the residual stream as it goes, and
//! the moment a token's activation reads as harmful the guard clamps that
//! activation (`h' = h - alpha * max(0, h . v_c) * v_c`, along the harm
//! CLUSTER that tripped), rolls the KV cache back to before the offending
//! token, recomputes the layers above the probe layer from the clamped
//! residual, and RESUMES decoding from there.
//!
//! The pieces that make this possible:
//!
//! * a **shared KV cache** in the decoder layer (`QwenLoadedLayer::forward_cached`),
//!   so the context is prefilled ONCE and the same cache serves both the
//!   speculative generation and the re-generation after a rollback;
//! * a **greedy decode loop** that measures the RepE reading on every
//!   generated token;
//! * a **rollback** that rewinds the cache and recomputes the affected
//!   layers from the clamped residual.
//!
//! The 403 path is untouched: this module is an ADDITION. The guard still
//! blocks a tool call it has already received; this module is what the agent
//! gets when it asks the guard to *generate* the call instead.

use anyhow::{Context, Result};
use mlx_rs::{
    Array,
    ops::{
        indexing::{IndexOp, argmax},
        *,
    },
};
use qwen_clef_repe_guard::mlx_loader::{HfModelConfig, QwenLoadedLayer, ShardedModelLoader};
use qwen_clef_repe_guard::qwen_hook::{GuardableEngine, HookedQwenClefEngine, QwenDecoderLayer};
use qwen_clef_repe_guard::repe_sensor::RepeSensor;
use serde::Serialize;
use std::path::Path;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// How the guard decides that a generated token is harmful.
#[derive(Debug, Clone, Serialize)]
pub struct TripRule {
    /// The harm reading above which the guard trips.
    pub threshold: f32,
    /// Where the threshold came from — recorded so a reading is never
    /// reported without the operating point it was judged against.
    pub rule: String,
}

/// Resolve the trip threshold from the artifact.
///
/// The calibrated ABSOLUTE harm threshold wins when the artifact carries
/// one: it is measured on the same cosine scale the guard reads, and it
/// does not depend on a baseline that was measured against a pooled
/// tool-call span — the decode loop reads one token at a time, and a span
/// statistic is not interchangeable with a per-token one.
///
/// The calibrated EXCESS threshold is the fallback: it is the operating
/// point the 403 path uses, but it is an excess over a matched benign
/// PANEL, so it only means something against that panel.
///
/// An explicit value wins over both — the caller knows the statistic it is
/// watching.
pub fn resolve_trip_threshold(sensor: &RepeSensor, explicit: Option<f32>) -> TripRule {
    if let Some(t) = explicit {
        return TripRule {
            threshold: t,
            rule: "explicit".to_string(),
        };
    }
    if let Some(t) = sensor.calibrated_harm_threshold {
        return TripRule {
            threshold: t,
            rule: "calibrated-harm-threshold".to_string(),
        };
    }
    if let (Some(baseline), Some(excess)) = (
        sensor.static_benign_baseline,
        sensor.calibrated_harm_excess_threshold,
    ) {
        return TripRule {
            threshold: baseline + excess,
            rule: format!("excess-over-static-baseline (baseline {baseline} + excess {excess})"),
        };
    }
    TripRule {
        threshold: 0.45,
        rule: "default".to_string(),
    }
}

/// The knobs of the rollback loop.
#[derive(Debug, Clone)]
pub struct RollbackConfig {
    /// The clamp strength: `h' = h - alpha * max(0, h . v_c) * v_c`.
    ///
    /// `alpha = 1.0` removes the whole harmful component (what the inline
    /// hook does); `alpha = 0.5` removes half of it, which steers the model
    /// without erasing the instruction it is following.
    pub alpha: f32,
    /// The maximum number of tokens to generate.
    pub max_tokens: usize,
    /// The harm reading above which the guard trips.
    pub trip_threshold: f32,
    /// Where that threshold came from.
    pub trip_rule: String,
    /// How many times the guard may trip and roll back.
    pub max_rollbacks: usize,
}

impl Default for RollbackConfig {
    fn default() -> Self {
        Self {
            alpha: 0.5,
            max_tokens: 64,
            trip_threshold: 0.45,
            trip_rule: "default".to_string(),
            max_rollbacks: 4,
        }
    }
}

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

/// One rollback: what the guard saw, what it did, and what came out.
#[derive(Debug, Clone, Serialize)]
pub struct RollbackEvent {
    /// The index of the offending token in the generated sequence.
    pub token_index: usize,
    /// The offending token id.
    pub token_id: u32,
    /// The offending token's text.
    pub token_text: String,
    /// Which harm cluster tripped.
    pub cluster: usize,
    /// The tripped cluster's cosine BEFORE the clamp.
    pub cluster_cosine_before: f32,
    /// The tripped cluster's cosine AFTER the clamp.
    pub cluster_cosine_after: f32,
    /// The pooled harm reading BEFORE the clamp (the maximum over clusters).
    pub reading_before: f32,
    /// The pooled harm reading AFTER the clamp.
    pub reading_after: f32,
    /// Every cluster's cosine BEFORE the clamp.
    pub cluster_scores_before: Vec<f32>,
    /// Every cluster's cosine AFTER the clamp.
    pub cluster_scores_after: Vec<f32>,
    /// How many cache entries were rolled back.
    pub cache_entries_rolled_back: usize,
    /// How many decoder layers were recomputed from the clamped residual.
    pub layers_recomputed: usize,
    /// The token the model sampled after the rollback.
    pub next_token_id: u32,
    /// The text the model sampled after the rollback.
    pub next_token_text: String,
}

/// What the guarded generation produced.
#[derive(Debug, Clone, Serialize)]
pub struct GenerationOutcome {
    /// The guarded completion — what the model produced AFTER the rollback.
    pub text: String,
    /// The guarded token ids.
    pub tokens: Vec<u32>,
    /// Whether the guard tripped at all.
    pub tripped: bool,
    /// The index of the token the guard tripped on.
    pub trip_token: Option<usize>,
    /// The harm cluster that tripped.
    pub trip_cluster: Option<usize>,
    /// The harm reading that tripped.
    pub trip_cosine: f32,
    /// Whether a clamp was applied.
    pub clamped: bool,
    /// How many layers were recomputed after the rollback.
    pub rollback_steps: usize,

    // --- the detail the guard's dashboard and the acceptance checks need ---
    /// The completion the model WOULD have produced without the guard.
    ///
    /// This is the speculative pass: the same prefill, the same greedy
    /// decode, no clamp. It is what the rollback replaced.
    pub text_before_rollback: String,
    /// The tripped cluster's cosine BEFORE the clamp.
    pub cosine_before: f32,
    /// The tripped cluster's cosine AFTER the clamp.
    pub cosine_after: f32,
    /// The pooled harm reading BEFORE the clamp.
    pub reading_before: f32,
    /// The pooled harm reading AFTER the clamp.
    pub reading_after: f32,
    /// Every rollback the guard performed.
    pub rollbacks: Vec<RollbackEvent>,
    /// The threshold the reading was judged against.
    pub trip_threshold: f32,
    /// Where that threshold came from.
    pub trip_rule: String,
    /// How many cache entries were rolled back in total.
    pub cache_entries_rolled_back: usize,
    /// How many decoder layers were recomputed in total.
    pub layers_recomputed: usize,
    /// How many tokens the prefill consumed.
    pub prefill_tokens: usize,
    /// The probe layer the guard measures at.
    pub probe_layer: usize,
    /// The clamp strength that was used.
    pub alpha: f32,
    /// The end-of-sequence ids the loop stops on.
    pub eos_token_ids: Vec<u32>,
    /// The harm reading of every token of the speculative pass.
    ///
    /// One entry per generated token, in order. It is the raw material of the
    /// trip decision: the guard reads these.
    pub token_readings: Vec<f32>,
    /// The token ids of the speculative pass, aligned with `token_readings`.
    pub token_ids: Vec<u32>,
    /// The beginning-of-sequence token id of the checkpoint, when it has one.
    pub bos_token_id: Option<u32>,
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/// A Qwen backbone with its shared KV caches, the RepE sensor and the
/// language-model head.
pub struct RollbackEngine {
    pub embed_tokens: Array,
    pub layers: Vec<QwenLoadedLayer>,
    pub final_norm_weight: Array,
    /// The language-model head: the tied embedding table when the checkpoint
    /// ties its input and output embeddings.
    pub lm_head: Array,
    pub repe_sensor: RepeSensor,
    pub eos_token_ids: Vec<u32>,
    pub bos_token_id: Option<u32>,
}

impl RollbackEngine {
    /// Load a checkpoint and a RepE artifact exactly like the guard's normal
    /// path does.
    pub fn load(model_dir: &Path, artifact: &Path) -> Result<Self> {
        let loader = ShardedModelLoader::open(model_dir, None)?;
        if loader.config.is_hybrid_attention() {
            anyhow::bail!(
                "checkpoint at {:?} uses a hybrid linear-attention stack; the reference \
                 decoder block in this crate implements the dense stack only",
                model_dir
            );
        }
        let layer_count = loader.detected_layer_count();
        let mut repe = RepeSensor::load_safetensors(artifact, 0, Some(0.45))?;
        repe.target_layer = repe.target_layer.min(layer_count.saturating_sub(1));

        let mut layers = Vec::with_capacity(layer_count);
        for i in 0..layer_count {
            layers.push(loader.load_layer(i)?);
        }
        let embed_tokens = loader.load_embed_tokens_f32()?;
        let final_norm_weight = loader.load_final_norm()?;
        let lm_head = loader.load_lm_head()?;
        let special = special_tokens(model_dir, &loader.config);

        Ok(Self {
            embed_tokens,
            layers,
            final_norm_weight,
            lm_head,
            repe_sensor: repe,
            eos_token_ids: special.eos,
            bos_token_id: special.bos,
        })
    }

    /// The probe layer the guard measures at.
    pub fn probe_layer(&self) -> usize {
        self.repe_sensor.target_layer.min(self.layers.len().saturating_sub(1))
    }
}

/// The special tokens the decode loop needs.
#[derive(Debug, Clone, Default)]
pub struct SpecialTokens {
    pub bos: Option<u32>,
    pub eos: Vec<u32>,
}

/// Read the BOS/EOS ids of a checkpoint.
///
/// `config.json` records them, and `generation_config.json` sometimes
/// records a wider list of end-of-sequence ids. Both are read and merged.
pub fn special_tokens(model_dir: &Path, config: &HfModelConfig) -> SpecialTokens {
    let mut out = SpecialTokens::default();
    let cfg = config.effective();
    if let Some(bos) = &cfg.bos_token_id {
        out.bos = bos.ids().first().map(|v| *v as u32);
    }
    if let Some(eos) = &cfg.eos_token_id {
        out.eos.extend(eos.ids().into_iter().map(|v| v as u32));
    }
    if let Ok(raw) = std::fs::read_to_string(model_dir.join("generation_config.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            match value.get("eos_token_id") {
                Some(serde_json::Value::Number(n)) => {
                    if let Some(v) = n.as_i64() {
                        out.eos.push(v as u32);
                    }
                }
                Some(serde_json::Value::Array(list)) => {
                    for item in list {
                        if let Some(v) = item.as_i64() {
                            out.eos.push(v as u32);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    out.eos.sort_unstable();
    out.eos.dedup();
    out
}

// ---------------------------------------------------------------------------
// The tokenizer front-end
// ---------------------------------------------------------------------------

/// A thin wrapper around the checkpoint's BPE tokenizer.
pub struct TokenCodec {
    tokenizer: Option<tokenizers::Tokenizer>,
}

impl TokenCodec {
    /// Load the tokenizer that sits next to the checkpoint.
    pub fn from_model_dir(model_dir: &Path) -> Self {
        let path = model_dir.join("tokenizer.json");
        let loaded = tokenizers::Tokenizer::from_file(&path)
            .ok()
            .filter(|t| t.get_vocab_size(true) > 0);
        Self { tokenizer: loaded }
    }

    /// Encode a piece of text.
    pub fn encode(&self, text: &str) -> Vec<u32> {
        match &self.tokenizer {
            Some(tok) => tok
                .encode(text, false)
                .map(|enc| enc.get_ids().to_vec())
                .unwrap_or_else(|_| byte_fallback(text)),
            None => byte_fallback(text),
        }
    }

    /// Decode a sequence of tokens.
    pub fn decode(&self, ids: &[u32]) -> String {
        match &self.tokenizer {
            Some(tok) => tok.decode(ids, true).unwrap_or_default(),
            None => String::new(),
        }
    }

    /// Decode a single token.
    pub fn decode_token(&self, id: u32) -> String {
        match &self.tokenizer {
            Some(tok) => tok.decode(&[id], true).unwrap_or_default(),
            None => String::new(),
        }
    }
}

/// One token per UTF-8 byte, kept inside the byte range.
fn byte_fallback(text: &str) -> Vec<u32> {
    text.as_bytes().iter().map(|b| *b as u32).collect()
}

// ---------------------------------------------------------------------------
// The decode loop
// ---------------------------------------------------------------------------

/// The residual states of one decoded token.
struct TokenForward {
    /// The final hidden state, after the last layer and the final norm.
    h_final: Array,
    /// The probe layer's output for this token.
    probe_h: Array,
    /// The probe layer's INPUT for this token — what the probe layer has to be
    /// re-run with when the token is recomputed.
    probe_input: Array,
}

/// A snapshot of every layer's KV cache.
///
/// `Array::clone` is a reference-count bump, so a snapshot costs almost
/// nothing and the cache can be rewound to exactly where it was.
type CacheSnapshot = Vec<(Option<Array>, Option<Array>)>;

fn snapshot_cache(engine: &RollbackEngine) -> CacheSnapshot {
    engine
        .layers
        .iter()
        .map(|l| (l.k_cache.clone(), l.v_cache.clone()))
        .collect()
}

fn restore_cache(engine: &mut RollbackEngine, snapshot: &CacheSnapshot) {
    for (layer, (k, v)) in engine.layers.iter_mut().zip(snapshot.iter()) {
        layer.k_cache = k.clone();
        layer.v_cache = v.clone();
    }
}

/// The final RMSNorm over the backbone hidden state.
fn rms_norm(x: &Array, weight: &Array, eps: f32) -> Result<Array> {
    let xf = x.as_type::<f32>()?;
    let variance = mean_axes(&multiply(&xf, &xf)?, &[-1], true)?;
    let inv_rms = rsqrt(&add(&variance, &Array::from_f32(eps))?)?;
    let normed = multiply(&xf, &inv_rms)?;
    Ok(multiply(&normed, &weight.as_type::<f32>()?)?)
}

/// Feed one token through the whole stack, appending to the KV caches.
fn forward_token(
    engine: &mut RollbackEngine,
    token_id: u32,
    position_offset: usize,
    probe_layer: usize,
) -> Result<TokenForward> {
    let ids = Array::from_slice(&[token_id as i32], &[1, 1]);
    let mut h = engine.embed_tokens.take_axis(&ids, 0)?;
    let mut probe_input: Option<Array> = None;
    let mut probe_h: Option<Array> = None;
    for (idx, layer) in engine.layers.iter_mut().enumerate() {
        if idx == probe_layer {
            probe_input = Some(h.clone());
        }
        h = layer.forward_cached(&h, position_offset)?;
        if idx == probe_layer {
            probe_h = Some(h.clone());
        }
    }
    let probe_input = probe_input.context("the probe layer is out of range")?;
    let probe_h = probe_h.context("the probe layer is out of range")?;
    let h_final = rms_norm(&h, &engine.final_norm_weight, 1e-6)?;
    Ok(TokenForward {
        h_final,
        probe_h,
        probe_input,
    })
}

/// Prefill a whole sequence into the cache.
fn prefill(
    engine: &mut RollbackEngine,
    ids: &[u32],
    probe_layer: usize,
) -> Result<(Array, Array)> {
    let flat: Vec<i32> = ids.iter().map(|i| *i as i32).collect();
    let ids_arr = Array::from_slice(&flat, &[1, flat.len() as i32]);
    let mut h = engine.embed_tokens.take_axis(&ids_arr, 0)?;
    let mut probe_h: Option<Array> = None;
    for (idx, layer) in engine.layers.iter_mut().enumerate() {
        h = layer.forward_cached(&h, 0)?;
        if idx == probe_layer {
            probe_h = Some(h.clone());
        }
    }
    let probe_h = probe_h.context("the probe layer is out of range")?;
    let h_final = rms_norm(&h, &engine.final_norm_weight, 1e-6)?;
    Ok((h_final, probe_h))
}

/// The next token: the greedy argmax of the language-model head.
fn sample_token(engine: &RollbackEngine, h_final: &Array) -> Result<u32> {
    let seq = h_final.shape()[1];
    let last = h_final.index((0, seq - 1, ..)).expand_dims(0)?; // [1, D]
    let w_t = transpose_axes(&engine.lm_head, &[1, 0])?; // [D, V]
    let logits = matmul(&last, &w_t)?; // [1, V]
    let idx = argmax(&logits, Some(false))?.as_type::<i32>()?;
    idx.eval()?;
    Ok(idx.item_exact::<i32>().max(0) as u32)
}

/// The harm direction of one cluster.
///
/// The artifact's cluster directions win; an artifact without them falls back
/// to the legacy single `v_harm` direction, which is then also "cluster 0".
fn cluster_direction(sensor: &RepeSensor, cluster: usize) -> Array {
    match sensor.v_harm_clusters.get(cluster) {
        Some(dir) => dir.clone(),
        None => sensor.v_harm.clone(),
    }
}

/// `h' = h - alpha * max(0, h . v) * v`, applied to the LAST token of `h`.
///
/// This is the inline hook's in-place clamp with two changes: the CLUSTER
/// direction instead of the mean `v_harm`, and the strength `alpha` instead
/// of a full projection removal. Only the positive part of the projection is
/// removed — a token that points AWAY from the harm direction is left alone.
fn clamp_last_token(h: &Array, dir: &Array, alpha: f32) -> Result<Array> {
    let seq_len = h.shape()[1];
    let h_last = h.index((0, seq_len - 1, ..)).as_type::<f32>()?;
    let dot = sum(&multiply(&h_last, dir)?, true)?;
    let pos_proj = maximum(&dot, &Array::from_f32(0.0))?;
    let correction = multiply(&pos_proj, dir)?;
    let scaled = multiply(&correction, &Array::from_f32(alpha))?;
    let h_clamped = subtract(&h_last, &scaled)?.reshape(&[1, 1, -1])?;
    if seq_len > 1 {
        let prefix = h.index((.., 0..(seq_len - 1), ..));
        Ok(concatenate(&[prefix, h_clamped], 1)?)
    } else {
        Ok(h_clamped)
    }
}

/// What a rollback did.
struct RollbackResult {
    h_final: Array,
    cluster_cosine_before: f32,
    cluster_cosine_after: f32,
    reading_before: f32,
    reading_after: f32,
    cluster_scores_before: Vec<f32>,
    cluster_scores_after: Vec<f32>,
    cache_entries_rolled_back: usize,
    layers_recomputed: usize,
}

/// Clamp the offending token, roll the KV cache back and recompute.
///
/// The cache of the probe layer and of every layer ABOVE it is rolled back to
/// before the offending token: their entries were written from the UNCLAMPED
/// residual. The layers are then recomputed from the clamped residual, so the
/// continuation is generated from the clamped state.
///
/// The probe layer's own entry is recomputed too, even though its input — the
/// residual entering the probe layer — was not touched by the clamp: rolling
/// it back keeps the contract "the cache is rewound to the state before the
/// offending token" true for every layer at and above the probe, and the
/// recomputation reproduces the same key/value pair bit for bit.
fn rollback_and_recompute(
    engine: &mut RollbackEngine,
    probe_layer: usize,
    forward: &TokenForward,
    cluster: usize,
    alpha: f32,
    pre_len: usize,
) -> Result<RollbackResult> {
    let dir = cluster_direction(&engine.repe_sensor, cluster);

    // The reading BEFORE the clamp, measured the same way the guard measures
    // it: the pooled reading over the token, against the cluster directions.
    let (reading_before, scores_before) = engine
        .repe_sensor
        .span_harm_reading(&forward.probe_h, None)?;
    let cluster_before = scores_before
        .cluster_scores
        .get(cluster)
        .copied()
        .unwrap_or(reading_before);

    // The clamp, and the reading AFTER it.
    let clamped_probe = clamp_last_token(&forward.probe_h, &dir, alpha)?;
    let (reading_after, scores_after) = engine
        .repe_sensor
        .span_harm_reading(&clamped_probe, None)?;
    let cluster_after = scores_after
        .cluster_scores
        .get(cluster)
        .copied()
        .unwrap_or(reading_after);

    // Roll the KV cache back to before the offending token.
    let mut rolled = 0usize;
    for layer in engine.layers.iter_mut().skip(probe_layer) {
        rolled += layer.cache_len().saturating_sub(pre_len);
        layer.truncate_cache(pre_len)?;
    }

    // Recompute the probe layer and every layer above it from the clamped
    // residual.
    let mut h = forward.probe_input.clone();
    let mut recomputed = 0usize;
    for (idx, layer) in engine.layers.iter_mut().enumerate().skip(probe_layer) {
        h = layer.forward_cached(&h, pre_len)?;
        if idx == probe_layer {
            // The clamp acts on the probe layer's OUTPUT, so the recomputed
            // output is clamped again — exactly once, from the same
            // unclamped state the first clamp used.
            h = clamp_last_token(&h, &dir, alpha)?;
        }
        recomputed += 1;
    }
    let h_final = rms_norm(&h, &engine.final_norm_weight, 1e-6)?;

    Ok(RollbackResult {
        h_final,
        cluster_cosine_before: cluster_before,
        cluster_cosine_after: cluster_after,
        reading_before,
        reading_after,
        cluster_scores_before: scores_before.cluster_scores,
        cluster_scores_after: scores_after.cluster_scores,
        cache_entries_rolled_back: rolled,
        layers_recomputed: recomputed,
    })
}

/// Where the guard tripped.
struct Trip {
    token_index: usize,
    token_id: u32,
    cluster: usize,
    cosine: f32,
    snapshot: CacheSnapshot,
    pre_len: usize,
}

/// Generate a completion with the guard watching the residual stream.
///
/// The context is prefilled ONCE. The speculative pass then decodes greedily
/// and measures the RepE reading on every generated token. When a reading
/// trips, the guard clamps the offending activation, rolls the KV cache back
/// and RESUMES decoding from the clamped state; the speculative pass is
/// replayed from the trip point so the outcome can report what the model
/// WOULD have said.
pub fn generate_with_guard(
    engine: &mut RollbackEngine,
    codec: &TokenCodec,
    context: &str,
    config: &RollbackConfig,
) -> Result<GenerationOutcome> {
    let probe_layer = engine.probe_layer();
    let ids = codec.encode(context);
    if ids.is_empty() {
        anyhow::bail!("the rendered context is empty");
    }
    let prefill_tokens = ids.len();

    // --- 1. PREFILL: the shared cache ---
    let (h_final, _probe_h) = prefill(engine, &ids, probe_layer)?;
    let mut cur = sample_token(engine, &h_final)?;

    // --- 2. the speculative pass ---
    let mut spec_tokens: Vec<u32> = Vec::new();
    let mut token_readings: Vec<f32> = Vec::new();
    let mut trip: Option<Trip> = None;
    let mut position = prefill_tokens;

    loop {
        if spec_tokens.len() >= config.max_tokens {
            break;
        }
        // The cache is snapshotted BEFORE the forward: rewinding to this
        // point is what the guarded pass needs.
        let snapshot = snapshot_cache(engine);
        let forward = forward_token(engine, cur, position, probe_layer)?;
        let (cosine, scores) = engine
            .repe_sensor
            .span_harm_reading(&forward.probe_h, None)?;
        if trip.is_none() && cosine > config.trip_threshold {
            trip = Some(Trip {
                token_index: spec_tokens.len(),
                token_id: cur,
                cluster: scores.argmax_cluster,
                cosine,
                snapshot,
                pre_len: position,
            });
        }
        spec_tokens.push(cur);
        token_readings.push(cosine);
        let next = sample_token(engine, &forward.h_final)?;
        if engine.eos_token_ids.contains(&next) {
            spec_tokens.push(next);
            break;
        }
        cur = next;
        position += 1;
    }

    let text_before_rollback = codec.decode(&spec_tokens);

    // --- 3. the guarded pass ---
    let mut guarded_tokens: Vec<u32> = Vec::new();
    let mut rollbacks: Vec<RollbackEvent> = Vec::new();
    let mut trip_token = None;
    let mut trip_cluster = None;
    let mut trip_cosine = 0.0;
    let mut cosine_before = 0.0;
    let mut cosine_after = 0.0;
    let mut reading_before = 0.0;
    let mut reading_after = 0.0;
    let mut clamped = false;
    let mut rollback_steps = 0usize;
    let mut cache_entries_rolled_back = 0usize;
    let mut layers_recomputed = 0usize;

    if let Some(trip) = trip {
        trip_token = Some(trip.token_index);
        trip_cluster = Some(trip.cluster);
        trip_cosine = trip.cosine;

        // Rewind the cache to the state before the offending token was fed.
        restore_cache(engine, &trip.snapshot);

        // The prefix the guard kept: everything the model generated BEFORE
        // the offending token.
        guarded_tokens.extend_from_slice(&spec_tokens[..trip.token_index]);

        // Feed the offending token again, clamp it, roll the cache back and
        // recompute the layers above the probe layer.
        let forward = forward_token(engine, trip.token_id, trip.pre_len, probe_layer)?;
        let result = rollback_and_recompute(
            engine,
            probe_layer,
            &forward,
            trip.cluster,
            config.alpha,
            trip.pre_len,
        )?;
        clamped = true;
        cosine_before = result.cluster_cosine_before;
        cosine_after = result.cluster_cosine_after;
        reading_before = result.reading_before;
        reading_after = result.reading_after;
        rollback_steps += result.layers_recomputed;
        cache_entries_rolled_back += result.cache_entries_rolled_back;
        layers_recomputed += result.layers_recomputed;

        // RESUME decoding from the clamped state.
        let next = sample_token(engine, &result.h_final)?;
        rollbacks.push(RollbackEvent {
            token_index: trip.token_index,
            token_id: trip.token_id,
            token_text: codec.decode_token(trip.token_id),
            cluster: trip.cluster,
            cluster_cosine_before: result.cluster_cosine_before,
            cluster_cosine_after: result.cluster_cosine_after,
            reading_before: result.reading_before,
            reading_after: result.reading_after,
            cluster_scores_before: result.cluster_scores_before,
            cluster_scores_after: result.cluster_scores_after,
            cache_entries_rolled_back: result.cache_entries_rolled_back,
            layers_recomputed: result.layers_recomputed,
            next_token_id: next,
            next_token_text: codec.decode_token(next),
        });
        guarded_tokens.push(trip.token_id);
        guarded_tokens.push(next);

        // Continue the guarded generation. A second trip is handled the same
        // way: clamp, roll back, recompute, resume.
        let mut cur = next;
        let mut position = trip.pre_len + 1;
        loop {
            if guarded_tokens.len() >= config.max_tokens {
                break;
            }
            let forward = forward_token(engine, cur, position, probe_layer)?;
            let (cosine, scores) = engine
                .repe_sensor
                .span_harm_reading(&forward.probe_h, None)?;
            if cosine > config.trip_threshold && rollbacks.len() < config.max_rollbacks {
                let pre_len = position;
                let result = rollback_and_recompute(
                    engine,
                    probe_layer,
                    &forward,
                    scores.argmax_cluster,
                    config.alpha,
                    pre_len,
                )?;
                clamped = true;
                rollback_steps += result.layers_recomputed;
                cache_entries_rolled_back += result.cache_entries_rolled_back;
                layers_recomputed += result.layers_recomputed;
                let next = sample_token(engine, &result.h_final)?;
                rollbacks.push(RollbackEvent {
                    token_index: guarded_tokens.len(),
                    token_id: cur,
                    token_text: codec.decode_token(cur),
                    cluster: scores.argmax_cluster,
                    cluster_cosine_before: result.cluster_cosine_before,
                    cluster_cosine_after: result.cluster_cosine_after,
                    reading_before: result.reading_before,
                    reading_after: result.reading_after,
                    cluster_scores_before: result.cluster_scores_before,
                    cluster_scores_after: result.cluster_scores_after,
                    cache_entries_rolled_back: result.cache_entries_rolled_back,
                    layers_recomputed: result.layers_recomputed,
                    next_token_id: next,
                    next_token_text: codec.decode_token(next),
                });
                guarded_tokens.push(cur);
                guarded_tokens.push(next);
                cur = next;
                position += 1;
                continue;
            }
            guarded_tokens.push(cur);
            let next = sample_token(engine, &forward.h_final)?;
            if engine.eos_token_ids.contains(&next) {
                guarded_tokens.push(next);
                break;
            }
            cur = next;
            position += 1;
        }
    } else {
        guarded_tokens = spec_tokens.clone();
    }

    Ok(GenerationOutcome {
        text: codec.decode(&guarded_tokens),
        tokens: guarded_tokens,
        tripped: !rollbacks.is_empty(),
        trip_token,
        trip_cluster,
        trip_cosine,
        clamped,
        rollback_steps,
        text_before_rollback,
        cosine_before,
        cosine_after,
        reading_before,
        reading_after,
        rollbacks,
        trip_threshold: config.trip_threshold,
        trip_rule: config.trip_rule.clone(),
        cache_entries_rolled_back,
        layers_recomputed,
        prefill_tokens,
        probe_layer,
        alpha: config.alpha,
        eos_token_ids: engine.eos_token_ids.clone(),
        token_readings,
        token_ids: spec_tokens.clone(),
        bos_token_id: engine.bos_token_id,
    })
}

// ---------------------------------------------------------------------------
// The cache parity check
// ---------------------------------------------------------------------------

/// The numbers that say whether the cached pass agrees with the plain one.
#[derive(Debug, Clone, Serialize)]
pub struct CacheParity {
    /// How many tokens the prompt had.
    pub prompt_tokens: usize,
    /// Where the prompt was split: the first `split` tokens are prefilled and
    /// the rest are appended at their own positions.
    pub split: usize,
    /// The largest absolute difference between the cached and the plain final
    /// hidden states.
    pub h_final_max_abs_diff: f32,
    /// The largest relative difference between the cached and the plain final
    /// hidden states.
    pub h_final_max_rel_diff: f32,
    /// The largest absolute difference between the two next-token logit
    /// vectors.
    pub logits_max_abs_diff: f32,
    /// The largest relative difference between the two next-token logit
    /// vectors.
    pub logits_max_rel_diff: f32,
    /// The next token the plain pass produced.
    pub next_token_uncached: u32,
    /// The next token the cached pass produced.
    pub next_token_cached: u32,
    /// Whether the two passes produced the same next token.
    pub next_token_match: bool,
    /// The largest absolute difference between the cached final hidden state
    /// and the one the existing `run_hooked` path produced.
    ///
    /// The two differ exactly when `run_hooked` clamped the residual in
    /// place — the RepE hook is part of that path and is deliberately NOT
    /// part of the cached pass, which is compared against the plain stack
    /// above.
    pub h_final_max_abs_diff_vs_hooked: f32,
    /// The largest absolute difference between the two logit vectors.
    pub logits_max_abs_diff_vs_hooked: f32,
    /// The next token the `run_hooked` path produced.
    pub next_token_hooked: u32,
    /// Whether the `run_hooked` path produced the same next token.
    pub next_token_hooked_match: bool,
    /// Whether the `run_hooked` path clamped the residual in place.
    pub hooked_clamped_in_place: bool,
    /// The harm reading the `run_hooked` path measured.
    pub hooked_harm_cosine: f32,
}

/// Compare the cached forward pass against the plain one.
///
/// The plain pass runs the whole prompt through the stack at once — the path
/// the probe uses. The cached pass prefills the first `split` tokens and then
/// appends the rest at their own positions, which is where a wrong RoPE
/// offset or a wrong causal mask would show up. The two final hidden states
/// — and the next-token logits derived from them — have to agree to float32
/// rounding.
pub fn verify_cache_parity(
    model_dir: &Path,
    artifact: &Path,
    ids: &[u32],
    split: usize,
) -> Result<CacheParity> {
    let loader = ShardedModelLoader::open(model_dir, None)?;
    let layer_count = loader.detected_layer_count();
    let mut repe = RepeSensor::load_safetensors(artifact, 0, Some(0.45))?;
    repe.target_layer = repe.target_layer.min(layer_count.saturating_sub(1));

    let mut layers = Vec::with_capacity(layer_count);
    for i in 0..layer_count {
        layers.push(loader.load_layer(i)?);
    }
    let embed_tokens = loader.load_embed_tokens_f32()?;
    let final_norm_weight = loader.load_final_norm()?;
    let lm_head = loader.load_lm_head()?;

    let flat: Vec<i32> = ids.iter().map(|i| *i as i32).collect();
    let ids_arr = Array::from_slice(&flat, &[1, flat.len() as i32]);

    // --- the plain path: the same stack, without the RepE hook ---
    let mut plain_layers = layers.clone();
    let mut h_plain = embed_tokens.take_axis(&ids_arr, 0)?;
    for layer in plain_layers.iter_mut() {
        h_plain = layer.forward(&h_plain, 0.0)?;
    }
    let h_plain = rms_norm(&h_plain, &final_norm_weight, 1e-6)?;

    // --- the existing `run_hooked` path, for reference ---
    let mut hooked = HookedQwenClefEngine {
        embed_tokens: embed_tokens.clone(),
        layers: layers.clone(),
        final_norm_weight: final_norm_weight.clone(),
        repe_sensor: repe,
        clef_head: None,
        capture_attention: false,
    };
    let out = hooked.run_hooked(&ids_arr, false, false, None, None)?;
    let h_hooked = out.h_final;
    let hooked_clamped = out
        .repe_telemetry
        .as_ref()
        .map(|t| t.clamped_in_place)
        .unwrap_or(false);
    let hooked_harm = out
        .repe_telemetry
        .as_ref()
        .map(|t| t.harm_cosine)
        .unwrap_or(0.0);

    // --- the cached path ---
    let split = split.clamp(1, ids.len().saturating_sub(1).max(1));
    let mut cached_layers = layers;

    // Prefill the first `split` tokens.
    let head: Vec<i32> = flat[..split].iter().copied().collect();
    let head_arr = Array::from_slice(&head, &[1, split as i32]);
    let mut h = embed_tokens.take_axis(&head_arr, 0)?;
    for layer in cached_layers.iter_mut() {
        h = layer.forward_cached(&h, 0)?;
    }
    let h_head = rms_norm(&h, &final_norm_weight, 1e-6)?;
    // Append the rest at their own positions.
    let tail: Vec<i32> = flat[split..].iter().copied().collect();
    let tail_arr = Array::from_slice(&tail, &[1, tail.len() as i32]);
    let mut h_tail = embed_tokens.take_axis(&tail_arr, 0)?;
    for layer in cached_layers.iter_mut() {
        h_tail = layer.forward_cached(&h_tail, split)?;
    }
    let h_tail = rms_norm(&h_tail, &final_norm_weight, 1e-6)?;
    // The two halves together are the SAME sequence the plain pass produced,
    // so the two hidden states can be compared position by position.
    let h_cached = concatenate(&[h_head, h_tail], 1)?;

    // The next-token logits of all three.
    let logits_plain = last_logits(&h_plain, &lm_head)?;
    let logits_hooked = last_logits(&h_hooked, &lm_head)?;
    let logits_cached = last_logits(&h_cached, &lm_head)?;

    let (h_abs, h_rel) = max_diff(&h_plain, &h_cached)?;
    let (l_abs, l_rel) = max_diff(&logits_plain, &logits_cached)?;
    let next_plain = argmax_token(&logits_plain)?;
    let next_cached = argmax_token(&logits_cached)?;
    let next_hooked = argmax_token(&logits_hooked)?;
    let (h_abs_hooked, _) = max_diff(&h_hooked, &h_cached)?;
    let (l_abs_hooked, _) = max_diff(&logits_hooked, &logits_cached)?;

    Ok(CacheParity {
        prompt_tokens: ids.len(),
        split,
        h_final_max_abs_diff: h_abs,
        h_final_max_rel_diff: h_rel,
        logits_max_abs_diff: l_abs,
        logits_max_rel_diff: l_rel,
        next_token_uncached: next_plain,
        next_token_cached: next_cached,
        next_token_match: next_plain == next_cached,
        h_final_max_abs_diff_vs_hooked: h_abs_hooked,
        logits_max_abs_diff_vs_hooked: l_abs_hooked,
        next_token_hooked: next_hooked,
        next_token_hooked_match: next_hooked == next_cached,
        hooked_clamped_in_place: hooked_clamped,
        hooked_harm_cosine: hooked_harm,
    })
}

/// The next-token logits of a final hidden state.
fn last_logits(h_final: &Array, lm_head: &Array) -> Result<Array> {
    let seq = h_final.shape()[1];
    let last = h_final.index((0, seq - 1, ..)).expand_dims(0)?;
    let w_t = transpose_axes(lm_head, &[1, 0])?;
    Ok(matmul(&last, &w_t)?)
}

/// The greedy argmax of a logit vector.
fn argmax_token(logits: &Array) -> Result<u32> {
    let idx = argmax(logits, Some(false))?.as_type::<i32>()?;
    idx.eval()?;
    Ok(idx.item_exact::<i32>().max(0) as u32)
}

/// The largest absolute and relative difference between two arrays.
fn max_diff(a: &Array, b: &Array) -> Result<(f32, f32)> {
    let a = a.as_type::<f32>()?;
    let b = b.as_type::<f32>()?;
    a.eval()?;
    b.eval()?;
    let sa = a.as_slice::<f32>();
    let sb = b.as_slice::<f32>();
    let mut max_abs = 0f32;
    let mut max_rel = 0f32;
    for i in 0..sa.len().min(sb.len()) {
        let diff = (sa[i] - sb[i]).abs();
        if diff > max_abs {
            max_abs = diff;
        }
        let scale = sa[i].abs().max(sb[i].abs()).max(1e-6);
        let rel = diff / scale;
        if rel > max_rel {
            max_rel = rel;
        }
    }
    Ok((max_abs, max_rel))
}
