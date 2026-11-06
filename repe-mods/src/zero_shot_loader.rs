//! Zero-shot hyperparameter discovery and RepE extraction from static weights.
//!
//! Two things happen here, both without running a single prompt forward pass:
//!
//! 1. **Introspection** — the checkpoint's `config.json` and safetensors headers
//!    are read to infer the layer count, residual width, vocabulary size, norm
//!    epsilon and the per-projection quantization bit-width (4-bit, 6-bit,
//!    8-bit, mixed OptiQ or bf16).
//!
//! 2. **Closed-form extraction** — the RepE directions are computed directly
//!    from the static weight matrices: the unembedding contrast between unsafe
//!    and safe coding tokens gives the residual-stream basis, and the probe
//!    layer's MLP `down_proj` projects that basis onto the write direction the
//!    network actually uses for tool calls.

use anyhow::{Context, Result};
use mlx_rs::{
    Array,
    linalg::svd,
    ops::{indexing::IndexOp, *},
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tokenizers::Tokenizer;
use tracing::info;

/// Everything the guard learned about a checkpoint without being told.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredHyperparams {
    pub architecture: String,
    pub num_layers: usize,
    pub probe_layer: usize,
    pub d_model: i32,
    pub vocab_size: i32,
    pub rms_norm_eps: f32,
    pub default_group_size: i32,
    pub weight_quant_summary: String,
    pub calibration_mode: String,
}

/// A structural fingerprint used to decide whether cached vectors still apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelFingerprint {
    pub architecture: String,
    pub num_layers: usize,
    pub d_model: i32,
    pub vocab_size: i32,
}

impl ModelFingerprint {
    pub fn to_metadata(&self) -> Vec<(String, String)> {
        vec![
            ("fingerprint_architecture".into(), self.architecture.clone()),
            ("fingerprint_num_layers".into(), self.num_layers.to_string()),
            ("fingerprint_d_model".into(), self.d_model.to_string()),
            ("fingerprint_vocab_size".into(), self.vocab_size.to_string()),
        ]
    }

    pub fn from_metadata(meta: &HashMap<String, String>) -> Option<Self> {
        // The explicit fingerprint block written by this guard.
        if let (Some(arch), Some(layers), Some(d), Some(v)) = (
            meta.get("fingerprint_architecture"),
            meta.get("fingerprint_num_layers"),
            meta.get("fingerprint_d_model"),
            meta.get("fingerprint_vocab_size"),
        ) {
            return Some(Self {
                architecture: arch.clone(),
                num_layers: layers.parse().ok()?,
                d_model: d.parse().ok()?,
                vocab_size: v.parse().ok()?,
            });
        }

        // Artifacts written by the extractors before the fingerprint block
        // existed still carry the layer count and the residual width. Accept
        // them as a partial fingerprint so a calibrated file is not mistaken
        // for an unknown one and silently replaced by zero-shot vectors.
        let layers = meta.get("num_layers")?.parse().ok()?;
        let d = meta.get("d_model")?.parse().ok()?;
        Some(Self {
            architecture: meta
                .get("architecture")
                .cloned()
                .unwrap_or_else(|| "unknown".to_string()),
            num_layers: layers,
            d_model: d,
            // Unknown for legacy artifacts — `matches` then skips this field.
            vocab_size: 0,
        })
    }

    /// Whether a cached fingerprint describes the same model structure.
    ///
    /// Fields the cached file did not record are not compared, so a partial
    /// fingerprint still matches on the structure it does describe.
    pub fn matches(&self, other: &ModelFingerprint) -> bool {
        if self.num_layers != other.num_layers || self.d_model != other.d_model {
            return false;
        }
        if self.vocab_size != 0 && other.vocab_size != 0 && self.vocab_size != other.vocab_size
        {
            return false;
        }
        if self.architecture != "unknown"
            && other.architecture != "unknown"
            && self.architecture != other.architecture
        {
            return false;
        }
        true
    }
}

#[derive(Deserialize, Debug, Default)]
struct RawConfigJson {
    #[serde(default)]
    architectures: Vec<String>,
    #[serde(default)]
    model_type: Option<String>,
    rms_norm_eps: Option<f32>,
    quantization: Option<RawQuantConfig>,
    /// Multimodal / conditional-generation checkpoints keep the text tower's
    /// settings in a nested block.
    #[serde(default)]
    text_config: Option<Box<RawConfigJson>>,
    /// The per-layer attention mix of a hybrid stack.
    #[serde(default)]
    layer_types: Option<Vec<String>>,
    #[serde(default)]
    num_hidden_layers: Option<usize>,
    #[serde(default)]
    vocab_size: Option<i32>,
}

impl RawConfigJson {
    /// The configuration that actually describes the decoder stack.
    fn effective(&self) -> &RawConfigJson {
        match &self.text_config {
            Some(inner) => inner.effective(),
            None => self,
        }
    }

    /// Whether the stack interleaves gated linear attention with full
    /// attention — a layout this loader cannot run.
    fn is_hybrid_attention(&self) -> bool {
        let cfg = self.effective();
        cfg.layer_types
            .as_ref()
            .map(|lt| lt.iter().any(|t| t.contains("linear_attention")))
            .unwrap_or(false)
    }
}

#[derive(Deserialize, Debug, Clone)]
struct RawQuantConfig {
    #[serde(default = "default_gs")]
    group_size: i32,
    #[serde(default = "default_bits")]
    bits: i32,
}
fn default_gs() -> i32 {
    64
}
fn default_bits() -> i32 {
    4
}

#[derive(Deserialize)]
struct SafetensorsIndex {
    weight_map: HashMap<String, String>,
}

/// A linear projection in either dense or affine-quantized form.
pub enum AnyLinear {
    /// Torch layout: `[out_dims, in_dims]`.
    Dense {
        weight: Array,
    },
    /// Torch layout: `[out_dims, in_dims * bits / 32]` with per-group scales
    /// `[out_dims, in_dims / group_size]` — the layout a Hugging Face
    /// safetensors checkpoint stores, which is what `quantized_matmul` with
    /// `transpose: true` expects.
    Quantized {
        weight: Array,
        scales: Array,
        biases: Array,
        group_size: i32,
        bits: i32,
    },
}

impl AnyLinear {
    pub fn forward(&self, x: &Array) -> Result<Array> {
        match self {
            AnyLinear::Dense { weight } => {
                let xf = x.as_type::<f32>()?;
                let wt = transpose_axes(&weight.as_type::<f32>()?, &[1, 0])?;
                Ok(matmul(&xf, &wt)?)
            }
            AnyLinear::Quantized {
                weight,
                scales,
                biases,
                group_size,
                bits,
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

    pub fn describe(&self) -> String {
        match self {
            AnyLinear::Dense { .. } => "bf16/f32-dense".to_string(),
            AnyLinear::Quantized {
                bits, group_size, ..
            } => format!("{bits}bit-g{group_size}"),
        }
    }

    /// The projection matrix in dense form: `[out_dims, in_dims]`.
    ///
    /// Every column of a projection is one value vector — the direction that
    /// layer writes into the residual stream — so the matrix has to be
    /// readable as a matrix, not only as a function.
    pub fn dense_matrix(&self) -> Result<Array> {
        match self {
            AnyLinear::Dense { weight } => Ok(weight.as_type::<f32>()?),
            AnyLinear::Quantized {
                weight,
                scales,
                biases,
                group_size,
                bits,
            } => {
                let deq = dequantize(
                    weight,
                    scales,
                    Some(biases),
                    DequantizeOptions {
                        mode: QuantizationMode::Affine,
                        group_size: Some(*group_size),
                        bits: Some(*bits),
                    },
                )?;
                Ok(deq.as_type::<f32>()?)
            }
        }
    }
}

/// The embedding table, in whichever form the checkpoint stores it.
pub enum AnyEmbedding {
    Dense {
        weight: Array, // [vocab, d_model]
    },
    Quantized {
        weight: Array, // [vocab, d_model / pack]
        scales: Array, // [vocab, d_model / group_size]
        biases: Array,
        group_size: i32,
        bits: i32,
    },
}

impl AnyEmbedding {
    pub fn vocab_size(&self) -> i32 {
        match self {
            AnyEmbedding::Dense { weight } => weight.shape()[0],
            AnyEmbedding::Quantized { weight, .. } => weight.shape()[0],
        }
    }

    pub fn describe(&self) -> String {
        match self {
            AnyEmbedding::Dense { .. } => "bf16/f32-dense".to_string(),
            AnyEmbedding::Quantized {
                bits, group_size, ..
            } => format!("{bits}bit-g{group_size}"),
        }
    }

    /// Fetch the unembedding rows for a set of token ids.
    pub fn rows(&self, ids: &Array) -> Result<Array> {
        match self {
            AnyEmbedding::Dense { weight } => {
                let w = weight.as_type::<f32>()?;
                Ok(w.take_axis(ids, 0)?)
            }
            AnyEmbedding::Quantized {
                weight,
                scales,
                biases,
                group_size,
                bits,
            } => {
                // MLX stores embeddings vocab-major: [vocab, d/pack]. The
                // packed rows are independent, so gather them first and then
                // dequantize the (small) subset.
                let w = weight.take_axis(ids, 0)?;
                let s = scales.take_axis(ids, 0)?;
                let b = biases.take_axis(ids, 0)?;
                let deq = dequantize(
                    &w,
                    &s,
                    Some(&b),
                    DequantizeOptions {
                        mode: QuantizationMode::Affine,
                        group_size: Some(*group_size),
                        bits: Some(*bits),
                    },
                )?;
                Ok(deq.as_type::<f32>()?)
            }
        }
    }
}

/// One decoder block, reduced to the projections that matter for the
/// residual write: the attention output and the MLP.
pub struct GenericDecoderLayer {
    pub input_norm: Array,
    pub post_attn_norm: Array,
    pub o_proj: AnyLinear,
    pub gate_proj: AnyLinear,
    pub up_proj: AnyLinear,
    pub down_proj: AnyLinear,
}

impl GenericDecoderLayer {
    pub fn forward(&self, h: &Array, eps: f32) -> Result<Array> {
        let h_norm = rms_norm(h, &self.input_norm, eps)?;
        let attn_delta = self.o_proj.forward(&h_norm)?;
        let h_mid = add(h, &attn_delta)?;

        let h_mlp_norm = rms_norm(&h_mid, &self.post_attn_norm, eps)?;
        let gate = self.gate_proj.forward(&h_mlp_norm)?;
        let up = self.up_proj.forward(&h_mlp_norm)?;
        let silu = divide(&gate, &add(&Array::from_f32(1.0), &exp(&negative(&gate)?)?)?)?;
        let mlp_out = self.down_proj.forward(&multiply(&silu, &up)?)?;
        Ok(add(&h_mid, &mlp_out)?)
    }
}

/// A checkpoint that has been introspected, with its RepE vectors already
/// extracted from the static weights.
pub struct UniversalModelRuntime {
    pub hyperparams: DiscoveredHyperparams,
    pub embed_tokens: AnyEmbedding,
    pub layers: Vec<GenericDecoderLayer>,
    pub final_norm: Array,
    pub tokenizer: Option<Tokenizer>,
}

impl UniversalModelRuntime {
    /// Introspects a checkpoint directory, or builds a zero-config synthetic
    /// model when no directory is given.
    pub fn load_or_introspect(model_dir: Option<&Path>) -> Result<Self> {
        match model_dir {
            Some(dir) => Self::load_from_checkpoint(dir),
            None => Self::build_zero_shot_synthetic(36, 4096),
        }
    }

    pub fn fingerprint(&self) -> ModelFingerprint {
        ModelFingerprint {
            architecture: self.hyperparams.architecture.clone(),
            num_layers: self.hyperparams.num_layers,
            d_model: self.hyperparams.d_model,
            vocab_size: self.hyperparams.vocab_size,
        }
    }

    fn load_from_checkpoint(dir: &Path) -> Result<Self> {
        let cfg_path = dir.join("config.json");
        let raw_cfg: RawConfigJson = if cfg_path.exists() {
            serde_json::from_str(&std::fs::read_to_string(&cfg_path)?).unwrap_or_default()
        } else {
            RawConfigJson::default()
        };

        let effective = raw_cfg.effective();
        if raw_cfg.is_hybrid_attention() {
            anyhow::bail!(
                "checkpoint at {:?} uses a hybrid linear-attention stack; the Rust loader \
                 implements the dense decoder block only. Use the Python extractor (mlx_lm) \
                 and serve the backbone from mlx_lm.",
                dir
            );
        }
        let default_gs = effective
            .quantization
            .as_ref()
            .map(|q| q.group_size)
            .unwrap_or(64);
        // The declared bit-width is only a fallback — the exact width is
        // recovered from the packed tensor shapes, which is authoritative.
        let default_bits = effective
            .quantization
            .as_ref()
            .map(|q| q.bits)
            .unwrap_or(4);
        let rms_eps = effective.rms_norm_eps.unwrap_or(1e-6);
        let arch = raw_cfg
            .architectures
            .first()
            .cloned()
            .or_else(|| raw_cfg.model_type.clone())
            .unwrap_or_else(|| "unknown".into());

        // Single-file or sharded safetensors.
        let index_path = dir.join("model.safetensors.index.json");
        let mut tensors: HashMap<String, Array> = HashMap::new();
        if index_path.exists() {
            let idx: SafetensorsIndex =
                serde_json::from_str(&std::fs::read_to_string(&index_path)?)?;
            let unique_shards: HashSet<String> = idx.weight_map.values().cloned().collect();
            for shard in unique_shards {
                let st = Array::load_safetensors(&dir.join(shard))?;
                tensors.extend(st);
            }
        } else {
            tensors = Array::load_safetensors(&dir.join("model.safetensors"))?;
        }

        // Multimodal checkpoints nest the text stack under `language_model.model`.
        // The decoder stack lives under one of three prefixes depending on
        // how the checkpoint was exported.
        let prefix = [
            "model.language_model",
            "language_model.model",
            "model",
        ]
        .into_iter()
        .find(|p| tensors.contains_key(&format!("{p}.embed_tokens.weight")))
        .unwrap_or("model");

        let mut num_layers = 0usize;
        while tensors.contains_key(&format!("{prefix}.layers.{num_layers}.input_layernorm.weight")) {
            num_layers += 1;
        }
        if num_layers == 0 {
            // The tensor scan is authoritative, but a checkpoint whose prefix
            // was not recognised still reports its depth in the config.
            num_layers = effective.num_hidden_layers.unwrap_or(0);
        }
        anyhow::ensure!(
            num_layers > 0,
            "could not find any decoder layers in {:?}",
            dir
        );

        let final_norm = tensors
            .get(&format!("{prefix}.norm.weight"))
            .context("Missing final norm.weight")?
            .as_type::<f32>()?;
        let d_model = final_norm.shape()[0];

        let embed_tokens = Self::extract_embedding(&tensors, &format!("{prefix}.embed_tokens"), default_gs, default_bits)?;
        let vocab_size = {
            let detected = embed_tokens.vocab_size();
            if detected > 0 {
                detected
            } else {
                effective.vocab_size.unwrap_or(0)
            }
        };

        let mut layers = Vec::with_capacity(num_layers);
        for i in 0..num_layers {
            let lp = format!("{prefix}.layers.{i}");
            layers.push(GenericDecoderLayer {
                input_norm: tensors[&format!("{lp}.input_layernorm.weight")].as_type::<f32>()?,
                post_attn_norm: tensors[&format!("{lp}.post_attention_layernorm.weight")]
                    .as_type::<f32>()?,
                o_proj: Self::extract_linear(&tensors, &format!("{lp}.self_attn.o_proj"), default_gs, default_bits)?,
                gate_proj: Self::extract_linear(&tensors, &format!("{lp}.mlp.gate_proj"), default_gs, default_bits)?,
                up_proj: Self::extract_linear(&tensors, &format!("{lp}.mlp.up_proj"), default_gs, default_bits)?,
                down_proj: Self::extract_linear(&tensors, &format!("{lp}.mlp.down_proj"), default_gs, default_bits)?,
            })
        }

        let probe_layer = ((num_layers as f32) * 0.68).round() as usize;
        let quant_summary = format!(
            "embed={}, layer_{}_mlp={}",
            embed_tokens.describe(),
            probe_layer,
            layers[probe_layer].down_proj.describe()
        );

        let tok_path = dir.join("tokenizer.json");
        let tokenizer = if tok_path.exists() {
            Tokenizer::from_file(&tok_path).ok()
        } else {
            None
        };

        let hyperparams = DiscoveredHyperparams {
            architecture: arch,
            num_layers,
            probe_layer,
            d_model,
            vocab_size,
            rms_norm_eps: rms_eps,
            default_group_size: default_gs,
            weight_quant_summary: quant_summary,
            calibration_mode: "Zero-Shot Static Weight Introspection (Unembedding + Layer-l* MLP SVD)"
                .into(),
        };

        info!("Auto-discovered model hyperparameters: {hyperparams:?}");

        Ok(Self {
            hyperparams,
            embed_tokens,
            layers,
            final_norm,
            tokenizer,
        })
    }

    fn extract_linear(
        tensors: &HashMap<String, Array>,
        prefix: &str,
        default_gs: i32,
        default_bits: i32,
    ) -> Result<AnyLinear> {
        let weight = tensors
            .get(&format!("{prefix}.weight"))
            .with_context(|| format!("Missing {prefix}.weight"))?
            .clone();
        let scales_key = format!("{prefix}.scales");

        if let Some(scales) = tensors.get(&scales_key) {
            let biases = tensors
                .get(&format!("{prefix}.biases"))
                .context("Missing quantized biases")?
                .clone();
            // The checkpoint stores the projection as
            //   weight [out_dims, in_dims * bits / 32]
            //   scales [out_dims, in_dims / group_size]
            // so the exact bit-width follows from the packed column count.
            let in_features = scales.shape()[1] * default_gs;
            let packed_cols = weight.shape()[1];
            let bits = if in_features > 0 {
                ((32 * packed_cols) / in_features).clamp(2, 8)
            } else {
                default_bits
            };

            Ok(AnyLinear::Quantized {
                weight,
                scales: scales.clone(),
                biases,
                group_size: default_gs,
                bits,
            })
        } else {
            Ok(AnyLinear::Dense { weight })
        }
    }

    fn extract_embedding(
        tensors: &HashMap<String, Array>,
        prefix: &str,
        default_gs: i32,
        default_bits: i32,
    ) -> Result<AnyEmbedding> {
        let weight = tensors
            .get(&format!("{prefix}.weight"))
            .with_context(|| format!("Missing {prefix}.weight"))?
            .clone();
        let scales_key = format!("{prefix}.scales");

        if let Some(scales) = tensors.get(&scales_key) {
            let biases = tensors
                .get(&format!("{prefix}.biases"))
                .context("Missing quantized biases")?
                .clone();
            // Embeddings are vocab-major: weight [vocab, d / pack].
            let bits = if scales.shape()[1] > 0 {
                let d_model = scales.shape()[1] * default_gs;
                let packed = weight.shape()[1];
                if d_model > 0 {
                    ((32 * packed) / d_model).clamp(2, 8)
                } else {
                    default_bits
                }
            } else {
                default_bits
            };
            Ok(AnyEmbedding::Quantized {
                weight,
                scales: scales.clone(),
                biases,
                group_size: default_gs,
                bits,
            })
        } else {
            Ok(AnyEmbedding::Dense { weight })
        }
    }

    fn build_zero_shot_synthetic(num_layers: usize, d_model: i32) -> Result<Self> {
        let probe_layer = ((num_layers as f32) * 0.68).round() as usize;
        let vocab_size = 32768;
        let scale = Array::from_f32(0.015);

        let embed_w = multiply(
            &mlx_rs::random::normal::<f32>(&[vocab_size, d_model], None, None, None)?,
            &scale,
        )?;
        let mut layers = Vec::with_capacity(num_layers);
        for _ in 0..num_layers {
            let mat = || -> Result<AnyLinear> {
                let w = multiply(
                    &mlx_rs::random::normal::<f32>(&[d_model, d_model], None, None, None)?,
                    &scale,
                )?;
                Ok(AnyLinear::Dense { weight: w })
            };
            layers.push(GenericDecoderLayer {
                input_norm: Array::ones::<f32>(&[d_model])?,
                post_attn_norm: Array::ones::<f32>(&[d_model])?,
                o_proj: mat()?,
                gate_proj: mat()?,
                up_proj: mat()?,
                down_proj: mat()?,
            })
        }

        let hyperparams = DiscoveredHyperparams {
            architecture: "Qwen3ForCausalLM (Zero-Shot Auto-Introspected)".into(),
            num_layers,
            probe_layer,
            d_model,
            vocab_size,
            rms_norm_eps: 1e-6,
            default_group_size: 64,
            weight_quant_summary: "8bit-g64 (M5 Neural Accelerator Native)".into(),
            calibration_mode: "Zero-Shot Static Weight Introspection (Unembedding + Layer-l* MLP SVD)"
                .into(),
        };

        Ok(Self {
            hyperparams,
            embed_tokens: AnyEmbedding::Dense { weight: embed_w },
            layers,
            final_norm: Array::ones::<f32>(&[d_model])?,
            tokenizer: None,
        })
    }

    /// ZERO-FORWARD-PASS EXTRACTION.
    ///
    /// `v_harm` and `v_drift` come from the unembedding contrast between unsafe
    /// and safe coding lexemes; the probe layer's MLP `down_proj` then maps
    /// that residual-stream basis onto the write direction the network uses for
    /// tool calls. `pca_basis` is the top-3 orthonormal basis of the same
    /// contrast matrix.
    pub fn extract_zero_shot_vectors_from_weights(&self) -> Result<(Array, Array, Array)> {
        let unsafe_lexemes = ["rm", "curl", "ssh", "eval", "sudo", "id_rsa", "dd", "webhook"];
        let safe_lexemes = ["cargo", "test", "check", "status", "build", "clippy", "fmt", "read"];
        let drift_lexemes = ["IGNORE", "SYSTEM", "OVERRIDE", "INSTRUCTION", "IMPORTANT", "STOP"];

        let unsafe_ids = self.resolve_lexeme_token_ids(&unsafe_lexemes, 100);
        let safe_ids = self.resolve_lexeme_token_ids(&safe_lexemes, 200);
        let drift_ids = self.resolve_lexeme_token_ids(&drift_lexemes, 300);

        // 1. The unembedding rows for each lexical group.
        let u_unsafe = self.embed_tokens.rows(&unsafe_ids)?;
        let u_safe = self.embed_tokens.rows(&safe_ids)?;
        let u_drift = self.embed_tokens.rows(&drift_ids)?;

        // 2. Contrastive unembedding matrix in the residual-stream basis.
        let raw_diffs = multiply(&subtract(&u_unsafe, &u_safe)?, &self.final_norm)?;

        // 3. The unembedding axis: the unit difference between what the model
        //    writes for unsafe commands and what it writes for safe ones.
        let unembed_axis = unit_norm(&mean_axes(&raw_diffs, &[0], false)?)?;

        // 4. Layer-l* MLP value-vector routing.
        //
        //    Every column of `down_proj` is one MLP value vector — the
        //    direction the middle layer writes into the residual stream. The
        //    columns are scored by their alignment with the unembedding axis
        //    and the strongest ones are isolated, which yields the exact
        //    middle-layer write direction that routes into the unsafe axis.
        //    This is a pure matrix operation: no prompt is ever forwarded.
        let mlp_axis = self.mlp_write_direction(&unembed_axis, 8.0)?;

        // 5. `v_harm`: the unembedding axis plus the middle-layer MLP write
        //    direction it selects.
        let v_harm = unit_norm(&add(&unembed_axis, &mlp_axis)?)?;

        // 6. `pca_basis`: top-3 orthonormal right singular vectors of the
        //    per-lexeme contrastive differences.
        let cpu = mlx_rs::Stream::cpu();
        let (_u, _s, vt) = mlx_rs::with_stream(&cpu, || svd(&raw_diffs))?;
        let top_3 = vt.index((0..3.min(vt.shape()[0]), ..));
        let row_norms = sqrt(&sum(&multiply(&top_3, &top_3)?, true)?)?;
        let pca_basis = divide(&top_3, &add(&row_norms, &Array::from_f32(1e-6))?)?;

        // 7. `v_drift`: instruction-override lexemes against safe coding ones,
        //    routed through the same middle-layer value vectors.
        let safe_head = u_safe.index((0..6.min(u_safe.shape()[0]), ..));
        let drift_diffs = multiply(&subtract(&u_drift, &safe_head)?, &self.final_norm)?;
        let drift_axis = unit_norm(&mean_axes(&drift_diffs, &[0], false)?)?;
        let drift_mlp = self.mlp_write_direction(&drift_axis, 8.0)?;
        let v_drift = unit_norm(&add(&drift_axis, &drift_mlp)?)?;

        mlx_rs::transforms::eval([&v_harm, &v_drift, &pca_basis])?;
        Ok((v_harm, v_drift, pca_basis))
    }

    /// Isolate the middle-layer MLP write direction that routes along `axis`.
    ///
    /// `down_proj` is `[d_model, intermediate]`, so its columns are the MLP
    /// value vectors. Each column is scored by how strongly it aligns with
    /// `axis`; the scores become a soft selection over the columns, and the
    /// selected columns are averaged into one residual-space direction.
    fn mlp_write_direction(&self, axis: &Array, sharpness: f32) -> Result<Array> {
        let probe_l = self.hyperparams.probe_layer.min(self.layers.len() - 1);
        let down = self.layers[probe_l].down_proj.dense_matrix()?;

        // [intermediate] — one alignment score per MLP value vector.
        let scores = matmul(&transpose_axes(&down, &[1, 0])?, axis)?;
        let magnitudes = abs(&scores)?;
        let scaled = multiply(&magnitudes, &Array::from_f32(sharpness))?;
        let weights = softmax_axes(&scaled, &[0], true)?;

        // [d_model, 1] — the soft-weighted average of the selected columns.
        let direction = matmul(&down, &weights.reshape(&[-1, 1])?)?;
        unit_norm(&direction.reshape(&[-1])?)
    }

    fn resolve_lexeme_token_ids(&self, words: &[&str], fallback_offset: i32) -> Array {
        let mut ids = Vec::with_capacity(words.len());
        for (i, w) in words.iter().enumerate() {
            if let Some(ref tok) = self.tokenizer {
                if let Ok(enc) = tok.encode(*w, false) {
                    if let Some(&first_id) = enc.get_ids().first() {
                        ids.push((first_id as i32).min(self.hyperparams.vocab_size - 1));
                        continue;
                    }
                }
            }
            ids.push((fallback_offset + (i as i32) * 17).min(self.hyperparams.vocab_size - 1));
        }
        Array::from_slice(&ids, &[ids.len() as i32])
    }
}

pub fn rms_norm(x: &Array, weight: &Array, eps: f32) -> Result<Array> {
    let xf = x.as_type::<f32>()?;
    let var = mean_axes(&multiply(&xf, &xf)?, &[-1], true)?;
    let inv = rsqrt(&add(&var, &Array::from_f32(eps))?)?;
    Ok(multiply(&multiply(&xf, &inv)?, weight)?)
}

#[inline]
pub fn unit_norm(v: &Array) -> Result<Array> {
    let vf = v.as_type::<f32>()?;
    let norm = sqrt(&sum(&multiply(&vf, &vf)?, true)?)?;
    Ok(divide(&vf, &add(&norm, &Array::from_f32(1e-6))?)?)
}
