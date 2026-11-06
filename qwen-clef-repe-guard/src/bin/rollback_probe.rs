//! The standalone rollback probe.
//!
//! Loads a checkpoint and a RepE artifact, renders the prompt as the
//! canonical tool-call context, and runs the guarded generation: the model
//! writes the tool call, the RepE sensor watches the residual stream, and a
//! harmful activation is clamped and rolled back instead of being blocked.
//!
//! The outcome is printed as JSON.

#[path = "../rollback.rs"]
mod rollback;

use anyhow::Result;
use clap::Parser;
use rollback::{
    RollbackConfig, RollbackEngine, TokenCodec, generate_with_guard, resolve_trip_threshold,
    verify_cache_parity,
};
use std::path::PathBuf;

#[derive(Parser, Debug)]
struct Args {
    /// The checkpoint directory.
    #[arg(long)]
    model: PathBuf,
    /// The RepE artifact (`repe_vectors*.safetensors`).
    #[arg(long)]
    artifact: PathBuf,
    /// The user prompt the tool call answers.
    #[arg(long)]
    prompt: String,
    /// The clamp strength: `h' = h - alpha * max(0, h.v) * v`.
    #[arg(long, default_value_t = 0.5)]
    alpha: f32,
    /// How many tokens to generate at most.
    #[arg(long, default_value_t = 64)]
    max_tokens: usize,
    /// The harm reading above which the guard trips.
    ///
    /// Defaults to the artifact's own calibrated operating point.
    #[arg(long)]
    trip_threshold: Option<f32>,
    /// How many times the guard may trip and roll back.
    #[arg(long, default_value_t = 4)]
    max_rollbacks: usize,
    /// Only check that the cached forward pass agrees with the plain one.
    #[arg(long, default_value_t = false)]
    verify_cache: bool,
    /// Where the prompt is split for the cache check.
    #[arg(long, default_value_t = 8)]
    split: usize,
    /// Override the rendered context instead of using the canonical
    /// user-turn + tool-call prefix.
    #[arg(long)]
    context: Option<String>,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    let args = Args::parse();

    if args.verify_cache {
        let codec = TokenCodec::from_model_dir(&args.model);
        let context = qwen_clef_repe_guard::repe_sensor::tool_call_span_prefix(&args.prompt);
        let ids = codec.encode(&context);
        let parity = verify_cache_parity(&args.model, &args.artifact, &ids, args.split)?;
        println!("{}", serde_json::to_string_pretty(&parity)?);
        return Ok(());
    }

    let mut engine = RollbackEngine::load(&args.model, &args.artifact)?;
    let codec = TokenCodec::from_model_dir(&args.model);

    let rule = resolve_trip_threshold(&engine.repe_sensor, args.trip_threshold);
    let config = RollbackConfig {
        alpha: args.alpha,
        max_tokens: args.max_tokens,
        trip_threshold: rule.threshold,
        trip_rule: rule.rule,
        max_rollbacks: args.max_rollbacks,
    };

    // The canonical context: the trusted user turn followed by the assistant's
    // tool-call prefix. The model writes the call itself from here.
    let context = args.context.unwrap_or_else(|| {
        qwen_clef_repe_guard::repe_sensor::tool_call_span_prefix(&args.prompt)
    });

    let outcome = generate_with_guard(&mut engine, &codec, &context, &config)?;
    println!("{}", serde_json::to_string_pretty(&outcome)?);
    Ok(())
}
