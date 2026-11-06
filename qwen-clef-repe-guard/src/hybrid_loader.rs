//! Loader for the Cloudflare/clef-flash hybrid checkpoint.
//!
//! The checkpoint is a sharded safetensors file (`model.safetensors.index.json`
//! + `model-0000X-of-00004.safetensors`) holding `bfloat16` tensors under the
//! `model.language_model.` prefix.
//!
//! This loader mirrors `mlx_lm.models.qwen3_5.Model.sanitize` /
//! `TextModel.sanitize` exactly, because those transformations are part of the
//! numerical contract of the Python reference:
//!
//! * `conv1d.weight` is stored in the HuggingFace layout `[out, in/groups, k]`.
//!   When the last axis is not `1` the reference moves it to
//!   `[out, k, in/groups]`, which is what `mlx.nn.Conv1d` expects.
//! * The same condition triggers the reference's RMSNorm correction: the
//!   checkpoint stores the RMSNorm weights offset by `-1`, so the reference adds
//!   `1.0` — in `bfloat16`, i.e. the sum is rounded back to `bfloat16` before
//!   the model is widened to `float32`.
//!
//! Everything is loaded as `float32` so the Rust and Python sides run the same
//! arithmetic.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use mlx_rs::{Array, ops};
use serde::Deserialize;

use crate::gdn::{GatedDeltaNetWeights, GdnConfig};

/// `rope_parameters` block of the text config.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct RopeParameters {
    /// `rope_type` after the reference's `type` / `rope_type` normalisation.
    #[serde(default, rename = "type")]
    pub rope_type: Option<String>,
    /// The `rope_type` spelling used by the checkpoint.
    #[serde(default, rename = "rope_type")]
    pub rope_type_alias: Option<String>,
    /// Rotary base.
    #[serde(default)]
    pub rope_theta: Option<f64>,
    /// Fraction of the head dimension that is rotated.
    #[serde(default)]
    pub partial_rotary_factor: Option<f64>,
}

/// The subset of `config.json` / `config.json:text_config` that is needed.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TextConfig {
    #[serde(default)]
    pub hidden_size: i32,
    #[serde(default)]
    pub num_hidden_layers: usize,
    #[serde(default)]
    pub vocab_size: i32,
    #[serde(default)]
    pub intermediate_size: i32,
    #[serde(default = "default_rms_eps")]
    pub rms_norm_eps: f32,
    #[serde(default)]
    pub num_attention_heads: i32,
    #[serde(default)]
    pub num_key_value_heads: i32,
    #[serde(default)]
    pub head_dim: Option<i32>,
    #[serde(default)]
    pub attention_bias: bool,
    #[serde(default)]
    pub attn_output_gate: bool,
    #[serde(default)]
    pub linear_num_value_heads: i32,
    #[serde(default)]
    pub linear_num_key_heads: i32,
    #[serde(default)]
    pub linear_key_head_dim: i32,
    #[serde(default)]
    pub linear_value_head_dim: i32,
    #[serde(default)]
    pub linear_conv_kernel_dim: i32,
    #[serde(default = "default_full_attention_interval")]
    pub full_attention_interval: usize,
    #[serde(default)]
    pub layer_types: Vec<String>,
    #[serde(default)]
    pub rope_parameters: Option<RopeParameters>,
    #[serde(default)]
    pub rope_theta: Option<f64>,
    #[serde(default)]
    pub partial_rotary_factor: Option<f64>,
    #[serde(default)]
    pub max_position_embeddings: i32,
    #[serde(default)]
    pub tie_word_embeddings: bool,
}

fn default_rms_eps() -> f32 {
    1e-6
}

fn default_full_attention_interval() -> usize {
    4
}

/// Fully resolved model geometry.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct HybridConfig {
    pub hidden_size: i32,
    pub num_hidden_layers: usize,
    pub vocab_size: i32,
    pub intermediate_size: i32,
    pub rms_norm_eps: f32,
    pub num_attention_heads: i32,
    pub num_key_value_heads: i32,
    pub head_dim: i32,
    pub attention_bias: bool,
    pub attn_output_gate: bool,
    pub rope_theta: f32,
    pub partial_rotary_factor: f64,
    pub max_position_embeddings: i32,
    pub full_attention_interval: usize,
    pub layer_types: Vec<String>,
    /// Geometry of the Gated DeltaNet blocks.
    pub gdn: GdnConfig,
}

impl HybridConfig {
    /// `True` when layer `index` is a `linear_attention` (Gated DeltaNet) layer.
    ///
    /// The reference derives this from `full_attention_interval`; the
    /// checkpoint's explicit `layer_types` list is cross-checked against it.
    pub fn is_linear_layer(&self, index: usize) -> bool {
        (index + 1) % self.full_attention_interval != 0
    }
}

/// Weights of one `Qwen3NextAttention` block.
#[derive(Debug, Clone)]
pub struct FullAttentionWeights {
    /// Fused query + output-gate projection, `[2 * num_heads * head_dim, hidden]`.
    pub q_proj: Array,
    /// Key projection, `[num_kv_heads * head_dim, hidden]`.
    pub k_proj: Array,
    /// Value projection, `[num_kv_heads * head_dim, hidden]`.
    pub v_proj: Array,
    /// Output projection, `[hidden, num_heads * head_dim]`.
    pub o_proj: Array,
    /// Per-head query RMSNorm weight, `[head_dim]`.
    pub q_norm: Array,
    /// Per-head key RMSNorm weight, `[head_dim]`.
    pub k_norm: Array,
}

/// SwiGLU MLP weights.
#[derive(Debug, Clone)]
pub struct MlpWeights {
    /// `[intermediate_size, hidden]`.
    pub gate_proj: Array,
    /// `[intermediate_size, hidden]`.
    pub up_proj: Array,
    /// `[hidden, intermediate_size]`.
    pub down_proj: Array,
}

/// The attention block of a decoder layer.
#[derive(Debug, Clone)]
pub enum LayerAttentionWeights {
    /// Gated DeltaNet (linear attention).
    Linear(GatedDeltaNetWeights),
    /// Full softmax attention.
    Full(FullAttentionWeights),
}

/// Weights of one decoder layer.
#[derive(Debug, Clone)]
pub struct HybridLayerWeights {
    pub input_layernorm: Array,
    pub post_attention_layernorm: Array,
    pub attn: LayerAttentionWeights,
    pub mlp: MlpWeights,
}

/// All weights of the hybrid stack.
#[derive(Debug, Clone)]
pub struct HybridModelWeights {
    pub embed_tokens: Array,
    pub layers: Vec<HybridLayerWeights>,
    pub norm: Array,
    pub lm_head: Array,
    pub cfg: HybridConfig,
}

/// `model.safetensors.index.json`.
#[derive(Debug, Deserialize)]
struct SafetensorsIndex {
    weight_map: HashMap<String, String>,
}

/// Round a finite `f32` to the nearest `bfloat16` value (round-half-to-even).
///
/// This mirrors what MLX does when a `bfloat16` tensor is added to a scalar:
/// the operands are widened to `float32`, the addition is performed there and
/// the result is rounded back to `bfloat16`.
fn round_to_bf16(x: f32) -> f32 {
    let bits = x.to_bits();
    // Leave NaN untouched.
    if bits & 0x7fff_ffff > 0x7f80_0000 {
        return x;
    }
    let lsb = (bits >> 16) & 1;
    let rounded = bits.wrapping_add(0x7fff + lsb);
    f32::from_bits(rounded & 0xffff_0000)
}

/// Apply the reference's RMSNorm correction: `bfloat16(w + 1)` widened to
/// `float32`.
fn sanitize_norm_weight(w: &Array) -> Result<Array> {
    let f32_view = w.as_type::<f32>()?;
    f32_view.eval()?;
    let values = f32_view.to_vec_exact::<f32>()?;
    let adjusted: Vec<f32> = values.iter().map(|&v| round_to_bf16(v + 1.0)).collect();
    Ok(Array::from_slice(&adjusted, f32_view.shape()))
}

/// Convert a checkpoint tensor to `float32`.
fn to_f32(w: &Array) -> Result<Array> {
    Ok(w.as_type::<f32>()?)
}

impl HybridModelWeights {
    /// Load the hybrid checkpoint from a local model directory.
    pub fn load(model_dir: &Path) -> Result<Self> {
        let cfg = load_config(model_dir)?;

        // Collect every key we need, grouped by the shard that holds it.
        let mut wanted: Vec<String> = vec![
            "model.language_model.embed_tokens.weight".to_string(),
            "model.language_model.norm.weight".to_string(),
            "lm_head.weight".to_string(),
        ];
        for i in 0..cfg.num_hidden_layers {
            let p = format!("model.language_model.layers.{i}");
            wanted.push(format!("{p}.input_layernorm.weight"));
            wanted.push(format!("{p}.post_attention_layernorm.weight"));
            wanted.push(format!("{p}.mlp.gate_proj.weight"));
            wanted.push(format!("{p}.mlp.up_proj.weight"));
            wanted.push(format!("{p}.mlp.down_proj.weight"));
            if cfg.is_linear_layer(i) {
                wanted.push(format!("{p}.linear_attn.in_proj_qkv.weight"));
                wanted.push(format!("{p}.linear_attn.in_proj_z.weight"));
                wanted.push(format!("{p}.linear_attn.in_proj_a.weight"));
                wanted.push(format!("{p}.linear_attn.in_proj_b.weight"));
                wanted.push(format!("{p}.linear_attn.conv1d.weight"));
                wanted.push(format!("{p}.linear_attn.A_log"));
                wanted.push(format!("{p}.linear_attn.dt_bias"));
                wanted.push(format!("{p}.linear_attn.norm.weight"));
                wanted.push(format!("{p}.linear_attn.out_proj.weight"));
            } else {
                wanted.push(format!("{p}.self_attn.q_proj.weight"));
                wanted.push(format!("{p}.self_attn.k_proj.weight"));
                wanted.push(format!("{p}.self_attn.v_proj.weight"));
                wanted.push(format!("{p}.self_attn.o_proj.weight"));
                wanted.push(format!("{p}.self_attn.q_norm.weight"));
                wanted.push(format!("{p}.self_attn.k_norm.weight"));
            }
        }

        let index_path = model_dir.join("model.safetensors.index.json");
        let raw_index = std::fs::read_to_string(&index_path)
            .with_context(|| format!("failed to read {}", index_path.display()))?;
        let index: SafetensorsIndex = serde_json::from_str(&raw_index)?;

        let wanted_set: HashSet<&str> = wanted.iter().map(|s| s.as_str()).collect();
        let mut by_shard: HashMap<String, Vec<String>> = HashMap::new();
        for (name, shard) in &index.weight_map {
            if wanted_set.contains(name.as_str()) {
                by_shard
                    .entry(shard.clone())
                    .or_default()
                    .push(name.clone());
            }
        }
        let missing: Vec<&str> = wanted
            .iter()
            .filter(|k| !index.weight_map.contains_key(*k))
            .map(|k| k.as_str())
            .collect();
        if !missing.is_empty() {
            anyhow::bail!("checkpoint is missing {} tensors: {missing:?}", missing.len());
        }

        // Load one shard at a time so only a single `bfloat16` shard is
        // resident while the `float32` copies accumulate.
        let mut tensors: HashMap<String, Array> = HashMap::new();
        let mut shards: Vec<String> = by_shard.keys().cloned().collect();
        shards.sort();
        for shard in shards {
            let shard_path = model_dir.join(&shard);
            let shard_tensors = Array::load_safetensors(&shard_path)
                .with_context(|| format!("failed to load shard {}", shard_path.display()))?;
            for name in &by_shard[&shard] {
                let raw = shard_tensors
                    .get(name)
                    .with_context(|| format!("shard {shard} is missing {name}"))?;
                tensors.insert(name.clone(), raw.clone());
            }
            // Drop the `bfloat16` shard before the next one is read.
            drop(shard_tensors);
        }

        let get = |name: &str| -> Result<Array> {
            tensors
                .get(name)
                .cloned()
                .with_context(|| format!("missing tensor {name}"))
        };

        // `TextModel.sanitize` detects the HuggingFace convolution layout from
        // the last axis of `conv1d.weight` and only then applies the RMSNorm
        // correction.
        let has_unsanitized_conv1d = tensors.iter().any(|(name, value)| {
            name.contains("conv1d.weight") && value.shape().last().copied() != Some(1)
        });
        let norm_weight = |_name: &str, value: &Array| -> Result<Array> {
            if has_unsanitized_conv1d {
                sanitize_norm_weight(value)
            } else {
                to_f32(value)
            }
        };

        let embed_tokens = to_f32(&get("model.language_model.embed_tokens.weight")?)?;

        let mut layers = Vec::with_capacity(cfg.num_hidden_layers);
        for i in 0..cfg.num_hidden_layers {
            let p = format!("model.language_model.layers.{i}");
            let input_layernorm = norm_weight(
                &format!("{p}.input_layernorm.weight"),
                &get(&format!("{p}.input_layernorm.weight"))?,
            )?;
            let post_attention_layernorm = norm_weight(
                &format!("{p}.post_attention_layernorm.weight"),
                &get(&format!("{p}.post_attention_layernorm.weight"))?,
            )?;

            let mlp = MlpWeights {
                gate_proj: to_f32(&get(&format!("{p}.mlp.gate_proj.weight"))?)?,
                up_proj: to_f32(&get(&format!("{p}.mlp.up_proj.weight"))?)?,
                down_proj: to_f32(&get(&format!("{p}.mlp.down_proj.weight"))?)?,
            };

            let attn = if cfg.is_linear_layer(i) {
                let conv_raw = get(&format!("{p}.linear_attn.conv1d.weight"))?;
                // HuggingFace layout [out, in/groups, k] -> MLX layout
                // [out, k, in/groups].
                let conv1d = if conv_raw.shape().last().copied() != Some(1) {
                    ops::transpose_axes(&conv_raw, &[0, 2, 1])?
                } else {
                    conv_raw.clone()
                };
                LayerAttentionWeights::Linear(GatedDeltaNetWeights {
                    in_proj_qkv: to_f32(&get(&format!("{p}.linear_attn.in_proj_qkv.weight"))?)?,
                    in_proj_z: to_f32(&get(&format!("{p}.linear_attn.in_proj_z.weight"))?)?,
                    in_proj_a: to_f32(&get(&format!("{p}.linear_attn.in_proj_a.weight"))?)?,
                    in_proj_b: to_f32(&get(&format!("{p}.linear_attn.in_proj_b.weight"))?)?,
                    conv1d: to_f32(&conv1d)?,
                    a_log: to_f32(&get(&format!("{p}.linear_attn.A_log"))?)?,
                    dt_bias: to_f32(&get(&format!("{p}.linear_attn.dt_bias"))?)?,
                    // `linear_attn.norm.weight` is not part of the reference's
                    // `norm_keys` list, so it is *not* corrected.
                    norm: to_f32(&get(&format!("{p}.linear_attn.norm.weight"))?)?,
                    out_proj: to_f32(&get(&format!("{p}.linear_attn.out_proj.weight"))?)?,
                })
            } else {
                LayerAttentionWeights::Full(FullAttentionWeights {
                    q_proj: to_f32(&get(&format!("{p}.self_attn.q_proj.weight"))?)?,
                    k_proj: to_f32(&get(&format!("{p}.self_attn.k_proj.weight"))?)?,
                    v_proj: to_f32(&get(&format!("{p}.self_attn.v_proj.weight"))?)?,
                    o_proj: to_f32(&get(&format!("{p}.self_attn.o_proj.weight"))?)?,
                    q_norm: norm_weight(
                        &format!("{p}.self_attn.q_norm.weight"),
                        &get(&format!("{p}.self_attn.q_norm.weight"))?,
                    )?,
                    k_norm: norm_weight(
                        &format!("{p}.self_attn.k_norm.weight"),
                        &get(&format!("{p}.self_attn.k_norm.weight"))?,
                    )?,
                })
            };

            layers.push(HybridLayerWeights {
                input_layernorm,
                post_attention_layernorm,
                attn,
                mlp,
            });
        }

        let norm = norm_weight(
            "model.language_model.norm.weight",
            &get("model.language_model.norm.weight")?,
        )?;
        let lm_head = to_f32(&get("lm_head.weight")?)?;

        Ok(Self {
            embed_tokens,
            layers,
            norm,
            lm_head,
            cfg,
        })
    }
}

/// Parse `config.json` and resolve the geometry the same way the reference's
/// `TextModelArgs.__post_init__` does.
fn load_config(model_dir: &Path) -> Result<HybridConfig> {
    let config_path = model_dir.join("config.json");
    let raw = std::fs::read_to_string(&config_path)
        .with_context(|| format!("failed to read {}", config_path.display()))?;
    let root: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| format!("invalid {}", config_path.display()))?;
    let text_value = root
        .get("text_config")
        .cloned()
        .unwrap_or_else(|| root.clone());
    let text: TextConfig = serde_json::from_value(text_value)
        .with_context(|| format!("invalid text_config in {}", config_path.display()))?;

    let head_dim = text
        .head_dim
        .unwrap_or_else(|| text.hidden_size / text.num_attention_heads.max(1));

    // `TextModelArgs.__post_init__` normalises `rope_type` -> `type` and then
    // reads `rope_theta` / `partial_rotary_factor` from `rope_parameters`.
    let mut rope = text.rope_parameters.clone().unwrap_or_default();
    if rope.rope_type.is_none() {
        rope.rope_type = rope.rope_type_alias.take();
    }
    let rope_theta = rope.rope_theta.or(text.rope_theta).unwrap_or(100_000.0);
    let partial_rotary_factor = rope
        .partial_rotary_factor
        .or(text.partial_rotary_factor)
        .unwrap_or(0.25);

    let cfg = HybridConfig {
        hidden_size: text.hidden_size,
        num_hidden_layers: text.num_hidden_layers,
        vocab_size: text.vocab_size,
        intermediate_size: text.intermediate_size,
        rms_norm_eps: text.rms_norm_eps,
        num_attention_heads: text.num_attention_heads,
        num_key_value_heads: text.num_key_value_heads,
        head_dim,
        attention_bias: text.attention_bias,
        attn_output_gate: text.attn_output_gate,
        rope_theta: rope_theta as f32,
        partial_rotary_factor,
        max_position_embeddings: text.max_position_embeddings,
        full_attention_interval: text.full_attention_interval,
        layer_types: text.layer_types.clone(),
        gdn: GdnConfig {
            hidden_size: text.hidden_size,
            num_v_heads: text.linear_num_value_heads,
            num_k_heads: text.linear_num_key_heads,
            head_k_dim: text.linear_key_head_dim,
            head_v_dim: text.linear_value_head_dim,
            conv_kernel_size: text.linear_conv_kernel_dim,
            rms_eps: text.rms_norm_eps,
        },
    };

    // Cross-check the explicit `layer_types` list against the interval rule the
    // reference uses.
    if !cfg.layer_types.is_empty() {
        for (i, kind) in cfg.layer_types.iter().enumerate() {
            let expected_linear = cfg.is_linear_layer(i);
            let actual_linear = kind.contains("linear_attention");
            if expected_linear != actual_linear {
                anyhow::bail!(
                    "layer_types[{i}] = {kind:?} disagrees with full_attention_interval = {}",
                    cfg.full_attention_interval
                );
            }
        }
    }

    Ok(cfg)
}
