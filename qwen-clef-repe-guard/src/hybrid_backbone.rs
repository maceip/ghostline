//! The 32-layer hybrid decoder stack of Cloudflare/clef-flash.
//!
//! Layer layout (mirrors `mlx_lm/models/qwen3_5.py`):
//!
//! * `linear_attention` layers use the Gated DeltaNet in [`crate::gdn`].
//! * `full_attention` layers use `Qwen3NextAttention` (fused query + output
//!   gate projection, per-head `q_norm`/`k_norm` RMSNorm, partial rotary
//!   embeddings and an output gate applied after attention).
//!
//! The decoder block is pre-norm / post-residual:
//!
//! ```text
//! r   = attn(input_layernorm(x))
//! h   = x + r
//! out = h + mlp(post_attention_layernorm(h))
//! ```

use anyhow::Result;
use mlx_rs::{
    Array,
    fast,
    ops::{self, indexing::take_axis},
};

use crate::gdn::{linear, rms_norm, silu};
use crate::hybrid_loader::{
    FullAttentionWeights, HybridConfig, HybridModelWeights, LayerAttentionWeights, MlpWeights,
};

/// `Qwen3NextAttention.__call__`.
fn full_attention_forward(
    cfg: &HybridConfig,
    w: &FullAttentionWeights,
    x: &Array,
) -> Result<Array> {
    let shape = x.shape();
    let (b, l) = (shape[0], shape[1]);
    let heads = cfg.num_attention_heads;
    let kv_heads = cfg.num_key_value_heads;
    let head_dim = cfg.head_dim;

    // The query projection is fused with the output gate: the projection
    // output is reshaped to [B, L, heads, 2 * head_dim] and split in half.
    let q_proj_output = linear(x, &w.q_proj)?; // [B, L, 2 * heads * head_dim]
    let qg = ops::reshape(&q_proj_output, &[b, l, heads, 2 * head_dim])?;
    let qg_parts = ops::split_at_indices(&qg, &[head_dim], -1)?;
    let queries = qg_parts[0].clone(); // [B, L, heads, head_dim]
    let gate = ops::reshape(&qg_parts[1], &[b, l, heads * head_dim])?;

    let keys = linear(x, &w.k_proj)?; // [B, L, kv_heads * head_dim]
    let values = linear(x, &w.v_proj)?; // [B, L, kv_heads * head_dim]

    // Per-head RMSNorm on the query and key projections.
    let queries = rms_norm(&queries, Some(&w.q_norm), cfg.rms_norm_eps)?;
    let queries = ops::transpose_axes(&queries, &[0, 2, 1, 3])?; // [B, heads, L, head_dim]

    let keys = rms_norm(
        &ops::reshape(&keys, &[b, l, kv_heads, head_dim])?,
        Some(&w.k_norm),
        cfg.rms_norm_eps,
    )?;
    let keys = ops::transpose_axes(&keys, &[0, 2, 1, 3])?; // [B, kv_heads, L, head_dim]

    let values = ops::transpose_axes(
        &ops::reshape(&values, &[b, l, kv_heads, head_dim])?,
        &[0, 2, 1, 3],
    )?; // [B, kv_heads, L, head_dim]

    // Partial rotary embeddings: only the first
    // `int(head_dim * partial_rotary_factor)` dimensions are rotated.
    let rope_dims = (cfg.head_dim as f64 * cfg.partial_rotary_factor) as i32;
    let queries = fast::rope(
        &queries,
        rope_dims,
        false,
        Some(cfg.rope_theta),
        1.0,
        0,
        None::<&Array>,
    )?;
    let keys = fast::rope(
        &keys,
        rope_dims,
        false,
        Some(cfg.rope_theta),
        1.0,
        0,
        None::<&Array>,
    )?;

    // Grouped-query attention: MLX expands the KV heads internally, so the
    // keys/values are passed un-tiled exactly like the reference does.
    let scale = (cfg.head_dim as f64).powf(-0.5) as f32;
    let output = fast::scaled_dot_product_attention(
        &queries,
        &keys,
        &values,
        scale,
        fast::ScaledDotProductAttentionMask::Causal,
        None::<&Array>,
    )?; // [B, heads, L, head_dim]

    let output = ops::transpose_axes(&output, &[0, 2, 1, 3])?;
    let output = ops::reshape(&output, &[b, l, heads * head_dim])?;

    // Output gate: `o_proj(output * sigmoid(gate))`.
    let gated = ops::multiply(&output, &ops::sigmoid(&gate)?)?;
    linear(&gated, &w.o_proj)
}

/// `Qwen3NextMLP.__call__`: `down_proj(silu(gate_proj(x)) * up_proj(x))`.
fn mlp_forward(w: &MlpWeights, x: &Array) -> Result<Array> {
    let gate = linear(x, &w.gate_proj)?;
    let up = linear(x, &w.up_proj)?;
    let activated = ops::multiply(&silu(&gate)?, &up)?;
    linear(&activated, &w.down_proj)
}

/// One decoder layer.
#[derive(Debug, Clone)]
pub struct HybridLayer {
    /// `[hidden]`.
    pub input_layernorm: Array,
    /// `[hidden]`.
    pub post_attention_layernorm: Array,
    /// The attention block.
    pub attn: LayerAttentionWeights,
    /// The MLP block.
    pub mlp: MlpWeights,
}

impl HybridLayer {
    /// One decoder block.
    pub fn forward(&self, cfg: &HybridConfig, x: &Array) -> Result<Array> {
        let h_norm = rms_norm(x, Some(&self.input_layernorm), cfg.rms_norm_eps)?;
        let r = match &self.attn {
            LayerAttentionWeights::Linear(gdn) => gdn.forward(&cfg.gdn, &h_norm)?,
            LayerAttentionWeights::Full(full) => full_attention_forward(cfg, full, &h_norm)?,
        };
        let h = ops::add(x, &r)?;
        let mlp_in = rms_norm(&h, Some(&self.post_attention_layernorm), cfg.rms_norm_eps)?;
        let m = mlp_forward(&self.mlp, &mlp_in)?;
        Ok(ops::add(&h, &m)?)
    }
}

/// The complete executable hybrid stack.
#[derive(Debug, Clone)]
pub struct HybridBackbone {
    /// `[vocab_size, hidden_size]`.
    pub embed_tokens: Array,
    /// The decoder layers, in order.
    pub layers: Vec<HybridLayer>,
    /// Final RMSNorm weight, `[hidden_size]`.
    pub norm: Array,
    /// `[vocab_size, hidden_size]`.
    pub lm_head: Array,
    /// Model geometry.
    pub cfg: HybridConfig,
}

impl HybridBackbone {
    /// Build the stack from loaded weights.
    pub fn new(weights: HybridModelWeights) -> Self {
        let cfg = weights.cfg;
        let layers = weights
            .layers
            .into_iter()
            .map(|l| HybridLayer {
                input_layernorm: l.input_layernorm,
                post_attention_layernorm: l.post_attention_layernorm,
                attn: l.attn,
                mlp: l.mlp,
            })
            .collect();
        Self {
            embed_tokens: weights.embed_tokens,
            layers,
            norm: weights.norm,
            lm_head: weights.lm_head,
            cfg,
        }
    }

    /// Embed a `[B, S]` int32 token array.
    pub fn embed(&self, token_ids: &Array) -> Result<Array> {
        Ok(take_axis(&self.embed_tokens, token_ids, 0)?)
    }

    /// Run the stack and return the hidden state *after* the final norm and
    /// *before* the LM head.
    ///
    /// `capture` lists the layer indices whose post-block output should be
    /// retained in `captured`.
    pub fn forward_hidden(
        &self,
        token_ids: &Array,
        capture: &[usize],
        captured: &mut Vec<(usize, Array)>,
    ) -> Result<Array> {
        let mut hidden = self.embed(token_ids)?;
        for (index, layer) in self.layers.iter().enumerate() {
            hidden = layer.forward(&self.cfg, &hidden)?;
            if capture.contains(&index) {
                captured.push((index, hidden.clone()));
            }
        }
        rms_norm(&hidden, Some(&self.norm), self.cfg.rms_norm_eps)
    }

    /// Run the stack and return the LM-head logits.
    pub fn forward(&self, token_ids: &Array) -> Result<Array> {
        let mut sink = Vec::new();
        let hidden = self.forward_hidden(token_ids, &[], &mut sink)?;
        linear(&hidden, &self.lm_head)
    }
}
