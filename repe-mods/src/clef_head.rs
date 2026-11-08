use anyhow::{Context, Result};
use mlx_rs::{
    Array,
    ops::{indexing::IndexOp, *},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClefQuestion {
    Noul { id: String, query: String },
    Choice { id: String, query: String, options: Vec<String> },
    Score { id: String, query: String, levels: Vec<String> },
}

/// The canonical answer set for a boolean (`noul`) question.
pub const NOUL_OPTIONS: [&str; 2] = ["true", "false"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClefDecision {
    pub id: String,
    pub pick: String,
    pub weighted_score: Option<f32>,
    pub confidence: f32,
    pub distribution: Vec<(String, f32)>,
}

/// The joint schema head of a Clef / Clef-Flash checkpoint.
///
/// The upstream checkpoint stores its projections with the PyTorch `Linear`
/// layout (`[out, in]`). When the full `JointSchemaHead` (`evidence_layers`,
/// `layers`, `residual_scorer.0`, `residual_scorer.3`, `prior_logit_scale`,
/// `joint_logit_scale`, `residual_gate`) is present in `joint_head.safetensors`,
/// `joint_head` holds the full module and `evaluate` runs the complete routing
/// and decoder pipeline.
#[derive(Clone)]
pub struct ClefSchemaHead {
    pub w_q_option: Array,   // [d_model, d_head]
    pub w_k_state: Array,    // [d_model, d_head]
    pub w_v_state: Array,    // [d_model, d_head]
    pub w_score_proj: Array, // [d_head, 1]
    pub temperature: f32,
    pub scale: f32,
    /// True when the weights came from a trained joint head. A mock head
    /// cannot judge anything, so the guard treats its answers as advisory.
    pub calibrated: bool,
    /// Full upstream `JointSchemaHead` when loaded from a Clef / Clef-Flash checkpoint.
    pub joint_head: Option<crate::joint_head::JointSchemaHead>,
}

impl ClefSchemaHead {
    /// Loads `joint_head.safetensors` from a Clef / Clef-Flash checkpoint directory.
    ///
    /// Two schemas are accepted:
    ///   * the upstream Cloudflare `JointSchemaHead` layout (loaded with full
    ///     `EvidenceRoutingLayer`s, `TransformerDecoderLayer`s, and 2-layer
    ///     `residual_scorer` when `hidden_norm.weight` is present), and
    ///   * a project-local export that already uses the `clef_head.*` keys.
    pub fn load_safetensors(path: impl AsRef<Path>, d_head: usize, temperature: f32) -> Result<Self> {
        let tensors: HashMap<String, Array> = Array::load_safetensors(path.as_ref())
            .with_context(|| format!("Failed to load Clef head from {:?}", path.as_ref()))?;

        let get = |key: &str| -> Option<Array> { tensors.get(key).cloned() };

        // Prefer the project-local export when it exists.
        if let Some(w) = get("clef_head.w_q_option") {
            let w_k = get("clef_head.w_k_state").context("Missing `clef_head.w_k_state`")?;
            let w_v = get("clef_head.w_v_state").context("Missing `clef_head.w_v_state`")?;
            let w_s = get("clef_head.w_score_proj").context("Missing `clef_head.w_score_proj`")?;
            return Ok(Self {
                w_q_option: w.as_type::<f32>()?,
                w_k_state: w_k.as_type::<f32>()?,
                w_v_state: w_v.as_type::<f32>()?,
                w_score_proj: w_s.as_type::<f32>()?,
                temperature,
                scale: 1.0 / (d_head as f32).sqrt(),
                calibrated: true,
                joint_head: None,
            });
        }

        let joint_head = if tensors.contains_key("hidden_norm.weight") {
            crate::joint_head::JointSchemaHead::load_safetensors(path.as_ref()).ok()
        } else {
            None
        };

        // Upstream Clef joint head.
        let question_projection = get("question_projection.weight")
            .context("Missing `question_projection.weight` in the Clef joint head")?;
        let memory_projection = get("memory_projection.weight")
            .context("Missing `memory_projection.weight` in the Clef joint head")?;
        let global_projection = get("global_projection.weight")
            .context("Missing `global_projection.weight` in the Clef joint head")?;
        let residual_scorer = get("residual_scorer.3.weight")
            .context("Missing `residual_scorer.3.weight` in the Clef joint head")?;

        Ok(Self {
            // PyTorch Linear stores [out, in]; this struct wants [d_model, d_head].
            w_q_option: transpose_axes(&question_projection.as_type::<f32>()?, &[1, 0])?,
            w_k_state: transpose_axes(&memory_projection.as_type::<f32>()?, &[1, 0])?,
            w_v_state: transpose_axes(&global_projection.as_type::<f32>()?, &[1, 0])?,
            // `residual_scorer.3.weight` is [1, width]; the scorer wants [width, 1].
            w_score_proj: transpose_axes(&residual_scorer.as_type::<f32>()?, &[1, 0])?,
            temperature,
            scale: 1.0 / (d_head as f32).sqrt(),
            calibrated: true,
            joint_head,
        })
    }

    /// Evaluates all typed Clef questions in a single non-autoregressive pass over `h_final` [1, seq_len, d_model].
    ///
    /// `option_embeddings[i]` is the option matrix for question `i` — one row per answer the
    /// question may take (`["true", "false"]` for `noul`, the declared `options` for `choice`,
    /// the declared `levels` for `score`) — shaped `[n_options, d_model]`.
    pub fn evaluate(
        &self,
        h_final: &Array,
        questions: &[ClefQuestion],
        option_embeddings: &[Array],
    ) -> Result<Vec<ClefDecision>> {
        if let Some(jh) = &self.joint_head {
            let q_types: Vec<i32> = questions
                .iter()
                .map(|q| match q {
                    ClefQuestion::Noul { .. } => 0,
                    ClefQuestion::Choice { .. } => 1,
                    ClefQuestion::Score { .. } => 2,
                })
                .collect();
            let raw_logits = jh.forward_hidden_options(h_final, &q_types, option_embeddings)?;
            let mut out = Vec::with_capacity(questions.len());
            for (q, logits) in questions.iter().zip(raw_logits.into_iter()) {
                let logits = divide(&logits, &Array::from_f32(self.temperature.max(1e-3)))?;
                let probs_arr = softmax_axes(&logits, &[-1], None)?;
                probs_arr.eval()?;
                let probs: Vec<f32> = probs_arr.as_slice::<f32>().to_vec();
                out.push(Self::decision_from_probs(q, &probs));
            }
            return Ok(out);
        }

        let h_seq = h_final.index((0, .., ..)).as_type::<f32>()?;
        let k_state = matmul(&h_seq, &self.w_k_state)?;
        let v_state = matmul(&h_seq, &self.w_v_state)?;
        let k_t = transpose_axes(&k_state, &[1, 0])?;

        let mut out = Vec::with_capacity(questions.len());

        for (q, opt_emb) in questions.iter().zip(option_embeddings.iter()) {
            // [n_options, d_model] -> [n_options, d_head] -> [n_options, seq_len]
            let q_opt = matmul(&opt_emb.as_type::<f32>()?, &self.w_q_option)?;
            let attn_scores = multiply(&matmul(&q_opt, &k_t)?, &Array::from_f32(self.scale))?;
            let attn_probs = softmax_axes(&attn_scores, &[-1], None)?;
            let routed = matmul(&attn_probs, &v_state)?; // [n_options, d_head]

            // [n_options, d_head] @ [d_head, 1] -> [n_options] -> softmax over the options
            let logits = squeeze_axes(&matmul(&routed, &self.w_score_proj)?, &[-1])?;
            let logits = divide(&logits, &Array::from_f32(self.temperature.max(1e-3)))?;
            let probs_arr = softmax_axes(&logits, &[-1], None)?;
            probs_arr.eval()?;
            let probs: Vec<f32> = probs_arr.as_slice::<f32>().to_vec();

            out.push(Self::decision_from_probs(q, &probs));
        }

        Ok(out)
    }

    fn decision_from_probs(q: &ClefQuestion, probs: &[f32]) -> ClefDecision {
        let best = probs
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(i, p)| (i, *p))
            .unwrap_or((0, 0.0));

        match q {
            ClefQuestion::Noul { id, .. } => {
                let p_true = probs.first().copied().unwrap_or(0.0);
                let p_false = probs.get(1).copied().unwrap_or(1.0 - p_true);
                ClefDecision {
                    id: id.clone(),
                    pick: if p_true >= p_false { "true".into() } else { "false".into() },
                    weighted_score: Some(p_true),
                    confidence: p_true.max(p_false),
                    distribution: vec![("true".into(), p_true), ("false".into(), p_false)],
                }
            }
            ClefQuestion::Choice { id, options, .. } => {
                let pick = options
                    .get(best.0)
                    .cloned()
                    .unwrap_or_else(|| "none".to_string());
                ClefDecision {
                    id: id.clone(),
                    pick,
                    weighted_score: None,
                    confidence: best.1,
                    distribution: options
                        .iter()
                        .cloned()
                        .zip(probs.iter().copied())
                        .collect(),
                }
            }
            ClefQuestion::Score { id, levels, .. } => {
                let weighted_idx: f32 = probs
                    .iter()
                    .enumerate()
                    .map(|(i, &p)| (i as f32) * p)
                    .sum();
                let pick = levels
                    .get(best.0)
                    .cloned()
                    .unwrap_or_else(|| "none".to_string());
                ClefDecision {
                    id: id.clone(),
                    pick,
                    weighted_score: Some(weighted_idx),
                    confidence: best.1,
                    distribution: levels
                        .iter()
                        .cloned()
                        .zip(probs.iter().copied())
                        .collect(),
                }
            }
        }
    }
}
