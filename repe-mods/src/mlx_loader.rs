use crate::qwen_hook::QwenDecoderLayer;
use anyhow::{Context, Result};
use mlx_rs::{
    Array,
    ops::{indexing::IndexOp, *},
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Deserialize, Debug, Clone)]
pub struct QuantConfig {
    #[serde(default = "default_group_size")]
    pub group_size: i32,
    #[serde(default = "default_bits")]
    pub bits: i32,
}
fn default_group_size() -> i32 { 64 }
fn default_bits() -> i32 { 4 }

/// The subset of `config.json` this loader needs.
#[derive(Deserialize, Debug, Default, Clone)]
pub struct HfModelConfig {
    pub quantization: Option<QuantConfig>,
    /// The `architectures` list from `config.json` — the canonical name of
    /// the model class, used as part of the structural fingerprint.
    #[serde(default)]
    pub architectures: Option<Vec<String>>,
    #[serde(default)]
    pub model_type: Option<String>,
    #[serde(default)]
    pub num_hidden_layers: Option<usize>,
    #[serde(default)]
    pub hidden_size: Option<i32>,
    #[serde(default)]
    pub num_attention_heads: Option<i32>,
    #[serde(default)]
    pub num_key_value_heads: Option<i32>,
    #[serde(default)]
    pub head_dim: Option<i32>,
    #[serde(default)]
    pub rms_norm_eps: Option<f32>,
    #[serde(default)]
    pub rope_theta: Option<f32>,
    #[serde(default)]
    pub vocab_size: Option<i32>,
    #[serde(default)]
    pub tie_word_embeddings: Option<bool>,
    /// The beginning-of-sequence token id, when the checkpoint records one.
    #[serde(default)]
    pub bos_token_id: Option<TokenId>,
    /// The end-of-sequence token id(s), when the checkpoint records them.
    ///
    /// Checkpoints write this either as a single id (`151645`) or as a list
    /// (`[151645, 151643]`), so both forms are accepted.
    #[serde(default)]
    pub eos_token_id: Option<TokenId>,
    /// Qwen3.5 / Qwen3.8 hybrid stacks mark their attention mix here.
    #[serde(default)]
    pub layer_types: Option<Vec<String>>,
    #[serde(default)]
    pub text_config: Option<Box<HfModelConfig>>,
}

/// A token id that a checkpoint records either as one id or as a list of them.
#[derive(Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum TokenId {
    One(i64),
    Many(Vec<i64>),
}

impl TokenId {
    /// Every id this entry stands for.
    pub fn ids(&self) -> Vec<i64> {
        match self {
            TokenId::One(v) => vec![*v],
            TokenId::Many(v) => v.clone(),
        }
    }
}

impl HfModelConfig {
    /// Hybrid stacks interleave gated linear attention with full attention.
    /// The reference decoder block in this crate implements the dense
    /// (full-attention) stack only.
    pub fn is_hybrid_attention(&self) -> bool {
        if let Some(t) = &self.text_config {
            if t.is_hybrid_attention() {
                return true;
            }
        }
        self.layer_types
            .as_ref()
            .map(|lt| lt.iter().any(|t| t.contains("linear_attention")))
            .unwrap_or(false)
    }

    pub fn effective(&self) -> &HfModelConfig {
        match &self.text_config {
            Some(inner) => inner.effective(),
            None => self,
        }
    }
}

#[derive(Deserialize, Debug)]
pub struct SafetensorsIndex {
    pub weight_map: HashMap<String, String>,
}

/// Transparently executes either full-precision (`bf16`/`f32`) matmul or
/// Apple Silicon Metal affine `quantized_matmul` (`4-bit`, `6-bit`, `8-bit`, or mixed OptiQ).
#[derive(Clone)]
pub enum MlxLinear {
    FullPrecision {
        weight: Array,
        /// The additive linear bias (`<prefix>.bias`). Qwen2 / Qwen2.5 carry
        /// one on q/k/v; dropping it silently corrupts the forward pass.
        bias: Option<Array>,
    },
    Quantized {
        weight: Array,
        scales: Array,
        biases: Array,
        group_size: i32,
        bits: i32,
        bias: Option<Array>,
    },
}

impl MlxLinear {
    pub fn forward(&self, x: &Array) -> Result<Array> {
        let out = self.forward_no_bias(x)?;
        let bias = match self {
            MlxLinear::FullPrecision { bias, .. } | MlxLinear::Quantized { bias, .. } => bias,
        };
        match bias {
            Some(b) => Ok(mlx_rs::ops::add(&out, &b.as_type::<f32>()?)?),
            None => Ok(out),
        }
    }

    fn forward_no_bias(&self, x: &Array) -> Result<Array> {
        match self {
            MlxLinear::FullPrecision { weight, .. } => {
                let x_f32 = x.as_type::<f32>()?;
                let w_t = transpose_axes(&weight.as_type::<f32>()?, &[1, 0])?;
                // MLX's Metal float32 GEMM is not float32-accurate: it
                // multiplies through `metal::simdgroup_float8x8`, so a f32
                // product carries roughly float16 precision (~7.8e-4 relative,
                // against ~1.7e-7 for a fused element-wise multiply and
                // reduce). The accurate formulation is used for the Clef
                // head, but it cannot be used here: at the backbone's
                // [B, S, 4096] x [4096, 4096] shape MLX does not fuse the
                // broadcast, and the intermediate OOM-kills the process.
                //
                // Calibration and runtime share this kernel, so the measured
                // threshold transfers exactly; the representation is simply
                // coarser than a true float32 forward would be.
                Ok(matmul(&x_f32, &w_t)?)
            }
            MlxLinear::Quantized {
                weight,
                scales,
                biases,
                group_size,
                bits,
                ..
            } => {
                let out = quantized_matmul(
                    x,
                    weight,
                    scales,
                    Some(biases),
                    QuantizedMatmulOptions {
                        mode: QuantizationMode::Affine,
                        group_size: Some(*group_size),
                        bits: Some(*bits),
                        transpose: true,
                    },
                )?;
                Ok(out.as_type::<f32>()?)
            }
        }
    }
}

/// RoPE tables for one sequence length.
pub struct RopeTables {
    pub cos: Array,
    pub sin: Array,
}

/// Build rotary position tables for `seq_len` positions.
///
/// Uses the NeoX ("half-split") convention that Qwen2/Qwen3 use: the head
/// dimension is cut in half and the two halves are rotated against each other.
pub fn rope_tables(seq_len: i32, head_dim: i32, theta: f32) -> Result<RopeTables> {
    rope_tables_at(0, seq_len, head_dim, theta)
}

/// Build rotary position tables for `seq_len` positions starting at
/// `position_offset`.
///
/// This is what the shared KV cache needs: the cached entries keep the
/// positions they were written with, and the newly appended tokens are
/// rotated at `position_offset + i`. With an offset of zero the tables are
/// bit-identical to [`rope_tables`] — the same angle is computed from the
/// same `f64` expression and rounded to `f32` in the same order — so the
/// non-cached path is numerically untouched.
pub fn rope_tables_at(
    position_offset: usize,
    seq_len: i32,
    head_dim: i32,
    theta: f32,
) -> Result<RopeTables> {
    let half = (head_dim / 2) as usize;
    let mut cos_data = vec![0f32; seq_len as usize * half];
    let mut sin_data = vec![0f32; seq_len as usize * half];
    for pos in 0..seq_len {
        let abs_pos = position_offset as f64 + pos as f64;
        for i in 0..half {
            let freq = 1.0f64 / (theta as f64).powf((2 * i) as f64 / head_dim as f64);
            let angle = abs_pos * freq;
            cos_data[pos as usize * half + i] = angle.cos() as f32;
            sin_data[pos as usize * half + i] = angle.sin() as f32;
        }
    }
    Ok(RopeTables {
        cos: Array::from_slice(&cos_data, &[seq_len, half as i32]),
        sin: Array::from_slice(&sin_data, &[seq_len, half as i32]),
    })
}

/// Apply rotary embeddings to `q` and `k`, both shaped `[B, S, H, D]`.
fn apply_rope(q: &Array, k: &Array, tables: &RopeTables) -> Result<(Array, Array)> {
    // Index ranges in `mlx-rs` are `i32`-based.
    // The tables are [seq_len, head_dim/2]; broadcasting them against a
    // [B, S, H, D] activation needs [1, S, 1, D/2].
    let seq_len = q.shape()[1];
    let half = q.shape()[3] / 2;
    let cos = tables.cos.reshape(&[1, seq_len, 1, half])?;
    let sin = tables.sin.reshape(&[1, seq_len, 1, half])?;

    let rotate = |x: &Array| -> Result<Array> {
        let x1 = x.index((.., .., .., 0..half)).as_type::<f32>()?;
        let x2 = x.index((.., .., .., half..)).as_type::<f32>()?;
        let first = subtract(&multiply(&x1, &cos)?, &multiply(&x2, &sin)?)?;
        let second = add(&multiply(&x2, &cos)?, &multiply(&x1, &sin)?)?;
        Ok(concatenate(&[first, second], 3)?)
    };

    Ok((rotate(q)?, rotate(k)?))
}

/// Additive causal mask: `0` for `j <= i`, `-1e9` above the diagonal.
///
/// A large negative rather than `-inf` keeps the softmax in range.
fn causal_mask(seq_len: i32) -> Result<Array> {
    let mut data: Vec<f32> = Vec::with_capacity((seq_len * seq_len) as usize);
    for i in 0..seq_len {
        for j in 0..seq_len {
            data.push(if j <= i { 0.0 } else { -1e9 });
        }
    }
    Ok(Array::from_slice(&data, &[seq_len, seq_len]))
}

/// The additive causal mask for `new_len` tokens appended to a cache that
/// already holds `offset` positions, over a total length of `total_len`.
///
/// Row `i` is the token at absolute position `offset + i`: it attends to
/// EVERY cached position (they are all in the past) and to the new tokens up
/// to and including itself. This is NOT a fresh `causal_mask(new_len)` over
/// the new tokens alone — that would hide the cached context from the new
/// tokens and silently produce a different model.
///
/// With `offset == 0` and `total_len == new_len` the mask is exactly
/// `causal_mask(new_len)`.
fn cached_causal_mask(new_len: i32, offset: usize, total_len: i32) -> Result<Array> {
    let mut data: Vec<f32> = Vec::with_capacity((new_len * total_len) as usize);
    for i in 0..new_len {
        // The last position this row may attend to.
        let limit = offset + i as usize;
        for j in 0..total_len as usize {
            data.push(if j <= limit { 0.0 } else { -1e9 });
        }
    }
    Ok(Array::from_slice(&data, &[new_len, total_len]))
}

/// Complete Qwen Transformer Decoder Block supporting both quantized and
/// unquantized projections.
#[derive(Clone)]
pub struct QwenLoadedLayer {
    pub input_norm: Array,
    pub post_attn_norm: Array,
    pub q_proj: MlxLinear,
    pub k_proj: MlxLinear,
    pub v_proj: MlxLinear,
    pub o_proj: MlxLinear,
    pub gate_proj: MlxLinear,
    pub up_proj: MlxLinear,
    pub down_proj: MlxLinear,
    /// Qwen3-style per-head RMSNorm on the query and key projections.
    pub q_norm: Option<Array>,
    pub k_norm: Option<Array>,
    pub num_heads: i32,
    pub num_kv_heads: i32,
    pub head_dim: i32,
    pub rope_theta: f32,
    pub rms_eps: f32,
    /// Whether the layer keeps its attention probabilities.
    ///
    /// Off by default: the probabilities are [B, H, S, S], which is large.
    pub capture_attention: bool,
    /// The attention probabilities kept by the last forward pass.
    pub attention_probs: Option<Array>,
    /// The cached keys of the shared KV cache, `[B, n_kv, S, D]`.
    ///
    /// The cache holds the projected keys AFTER RoPE but BEFORE the
    /// grouped-query expansion: appending a token is then a concatenation on
    /// axis 2, and the expansion is redone over the whole cache on every
    /// step. `None` means "no cache" — the layer then behaves exactly like
    /// the non-cached path.
    pub k_cache: Option<Array>,
    /// The cached values of the shared KV cache, `[B, n_kv, S, D]`.
    pub v_cache: Option<Array>,
}

impl QwenLoadedLayer {
    pub fn synthetic(d_model: i32) -> Result<Self> {
        let scale = Array::from_f32(0.005);
        let mk_lin = || -> Result<MlxLinear> {
            let w = multiply(
                &mlx_rs::random::normal::<f32>(&[d_model, d_model], None, None, None)?,
                &scale,
            )?;
            Ok(MlxLinear::FullPrecision { weight: w, bias: None })
        };
        Ok(Self {
            input_norm: Array::ones::<f32>(&[d_model])?,
            post_attn_norm: Array::ones::<f32>(&[d_model])?,
            q_proj: mk_lin()?,
            k_proj: mk_lin()?,
            v_proj: mk_lin()?,
            o_proj: mk_lin()?,
            gate_proj: mk_lin()?,
            up_proj: mk_lin()?,
            down_proj: mk_lin()?,
            q_norm: None,
            k_norm: None,
            num_heads: 4,
            num_kv_heads: 4,
            head_dim: (d_model / 4).max(1),
            rope_theta: 10000.0,
            capture_attention: false,
            attention_probs: None,
            k_cache: None,
            v_cache: None,
            rms_eps: 1e-6,
        })
    }

    fn rms_norm(x: &Array, weight: &Array, eps: f32) -> Result<Array> {
        let xf = x.as_type::<f32>()?;
        let var = mean_axes(&multiply(&xf, &xf)?, &[-1], true)?;
        let inv = rsqrt(&add(&var, &Array::from_f32(eps))?)?;
        Ok(multiply(&multiply(&xf, &inv)?, &weight.as_type::<f32>()?)?)
    }

    /// Split `[B, S, H*D]` into `[B, S, H, D]`.
    fn to_heads(x: &Array, heads: i32, head_dim: i32) -> Result<Array> {
        let b = x.shape()[0];
        let s = x.shape()[1];
        Ok(x.reshape(&[b, s, heads, head_dim])?)
    }

    /// The number of positions the layer's shared KV cache holds.
    pub fn cache_len(&self) -> usize {
        self.k_cache
            .as_ref()
            .map(|k| k.shape()[2] as usize)
            .unwrap_or(0)
    }

    /// Drop every cache entry beyond `length`.
    ///
    /// This is the rollback primitive. The layers above the probe layer wrote
    /// their entries for an offending token from the UNCLAMPED residual, so
    /// they have to be dropped and recomputed from the clamped one.
    ///
    /// `length` larger than the current cache is a no-op: the cache simply
    /// does not reach that far.
    pub fn truncate_cache(&mut self, length: usize) -> Result<()> {
        let len = length as i32;
        if let Some(kc) = &self.k_cache {
            if len < kc.shape()[2] {
                self.k_cache = Some(kc.index((.., .., 0..len, ..)));
            }
        }
        if let Some(vc) = &self.v_cache {
            if len < vc.shape()[2] {
                self.v_cache = Some(vc.index((.., .., 0..len, ..)));
            }
        }
        Ok(())
    }

    /// Forget the shared KV cache entirely.
    pub fn clear_cache(&mut self) {
        self.k_cache = None;
        self.v_cache = None;
    }

    /// Run the layer against the shared KV cache.
    ///
    /// The new tokens are appended to the layer's cache and the attention runs
    /// over the FULL cached length. The new tokens are rotated at
    /// `position_offset + i`; the cached entries keep the positions they were
    /// written with, because the cache stores the keys AFTER RoPE.
    ///
    /// `position_offset` must equal the current cache length — the position
    /// of the first new token. A mismatch is a bug in the caller (a dropped
    /// token, or a cache that was not rolled back) and is reported rather
    /// than silently producing a model that attends to the wrong places.
    pub fn forward_cached(&mut self, h: &Array, position_offset: usize) -> Result<Array> {
        let cached = self.cache_len();
        if cached != position_offset {
            anyhow::bail!(
                "forward_cached: position_offset {position_offset} does not match the cache \
                 length {cached} — the cache and the position must advance together"
            );
        }
        let seq_len = h.shape()[1];
        let h_norm = Self::rms_norm(h, &self.input_norm, self.rms_eps)?;

        let mut q = self.q_proj.forward(&h_norm)?;
        let mut k = self.k_proj.forward(&h_norm)?;
        let v = self.v_proj.forward(&h_norm)?;

        q = Self::to_heads(&q, self.num_heads, self.head_dim)?;
        k = Self::to_heads(&k, self.num_kv_heads, self.head_dim)?;
        let v = Self::to_heads(&v, self.num_kv_heads, self.head_dim)?;

        // Qwen3 applies an RMSNorm per head to q and k.
        if let Some(qn) = &self.q_norm {
            q = Self::rms_norm(&q, qn, self.rms_eps)?;
        }
        if let Some(kn) = &self.k_norm {
            k = Self::rms_norm(&k, kn, self.rms_eps)?;
        }

        let tables = rope_tables_at(position_offset, seq_len, self.head_dim, self.rope_theta)?;
        let (q, k) = apply_rope(&q, &k, &tables)?;

        // [B, S, H, D] -> [B, H, S, D]
        let q = transpose_axes(&q, &[0, 2, 1, 3])?;
        let k = transpose_axes(&k, &[0, 2, 1, 3])?;
        let v = transpose_axes(&v, &[0, 2, 1, 3])?;

        // Append the new keys and values to the cache. With an empty cache the
        // new arrays are used as they are — no concatenation, no copy — so
        // the numbers are exactly the ones the non-cached path produces.
        let (k_all, v_all) = match (self.k_cache.as_ref(), self.v_cache.as_ref()) {
            (Some(kc), Some(vc)) => (
                concatenate(&[kc, &k], 2)?,
                concatenate(&[vc, &v], 2)?,
            ),
            _ => (k, v),
        };
        let total_len = k_all.shape()[2] as usize;
        self.k_cache = Some(k_all.clone());
        self.v_cache = Some(v_all.clone());

        // Grouped-query attention: each KV head serves `repeats` consecutive
        // query heads, matching the `repeat_kv` convention. The KV axis is
        // expanded and broadcast, not merely reshaped.
        let repeats = (self.num_heads / self.num_kv_heads.max(1)).max(1);
        let (k, v) = if repeats > 1 {
            let b = k_all.shape()[0];
            let expand = |x: &Array| -> Result<Array> {
                let x5 = x.expand_dims(2)?; // [B, n_kv, 1, S, D]
                let x5 = broadcast_to(
                    &x5,
                    &[b, self.num_kv_heads, repeats, total_len as i32, self.head_dim],
                )?;
                Ok(x5.reshape(&[b, self.num_heads, total_len as i32, self.head_dim])?)
            };
            (expand(&k_all)?, expand(&v_all)?)
        } else {
            (k_all, v_all)
        };

        let scale = 1.0f32 / (self.head_dim as f32).sqrt();
        let scores = multiply(
            &matmul(&q, &transpose_axes(&k, &[0, 1, 3, 2])?)?,
            &Array::from_f32(scale),
        )?;
        // The new tokens see every cached position and each other causally.
        let mask = cached_causal_mask(seq_len, position_offset, total_len as i32)?;
        let scores = add(&scores, &mask)?;
        let probs = softmax_axes(&scores, &[-1], None)?;
        if self.capture_attention {
            // Kept for the provenance reading: the attention distribution of
            // the probe layer, so the guard can see how much of the tool
            // call's attention came from the untrusted part of the context.
            self.attention_probs = Some(probs.clone());
        }
        let attn_ctx = matmul(&probs, &v)?; // [B, H, S, D]

        // [B, H, S, D] -> [B, S, H*D]
        let attn_ctx = transpose_axes(&attn_ctx, &[0, 2, 1, 3])?;
        let attn_ctx = attn_ctx.reshape(&[h.shape()[0], seq_len, self.num_heads * self.head_dim])?;
        let attn_out = self.o_proj.forward(&attn_ctx)?;
        let h_mid = add(&h.as_type::<f32>()?, &attn_out)?;

        let h_mlp_norm = Self::rms_norm(&h_mid, &self.post_attn_norm, self.rms_eps)?;
        let gate = self.gate_proj.forward(&h_mlp_norm)?;
        let up = self.up_proj.forward(&h_mlp_norm)?;
        // SiLU(gate) = gate / (1 + exp(-gate))
        let silu_gate = divide(&gate, &add(&Array::from_f32(1.0), &exp(&negative(&gate)?)?)?)?;
        let fused = multiply(&silu_gate, &up)?;
        let mlp_out = self.down_proj.forward(&fused)?;

        Ok(add(&h_mid, &mlp_out)?)
    }
}

impl QwenDecoderLayer for QwenLoadedLayer {
    fn set_attention_capture(&mut self, on: bool) {
        self.capture_attention = on;
        if !on {
            self.attention_probs = None;
        }
    }

    fn take_attention_probs(&mut self) -> Option<Array> {
        self.attention_probs.take()
    }

    fn forward_cached(&mut self, h: &Array, position_offset: usize) -> Result<Array> {
        QwenLoadedLayer::forward_cached(self, h, position_offset)
    }

    fn truncate_cache(&mut self, length: usize) -> Result<()> {
        QwenLoadedLayer::truncate_cache(self, length)
    }

    fn cache_len(&self) -> usize {
        QwenLoadedLayer::cache_len(self)
    }

    fn forward(&mut self, h: &Array, _lora_scale: f32) -> Result<Array> {
        let seq_len = h.shape()[1];
        let h_norm = Self::rms_norm(h, &self.input_norm, self.rms_eps)?;

        let mut q = self.q_proj.forward(&h_norm)?;
        let mut k = self.k_proj.forward(&h_norm)?;
        let v = self.v_proj.forward(&h_norm)?;

        q = Self::to_heads(&q, self.num_heads, self.head_dim)?;
        k = Self::to_heads(&k, self.num_kv_heads, self.head_dim)?;
        let v = Self::to_heads(&v, self.num_kv_heads, self.head_dim)?;

        // Qwen3 applies an RMSNorm per head to q and k.
        if let Some(qn) = &self.q_norm {
            q = Self::rms_norm(&q, qn, self.rms_eps)?;
        }
        if let Some(kn) = &self.k_norm {
            k = Self::rms_norm(&k, kn, self.rms_eps)?;
        }

        let tables = rope_tables(seq_len, self.head_dim, self.rope_theta)?;
        let (q, k) = apply_rope(&q, &k, &tables)?;

        // [B, S, H, D] -> [B, H, S, D]
        let q = transpose_axes(&q, &[0, 2, 1, 3])?;
        let k = transpose_axes(&k, &[0, 2, 1, 3])?;
        let v = transpose_axes(&v, &[0, 2, 1, 3])?;

        // Grouped-query attention: each KV head serves `repeats` consecutive
        // query heads, matching the `repeat_kv` convention. The KV axis is
        // expanded and broadcast, not merely reshaped.
        let repeats = (self.num_heads / self.num_kv_heads.max(1)).max(1);
        let (k, v) = if repeats > 1 {
            let b = k.shape()[0];
            let expand = |x: &Array| -> Result<Array> {
                let x5 = x.expand_dims(2)?; // [B, n_kv, 1, S, D]
                let x5 = broadcast_to(
                    &x5,
                    &[b, self.num_kv_heads, repeats, seq_len, self.head_dim],
                )?;
                Ok(x5.reshape(&[b, self.num_heads, seq_len, self.head_dim])?)
            };
            (expand(&k)?, expand(&v)?)
        } else {
            (k, v)
        };

        let scale = 1.0f32 / (self.head_dim as f32).sqrt();
        let scores = multiply(
            &matmul(&q, &transpose_axes(&k, &[0, 1, 3, 2])?)?,
            &Array::from_f32(scale),
        )?;
        let mask = causal_mask(seq_len)?;
        let scores = add(&scores, &mask)?;
        let probs = softmax_axes(&scores, &[-1], None)?;
        if self.capture_attention {
            // Kept for the provenance reading: the attention distribution of
            // the probe layer, so the guard can see how much of the tool
            // call's attention came from the untrusted part of the context.
            self.attention_probs = Some(probs.clone());
        }
        let attn_ctx = matmul(&probs, &v)?; // [B, H, S, D]

        // [B, H, S, D] -> [B, S, H*D]
        let attn_ctx = transpose_axes(&attn_ctx, &[0, 2, 1, 3])?;
        let attn_ctx = attn_ctx.reshape(&[h.shape()[0], seq_len, self.num_heads * self.head_dim])?;
        let attn_out = self.o_proj.forward(&attn_ctx)?;
        let h_mid = add(&h.as_type::<f32>()?, &attn_out)?;

        let h_mlp_norm = Self::rms_norm(&h_mid, &self.post_attn_norm, self.rms_eps)?;
        let gate = self.gate_proj.forward(&h_mlp_norm)?;
        let up = self.up_proj.forward(&h_mlp_norm)?;
        // SiLU(gate) = gate / (1 + exp(-gate))
        let silu_gate = divide(&gate, &add(&Array::from_f32(1.0), &exp(&negative(&gate)?)?)?)?;
        let fused = multiply(&silu_gate, &up)?;
        let mlp_out = self.down_proj.forward(&fused)?;

        Ok(add(&h_mid, &mlp_out)?)
    }
}

pub struct ShardedModelLoader {
    pub tensors: HashMap<String, Array>,
    pub default_quant: QuantConfig,
    pub config: HfModelConfig,
}

impl ShardedModelLoader {
    pub fn open(model_dir: &Path, max_layer_inclusive: Option<usize>) -> Result<Self> {
        let cfg_path = model_dir.join("config.json");
        let config: HfModelConfig = if cfg_path.exists() {
            let raw = std::fs::read_to_string(&cfg_path)?;
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            HfModelConfig::default()
        };
        let default_quant = config.quantization.clone().unwrap_or(QuantConfig {
            group_size: 64,
            bits: 4,
        });

        let index_path = model_dir.join("model.safetensors.index.json");
        let mut tensors = HashMap::new();

        if index_path.exists() {
            let raw_idx = std::fs::read_to_string(&index_path)?;
            let idx: SafetensorsIndex = serde_json::from_str(&raw_idx)?;

            let mut needed_shards = HashSet::new();
            for (tensor_name, shard_file) in &idx.weight_map {
                if tensor_name.contains("embed_tokens") || tensor_name.contains("norm.weight") {
                    needed_shards.insert(shard_file.clone());
                    continue;
                }
                if let Some(max_l) = max_layer_inclusive {
                    if let Some(layer_num) = Self::extract_layer_number(tensor_name) {
                        if layer_num <= max_l {
                            needed_shards.insert(shard_file.clone());
                        }
                    }
                } else {
                    needed_shards.insert(shard_file.clone());
                }
            }

            for shard in needed_shards {
                let shard_path = model_dir.join(&shard);
                let shard_tensors = Array::load_safetensors(&shard_path)
                    .with_context(|| format!("Failed loading shard {:?}", shard_path))?;
                tensors.extend(shard_tensors);
            }
        } else {
            let single_path = model_dir.join("model.safetensors");
            tensors = Array::load_safetensors(&single_path)
                .with_context(|| format!("Failed loading {:?}", single_path))?;
        }

        Ok(Self {
            tensors,
            default_quant,
            config,
        })
    }

    fn extract_layer_number(tensor_name: &str) -> Option<usize> {
        let marker = "layers.";
        let start = tensor_name.find(marker)? + marker.len();
        let rest = &tensor_name[start..];
        let end = rest.find('.')?;
        rest[..end].parse::<usize>().ok()
    }

    pub fn detected_layer_count(&self) -> usize {
        let mut count = 0usize;
        while self.tensors.contains_key(&format!("model.layers.{count}.input_layernorm.weight"))
            || self.tensors.contains_key(&format!("language_model.model.layers.{count}.input_layernorm.weight"))
        {
            count += 1;
        }
        count
    }

    pub fn get_tensor(&self, base_key: &str) -> Result<Array> {
        if let Some(t) = self.tensors.get(base_key) {
            return Ok(t.clone());
        }
        let vl_key = format!("language_model.{base_key}");
        self.tensors
            .get(&vl_key)
            .cloned()
            .with_context(|| format!("Missing tensor `{base_key}` (or `{vl_key}`)"))
    }

    /// Fetch a tensor if present, without failing when it is absent.
    pub fn optional_tensor(&self, base_key: &str) -> Option<Array> {
        self.tensors
            .get(base_key)
            .or_else(|| self.tensors.get(&format!("language_model.{base_key}")))
            .cloned()
    }

    pub fn get_linear(&self, prefix: &str) -> Result<MlxLinear> {
        let weight = self.get_tensor(&format!("{prefix}.weight"))?;
        let bias = self.optional_tensor(&format!("{prefix}.bias"));
        let scales_key = format!("{prefix}.scales");
        let vl_scales_key = format!("language_model.{scales_key}");

        if self.tensors.contains_key(&scales_key) || self.tensors.contains_key(&vl_scales_key) {
            let scales = self.get_tensor(&scales_key)?;
            let biases = self
                .optional_tensor(&format!("{prefix}.biases"))
                .unwrap_or_else(|| Array::zeros::<f32>(&[scales.shape()[0], scales.shape()[1]]).unwrap_or_else(|_| Array::from_f32(0.0)));

            let group_size = self.default_quant.group_size;
            // MLX stores affine-quantized weights transposed and packed:
            //   weight  [in_features / pack, out_features]
            //   scales  [in_features / group_size, out_features]
            let in_features = scales.shape()[0] * group_size;
            let packed_rows = weight.shape()[0];
            let inferred_bits = if in_features > 0 {
                (32 * packed_rows) / in_features
            } else {
                self.default_quant.bits
            };

            Ok(MlxLinear::Quantized {
                weight,
                scales,
                biases,
                group_size,
                bits: inferred_bits,
                bias,
            })
        } else {
            Ok(MlxLinear::FullPrecision { weight, bias })
        }
    }

    pub fn load_layer(&self, i: usize) -> Result<QwenLoadedLayer> {
        let cfg = self.config.effective();
        let hidden = cfg.hidden_size.unwrap_or(0);
        let num_heads = cfg.num_attention_heads.unwrap_or(0);
        let num_kv_heads = cfg.num_key_value_heads.unwrap_or(num_heads);
        let head_dim = cfg.head_dim.unwrap_or(if num_heads > 0 {
            hidden / num_heads
        } else {
            hidden
        });

        Ok(QwenLoadedLayer {
            input_norm: self
                .get_tensor(&format!("model.layers.{i}.input_layernorm.weight"))?
                .as_type::<f32>()?,
            post_attn_norm: self
                .get_tensor(&format!("model.layers.{i}.post_attention_layernorm.weight"))?
                .as_type::<f32>()?,
            q_proj: self.get_linear(&format!("model.layers.{i}.self_attn.q_proj"))?,
            k_proj: self.get_linear(&format!("model.layers.{i}.self_attn.k_proj"))?,
            v_proj: self.get_linear(&format!("model.layers.{i}.self_attn.v_proj"))?,
            o_proj: self.get_linear(&format!("model.layers.{i}.self_attn.o_proj"))?,
            gate_proj: self.get_linear(&format!("model.layers.{i}.mlp.gate_proj"))?,
            up_proj: self.get_linear(&format!("model.layers.{i}.mlp.up_proj"))?,
            down_proj: self.get_linear(&format!("model.layers.{i}.mlp.down_proj"))?,
            q_norm: self
                .optional_tensor(&format!("model.layers.{i}.self_attn.q_norm.weight"))
                .map(|a| a.as_type::<f32>())
                .transpose()?,
            k_norm: self
                .optional_tensor(&format!("model.layers.{i}.self_attn.k_norm.weight"))
                .map(|a| a.as_type::<f32>())
                .transpose()?,
            num_heads,
            num_kv_heads,
            head_dim,
            rope_theta: cfg.rope_theta.unwrap_or(10000.0),
            rms_eps: cfg.rms_norm_eps.unwrap_or(1e-6),
            capture_attention: false,
            attention_probs: None,
            k_cache: None,
            v_cache: None,
        })
    }

    pub fn load_embed_tokens_f32(&self) -> Result<Array> {
        match self.get_linear("model.embed_tokens")? {
            MlxLinear::FullPrecision { weight, .. } => Ok(weight.as_type::<f32>()?),
            MlxLinear::Quantized {
                weight,
                scales,
                biases,
                group_size,
                bits,
                ..
            } => {
                // Embeddings are stored row-major (not transposed like linear layers).
                let deq = dequantize(
                    &weight,
                    &scales,
                    Some(&biases),
                    DequantizeOptions {
                        mode: QuantizationMode::Affine,
                        group_size: Some(group_size),
                        bits: Some(bits),
                    },
                )?;
                Ok(deq.as_type::<f32>()?)
            }
        }
    }

    /// The model's final norm, if the checkpoint carries one.
    pub fn load_final_norm(&self) -> Result<Array> {
        let t = self
            .optional_tensor("model.norm.weight")
            .or_else(|| self.optional_tensor("language_model.model.norm.weight"))
            .context("Missing final norm weight")?;
        Ok(t.as_type::<f32>()?)
    }

    /// The language-model head: the tied embedding table when the checkpoint
    /// ties its input and output embeddings, otherwise the checkpoint's own
    /// `lm_head.weight`.
    ///
    /// Qwen2.5-0.5B ties them, so `lm_head == embed_tokens`; a checkpoint
    /// that does not tie them carries a separate `lm_head.weight`.
    pub fn load_lm_head(&self) -> Result<Array> {
        let cfg = self.config.effective();
        if cfg.tie_word_embeddings.unwrap_or(false) {
            return self.load_embed_tokens_f32();
        }
        let w = self
            .optional_tensor("lm_head.weight")
            .or_else(|| self.optional_tensor("model.lm_head.weight"))
            .context("Missing `lm_head.weight` and the checkpoint does not tie its embeddings")?;
        Ok(w.as_type::<f32>()?)
    }
}

#[cfg(test)]
mod rope_parity_tests {
    use super::*;

    #[test]
    fn rope_matches_mlx_fast_rope() {
        let seq_len = 8;
        let heads = 2;
        let head_dim = 64;
        let theta = 1_000_000.0f32;
        let n = (seq_len * heads * head_dim) as usize;
        let data: Vec<f32> = (0..n).map(|i| ((i as f32) * 0.037).sin()).collect();
        let q = Array::from_slice(&data, &[1, seq_len, heads, head_dim]);
        let tables = rope_tables(seq_len, head_dim, theta).unwrap();
        let (q_rot, _) = apply_rope(&q, &q, &tables).unwrap();

        // mlx_rs::fast::rope rotates [B, H, S, D]
        let q_bhsd = transpose_axes(&q, &[0, 2, 1, 3]).unwrap();
        let fast_rot = mlx_rs::fast::rope(
            &q_bhsd,
            head_dim,
            false,
            Some(theta),
            1.0,
            0,
            None::<&Array>,
        )
        .unwrap();
        let fast_bshd = transpose_axes(&fast_rot, &[0, 2, 1, 3]).unwrap();

        let diff = max(&abs(&subtract(&q_rot, &fast_bshd).unwrap()).unwrap(), None).unwrap();
        diff.eval().unwrap();
        let max_diff = diff.as_slice::<f32>()[0];
        assert!(
            max_diff < 1e-5,
            "RoPE tables diverged from mlx_rs::fast::rope: max_diff={max_diff}"
        );
    }
}
