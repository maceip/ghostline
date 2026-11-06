use anyhow::{Context, Result};
use clap::Parser;
use qwen_clef_repe_guard::enforcer_proxy::{
    default_questions, EngineInfo, EngineSpec, Enforcer, EnforcerConfig, EnforcementMode,
    PromptEncoder, ToolCallProbe,
};
use qwen_clef_repe_guard::zero_shot_loader::UniversalModelRuntime;
use std::path::PathBuf;

// The rollback module lives beside this binary rather than in the library:
// the composer emits it into the generated project as a source file, and the
// standalone probe binary includes the same file through `#[path]`.
mod rollback;

use rollback::{
    RollbackConfig, RollbackEngine, TokenCodec, generate_with_guard, resolve_trip_threshold,
    verify_cache_parity,
};

#[derive(Parser, Debug)]
struct Args {
    /// Port to bind the local RepE + Clef tool-call interceptor
    #[arg(long, default_value_t = 8090)]
    port: u16,
    /// Upstream `mlx_lm.server` URL if running in proxy mode
    #[arg(long, default_value = "http://127.0.0.1:8080")]
    upstream: String,
    /// Calibrated RepE vectors (`v_harm`, `v_drift`, `pca_basis`)
    #[arg(long, default_value = "artifacts/repe_vectors.safetensors")]
    repe: PathBuf,
    /// A checkpoint directory; enables the real backbone and introspection
    #[arg(long)]
    model: Option<PathBuf>,
    /// Explicit path to `joint_head.safetensors`
    #[arg(long)]
    joint_head: Option<PathBuf>,
    /// Explicit path to a `tokenizer.json`
    #[arg(long)]
    tokenizer: Option<PathBuf>,
    /// Hugging Face repo id used to fetch the tokenizer when none is given
    #[arg(long, default_value = "Qwen/Qwen2.5-Coder-1.5B-Instruct")]
    qwen_repo: String,
    /// Harm / drift cosine above which a tool call is refused
    #[arg(long, default_value_t = 0.45)]
    threshold: f32,
    /// `enforce` refuses unsafe tool calls, `monitor` only reports them
    #[arg(long, default_value = "enforce")]
    mode: String,
    /// Run an immediate self-test of the guard and exit
    #[arg(long, default_value_t = false)]
    self_test: bool,
    /// Skip zero-shot weight introspection and use the cached vectors as-is
    #[arg(long, default_value_t = false)]
    no_zero_shot: bool,
    /// Run the speculative-activation-rollback generation and print the
    /// outcome as JSON, instead of serving the guard.
    ///
    /// The model writes the tool call itself; when the RepE reading trips,
    /// the guard clamps the harmful activation, rolls the KV cache back and
    /// resumes decoding — the alternative completion instead of a 403.
    #[arg(long, default_value_t = false)]
    rollback: bool,
    /// The prompt the rollback generation answers.
    #[arg(long)]
    rollback_prompt: Option<String>,
    /// The clamp strength: `h' = h - alpha * max(0, h.v) * v`.
    #[arg(long, default_value_t = 0.5)]
    rollback_alpha: f32,
    /// How many tokens the rollback generation may produce.
    #[arg(long, default_value_t = 64)]
    rollback_max_tokens: usize,
    /// The harm reading above which the rollback generation trips.
    ///
    /// Defaults to the artifact's own calibrated operating point.
    #[arg(long)]
    rollback_trip_threshold: Option<f32>,
    /// How many times the rollback generation may trip and roll back.
    #[arg(long, default_value_t = 4)]
    rollback_max_rollbacks: usize,
    /// Check that the shared KV cache reproduces the plain forward pass and
    /// print the comparison as JSON.
    #[arg(long, default_value_t = false)]
    verify_cache: bool,
    /// Where the prompt is split for the cache check.
    #[arg(long, default_value_t = 8)]
    verify_cache_split: usize,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    let mode = match args.mode.as_str() {
        "enforce" => EnforcementMode::Enforce,
        "monitor" => EnforcementMode::Monitor,
        other => anyhow::bail!("unknown mode `{other}` — expected `enforce` or `monitor`"),
    };

    let config = EnforcerConfig {
        upstream_url: args.upstream.clone(),
        block_threshold: args.threshold,
        mode,
        clamp_threshold: 0.45,
        clem_temperature: 1.0,
    };

    // ---------------------------------------------------------------------
    // The rollback path: the model writes the tool call, the guard watches
    // the residual stream, and a harmful activation is clamped and rolled
    // back instead of being refused.
    // ---------------------------------------------------------------------
    if args.rollback {
        return run_rollback(&args);
    }
    if args.verify_cache {
        return run_verify_cache(&args);
    }

    // ---------------------------------------------------------------------
    // Introspect the checkpoint: hyper-parameters and the structural
    // fingerprint the cached vectors have to match.
    // ---------------------------------------------------------------------
    let zero_shot = UniversalModelRuntime::load_or_introspect(args.model.as_deref())?;
    let fingerprint = zero_shot.fingerprint();
    tracing::info!(
        architecture = %fingerprint.architecture,
        num_layers = fingerprint.num_layers,
        d_model = fingerprint.d_model,
        vocab_size = fingerprint.vocab_size,
        "introspected checkpoint"
    );

    // Cached vectors win when they were calibrated against this exact
    // structure; otherwise the zero-shot closed-form extraction takes over.
    let cache = qwen_clef_repe_guard::repe_sensor::RepeVectorsCache::open(&args.repe)?;
    let cache_matches = cache
        .as_ref()
        .map(|c| c.fingerprint.matches(&fingerprint))
        .unwrap_or(false);

    let use_zero_shot = !args.no_zero_shot && !cache_matches;
    if use_zero_shot {
        if args.repe.exists() {
            // Never silently destroy an artifact that was calibrated against a
            // different model — move it aside before the zero-shot pass.
            let backup = args.repe.with_extension("safetensors.bak");
            if std::fs::copy(&args.repe, &backup).is_ok() {
                tracing::warn!(
                    original = %args.repe.display(),
                    backup = %backup.display(),
                    "cached vectors do not match this checkpoint — backed up before zero-shot extraction"
                );
            }
        }
        tracing::info!(
            cached = args.repe.display().to_string(),
            "no cached vectors match this fingerprint — running zero-shot static weight extraction"
        );
        let (v_harm, v_drift, pca_basis) = zero_shot.extract_zero_shot_vectors_from_weights()?;
        qwen_clef_repe_guard::repe_sensor::save_repe_vectors(
            &args.repe,
            &v_harm,
            &v_drift,
            &pca_basis,
            &fingerprint,
            zero_shot.hyperparams.probe_layer,
            &zero_shot.hyperparams.calibration_mode,
        )?;
        tracing::info!(path = %args.repe.display(), "saved zero-shot RepE vectors");
    } else if cache_matches {
        tracing::info!("cached vectors match the model fingerprint — using them");
    }

    let info = EngineInfo {
        architecture: fingerprint.architecture.clone(),
        num_layers: fingerprint.num_layers,
        d_model: fingerprint.d_model,
        calibration_mode: zero_shot.hyperparams.calibration_mode.clone(),
        weight_quant_summary: zero_shot.hyperparams.weight_quant_summary.clone(),
    };

    let tokenizer = match &args.tokenizer {
        Some(path) => PromptEncoder::from_local(path),
        None => match args.model.as_ref() {
            Some(dir) => {
                let local = dir.join("tokenizer.json");
                if local.exists() {
                    PromptEncoder::from_local(&local)
                } else {
                    PromptEncoder::from_hub(&args.qwen_repo)
                }
            }
            None => PromptEncoder::from_hub(&args.qwen_repo),
        },
    };

    let spec = match &args.model {
        Some(model_dir) => EngineSpec::Real {
            model_dir: model_dir.clone(),
            repe_vectors: args.repe.clone(),
            joint_head: args.joint_head.clone(),
            max_layer: None,
        },
        None => EngineSpec::Synthetic {
            repe_vectors: args.repe.clone(),
            n_layers: 8,
        },
    };

    let runtime = tokio::runtime::Runtime::new()?;
    if args.self_test {
        return runtime.block_on(run_self_test(spec, tokenizer, config, info));
    }
    runtime.block_on(serve(args, spec, tokenizer, config, info))
}

/// Run the speculative-activation-rollback generation and print the
/// outcome as JSON.
///
/// The model and the RepE artifact are loaded exactly like the normal path
/// does; only the decision is different. Instead of refusing a tool call the
/// guard watches the model WRITE one, and steers it away from the harmful
/// activation.
fn run_rollback(args: &Args) -> Result<()> {
    let model_dir = args
        .model
        .as_ref()
        .context("--rollback needs --model pointing at a checkpoint")?;
    let prompt = args
        .rollback_prompt
        .as_ref()
        .context("--rollback needs --rollback-prompt")?;

    let mut engine = RollbackEngine::load(model_dir, &args.repe)?;
    let codec = TokenCodec::from_model_dir(model_dir);

    let rule = resolve_trip_threshold(&engine.repe_sensor, args.rollback_trip_threshold);
    let config = RollbackConfig {
        alpha: args.rollback_alpha,
        max_tokens: args.rollback_max_tokens,
        trip_threshold: rule.threshold,
        trip_rule: rule.rule,
        max_rollbacks: args.rollback_max_rollbacks,
    };

    // The canonical context: the trusted user turn followed by the
    // assistant's tool-call prefix. The model writes the call itself.
    let context = qwen_clef_repe_guard::repe_sensor::tool_call_span_prefix(prompt);

    let outcome = generate_with_guard(&mut engine, &codec, &context, &config)?;
    println!("{}", serde_json::to_string_pretty(&outcome)?);
    Ok(())
}

/// Check that the shared KV cache reproduces the plain forward pass.
///
/// The plain pass runs the whole prompt through the stack at once; the cached
/// pass prefills a prefix and appends the rest at their own positions. The
/// two final hidden states — and the next-token logits derived from them —
/// have to agree.
fn run_verify_cache(args: &Args) -> Result<()> {
    let model_dir = args
        .model
        .as_ref()
        .context("--verify-cache needs --model pointing at a checkpoint")?;
    let prompt = args
        .rollback_prompt
        .as_ref()
        .context("--verify-cache needs --rollback-prompt")?;
    let codec = TokenCodec::from_model_dir(model_dir);
    let context = qwen_clef_repe_guard::repe_sensor::tool_call_span_prefix(prompt);
    let ids = codec.encode(&context);
    let parity = verify_cache_parity(model_dir, &args.repe, &ids, args.verify_cache_split)?;
    println!("{}", serde_json::to_string_pretty(&parity)?);
    Ok(())
}

async fn serve(
    args: Args,
    spec: EngineSpec,
    tokenizer: PromptEncoder,
    config: EnforcerConfig,
    info: EngineInfo,
) -> Result<()> {
    let mode = config.mode;
    let enforcer = Enforcer::spawn(spec, tokenizer, config, info)?;
    let app = enforcer.router();
    let addr = format!("127.0.0.1:{}", args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(
        %addr,
        upstream = %args.upstream,
        mode = ?mode,
        "qwen-clef-repe-guard listening — telemetry dashboard at http://{addr}/"
    );
    axum::serve(listener, app).await?;
    Ok(())
}

/// Immediate end-to-end smoke test of the RepE hook + Clef head.
async fn run_self_test(
    spec: EngineSpec,
    tokenizer: PromptEncoder,
    config: EnforcerConfig,
    info: EngineInfo,
) -> Result<()> {
    let enforcer = Enforcer::spawn(spec, tokenizer, config, info)?;

    let probe = ToolCallProbe {
        prompt: "Refactor the parser and run the test suite.".to_string(),
        tool_name: "shell".to_string(),
        tool_args: serde_json::json!({ "cmd": "cargo test" }),
        questions: default_questions(),
        option_embeddings: Vec::new(),
        untrusted_context: Vec::new(),
        conversation_id: None,
    };

    let verdict = enforcer.judge(probe).await?;
    println!("{}", serde_json::to_string_pretty(&verdict)?);
    Ok(())
}
