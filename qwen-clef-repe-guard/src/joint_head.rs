//! Rust port of the Clef "joint schema" head.
//!
//! This mirrors `EvidenceRoutingLayer` and `JointSchemaHead` from the upstream
//! `joint_schema_model.py` (Cloudflare/Clef-Flash) op-for-op: the same
//! normalisation placement, the same packed `in_proj_weight` split, the same
//! `clamp(max=log(100)).exp()` scale handling, and the same residual gating.
//!
//! The PyTorch module this mirrors is `JointSchemaHead` in
//! `joint_schema_model.py` (see `JointSchemaHead.forward`).

use anyhow::{anyhow, bail, Context, Result};
use mlx_rs::fast::layer_norm;
use mlx_rs::nn::gelu;
use mlx_rs::ops::indexing::{take_axis, TryIndexOp};
use mlx_rs::ops::*;
use mlx_rs::Array;
use std::collections::HashMap;
use std::path::Path;

/// Size of the backbone hidden state the head consumes.
pub const HIDDEN_SIZE: usize = 4096;
/// Internal width of the head.
pub const WIDTH: usize = 1024;
/// Number of attention heads.
pub const HEADS: usize = 16;
/// Per-head dimension (`WIDTH / HEADS`).
pub const HEAD_DIM: usize = WIDTH / HEADS;
/// Feed-forward width.
pub const FEEDFORWARD: usize = 4096;
/// `torch.nn.LayerNorm` default epsilon.
pub const LAYER_NORM_EPS: f32 = 1e-5;
/// Number of question-type embeddings (`noul`, `choice`, `score`).
pub const TYPE_EMBEDDINGS: usize = 3;

/// One encoded question of a record, mirroring `EncodedQuestion`.
#[derive(Debug, Clone)]
pub struct EncodedQuestion {
    pub question_id: String,
    /// 0 = `noul`, 1 = `choice`, 2 = `score`.
    pub question_type: i32,
    /// Token span of the question instructions.
    pub question_span: (usize, usize),
    /// Token spans of each allowed option.
    pub option_spans: Vec<(usize, usize)>,
    pub option_ids: Vec<String>,
}

/// One encoded record, mirroring `EncodedRecord`.
#[derive(Debug, Clone)]
pub struct EncodedRecord {
    pub record_id: String,
    pub questions: Vec<EncodedQuestion>,
}

/// Intermediate tensors captured during a forward pass.
///
/// Only used for parity diagnostics; the production path ignores them.
#[derive(Debug, Default)]
pub struct HeadTrace {
    /// `hidden_norm(hidden_states)` — `[batch, seq, HIDDEN_SIZE]`.
    pub normalized_hidden: Option<Array>,
    /// Per record: `[1, seq, WIDTH]`.
    pub memory: Vec<Array>,
    /// Per record: `[questions, HIDDEN_SIZE]`.
    pub question_vectors: Vec<Array>,
    /// Per record: `[1, options, WIDTH]` (pre-routing option queries).
    pub option_queries: Vec<Array>,
    /// Per record: `[1, options, WIDTH]` (post-routing options).
    pub routed_options: Vec<Array>,
    /// Per record: `[1, questions, WIDTH]` (post `field_norm`).
    pub fields: Vec<Array>,
}

/// Packed `torch.nn.MultiheadAttention` parameters.
#[derive(Debug, Clone)]
struct AttentionWeights {
    /// `in_proj_weight` split into q, k, v chunks, each transposed to `[in, out]`.
    q_weight: Array,
    k_weight: Array,
    v_weight: Array,
    /// `in_proj_bias` split into q, k, v chunks.
    q_bias: Array,
    k_bias: Array,
    v_bias: Array,
    /// `out_proj.weight`, transposed to `[in, out]`.
    out_weight: Array,
    out_bias: Array,
}

/// `EvidenceRoutingLayer` from the upstream module.
#[derive(Debug, Clone)]
struct EvidenceRoutingLayer {
    query_norm_weight: Array,
    query_norm_bias: Array,
    memory_norm_weight: Array,
    memory_norm_bias: Array,
    attention: AttentionWeights,
    feedforward_norm_weight: Array,
    feedforward_norm_bias: Array,
    /// `feedforward.0` — `Linear(width -> feedforward)`.
    ff_in_weight: Array,
    ff_in_bias: Array,
    /// `feedforward.3` — `Linear(feedforward -> width)`.
    ff_out_weight: Array,
    ff_out_bias: Array,
}

/// `torch.nn.TransformerDecoderLayer(norm_first=True)` from the upstream module.
#[derive(Debug, Clone)]
struct TransformerDecoderLayer {
    self_attn: AttentionWeights,
    multihead_attn: AttentionWeights,
    linear1_weight: Array,
    linear1_bias: Array,
    linear2_weight: Array,
    linear2_bias: Array,
    norm1_weight: Array,
    norm1_bias: Array,
    norm2_weight: Array,
    norm2_bias: Array,
    norm3_weight: Array,
    norm3_bias: Array,
}

/// `JointSchemaHead` from the upstream module.
#[derive(Debug, Clone)]
pub struct JointSchemaHead {
    hidden_norm_weight: Array,
    hidden_norm_bias: Array,
    /// `[HIDDEN_SIZE, WIDTH]`.
    memory_projection_weight: Array,
    /// `[HIDDEN_SIZE, WIDTH]`.
    question_projection_weight: Array,
    /// `[HIDDEN_SIZE, WIDTH]`.
    option_question_projection_weight: Array,
    /// `[HIDDEN_SIZE, WIDTH]`.
    global_projection_weight: Array,
    /// `[HIDDEN_SIZE, WIDTH]`.
    option_context_projection_weight: Array,
    /// `[HIDDEN_SIZE, WIDTH]`.
    option_lexical_projection_weight: Array,
    /// `[TYPE_EMBEDDINGS, WIDTH]`.
    type_embedding_weight: Array,
    evidence_layers: Vec<EvidenceRoutingLayer>,
    option_summary_norm_weight: Array,
    option_summary_norm_bias: Array,
    layers: Vec<TransformerDecoderLayer>,
    field_norm_weight: Array,
    field_norm_bias: Array,
    option_norm_weight: Array,
    option_norm_bias: Array,
    /// `residual_scorer.0` — `Linear(WIDTH * 4 -> WIDTH)`, transposed.
    residual_scorer_0_weight: Array,
    residual_scorer_0_bias: Array,
    /// `residual_scorer.3` — `Linear(WIDTH -> 1)`, transposed.
    residual_scorer_3_weight: Array,
    residual_scorer_3_bias: Array,
    prior_logit_scale: f32,
    joint_logit_scale: f32,
    residual_gate: f32,
}

/// Matrix multiplication with full float32 accuracy.
///
/// MLX's Metal GEMM multiplies through `metal::simdgroup_float8x8`, whose
/// product precision on Apple silicon is only ~11 mantissa bits. On this
/// head's 4096-long projections that costs ~5e-3 absolute error, far above
/// the float32 noise PyTorch shows (~6e-6).
///
/// Reducing the products with element-wise ops instead keeps the same
/// mathematical result but the reduction is done in float32 by MLX's fused
/// reduce kernel, which is ~3000x more accurate and, because MLX fuses the
/// multiply into the reduction, the same speed as the GEMM.
fn matmul_accurate(a: &Array, b: &Array) -> Result<Array> {
    if a.ndim() < 1 || b.ndim() < 1 {
        bail!(
            "matmul_accurate expects arrays with at least one dimension, got {} and {}",
            a.ndim(),
            b.ndim()
        );
    }
    // numpy/PyTorch matmul semantics: a 1-D `a` is a row vector, a 1-D `b` is a
    // column vector, and the corresponding singleton axis is dropped again.
    let a_is_vector = a.ndim() == 1;
    let b_is_vector = b.ndim() == 1;
    let a = if a_is_vector { expand_dims(a, 0)? } else { a.clone() };
    let b = if b_is_vector { expand_dims(b, 1)? } else { b.clone() };
    let a_expanded = expand_dims_axes(&a, &[a.ndim() as i32])?;
    let b_expanded = expand_dims_axes(&b, &[b.ndim() as i32 - 2])?;
    let product = multiply(&a_expanded, &b_expanded)?;
    let mut out = sum_axes(&product, &[-2], false)?;
    if a_is_vector {
        out = squeeze_axes(&out, &[0])?;
    }
    if b_is_vector {
        out = squeeze_axes(&out, &[-1])?;
    }
    Ok(out)
}

/// `torch.nn.Linear` forward: `x @ W^T + b`, with `W` in PyTorch's `[out, in]` layout.
fn linear(x: &Array, weight: &Array, bias: Option<&Array>) -> Result<Array> {
    let y = matmul_accurate(x, weight)?;
    match bias {
        Some(b) => Ok(add(&y, b)?),
        None => Ok(y),
    }
}

/// `torch.nn.LayerNorm` — biased variance, `eps = 1e-5`, normalising the last axis.
fn layer_norm_op(x: &Array, weight: &Array, bias: &Array) -> Result<Array> {
    Ok(layer_norm(x, Some(weight), Some(bias), LAYER_NORM_EPS)?)
}

/// Transposes a PyTorch `[out, in]` linear weight into a contiguous `[in, out]` matrix.
fn transpose_weight(weight: &Array) -> Result<Array> {
    Ok(transpose_axes(weight, &[1, 0])?.contiguous()?)
}

/// Splits `[1, len, WIDTH]` into per-head `[1, heads, len, head_dim]` tensors.
fn split_heads(x: &Array) -> Result<Array> {
    let shape = x.shape();
    let (batch, len) = (shape[0], shape[1]);
    let x = reshape(x, &[batch, len, HEADS as i32, HEAD_DIM as i32])?;
    Ok(transpose_axes(&x, &[0, 2, 1, 3])?)
}

/// `F.multi_head_attention_forward` with PyTorch's packed `in_proj_weight`.
///
/// `query`, `key` and `value` are `[1, len, WIDTH]`. The packed projection is
/// split into q, k, v chunks along dim 0, exactly as PyTorch's
/// `_in_projection_packed` does.
fn multi_head_attention(
    query: &Array,
    key: &Array,
    value: &Array,
    weights: &AttentionWeights,
) -> Result<Array> {
    let q = linear(query, &weights.q_weight, Some(&weights.q_bias))?;
    let k = linear(key, &weights.k_weight, Some(&weights.k_bias))?;
    let v = linear(value, &weights.v_weight, Some(&weights.v_bias))?;

    let q = split_heads(&q)?;
    let k = split_heads(&k)?;
    let v = split_heads(&v)?;

    // PyTorch scales q by `sqrt(1 / head_dim)` before the `q @ k^T` product.
    let scale = (1.0f32 / HEAD_DIM as f32).sqrt();
    let q = multiply(&q, &Array::from_f32(scale))?;
    let scores = matmul_accurate(&q, &transpose_axes(&k, &[0, 1, 3, 2])?)?;
    let probs = softmax_axes(&scores, &[-1], true)?;
    let context = matmul_accurate(&probs, &v)?;

    // `[1, heads, len, head_dim]` -> `[1, len, WIDTH]`.
    let query_len = query.shape()[1];
    let context = transpose_axes(&context, &[0, 2, 1, 3])?;
    let context = reshape(&context, &[1, query_len, WIDTH as i32])?;

    Ok(linear(&context, &weights.out_weight, Some(&weights.out_bias))?)
}

impl EvidenceRoutingLayer {
    fn forward(&self, queries: &Array, memory: &Array) -> Result<Array> {
        let normalized_queries =
            layer_norm_op(queries, &self.query_norm_weight, &self.query_norm_bias)?;
        let normalized_memory =
            layer_norm_op(memory, &self.memory_norm_weight, &self.memory_norm_bias)?;
        let routed = multi_head_attention(
            &normalized_queries,
            &normalized_memory,
            &normalized_memory,
            &self.attention,
        )?;
        let queries = add(queries, &routed)?;
        let feedforward =
            layer_norm_op(&queries, &self.feedforward_norm_weight, &self.feedforward_norm_bias)?;
        let feedforward = linear(&feedforward, &self.ff_in_weight, Some(&self.ff_in_bias))?;
        let feedforward = gelu(&feedforward)?;
        let feedforward = linear(&feedforward, &self.ff_out_weight, Some(&self.ff_out_bias))?;
        Ok(add(&queries, &feedforward)?)
    }
}

impl TransformerDecoderLayer {
    /// `norm_first=True` ordering, matching `TransformerDecoderLayer.forward`.
    fn forward(&self, tgt: &Array, memory: &Array) -> Result<Array> {
        let norm1 = layer_norm_op(tgt, &self.norm1_weight, &self.norm1_bias)?;
        let self_attn = multi_head_attention(&norm1, &norm1, &norm1, &self.self_attn)?;
        let x = add(tgt, &self_attn)?;

        let norm2 = layer_norm_op(&x, &self.norm2_weight, &self.norm2_bias)?;
        let cross_attn = multi_head_attention(&norm2, memory, memory, &self.multihead_attn)?;
        let x = add(&x, &cross_attn)?;

        let norm3 = layer_norm_op(&x, &self.norm3_weight, &self.norm3_bias)?;
        let feedforward = linear(&norm3, &self.linear1_weight, Some(&self.linear1_bias))?;
        let feedforward = gelu(&feedforward)?;
        let feedforward = linear(&feedforward, &self.linear2_weight, Some(&self.linear2_bias))?;
        Ok(add(&x, &feedforward)?)
    }
}

/// `functional.normalize(x, dim=-1)`: `x / max(||x||_2, 1e-12)`.
///
/// PyTorch keeps the reduced axis (`keepdim=True`) so the norm broadcasts.
fn normalize(x: &Array) -> Result<Array> {
    let squared = multiply(x, x)?;
    let norm = sqrt(&sum_axes(&squared, &[-1], true)?)?;
    let norm = maximum(&norm, &Array::from_f32(1e-12))?;
    Ok(divide(x, &norm)?)
}

/// `functional.cosine_similarity(a, b, dim=-1)` as implemented by
/// `torch.cosine_similarity`: `dot / (max(||a||, eps) * max(||b||, eps))` with
/// `eps = 1e-8`.
fn cosine_similarity(a: &Array, b: &Array) -> Result<Array> {
    let dot = sum_axes(&multiply(a, b)?, &[-1], false)?;
    let a_norm = sqrt(&sum_axes(&multiply(a, a)?, &[-1], false)?)?;
    let b_norm = sqrt(&sum_axes(&multiply(b, b)?, &[-1], false)?)?;
    let a_norm = maximum(&a_norm, &Array::from_f32(1e-8))?;
    let b_norm = maximum(&b_norm, &Array::from_f32(1e-8))?;
    Ok(divide(&dot, &multiply(&a_norm, &b_norm)?)?)
}

/// Mean of `values[start..end]` over dim 0, matching `JointSchemaHead._mean_span`.
fn mean_span(values: &Array, span: (usize, usize)) -> Result<Array> {
    let (start, end) = span;
    if end <= start {
        bail!("empty span ({start}, {end})");
    }
    let slice = values.try_index((start as i32..end as i32, ..))?;
    Ok(mean_axes(&slice, &[0], false)?)
}

/// Fails unless `array` has exactly the expected shape.
fn expect_shape(name: &str, array: &Array, expected: &[i32]) -> Result<()> {
    if array.shape() != expected {
        bail!("tensor `{name}` has shape {:?}, expected {expected:?}", array.shape());
    }
    Ok(())
}

/// Number of leading `evidence_layers.{index}.` / `layers.{index}.` entries.
fn count_indexed_layers(tensors: &HashMap<String, Array>, prefix: &str) -> usize {
    tensors
        .keys()
        .filter_map(|key| {
            key.strip_prefix(prefix)
                .and_then(|rest| rest.split('.').next())
                .and_then(|index| index.parse::<usize>().ok())
        })
        .max()
        .map(|last| last + 1)
        .unwrap_or(0)
}

impl JointSchemaHead {
    /// Loads the head from an upstream `joint_head.safetensors` file.
    pub fn load_safetensors(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let tensors: HashMap<String, Array> = Array::load_safetensors(path)
            .with_context(|| format!("failed to load joint head from {path:?}"))?;

        let get = |key: &str| -> Result<Array> {
            let raw = tensors
                .get(key)
                .ok_or_else(|| anyhow!("joint head is missing tensor `{key}`"))?;
            raw.as_type::<f32>()
                .with_context(|| format!("failed to cast tensor `{key}` to f32"))
        };
        let scalar = |key: &str| -> Result<f32> {
            let raw = tensors
                .get(key)
                .ok_or_else(|| anyhow!("joint head is missing tensor `{key}`"))?;
            let value = raw.as_type::<f32>()?;
            let values = value
                .to_vec_exact::<f32>()
                .with_context(|| format!("failed to read scalar tensor `{key}`"))?;
            values
                .first()
                .copied()
                .ok_or_else(|| anyhow!("tensor `{key}` is empty"))
        };
        // A PyTorch `[out, in]` linear weight becomes a contiguous `[in, out]` matrix.
        let linear_weight = |key: &str| -> Result<Array> { transpose_weight(&get(key)?) };

        let attention = |prefix: &str| -> Result<AttentionWeights> {
            let weight = get(&format!("{prefix}.in_proj_weight"))?;
            let parts = weight.split_at_indices(&[WIDTH as i32, (2 * WIDTH) as i32], 0)?;
            let bias = get(&format!("{prefix}.in_proj_bias"))?;
            let bias_parts = bias.split_at_indices(&[WIDTH as i32, (2 * WIDTH) as i32], 0)?;
            Ok(AttentionWeights {
                q_weight: transpose_weight(&parts[0])?,
                k_weight: transpose_weight(&parts[1])?,
                v_weight: transpose_weight(&parts[2])?,
                q_bias: bias_parts[0].clone(),
                k_bias: bias_parts[1].clone(),
                v_bias: bias_parts[2].clone(),
                out_weight: linear_weight(&format!("{prefix}.out_proj.weight"))?,
                out_bias: get(&format!("{prefix}.out_proj.bias"))?,
            })
        };

        let mut evidence_layers = Vec::new();
        for index in 0..count_indexed_layers(&tensors, "evidence_layers.") {
            let prefix = format!("evidence_layers.{index}");
            let ff_in_weight = linear_weight(&format!("{prefix}.feedforward.0.weight"))?;
            let ff_out_weight = linear_weight(&format!("{prefix}.feedforward.3.weight"))?;
            // `feedforward.0` is Linear(width -> feedforward) and `feedforward.3`
            // is Linear(feedforward -> width); both are stored transposed here.
            expect_shape(
                &format!("{prefix}.feedforward.0.weight"),
                &ff_in_weight,
                &[WIDTH as i32, FEEDFORWARD as i32],
            )?;
            expect_shape(
                &format!("{prefix}.feedforward.3.weight"),
                &ff_out_weight,
                &[FEEDFORWARD as i32, WIDTH as i32],
            )?;
            evidence_layers.push(EvidenceRoutingLayer {
                query_norm_weight: get(&format!("{prefix}.query_norm.weight"))?,
                query_norm_bias: get(&format!("{prefix}.query_norm.bias"))?,
                memory_norm_weight: get(&format!("{prefix}.memory_norm.weight"))?,
                memory_norm_bias: get(&format!("{prefix}.memory_norm.bias"))?,
                attention: attention(&format!("{prefix}.attention"))?,
                feedforward_norm_weight: get(&format!("{prefix}.feedforward_norm.weight"))?,
                feedforward_norm_bias: get(&format!("{prefix}.feedforward_norm.bias"))?,
                ff_in_weight,
                ff_in_bias: get(&format!("{prefix}.feedforward.0.bias"))?,
                ff_out_weight,
                ff_out_bias: get(&format!("{prefix}.feedforward.3.bias"))?,
            });
        }

        let mut layers = Vec::new();
        for index in 0..count_indexed_layers(&tensors, "layers.") {
            let prefix = format!("layers.{index}");
            let linear1_weight = linear_weight(&format!("{prefix}.linear1.weight"))?;
            let linear2_weight = linear_weight(&format!("{prefix}.linear2.weight"))?;
            expect_shape(
                &format!("{prefix}.linear1.weight"),
                &linear1_weight,
                &[WIDTH as i32, FEEDFORWARD as i32],
            )?;
            expect_shape(
                &format!("{prefix}.linear2.weight"),
                &linear2_weight,
                &[FEEDFORWARD as i32, WIDTH as i32],
            )?;
            layers.push(TransformerDecoderLayer {
                self_attn: attention(&format!("{prefix}.self_attn"))?,
                multihead_attn: attention(&format!("{prefix}.multihead_attn"))?,
                linear1_weight,
                linear1_bias: get(&format!("{prefix}.linear1.bias"))?,
                linear2_weight,
                linear2_bias: get(&format!("{prefix}.linear2.bias"))?,
                norm1_weight: get(&format!("{prefix}.norm1.weight"))?,
                norm1_bias: get(&format!("{prefix}.norm1.bias"))?,
                norm2_weight: get(&format!("{prefix}.norm2.weight"))?,
                norm2_bias: get(&format!("{prefix}.norm2.bias"))?,
                norm3_weight: get(&format!("{prefix}.norm3.weight"))?,
                norm3_bias: get(&format!("{prefix}.norm3.bias"))?,
            });
        }

        Ok(Self {
            hidden_norm_weight: get("hidden_norm.weight")?,
            hidden_norm_bias: get("hidden_norm.bias")?,
            memory_projection_weight: linear_weight("memory_projection.weight")?,
            question_projection_weight: linear_weight("question_projection.weight")?,
            option_question_projection_weight: linear_weight(
                "option_question_projection.weight",
            )?,
            global_projection_weight: linear_weight("global_projection.weight")?,
            option_context_projection_weight: linear_weight("option_context_projection.weight")?,
            option_lexical_projection_weight: linear_weight("option_lexical_projection.weight")?,
            type_embedding_weight: get("type_embedding.weight")?,
            evidence_layers,
            option_summary_norm_weight: get("option_summary_norm.weight")?,
            option_summary_norm_bias: get("option_summary_norm.bias")?,
            layers,
            field_norm_weight: get("field_norm.weight")?,
            field_norm_bias: get("field_norm.bias")?,
            option_norm_weight: get("option_norm.weight")?,
            option_norm_bias: get("option_norm.bias")?,
            residual_scorer_0_weight: linear_weight("residual_scorer.0.weight")?,
            residual_scorer_0_bias: get("residual_scorer.0.bias")?,
            residual_scorer_3_weight: linear_weight("residual_scorer.3.weight")?,
            residual_scorer_3_bias: get("residual_scorer.3.bias")?,
            prior_logit_scale: scalar("prior_logit_scale")?,
            joint_logit_scale: scalar("joint_logit_scale")?,
            residual_gate: scalar("residual_gate")?,
        })
    }

    /// Runs the head, returning one logit vector per question of every record.
    pub fn forward(
        &self,
        hidden_states: &Array,
        input_ids: &Array,
        attention_mask: &Array,
        records: &[EncodedRecord],
        output_embedding_weight: &Array,
    ) -> Result<Vec<Vec<Array>>> {
        Ok(self
            .forward_traced(
                hidden_states,
                input_ids,
                attention_mask,
                records,
                output_embedding_weight,
            )?
            .0)
    }

    /// Runs the head and also captures intermediate tensors for parity checks.
    pub fn forward_traced(
        &self,
        hidden_states: &Array,
        input_ids: &Array,
        attention_mask: &Array,
        records: &[EncodedRecord],
        output_embedding_weight: &Array,
    ) -> Result<(Vec<Vec<Array>>, HeadTrace)> {
        let mut trace = HeadTrace::default();
        let mut results: Vec<Vec<Array>> = Vec::with_capacity(records.len());

        let normalized_hidden =
            layer_norm_op(hidden_states, &self.hidden_norm_weight, &self.hidden_norm_bias)?;
        trace.normalized_hidden = Some(normalized_hidden.clone());

        if hidden_states.ndim() != 3 || hidden_states.shape()[2] as usize != HIDDEN_SIZE {
            bail!(
                "hidden states must be [batch, seq, {HIDDEN_SIZE}], got {:?}",
                hidden_states.shape()
            );
        }
        let batch_size = hidden_states.shape()[0] as usize;
        let seq_len = hidden_states.shape()[1] as usize;
        let mask = attention_mask
            .to_vec_cast::<i32>()
            .context("attention_mask must be an integer array")?;
        let tokens = input_ids
            .to_vec_cast::<i32>()
            .context("input_ids must be an integer array")?;
        if mask.len() != batch_size * seq_len {
            bail!(
                "attention_mask has {} entries, expected {}",
                mask.len(),
                batch_size * seq_len
            );
        }
        if tokens.len() != batch_size * seq_len {
            bail!(
                "input_ids has {} entries, expected {}",
                tokens.len(),
                batch_size * seq_len
            );
        }

        for (batch_index, record) in records.iter().enumerate() {
            if batch_index >= batch_size {
                bail!("record {batch_index} exceeds batch size {batch_size}");
            }
            let row = &mask[batch_index * seq_len..(batch_index + 1) * seq_len];
            let sequence_length: usize = row.iter().map(|&value| value.max(0) as usize).sum();
            if sequence_length == 0 {
                bail!("record `{}` has an empty attention mask", record.record_id);
            }
            for question in &record.questions {
                if question.question_type < 0
                    || question.question_type as usize >= TYPE_EMBEDDINGS
                {
                    bail!(
                        "question `{}` has type {} outside 0..{TYPE_EMBEDDINGS}",
                        question.question_id,
                        question.question_type
                    );
                }
                if question.option_ids.len() != question.option_spans.len() {
                    bail!(
                        "question `{}` has {} option ids but {} option spans",
                        question.question_id,
                        question.option_ids.len(),
                        question.option_spans.len()
                    );
                }
                let spans = std::iter::once(&question.question_span).chain(&question.option_spans);
                for span in spans {
                    if span.1 > sequence_length || span.0 >= span.1 {
                        bail!(
                            "question `{}` has span {span:?} outside the {} token record",
                            question.question_id,
                            sequence_length
                        );
                    }
                }
            }

            let sequence_hidden =
                normalized_hidden.try_index((batch_index as i32, 0..sequence_length as i32, ..))?;
            let memory = linear(&sequence_hidden, &self.memory_projection_weight, None)?;
            let memory = expand_dims(&memory, 0)?;
            trace.memory.push(memory.clone());

            let global_vector = sequence_hidden.try_index(((sequence_length - 1) as i32, ..))?;

            let question_vectors = stack(
                &record
                    .questions
                    .iter()
                    .map(|question| mean_span(&sequence_hidden, question.question_span))
                    .collect::<Result<Vec<_>>>()?
                    .as_slice(),
                0,
            )?;
            trace.question_vectors.push(question_vectors.clone());

            let type_ids = Array::from_slice(
                &record
                    .questions
                    .iter()
                    .map(|question| question.question_type)
                    .collect::<Vec<_>>(),
                &[record.questions.len() as i32],
            );

            // Per-question option context and lexical vectors.
            let mut context_vectors: Vec<Array> = Vec::new();
            let mut lexical_vectors: Vec<Array> = Vec::new();
            let mut option_counts: Vec<usize> = Vec::new();
            for question in &record.questions {
                let contexts = stack(
                    &question
                        .option_spans
                        .iter()
                        .map(|span| mean_span(&sequence_hidden, *span))
                        .collect::<Result<Vec<_>>>()?
                        .as_slice(),
                    0,
                )?;
                let mut rows: Vec<Array> = Vec::new();
                for &(start, end) in &question.option_spans {
                    let base = batch_index * seq_len;
                    let ids = Array::from_slice(
                        &tokens[base + start..base + end],
                        &[(end - start) as i32],
                    );
                    let embedding = take_axis(output_embedding_weight, &ids, 0)?;
                    rows.push(mean_axes(&embedding, &[0], false)?);
                }
                let lexical = stack(&rows, 0)?;
                context_vectors.push(contexts);
                lexical_vectors.push(lexical);
                option_counts.push(question.option_spans.len());
            }

            // Option queries: option context + option lexical + question vector.
            let mut option_queries: Vec<Array> = Vec::new();
            for (index, (contexts, lexical)) in context_vectors
                .iter()
                .zip(lexical_vectors.iter())
                .enumerate()
            {
                let context_projected =
                    linear(contexts, &self.option_context_projection_weight, None)?;
                let lexical_projected =
                    linear(lexical, &self.option_lexical_projection_weight, None)?;
                let question_projected = linear(
                    &question_vectors.try_index((index as i32, ..))?,
                    &self.option_question_projection_weight,
                    None,
                )?;
                let question_projected = expand_dims(&question_projected, 0)?;
                option_queries.push(add(
                    &add(&context_projected, &lexical_projected)?,
                    &question_projected,
                )?);
            }

            // `torch.cat(option_queries, dim=0)` — options of different questions
            // have different counts, so this is a concatenation, not a stack.
            let mut routed_options = concatenate(&option_queries, 0)?;
            routed_options = expand_dims(&routed_options, 0)?;
            trace.option_queries.push(routed_options.clone());

            for layer in &self.evidence_layers {
                routed_options = layer.forward(&routed_options, &memory)?;
            }
            trace.routed_options.push(routed_options.clone());
            let routed_options = routed_options.try_index((0, ..))?;

            // Split the routed options back per question (`torch.split`).
            let mut split_points: Vec<i32> = Vec::new();
            let mut running = 0i32;
            for count in &option_counts[..option_counts.len().saturating_sub(1)] {
                running += *count as i32;
                split_points.push(running);
            }
            let split_options = routed_options.split_at_indices(&split_points, 0)?;

            let base_fields = linear(&question_vectors, &self.question_projection_weight, None)?;

            let mut option_summaries: Vec<Array> = Vec::new();
            for (index, options) in split_options.iter().enumerate() {
                let field = base_fields.try_index((index as i32, ..))?;
                let scores = matmul_accurate(options, &field)?;
                let scores = divide(&scores, &Array::from_f32((WIDTH as f32).sqrt()))?;
                let routing_weights = softmax_axes(&scores, &[0], true)?;
                let routing_weights = reshape(&routing_weights, &[options.shape()[0], 1])?;
                let summary = sum_axes(&multiply(&routing_weights, options)?, &[0], false)?;
                option_summaries.push(summary);
            }
            let option_summary = stack(&option_summaries, 0)?;
            let option_summary = layer_norm_op(
                &option_summary,
                &self.option_summary_norm_weight,
                &self.option_summary_norm_bias,
            )?;

            let global_projected = linear(&global_vector, &self.global_projection_weight, None)?;
            let global_projected = expand_dims(&global_projected, 0)?;
            let type_embeddings = take_axis(&self.type_embedding_weight, &type_ids, 0)?;

            let mut fields = add(&base_fields, &option_summary)?;
            fields = add(&fields, &global_projected)?;
            fields = add(&fields, &type_embeddings)?;
            let mut fields = expand_dims(&fields, 0)?;

            for layer in &self.layers {
                fields = layer.forward(&fields, &memory)?;
            }
            let fields = layer_norm_op(&fields, &self.field_norm_weight, &self.field_norm_bias)?;
            trace.fields.push(fields.clone());
            let fields = fields.try_index((0, ..))?;

            // `prior_logit_scale.clamp(max=log(100)).exp()` and friends.
            let prior_scale = Array::from_f32(self.prior_logit_scale.min(100f32.ln()).exp());
            let joint_scale = Array::from_f32(self.joint_logit_scale.min(100f32.ln()).exp());
            let gate = sigmoid(&Array::from_f32(self.residual_gate))?;

            let mut record_logits: Vec<Array> = Vec::new();
            for index in 0..record.questions.len() {
                let field = fields.try_index((index as i32, ..))?;
                let lexical = &lexical_vectors[index];
                let routed = &split_options[index];

                let anchor_source = add(
                    &question_vectors.try_index((index as i32, ..))?,
                    &global_vector,
                )?;
                let anchor = normalize(&anchor_source)?;
                let lexical_anchor = normalize(lexical)?;

                let prior = multiply(&prior_scale, &matmul_accurate(&lexical_anchor, &anchor)?)?;

                let options =
                    layer_norm_op(routed, &self.option_norm_weight, &self.option_norm_bias)?;
                let repeated_field = broadcast_to(&expand_dims(&field, 0)?, options.shape())?;
                let cosine = cosine_similarity(&repeated_field, &options)?;

                let product = multiply(&repeated_field, &options)?;
                let difference = abs(&subtract(&repeated_field, &options)?)?;
                let features = concatenate(&[&repeated_field, &options, &product, &difference], -1)?;
                let residual = linear(
                    &features,
                    &self.residual_scorer_0_weight,
                    Some(&self.residual_scorer_0_bias),
                )?;
                let residual = gelu(&residual)?;
                let residual = linear(
                    &residual,
                    &self.residual_scorer_3_weight,
                    Some(&self.residual_scorer_3_bias),
                )?;
                let residual = squeeze_axes(&residual, &[-1])?;

                let joint = add(&multiply(&joint_scale, &cosine)?, &residual)?;
                let logit = add(&prior, &multiply(&gate, &joint)?)?;
                record_logits.push(logit);
            }
            results.push(record_logits);
        }

        Ok((results, trace))
    }

    /// Input hidden dimension expected by `hidden_norm` (`4096` on Clef-Flash).
    #[allow(dead_code)]
    pub fn hidden_size(&self) -> usize {
        self.hidden_norm_weight
            .shape()
            .first()
            .copied()
            .unwrap_or(HIDDEN_SIZE as i32) as usize
    }

    /// Adapt a `[..., d_in]` tensor to `[..., target_d]` while preserving L2 norm
    /// when a smaller backbone is paired with a wider JointSchemaHead.
    #[allow(dead_code)]
    fn adapt_width(x: &Array, target_d: i32) -> Result<Array> {
        let xf = x.as_type::<f32>()?;
        let d_in = xf.shape().last().copied().unwrap_or(1).max(1);
        if d_in == target_d {
            return Ok(xf);
        }
        if d_in < target_d {
            let reps = ((target_d + d_in - 1) / d_in).max(1);
            let parts: Vec<&Array> = (0..reps).map(|_| &xf).collect();
            let tiled = concatenate(&parts, -1)?;
            let sliced = match tiled.ndim() {
                2 => tiled.try_index((.., 0..target_d))?,
                3 => tiled.try_index((.., .., 0..target_d))?,
                _ => tiled,
            };
            let scale = 1.0f32 / (reps as f32).sqrt();
            return Ok(multiply(&sliced, &Array::from_f32(scale))?);
        }
        let sliced = match xf.ndim() {
            2 => xf.try_index((.., 0..target_d))?,
            3 => xf.try_index((.., .., 0..target_d))?,
            _ => xf,
        };
        Ok(sliced)
    }

    /// Evaluates the full `JointSchemaHead` (`EvidenceRoutingLayer`s,
    /// `TransformerDecoderLayer`s, `option_summary_norm`, `field_norm`,
    /// `option_norm`, and 2-layer GELU `residual_scorer`) directly on the
    /// backbone final hidden state `[1, seq, d_model]` and per-question option
    /// embeddings `[n_options, d_model]`.
    #[allow(dead_code)]
    pub fn forward_hidden_options(
        &self,
        hidden_states: &Array,
        question_types: &[i32],
        option_embeddings: &[Array],
    ) -> Result<Vec<Array>> {
        if question_types.is_empty() || option_embeddings.is_empty() {
            return Ok(Vec::new());
        }
        let head_d = self.hidden_size() as i32;
        let h_adapted = Self::adapt_width(hidden_states, head_d)?;
        let normalized_hidden =
            layer_norm_op(&h_adapted, &self.hidden_norm_weight, &self.hidden_norm_bias)?;
        let seq_len = normalized_hidden.shape()[1] as usize;
        if seq_len == 0 {
            bail!("forward_hidden_options called with empty sequence");
        }

        let sequence_hidden = normalized_hidden.try_index((0, 0..seq_len as i32, ..))?;
        let memory = linear(&sequence_hidden, &self.memory_projection_weight, None)?;
        let memory = expand_dims(&memory, 0)?;
        let global_vector = sequence_hidden.try_index(((seq_len - 1) as i32, ..))?;
        let mean_hidden = mean_axes(&sequence_hidden, &[0], false)?;

        let n_q = question_types.len().min(option_embeddings.len());
        let mut q_vecs: Vec<Array> = Vec::with_capacity(n_q);
        let mut context_vectors: Vec<Array> = Vec::with_capacity(n_q);
        let mut lexical_vectors: Vec<Array> = Vec::with_capacity(n_q);
        let mut option_counts: Vec<usize> = Vec::with_capacity(n_q);

        for qi in 0..n_q {
            let opt_adapted = Self::adapt_width(&option_embeddings[qi], head_d)?;
            let n_opt = opt_adapted.shape()[0].max(1);
            let lexical =
                layer_norm_op(&opt_adapted, &self.hidden_norm_weight, &self.hidden_norm_bias)?;
            let opt_mean = mean_axes(&lexical, &[0], false)?;
            let q_vec = multiply(&add(&mean_hidden, &opt_mean)?, &Array::from_f32(0.5))?;
            let ctx = broadcast_to(&expand_dims(&global_vector, 0)?, &[n_opt, head_d])?;
            q_vecs.push(q_vec);
            context_vectors.push(ctx);
            lexical_vectors.push(lexical);
            option_counts.push(n_opt as usize);
        }

        let question_vectors = stack(&q_vecs, 0)?;
        let type_ids = Array::from_slice(&question_types[..n_q], &[n_q as i32]);

        let mut option_queries: Vec<Array> = Vec::with_capacity(n_q);
        for index in 0..n_q {
            let context_projected = linear(
                &context_vectors[index],
                &self.option_context_projection_weight,
                None,
            )?;
            let lexical_projected = linear(
                &lexical_vectors[index],
                &self.option_lexical_projection_weight,
                None,
            )?;
            let question_projected = linear(
                &question_vectors.try_index((index as i32, ..))?,
                &self.option_question_projection_weight,
                None,
            )?;
            let question_projected = expand_dims(&question_projected, 0)?;
            option_queries.push(add(
                &add(&context_projected, &lexical_projected)?,
                &question_projected,
            )?);
        }

        let mut routed_options = concatenate(&option_queries, 0)?;
        routed_options = expand_dims(&routed_options, 0)?;
        for layer in &self.evidence_layers {
            routed_options = layer.forward(&routed_options, &memory)?;
        }
        let routed_options = routed_options.try_index((0, ..))?;

        let mut split_points: Vec<i32> = Vec::new();
        let mut running = 0i32;
        for count in &option_counts[..option_counts.len().saturating_sub(1)] {
            running += *count as i32;
            split_points.push(running);
        }
        let split_options = if split_points.is_empty() {
            vec![routed_options]
        } else {
            routed_options.split_at_indices(&split_points, 0)?
        };

        let base_fields = linear(&question_vectors, &self.question_projection_weight, None)?;
        let mut option_summaries: Vec<Array> = Vec::with_capacity(n_q);
        for (index, options) in split_options.iter().enumerate() {
            let field = base_fields.try_index((index as i32, ..))?;
            let scores = matmul_accurate(options, &field)?;
            let scores = divide(&scores, &Array::from_f32((WIDTH as f32).sqrt()))?;
            let routing_weights = softmax_axes(&scores, &[0], true)?;
            let routing_weights = reshape(&routing_weights, &[options.shape()[0], 1])?;
            let summary = sum_axes(&multiply(&routing_weights, options)?, &[0], false)?;
            option_summaries.push(summary);
        }
        let option_summary = stack(&option_summaries, 0)?;
        let option_summary = layer_norm_op(
            &option_summary,
            &self.option_summary_norm_weight,
            &self.option_summary_norm_bias,
        )?;

        let global_projected = linear(&global_vector, &self.global_projection_weight, None)?;
        let global_projected = expand_dims(&global_projected, 0)?;
        let type_embeddings = take_axis(&self.type_embedding_weight, &type_ids, 0)?;

        let mut fields = add(&base_fields, &option_summary)?;
        fields = add(&fields, &global_projected)?;
        fields = add(&fields, &type_embeddings)?;
        let mut fields = expand_dims(&fields, 0)?;

        for layer in &self.layers {
            fields = layer.forward(&fields, &memory)?;
        }
        let fields = layer_norm_op(&fields, &self.field_norm_weight, &self.field_norm_bias)?;
        let fields = fields.try_index((0, ..))?;

        let prior_scale = Array::from_f32(self.prior_logit_scale.min(100f32.ln()).exp());
        let joint_scale = Array::from_f32(self.joint_logit_scale.min(100f32.ln()).exp());
        let gate = sigmoid(&Array::from_f32(self.residual_gate))?;

        let mut record_logits: Vec<Array> = Vec::with_capacity(n_q);
        for index in 0..n_q {
            let field = fields.try_index((index as i32, ..))?;
            let lexical = &lexical_vectors[index];
            let routed = &split_options[index];

            let anchor_source = add(
                &question_vectors.try_index((index as i32, ..))?,
                &global_vector,
            )?;
            let anchor = normalize(&anchor_source)?;
            let lexical_anchor = normalize(lexical)?;
            let prior = multiply(&prior_scale, &matmul_accurate(&lexical_anchor, &anchor)?)?;

            let options =
                layer_norm_op(routed, &self.option_norm_weight, &self.option_norm_bias)?;
            let repeated_field = broadcast_to(&expand_dims(&field, 0)?, options.shape())?;
            let cosine = cosine_similarity(&repeated_field, &options)?;

            let product = multiply(&repeated_field, &options)?;
            let difference = abs(&subtract(&repeated_field, &options)?)?;
            let features = concatenate(&[&repeated_field, &options, &product, &difference], -1)?;
            let residual = linear(
                &features,
                &self.residual_scorer_0_weight,
                Some(&self.residual_scorer_0_bias),
            )?;
            let residual = gelu(&residual)?;
            let residual = linear(
                &residual,
                &self.residual_scorer_3_weight,
                Some(&self.residual_scorer_3_bias),
            )?;
            let residual = squeeze_axes(&residual, &[-1])?;

            let joint = add(&multiply(&joint_scale, &cosine)?, &residual)?;
            let logit = add(&prior, &multiply(&gate, &joint)?)?;
            record_logits.push(logit);
        }

        Ok(record_logits)
    }
}
