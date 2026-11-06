//! Validation harness for the hybrid (Gated DeltaNet + full attention) stack.
//!
//! Loads the Cloudflare/clef-flash checkpoint, runs a fixed 16-token prompt and
//! dumps the intermediate activations as raw little-endian `float32` binaries
//! so the Python reference can be compared element by element.
//!
//! Usage:
//!
//! ```text
//! cargo run --release --bin gdn_probe -- <model_dir> <output_dir> [--diagnose]
//! ```
//!
//! Defaults: the local HuggingFace snapshot and `artifacts/gdn_probe`.
//! `--diagnose` additionally dumps the per-layer and per-op breakdown used to
//! localize a numerical divergence.

#[path = "../gdn.rs"]
mod gdn;
#[path = "../hybrid_backbone.rs"]
mod hybrid_backbone;
#[path = "../hybrid_loader.rs"]
mod hybrid_loader;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use mlx_rs::{
    Array,
    ops::indexing::{IndexOp, argmax},
};

use gdn::{linear, rms_norm, silu};
use hybrid_backbone::HybridBackbone;
use hybrid_loader::{HybridModelWeights, LayerAttentionWeights};

/// The fixed 16-token prompt used by both the Rust and the Python side.
///
/// Tokens: "The capital of France is Paris, and the capital of Germany is Berlin, too"
/// encoded with the clef-flash tokenizer (without special tokens).
const PROMPT_TOKEN_IDS: [i32; 16] = [
    760, 6511, 314, 9338, 369, 11751, 11, 321, 279, 6511, 314, 9564, 369, 19241, 11, 2166,
];

const DEFAULT_MODEL_DIR: &str = "/Users/mac/.cache/huggingface/hub/models--Cloudflare--clef-flash/snapshots/fb4417d31c1d0f9e7e77f1141b40aaede7491e00";
const DEFAULT_OUTPUT_DIR: &str = "artifacts/gdn_probe";

/// Write an array as a raw little-endian `float32` binary.
fn dump_f32(path: &Path, array: &Array) -> Result<()> {
    let as_f32 = array.as_type::<f32>()?.contiguous()?;
    as_f32.eval()?;
    let values = as_f32
        .to_vec_exact::<f32>()
        .with_context(|| format!("failed to materialize {}", path.display()))?;
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    std::fs::write(path, &bytes)
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let diagnose = args.iter().any(|a| a == "--diagnose");
    let positional: Vec<&String> = args.iter().filter(|a| *a != "--diagnose").collect();

    let model_dir = PathBuf::from(
        positional
            .first()
            .map(|s| s.as_str())
            .unwrap_or(DEFAULT_MODEL_DIR),
    );
    let output_dir = PathBuf::from(
        positional
            .get(1)
            .map(|s| s.as_str())
            .unwrap_or(DEFAULT_OUTPUT_DIR),
    );
    std::fs::create_dir_all(&output_dir)
        .with_context(|| format!("failed to create {}", output_dir.display()))?;

    println!("model dir : {}", model_dir.display());
    println!("output dir: {}", output_dir.display());
    println!("token ids : {PROMPT_TOKEN_IDS:?}");

    let weights = HybridModelWeights::load(&model_dir)?;
    println!(
        "loaded {} layers ({} linear / {} full)",
        weights.layers.len(),
        weights
            .layers
            .iter()
            .filter(|l| matches!(l.attn, hybrid_loader::LayerAttentionWeights::Linear(_)))
            .count(),
        weights
            .layers
            .iter()
            .filter(|l| matches!(l.attn, hybrid_loader::LayerAttentionWeights::Full(_)))
            .count(),
    );

    let backbone = HybridBackbone::new(weights);
    let token_ids = Array::from_slice(&PROMPT_TOKEN_IDS, &[1, 16]);

    // Capture every layer output so a mismatch can be localized.
    let capture: Vec<usize> = (0..backbone.layers.len()).collect();
    let mut captured: Vec<(usize, Array)> = Vec::new();
    let h_final = backbone.forward_hidden(&token_ids, &capture, &mut captured)?;

    for (index, output) in &captured {
        dump_f32(
            &output_dir.join(format!("rust_layer{index:02}.f32")),
            output,
        )?;
    }
    dump_f32(&output_dir.join("rust_hfinal.f32"), &h_final)?;

    // Optional per-layer breakdown, used to localize numerical divergence.
    if diagnose {
        for index in 0..2usize {
            let layer = &backbone.layers[index];
            let LayerAttentionWeights::Linear(gdn) = &layer.attn else {
                continue;
            };
            let input = captured
                .iter()
                .find(|(i, _)| *i == index - 1)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| backbone.embed(&token_ids).unwrap());
            let h_norm = rms_norm(
                &input,
                Some(&layer.input_layernorm),
                backbone.cfg.rms_norm_eps,
            )?;
            let mut trace = gdn::GdnTrace::default();
            let r = gdn.forward_traced(&backbone.cfg.gdn, &h_norm, &mut trace)?;
            for (name, value) in [
                ("convpre", &trace.conv_pre),
                ("convout", &trace.conv_out),
                ("q", &trace.q),
                ("k", &trace.k),
                ("v", &trace.v),
                ("adt", &trace.a_dt),
                ("soft", &trace.soft),
                ("gexp", &trace.g_exp),
                ("g", &trace.g),
                ("beta", &trace.beta),
                ("state", &trace.state),
                ("y", &trace.y),
                ("normed", &trace.normed),
                ("gated", &trace.gated),
            ] {
                if let Some(value) = value {
                    dump_f32(
                        &output_dir.join(format!("rust_l{index}_gdn_{name}.f32")),
                        value,
                    )?;
                }
            }
            let h = mlx_rs::ops::add(&input, &r)?;
            let mlp_in = rms_norm(
                &h,
                Some(&layer.post_attention_layernorm),
                backbone.cfg.rms_norm_eps,
            )?;
            let gate = linear(&mlp_in, &layer.mlp.gate_proj)?;
            let up = linear(&mlp_in, &layer.mlp.up_proj)?;
            let act = mlx_rs::ops::multiply(&silu(&gate)?, &up)?;
            let mlp_out = linear(&act, &layer.mlp.down_proj)?;
            let out = mlx_rs::ops::add(&h, &mlp_out)?;
            for (name, value) in [
                ("hnorm", &h_norm),
                ("r", &r),
                ("h", &h),
                ("gate", &gate),
                ("up", &up),
                ("act", &act),
                ("out", &out),
            ] {
                dump_f32(
                    &output_dir.join(format!("rust_l{index}_{name}.f32")),
                    value,
                )?;
            }
        }
        println!("wrote per-layer breakdown dumps");
    }

    // End-to-end sanity check: the LM head must produce a sensible next token.
    let logits = backbone.forward(&token_ids)?;
    let last = logits.index((0i32, (PROMPT_TOKEN_IDS.len() - 1) as i32, ..));
    let best = argmax(&last, None)?;
    let best_id = best.item_exact::<u32>();
    println!("next-token argmax id: {best_id}");
    println!(
        "wrote {} layer dumps + rust_hfinal.f32 to {}",
        captured.len(),
        output_dir.display()
    );
    Ok(())
}
