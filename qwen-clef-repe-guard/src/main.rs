use anyhow::Result;
use clap::Parser;
use qwen_clef_repe_guard::enforcer_proxy::{
    default_questions, EngineInfo, EngineSpec, Enforcer, EnforcerConfig, EnforcementMode,
    PromptEncoder, ToolCallProbe,
};
use qwen_clef_repe_guard::zero_shot_loader::UniversalModelRuntime;
use std::path::PathBuf;

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
