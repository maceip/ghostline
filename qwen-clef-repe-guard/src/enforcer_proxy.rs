use crate::access::{AccessConfig, AuthOutcome, RateLimiter, check_bearer, client_key};
use crate::clef_head::{ClefDecision, ClefQuestion, ClefSchemaHead};
use crate::mlx_loader::{QwenLoadedLayer, ShardedModelLoader};
use crate::session::{
    SessionConfig, SessionIssuer, SessionLookup, device_hash as compute_device_hash, parse_cookies,
    random_hex, set_cookie, unix_now,
};
use crate::qwen_hook::{GuardableEngine, HookedQwenClefEngine};
use crate::repe_sensor::{
    render_reference_tool_call_turn, render_tool_call_turn, render_user_turn, tool_call_span_prefix,
    untrusted_attention_ratio, RepeProbeTelemetry, RepeSensor, BENIGN_REFERENCE_COMMANDS,
};
use crate::trajectory::ExcessTrajectory;
use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Extension, Request, State, connect_info::ConnectInfo},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{
            ACCEPT_LANGUAGE, AUTHORIZATION, COOKIE, SET_COOKIE, USER_AGENT, WWW_AUTHENTICATE,
        },
    },
    middleware::{self, Next},
    response::{
        Html, IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use std::convert::Infallible;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio_stream::StreamExt;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use mlx_rs::{Array, ops::*};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Instant;
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

/// A single tool call submitted for judging.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallProbe {
    /// Conversation context ending at the assistant turn that emitted the tool call.
    #[serde(default)]
    pub prompt: String,
    /// Name of the tool the agent wants to invoke.
    #[serde(default)]
    pub tool_name: String,
    /// JSON arguments the agent wants to pass to the tool.
    #[serde(default)]
    pub tool_args: serde_json::Value,
    /// Typed Clef questions evaluated against the final hidden state.
    #[serde(default)]
    pub questions: Vec<ClefQuestion>,
    /// Optional option embeddings per question: `[question][option][d_model]`.
    #[serde(default)]
    pub option_embeddings: Vec<Vec<Vec<f32>>>,
    /// The parts of the context that came from an UNTRUSTED source — a file
    /// the agent read, a tool response, a web page.
    ///
    /// These are matched literally inside `prompt`. The guard measures how
    /// much of the tool call's attention landed on them, which is the
    /// provenance of the call: a command whose content was dictated by an
    /// untrusted span is a command the agent was steered into.
    ///
    /// Empty means the caller declared nothing untrusted — not that the
    /// context was clean.
    #[serde(default)]
    pub untrusted_context: Vec<String>,
    /// Which conversation this call belongs to.
    ///
    /// The cross-turn trajectory is accumulated per conversation: an agent
    /// that escalates across the turns of ONE conversation is the signal.
    /// Calls from different conversations must not accumulate into each
    /// other, so the trajectory is keyed by this id.
    ///
    /// `None` means the caller did not say — the proxy then keys the
    /// trajectory by the prompt itself, so two unrelated calls never share
    /// one.
    #[serde(default)]
    pub conversation_id: Option<String>,
}

/// The token ranges the untrusted text occupies in the rendered context.
///
/// The pieces are matched literally inside the prompt. The offsets are
/// taken on the FULL rendered context, so the ranges line up with the
/// sequence the model actually saw.
///
/// A piece that cannot be found is skipped rather than guessed: a range
/// pointing at the wrong tokens would measure the wrong provenance.
fn untrusted_token_ranges(
    encoder: &PromptEncoder,
    full_text: &str,
    prompt: &str,
    untrusted: &[String],
) -> Vec<(usize, usize)> {
    if untrusted.is_empty() {
        return Vec::new();
    }
    let prompt_offset = match full_text.find(prompt) {
        Some(offset) => offset,
        None => return Vec::new(),
    };
    let offsets = encoder.encode_offsets(full_text);
    let mut ranges = Vec::new();
    for piece in untrusted {
        if piece.is_empty() {
            continue;
        }
        let Some(rel_start) = prompt.find(piece.as_str()) else {
            continue;
        };
        let char_start = prompt_offset + rel_start;
        let char_end = char_start + piece.len();
        let mut lo = usize::MAX;
        let mut hi = 0usize;
        for (index, (_id, start, end)) in offsets.iter().enumerate() {
            // A token that straddles the boundary still carries part of the
            // untrusted text, so it counts.
            if *end > char_start && *start < char_end {
                lo = lo.min(index);
                hi = hi.max(index + 1);
            }
        }
        if lo < hi {
            ranges.push((lo, hi));
        }
    }
    ranges
}

/// A stable, process-independent hash of a string.
///
/// FNV-1a: cheap, and good enough to bucket conversations. It is not a
/// security primitive — it only has to separate different prompts.
fn stable_hash(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The index of the first token of the tool-call span.
///
/// The tokenizer may merge the last token of the prefix with the first token
/// of the span, so the span is taken to begin at the first token where the
/// two token sequences differ.
fn tool_span_start(prefix_ids: &[u32], full_ids: &[u32]) -> usize {
    let mut common = 0usize;
    while common < prefix_ids.len()
        && common < full_ids.len()
        && prefix_ids[common] == full_ids[common]
    {
        common += 1;
    }
    common.min(full_ids.len().saturating_sub(1))
}

/// A short, human-readable preview of the arguments a tool call carried.
///
/// The dashboard shows this so a reader can see *which* command the guard
/// judged, not merely that something was blocked.
fn preview_tool_args(args: &serde_json::Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(map) = args.as_object() {
        for (key, value) in map {
            let text = match value {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                other => other.to_string(),
            };
            parts.push(format!("{key}={text}"));
        }
    } else {
        parts.push(args.to_string());
    }
    let joined = parts.join("  ");
    if joined.chars().count() > 120 {
        let mut out: String = joined.chars().take(117).collect();
        out.push_str("...");
        out
    } else {
        joined
    }
}

/// The guard's answer: allow or refuse the tool call, and why.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeVerdict {
    pub allowed: bool,
    pub reason: String,
    /// Signals that are reported but never block on their own.
    #[serde(default)]
    pub advisories: Vec<String>,
    pub tool_name: String,
    /// The command the agent wanted to run, as it appeared in the tool call.
    /// Echoed so the dashboard shows *what* was judged, not just the verdict.
    pub tool_args_preview: String,
    pub harm_cosine: f32,
    /// The harm reading of the per-session benign baseline call.
    pub harm_baseline: f32,
    /// Which baseline the reading was compared against: `matched-panel` (the
    /// calibrated panel, each reference measured under the instruction it
    /// answers) or `live-panel` (measured in the live context).
    #[serde(default)]
    pub baseline_mode: String,
    /// `harm_cosine - harm_baseline` — the prompt-invariant statistic the
    /// calibrated excess threshold applies to.
    pub harm_excess: f32,
    pub drift_cosine: f32,
    pub pca_subspace_energy: f32,
    /// The PCA coordinates of the intercepted call, captured before the
    /// baseline pass overwrites the sensor's state.
    pub pca_coords: Vec<f32>,
    pub clamped_in_place: bool,
    /// The per-cluster harm readings of the intercepted call.
    #[serde(default)]
    pub cluster_scores: Vec<f32>,
    /// The token inside the tool-call span that carried the peak reading.
    #[serde(default)]
    pub attribution_token_index: Option<usize>,
    /// The text of the attributed token.
    #[serde(default)]
    pub attribution_token: String,
    /// Which harm cluster the attributed token belonged to.
    #[serde(default)]
    pub attribution_cluster: Option<usize>,
    /// The un-pooled cosine of the attributed token against its cluster.
    #[serde(default)]
    pub attribution_cosine: f32,
    /// How many tokens the tool-call span covered.
    #[serde(default)]
    pub span_tokens: usize,
    /// The share of the tool call's attention that landed on the untrusted
    /// part of the context. `None` when nothing was declared untrusted.
    #[serde(default)]
    pub untrusted_attention_ratio: Option<f32>,
    /// The session's exponentially-weighted average of the per-cluster excess.
    #[serde(default)]
    pub ema_excess: Vec<f32>,
    /// The per-turn slope of each cluster's excess over the session.
    #[serde(default)]
    pub ema_slope: Vec<f32>,
    /// How many turns the trajectory has accumulated.
    #[serde(default)]
    pub trajectory_turns: usize,
    pub clef_decisions: Vec<ClefDecision>,
}

/// Whether the proxy refuses unsafe tool calls or only reports them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnforcementMode {
    /// Refuse the unsafe tool call with a 403 and never hand it to the agent.
    Enforce,
    /// Pass the tool call through, but record and report the verdict.
    Monitor,
}

#[derive(Debug, Clone)]
pub struct EnforcerConfig {
    pub upstream_url: String,
    pub block_threshold: f32,
    pub mode: EnforcementMode,
    pub clamp_threshold: f32,
    pub clem_temperature: f32,
    /// Bearer authentication and rate limiting for the HTTP surface.
    ///
    /// Both are off by default, so a local run is unchanged.
    pub access: AccessConfig,
    /// Device-bound sessions for the public surface.
    pub session: SessionConfig,
}

/// How the engine inside the worker thread should be built.
#[derive(Debug, Clone)]
pub enum EngineSpec {
    /// A real checkpoint on disk.
    Real {
        model_dir: PathBuf,
        repe_vectors: PathBuf,
        joint_head: Option<PathBuf>,
        max_layer: Option<usize>,
    },
    /// Random weights shaped like the calibrated vectors — no checkpoint needed.
    Synthetic {
        repe_vectors: PathBuf,
        n_layers: usize,
    },
}

impl EngineSpec {
    fn build(&self) -> Result<Box<dyn GuardableEngine>> {
        match self {
            EngineSpec::Real {
                model_dir,
                repe_vectors,
                joint_head,
                max_layer,
            } => {
                let loader = ShardedModelLoader::open(model_dir, *max_layer)?;
                if loader.config.is_hybrid_attention() {
                    anyhow::bail!(
                        "checkpoint at {:?} uses a hybrid linear-attention stack; the reference \
                         decoder block in this crate implements the dense stack only. Calibrate \
                         with the Python extractor (mlx_lm) and serve the backbone from mlx_lm.",
                        model_dir
                    );
                }

                let layer_count = loader.detected_layer_count();
                let repe = RepeSensor::load_safetensors(repe_vectors, 0, Some(0.45))?;
                let target_layer = repe.target_layer.min(layer_count.saturating_sub(1));

                // Load the WHOLE stack: the Clef joint head is trained on the
                // final-layer residual, and the dashboard plots the RepE
                // profile across every decoder layer — both need the layers
                // above the probe. `max_layer` caps the depth for operators
                // who want a cheaper pass.
                let last_layer = max_layer
                    .unwrap_or(layer_count.saturating_sub(1))
                    .min(layer_count.saturating_sub(1));
                let mut layers = Vec::with_capacity(last_layer + 1);
                for i in 0..=last_layer {
                    layers.push(loader.load_layer(i)?);
                }

                let embed_tokens = loader.load_embed_tokens_f32()?;
                let final_norm_weight = loader.load_final_norm()?;

                let clef_head = match joint_head {
                    Some(path) => {
                        let d_head = clef_head_width(path)?;
                        Some(ClefSchemaHead::load_safetensors(path, d_head, 1.0)?)
                    }
                    None => {
                        // No trained head for this backbone -> no head. A random
                        // head cannot judge anything, so one is never invented.
                        tracing::warn!(
                            "no --joint-head supplied: the Clef questions are DISABLED \
                             (an untrained head cannot judge; nothing is fabricated)"
                        );
                        None
                    }
                };

                let mut repe = repe;
                repe.target_layer = target_layer;

                Ok(Box::new(HookedQwenClefEngine {
                    embed_tokens,
                    layers,
                    final_norm_weight,
                    repe_sensor: repe,
                    clef_head,
                    capture_attention: false,
                }))
            }
            EngineSpec::Synthetic {
                repe_vectors,
                n_layers,
            } => {
                let repe = RepeSensor::load_safetensors(repe_vectors, 0, Some(0.45))?;
                let d_model = repe.v_harm.shape()[0];
                let target_layer = ((*n_layers as f32) * 0.68).round() as usize;

                let embed_tokens = multiply(
                    &mlx_rs::random::normal::<f32>(&[256, d_model], None, None, None)?,
                    &Array::from_f32(0.02),
                )?;
                let mut layers = Vec::with_capacity(*n_layers);
                for _ in 0..*n_layers {
                    layers.push(QwenLoadedLayer::synthetic(d_model)?);
                }
                let final_norm_weight = Array::ones::<f32>(&[d_model])?;
                // The synthetic backbone has no trained joint head either.
                let clef_head: Option<ClefSchemaHead> = None;

                let mut repe = repe;
                repe.target_layer = target_layer.min(n_layers.saturating_sub(1));

                Ok(Box::new(HookedQwenClefEngine {
                    embed_tokens,
                    layers,
                    final_norm_weight,
                    repe_sensor: repe,
                    clef_head,
                    capture_attention: false,
                }))
            }
        }
    }
}

/// The head width of a `joint_head.safetensors` file.
fn clef_head_width(path: &Path) -> Result<usize> {
    let tensors: std::collections::HashMap<String, Array> = Array::load_safetensors(path)
        .with_context(|| format!("Failed to inspect Clef head at {:?}", path))?;
    let width = tensors
        .get("question_projection.weight")
        .map(|a| a.shape()[0] as usize)
        .or_else(|| {
            tensors
                .get("clef_head.w_q_option")
                .map(|a| a.shape()[1] as usize)
        })
        .context("Cannot determine the Clef head width")?;
    Ok(width)
}

/// Tokenizer front-end: the real BPE when it can be found, otherwise a
/// deterministic byte-level fallback so the guard never hard-fails offline.
pub struct PromptEncoder {
    tokenizer: Option<tokenizers::Tokenizer>,
    vocab_size: i32,
}

impl PromptEncoder {
    pub fn from_local(path: &Path) -> Self {
        let loaded = tokenizers::Tokenizer::from_file(path)
            .ok()
            .filter(|t| t.get_vocab_size(true) > 0);
        match loaded {
            Some(t) => {
                let vocab = t.get_vocab_size(true) as i32;
                info!(path = %path.display(), vocab_size = vocab, "loaded tokenizer");
                Self {
                    tokenizer: Some(t),
                    vocab_size: vocab,
                }
            }
            None => {
                warn!(path = %path.display(), "tokenizer unavailable — byte-level fallback");
                Self {
                    tokenizer: None,
                    vocab_size: 256,
                }
            }
        }
    }

    pub fn from_hub(repo_id: &str) -> Self {
        let fetched = (|| -> Option<tokenizers::Tokenizer> {
            let api = hf_hub::api::sync::Api::new().ok()?;
            let repo = api.repo(hf_hub::Repo::with_revision(
                repo_id.to_string(),
                hf_hub::RepoType::Model,
                "main".to_string(),
            ));
            let path = repo.get("tokenizer.json").ok()?;
            tokenizers::Tokenizer::from_file(&path).ok()
        })();

        match fetched {
            Some(t) => {
                let vocab = t.get_vocab_size(true) as i32;
                info!(repo_id, vocab_size = vocab, "loaded tokenizer from Hugging Face");
                Self {
                    tokenizer: Some(t),
                    vocab_size: vocab,
                }
            }
            None => {
                warn!(repo_id, "tokenizer unavailable — byte-level fallback");
                Self {
                    tokenizer: None,
                    vocab_size: 256,
                }
            }
        }
    }

    pub fn encode(&self, text: &str) -> Vec<u32> {
        match &self.tokenizer {
            Some(tok) => tok
                .encode(text, false)
                .map(|enc| enc.get_ids().to_vec())
                .unwrap_or_else(|_| byte_fallback(text)),
            None => byte_fallback(text),
        }
    }

    /// Decode a single token back to its text.
    ///
    /// This is what turns the attribution index into something a human can
    /// read: "the `rm` token carried the peak".
    pub fn decode_token(&self, id: u32) -> String {
        match &self.tokenizer {
            Some(tok) => tok
                .decode(&[id], true)
                .unwrap_or_default()
                .trim()
                .to_string(),
            None => String::new(),
        }
    }

    /// Encode with character offsets: `(token id, start, end)`.
    ///
    /// The offsets are what map a piece of untrusted text onto the token
    /// range it occupies in the rendered context.
    pub fn encode_offsets(&self, text: &str) -> Vec<(u32, usize, usize)> {
        match &self.tokenizer {
            Some(tok) => match tok.encode(text, true) {
                Ok(enc) => enc
                    .get_ids()
                    .iter()
                    .copied()
                    .zip(enc.get_offsets().iter().copied())
                    .map(|(id, (start, end))| (id, start, end))
                    .collect(),
                Err(_) => text
                    .as_bytes()
                    .iter()
                    .enumerate()
                    .map(|(i, b)| (*b as u32, i, i + 1))
                    .collect(),
            },
            None => text
                .as_bytes()
                .iter()
                .enumerate()
                .map(|(i, b)| (*b as u32, i, i + 1))
                .collect(),
        }
    }
}

/// One token per UTF-8 byte, kept inside the mock vocabulary range.
fn byte_fallback(text: &str) -> Vec<u32> {
    text.as_bytes().iter().map(|b| *b as u32).collect()
}

/// What the guard knows about the model it is guarding.
#[derive(Debug, Clone, Serialize)]
pub struct EngineInfo {
    pub architecture: String,
    pub num_layers: usize,
    pub d_model: i32,
    pub calibration_mode: String,
    pub weight_quant_summary: String,
}

/// One intercepted tool call, as broadcast to the dashboard.
#[derive(Debug, Clone, Serialize)]
pub struct TelemetryEvent {
    pub ts_ms: u64,
    pub tool_name: String,
    /// The command the intercepted call carried.
    pub tool_args_preview: String,
    pub allowed: bool,
    pub reason: String,
    pub advisories: Vec<String>,
    pub harm_cosine: f32,
    pub harm_baseline: f32,
    /// Which baseline the reading was compared against.
    #[serde(default)]
    pub baseline_mode: String,
    pub harm_excess: f32,
    pub drift_cosine: f32,
    pub pca_subspace_energy: f32,
    pub pca_coords: Vec<f32>,
    pub clamped_in_place: bool,
    /// The per-cluster harm readings of the intercepted call.
    #[serde(default)]
    pub cluster_scores: Vec<f32>,
    /// The token inside the tool-call span that carried the peak reading.
    #[serde(default)]
    pub attribution_token_index: Option<usize>,
    /// The text of the attributed token, decoded from the tokenizer.
    #[serde(default)]
    pub attribution_token: String,
    /// Which harm cluster the attributed token belonged to.
    #[serde(default)]
    pub attribution_cluster: Option<usize>,
    /// The un-pooled cosine of the attributed token against its cluster.
    #[serde(default)]
    pub attribution_cosine: f32,
    /// How many tokens the tool-call span covered.
    #[serde(default)]
    pub span_tokens: usize,
    /// The share of the tool call's attention that landed on the untrusted
    /// part of the context. `None` when nothing was declared untrusted.
    #[serde(default)]
    pub untrusted_attention_ratio: Option<f32>,
    /// The session's exponentially-weighted average of the per-cluster excess.
    #[serde(default)]
    pub ema_excess: Vec<f32>,
    /// The per-turn slope of each cluster's excess over the session.
    #[serde(default)]
    pub ema_slope: Vec<f32>,
    /// How many turns the trajectory has accumulated.
    #[serde(default)]
    pub trajectory_turns: usize,
    pub circuit_broken: bool,
    pub layer_profile: Vec<f32>,
    pub probe_layer: usize,
    pub num_layers: usize,
    pub d_model: i32,
    pub architecture: String,
    pub calibration_mode: String,
    pub weight_quant_summary: String,
    pub clef: Vec<ClefDecision>,
    /// Whether the Clef head carries trained weights. When false the Clef
    /// questions were not evaluated at all — no head is fabricated, so the
    /// dashboard must say "unavailable" rather than show a made-up
    /// distribution.
    pub clef_head_calibrated: bool,
    /// The arguments the intercepted call carried, in full.
    ///
    /// The preview above is truncated for display; a label has to record the
    /// arguments as they were, because the calibration re-probes the call
    /// through the real backbone and needs the command, not a fragment of it.
    #[serde(default)]
    pub tool_args: serde_json::Value,
}

/// The two judgements a human can give an intercepted call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SiteLabel {
    /// The call did what it was asked to do.
    Benign,
    /// The call was destructive, exfiltrating or otherwise unsafe.
    Harmful,
}

impl SiteLabel {
    /// Parse a label off the wire.
    ///
    /// Only the two exact words are accepted. A label that is neither is not a
    /// judgement, and guessing which of the two was meant would put a
    /// fabricated sample into the calibration set.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "benign" => Some(SiteLabel::Benign),
            "harmful" => Some(SiteLabel::Harmful),
            _ => None,
        }
    }

    /// The label as it is written into the calibration file.
    pub fn as_str(&self) -> &'static str {
        match self {
            SiteLabel::Benign => "benign",
            SiteLabel::Harmful => "harmful",
        }
    }
}

/// One labelled call, as it is appended to the calibration file.
///
/// The record carries the READINGS the guard measured, not the hidden states:
/// the states are not recoverable from a file of numbers, so the calibration
/// re-probes the call through the real backbone to recover them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteLabelRecord {
    /// The tool the agent wanted to invoke.
    pub tool_name: String,
    /// The arguments it wanted to pass.
    pub tool_args: serde_json::Value,
    /// The human's judgement: `"benign"` or `"harmful"`.
    pub label: String,
    /// The harm reading of the call.
    pub harm_cosine: f32,
    /// The baseline the reading was compared against.
    pub harm_baseline: f32,
    /// The reading's excess over that baseline.
    pub harm_excess: f32,
    /// Which baseline was used.
    pub baseline_mode: String,
    /// The per-cluster readings of the call.
    pub cluster_scores: Vec<f32>,
    /// When the call was intercepted, in milliseconds since the epoch.
    pub ts_ms: u64,
}

/// The environment variable that says where the labels are written.
pub const SITE_CALIBRATION_ENV: &str = "ZCODE_SITE_CALIBRATION";

/// Where the labels are written when the environment does not say.
pub const SITE_CALIBRATION_DEFAULT: &str = "artifacts/site_calibration.jsonl";

/// The file the labels are appended to.
///
/// The location is read from the environment rather than from
/// [`EnforcerConfig`], so that the calibration file can be pointed somewhere
/// else without every construction site of the config having to learn about
/// it.
pub fn site_calibration_path() -> PathBuf {
    match std::env::var_os(SITE_CALIBRATION_ENV) {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => PathBuf::from(SITE_CALIBRATION_DEFAULT),
    }
}

/// Append one label to the calibration file.
///
/// The write is durable: the file is opened in append mode, the line is
/// written, flushed and pushed to the disk before the call returns. A label
/// that only reached the page cache is a label that never existed.
pub fn append_site_label(path: &Path, record: &SiteLabelRecord) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Failed creating the calibration directory {parent:?}"))?;
        }
    }
    let mut line = serde_json::to_string(record)?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("Failed opening the calibration file {path:?}"))?;
    file.write_all(line.as_bytes())
        .with_context(|| format!("Failed appending a label to {path:?}"))?;
    file.flush()?;
    file.sync_data()?;
    Ok(())
}

/// Commands sent to the dedicated MLX engine thread.
enum EngineCommand {
    Probe {
        probe: ToolCallProbe,
        block_threshold: f32,
        reply: oneshot::Sender<Result<ProbeVerdict, String>>,
    },
}

/// The blocking tool-call enforcer.
#[derive(Clone)]
pub struct Enforcer {
    tx: mpsc::Sender<EngineCommand>,
    pub config: EnforcerConfig,
    /// Live telemetry, fanned out to every connected dashboard.
    pub events: broadcast::Sender<TelemetryEvent>,
    info: EngineInfo,
    /// The per-client rate limiter, shared by every request.
    ///
    /// `None` when no ceiling is configured — an unlimited guard must not
    /// pay for a map it never uses.
    limiter: Option<Arc<RateLimiter>>,
    /// The session issuer, shared by every request.
    ///
    /// Sessions are stateless: the cookie carries its own signed claims,
    /// so this holds the signing secret and the revocation list, not a
    /// table of live sessions.
    pub sessions: Arc<SessionIssuer>,
}

impl Enforcer {
    /// Spawns the engine thread and returns a handle to it.
    ///
    /// `mlx_rs::Array` is not `Send`, so the engine is *built* inside the worker
    /// thread and only plain data travels over the channel.
    pub fn spawn(
        spec: EngineSpec,
        tokenizer: PromptEncoder,
        config: EnforcerConfig,
        info: EngineInfo,
    ) -> Result<Self> {
        let (tx, rx) = mpsc::channel::<EngineCommand>();
        let (events, _) = broadcast::channel::<TelemetryEvent>(256);
        let engine_events = events.clone();
        let engine_info = info.clone();
        let limiter = config
            .access
            .rate_limit_per_minute
            .map(|rpm| Arc::new(RateLimiter::new(rpm)));
        let sessions = Arc::new(SessionIssuer::new(config.session.clone()));
        std::thread::Builder::new()
            .name("mlx-engine".to_string())
            .spawn(move || {
                let mut engine = match spec.build() {
                    Ok(engine) => engine,
                    Err(err) => {
                        warn!(error = %err, "MLX engine failed to start");
                        return;
                    }
                };
                // The cross-turn trajectories live with the engine, one per
                // conversation.
                let mut trajectories: std::collections::HashMap<String, ExcessTrajectory> =
                    std::collections::HashMap::new();
                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        EngineCommand::Probe {
                            probe,
                            block_threshold,
                            reply,
                        } => {
                            let outcome = evaluate_probe(
                                engine.as_mut(),
                                &tokenizer,
                                &probe,
                                block_threshold,
                                &mut trajectories,
                            )
                            .map_err(|e| format!("{e:#}"));
                            if let Ok(verdict) = &outcome {
                                let _ = engine_events.send(TelemetryEvent {
                                    ts_ms: std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|d| d.as_millis() as u64)
                                        .unwrap_or(0),
                                    tool_name: verdict.tool_name.clone(),
                                    tool_args_preview: verdict.tool_args_preview.clone(),
                                    allowed: verdict.allowed,
                                    reason: verdict.reason.clone(),
                                    advisories: verdict.advisories.clone(),
                                    harm_cosine: verdict.harm_cosine,
                                    harm_baseline: verdict.harm_baseline,
                                    baseline_mode: verdict.baseline_mode.clone(),
                                    harm_excess: verdict.harm_excess,
                                    drift_cosine: verdict.drift_cosine,
                                    pca_subspace_energy: verdict.pca_subspace_energy,
                                    pca_coords: verdict.pca_coords.clone(),
                                    clamped_in_place: verdict.clamped_in_place,
                                    cluster_scores: verdict.cluster_scores.clone(),
                                    attribution_token_index: verdict.attribution_token_index,
                                    attribution_token: verdict.attribution_token.clone(),
                                    attribution_cluster: verdict.attribution_cluster,
                                    attribution_cosine: verdict.attribution_cosine,
                                    span_tokens: verdict.span_tokens,
                                    untrusted_attention_ratio: verdict.untrusted_attention_ratio,
                                    ema_excess: verdict.ema_excess.clone(),
                                    ema_slope: verdict.ema_slope.clone(),
                                    trajectory_turns: verdict.trajectory_turns,
                                    circuit_broken: false,
                                    layer_profile: engine.layer_profile().to_vec(),
                                    probe_layer: engine.target_layer(),
                                    num_layers: engine.num_layers(),
                                    d_model: engine.d_model(),
                                    architecture: engine_info.architecture.clone(),
                                    calibration_mode: engine_info.calibration_mode.clone(),
                                    weight_quant_summary: engine_info.weight_quant_summary.clone(),
                                    clef: verdict.clef_decisions.clone(),
                                    clef_head_calibrated: engine.clef_head_calibrated(),
                                    tool_args: probe.tool_args.clone(),
                                });
                            }
                            let _ = reply.send(outcome);
                        }
                    }
                }
            })
            .context("failed to spawn the MLX engine thread")?;
        Ok(Self {
            tx,
            config,
            events,
            info,
            limiter,
            sessions,
        })
    }

    /// Judge one tool call.
    pub async fn judge(&self, probe: ToolCallProbe) -> Result<ProbeVerdict> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(EngineCommand::Probe {
                probe,
                block_threshold: self.config.block_threshold,
                reply: reply_tx,
            })
            .map_err(|_| anyhow::anyhow!("the MLX engine thread is not running"))?;

        match reply_rx.await {
            Ok(Ok(verdict)) => Ok(verdict),
            Ok(Err(e)) => Err(anyhow::anyhow!(e)),
            Err(_) => Err(anyhow::anyhow!("the MLX engine thread dropped the request")),
        }
    }

    /// The HTTP surface of the guard.
    ///
    /// The access-control layer carries its own copy of the state, so it
    /// does not depend on the router's state type.
    ///
    /// The router must be served through
    /// `into_make_service_with_connect_info::<SocketAddr>()`: the access
    /// layer reads the socket peer to identify a client.
    pub fn router(&self) -> Router {
        let state = EnforcerState {
            enforcer: self.clone(),
        };
        Router::new()
            .route("/", get(index))
            .route("/health", get(health))
            .route("/api/events", get(events_stream))
            .route("/api/info", get(engine_info))
            .route("/v1/guard/tool-call", post(guard_tool_call))
            .route("/v1/chat/completions", post(proxy_chat_completions))
            .route("/api/label", post(record_label))
            .route(
                "/api/session",
                get(session_status).post(session_issue),
            )
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                access_guard,
            ))
            .with_state(state)
    }
}

/// The access-control layer.
///
/// Three things happen here, in this order:
///
/// 1. **The device is identified.** A second, device-only cookie is
///    required alongside the session cookie, and the session is bound to
///    it together with the request's user-agent. A session cookie copied
///    into another browser does not work on its own.
/// 2. **The caller is admitted.** A bearer token (the operator's
///    credential) or a live session. When no token is configured — the
///    local case — nothing is required, so the local workflow and the
///    benchmark harnesses behave exactly as they always have.
/// 3. **The caller is rate limited.** The per-IP backstop. The limit that
///    protects a public deployment lives at the edge, at Caddy, keyed by
///    client IP.
///
/// `/health` is exempt from all three: it is the liveness probe the
/// supervisor polls, and it exposes nothing but the service name.
/// `/api/session` is exempt from the credential check — it is the
/// admission step, so it has to be reachable by somebody who does not
/// have a session yet.
async fn access_guard(
    State(state): State<EnforcerState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Response {
    let access = &state.enforcer.config.access;
    let path = request.uri().path().to_string();

    if path == "/health" {
        return next.run(request).await;
    }

    // ---------------------------------------------------------------------
    // The device.
    // ---------------------------------------------------------------------
    let cookies = headers
        .get(COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(parse_cookies)
        .unwrap_or_default();
    let sent_device = cookies
        .get(&state.enforcer.config.session.device_cookie)
        .cloned();
    let device_cookie_is_new = sent_device.is_none();
    let device_cookie = sent_device.unwrap_or_else(|| random_hex(32));
    let user_agent = headers
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let accept_language = headers
        .get(ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let device_hash = compute_device_hash(&device_cookie, user_agent, accept_language);

    // ---------------------------------------------------------------------
    // The session.
    // ---------------------------------------------------------------------
    let sent_session = cookies
        .get(&state.enforcer.config.session.session_cookie)
        .cloned();
    let lookup = state
        .enforcer
        .sessions
        .lookup(sent_session.as_deref(), &device_hash, unix_now());
    let session_id = match &lookup {
        SessionLookup::Active(claims) => Some(claims.id.clone()),
        _ => None,
    };
    let session_expires_in = match &lookup {
        SessionLookup::Active(claims) => Some(claims.expires_in_secs(unix_now())),
        _ => None,
    };

    // ---------------------------------------------------------------------
    // The credential.
    // ---------------------------------------------------------------------
    // With no token configured the guard is in its local mode: nothing is
    // required. With a token configured — and a routable bind always has
    // one — a caller has to present either that token or a live session.
    let bearer_ok = match access.token() {
        Some(expected) => {
            let header = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok());
            check_bearer(header, expected) == AuthOutcome::Ok
        }
        None => true,
    };

    if path != SESSION_ROUTE && !bearer_ok && session_id.is_none() {
        let reason = match &lookup {
            SessionLookup::WrongDevice => "this session belongs to another device",
            SessionLookup::Expired => "this session has expired",
            SessionLookup::Invalid => "this session is not valid",
            _ => "no session",
        };
        warn!(path = %path, reason = %reason, "rejected: no credential");
        let body = serde_json::json!({
            "error": "session_required",
            "reason": reason,
            "hint": "POST /api/session to get one",
        });
        return (
            StatusCode::UNAUTHORIZED,
            [(WWW_AUTHENTICATE, "Bearer")],
            Json(body),
        )
            .into_response();
    }

    // ---------------------------------------------------------------------
    // The backstop rate limit.
    // ---------------------------------------------------------------------
    let mut decision = None;
    if let Some(limiter) = state.enforcer.limiter.as_ref() {
        let forwarded = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok());
        let key = client_key(
            Some(peer),
            forwarded,
            access.trust_proxy,
            access.trust_any_peer,
        );
        let verdict = limiter.check(&key, Instant::now());
        if !verdict.allowed {
            debug!(client = %key, limit = verdict.limit, "rejected: rate limit");
            let body = serde_json::json!({
                "error": "rate_limited",
                "limit_per_minute": verdict.limit,
                "retry_after_seconds": verdict.retry_after_secs,
            });
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", verdict.retry_after_secs.to_string())],
                Json(body),
            )
                .into_response();
        }
        decision = Some(verdict);
    }

    // ---------------------------------------------------------------------
    // Hand the session to the handler.
    // ---------------------------------------------------------------------
    request.extensions_mut().insert(SessionContext {
        session_id,
        session_expires_in,
        device_hash,
        device_cookie: device_cookie.clone(),
        device_cookie_is_new,
        // The socket peer, never a forwarded header: this is the address the
        // guard itself saw, which is the only one it can vouch for.
        ip: client_key(Some(peer), None, false, false),
    });

    let mut response = next.run(request).await;

    if device_cookie_is_new {
        let header = set_cookie(
            &state.enforcer.config.session.device_cookie,
            &device_cookie,
            crate::session::DEVICE_COOKIE_MAX_AGE_SECS,
            state.enforcer.config.session.cookie_secure,
        );
        if let Ok(value) = HeaderValue::from_str(&header) {
            response.headers_mut().append(SET_COOKIE, value);
        }
    }

    if let Some(verdict) = decision {
        let headers = response.headers_mut();
        if let Ok(value) = HeaderValue::from_str(&verdict.limit.to_string()) {
            headers.insert("x-ratelimit-limit", value);
        }
        if let Ok(value) = HeaderValue::from_str(&verdict.remaining.to_string()) {
            headers.insert("x-ratelimit-remaining", value);
        }
    }
    response
}

/// The route that mints a session.
const SESSION_ROUTE: &str = "/api/session";

/// What the access layer worked out about the caller.
#[derive(Clone, Debug)]
pub struct SessionContext {
    /// The live session id, when there is one.
    pub session_id: Option<String>,
    /// How many seconds the live session has left, when there is one.
    pub session_expires_in: Option<u64>,
    /// The device hash the session is bound to.
    pub device_hash: String,
    /// The device cookie value in play — the one the client sent, or the
    /// fresh one the server just minted.
    pub device_cookie: String,
    /// Whether the device cookie is new and has to be sent back.
    pub device_cookie_is_new: bool,
    /// The client address.
    pub ip: String,
}

#[derive(Clone)]
struct EnforcerState {
    enforcer: Enforcer,
}

/// Build the `[1, seq_len]` input id matrix for a token list.
///
/// The dtype is `int32` because the embedding lookup is a `gather`, which
/// requires integral indices.
fn input_ids_matrix(ids: &[u32], vocab_size: i32) -> Array {
    let vocab = vocab_size.max(1) as usize;
    let mut flat: Vec<i32> = ids
        .iter()
        .map(|i| (*i as usize % vocab) as i32)
        .collect();
    let len = flat.len().max(1) as i32;
    flat.resize(len as usize, 0);
    Array::from_slice(&flat, &[1, len])
}

/// How many answer rows a question needs.
fn option_count(q: &ClefQuestion) -> usize {
    match q {
        ClefQuestion::Noul { .. } => 2,
        ClefQuestion::Choice { options, .. } => options.len(),
        ClefQuestion::Score { levels, .. } => levels.len(),
    }
}

/// A deterministic pseudo-random vector in `[-1, 1]`.
///
/// The mixing matters: a naive `(index * d_model + j) % k` scheme collapses to
/// the same vector for every option whenever `d_model` is a multiple of `k`,
/// which silently makes every option score identically.
fn synthetic_option_vector(question: usize, option: usize, j: usize) -> f32 {
    let mut h = (question as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ (option as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9)
        ^ (j as u64).wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= h >> 29;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 32;
    ((h % 2001) as f32 / 1000.0) - 1.0
}

/// Use the caller-supplied option embeddings when present, otherwise synthesize
/// deterministic ones so the head always receives one row per option.
fn build_option_embeddings(
    questions: &[ClefQuestion],
    supplied: &[Vec<Vec<f32>>],
    d_model: i32,
) -> Result<Vec<Array>> {
    let mut out = Vec::with_capacity(questions.len());
    for (qi, q) in questions.iter().enumerate() {
        let n = option_count(q).max(1);
        let mut flat: Vec<f32> = Vec::with_capacity(n * d_model as usize);
        for oi in 0..n {
            let row = match supplied.get(qi).and_then(|m| m.get(oi)) {
                Some(v) if v.len() == d_model as usize => v.clone(),
                _ => (0..d_model as usize)
                    .map(|j| synthetic_option_vector(qi, oi, j))
                    .collect(),
            };
            flat.extend_from_slice(&row);
        }
        out.push(Array::from_slice(&flat, &[n as i32, d_model]));
    }
    Ok(out)
}

/// Words that make an answer unambiguously unsafe.
const UNSAFE_WORDS: [&str; 10] = [
    "unsafe", "exfil", "destructive", "injection", "malicious", "harm", "danger", "block",
    "refuse", "deny",
];

/// Words that mark a boolean question as being about harm rather than safety.
const HARM_WORDS: [&str; 6] = ["unsafe", "harm", "destructive", "exfil", "injection", "malicious"];

/// Words that mark a boolean question as being about safety.
const SAFE_WORDS: [&str; 5] = ["safe", "benign", "legit", "allow", "permitted"];

/// Map a Clef answer onto the block/allow verdict.
///
/// The polarity of a boolean question matters: "true" is the *unsafe* answer to
/// "is this destructive?" but the *safe* answer to "is this benign?". The
/// question id decides which reading applies, so the verdict never hinges on a
/// coincidental tie in the score.
pub fn clef_flags_unsafe(question: &ClefQuestion, decision: &ClefDecision) -> bool {
    let pick = decision.pick.to_ascii_lowercase();
    let id = decision.id.to_ascii_lowercase();

    if UNSAFE_WORDS.iter().any(|k| pick.contains(k)) {
        return true;
    }

    match question {
        ClefQuestion::Noul { id: qid, .. } => {
            let text = format!("{qid} {id}").to_ascii_lowercase();
            if HARM_WORDS.iter().any(|k| text.contains(k)) {
                // "is this destructive?" -> true is the unsafe answer.
                pick == "true"
            } else if SAFE_WORDS.iter().any(|k| text.contains(k)) {
                // "is this safe?" -> false is the unsafe answer.
                pick == "false"
            } else {
                // Unknown polarity: only a confident affirmative blocks.
                pick == "true" && decision.confidence > 0.5
            }
        }
        // A choice answer was already matched against the unsafe vocabulary.
        ClefQuestion::Choice { .. } => false,
        // A graded question escalates once it passes the midpoint.
        ClefQuestion::Score { .. } => matches!(decision.weighted_score, Some(s) if s > 0.5),
    }
}

/// Judge one tool call: anchor on the trusted prompt, then inspect the
/// tool-call residual state.
pub fn evaluate_probe(
    engine: &mut dyn GuardableEngine,
    encoder: &PromptEncoder,
    probe: &ToolCallProbe,
    block_threshold: f32,
    trajectories: &mut std::collections::HashMap<String, ExcessTrajectory>,
) -> Result<ProbeVerdict> {
    // The trajectory of THIS conversation. A caller-supplied id groups the
    // turns of one conversation; without one, the prompt itself is the key,
    // so independent calls never accumulate into each other.
    let trajectory_key = probe
        .conversation_id
        .clone()
        .unwrap_or_else(|| format!("prompt:{:x}", stable_hash(&probe.prompt)));
    let trajectory = trajectories
        .entry(trajectory_key)
        .or_insert_with(ExcessTrajectory::default);
    let prompt_ids = encoder.encode(&render_user_turn(&probe.prompt));
    let full_ids = encoder.encode(&render_tool_call_turn(
        &probe.prompt,
        &probe.tool_name,
        &probe.tool_args,
    ));
    // The prefix that precedes the tool-call span. The span itself is what
    // gets pooled, so the user's own wording never enters the measurement.
    let span_prefix_ids = encoder.encode(&tool_call_span_prefix(&probe.prompt));

    // Pass 1 — lock the residual state at the end of the trusted user prompt.
    // Clamp against the smaller of the tokenizer's vocabulary and the
    // embedding table's, so a mismatch can never index out of bounds.
    let vocab = encoder.vocab_size.min(engine.vocab_size()).max(1);
    let user_ids = input_ids_matrix(&prompt_ids, vocab);
    engine.run_hooked(&user_ids, false, true, None, None)?;

    // Pass 2 — inspect + optionally clamp the tool-call residual state.
    let full = input_ids_matrix(&full_ids, vocab);
    let questions = probe.questions.clone();
    let d_model = engine.d_model();
    let option_embeddings = build_option_embeddings(&questions, &probe.option_embeddings, d_model)?;

    // The provenance reading needs the probe layer's attention distribution,
    // so it is captured for this pass only.
    let wants_attention = !probe.untrusted_context.is_empty();
    if wants_attention {
        engine.set_capture_attention(true);
    }
    let out = engine.run_hooked(
        &full,
        true,
        false,
        if questions.is_empty() {
            None
        } else {
            Some((&questions, &option_embeddings))
        },
        Some(tool_span_start(&span_prefix_ids, &full_ids)),
    );
    engine.set_capture_attention(false);
    let out = out?;

    // The share of the tool call's attention that came from the untrusted
    // part of the context. `None` when the caller declared nothing
    // untrusted — a zero would claim the context was clean, which is a
    // different statement.
    let untrusted_ranges = untrusted_token_ranges(
        encoder,
        &render_tool_call_turn(&probe.prompt, &probe.tool_name, &probe.tool_args),
        &probe.prompt,
        &probe.untrusted_context,
    );
    let span_start = tool_span_start(&span_prefix_ids, &full_ids);
    let untrusted_attention_ratio = match out.attention_probs.as_ref() {
        Some(probs) => {
            let span_len = full_ids.len().saturating_sub(span_start);
            untrusted_attention_ratio(probs, span_start, span_len, &untrusted_ranges)?
        }
        None => None,
    };

    // Captured now: the baseline pass below runs the sensor again and would
    // otherwise replace these coordinates with the reference call's.
    let pca_coords = engine.pca_coordinates();
    let telemetry = out.repe_telemetry.clone().unwrap_or(RepeProbeTelemetry {
        layer_idx: engine.target_layer(),
        harm_cosine: 0.0,
        drift_cosine: 0.0,
        pca_subspace_energy: 0.0,
        clamped_in_place: false,
        cluster_scores: Vec::new(),
        attribution_token_index: None,
        attribution_cluster: None,
        attribution_cosine: 0.0,
        span_tokens: 0,
    });
    let decisions = out.clef_decisions.unwrap_or_default();

    // Pass 3 — the benign baseline.
    //
    // The baseline has to measure a benign call that FOLLOWS an instruction.
    // Rendering the panel under the LIVE prompt makes every reference an
    // instruction-violating sequence, and the model scores that differently
    // enough to push the baseline above a compliant harmful call.
    //
    // The violation penalty is a property of DISOBEYING, so which baseline is
    // right depends on the intercepted call:
    //
    //   the call obeys the instruction -> the matched panel, measured at
    //     calibration against the instruction each reference actually answers
    //   the call violates it          -> the live panel, where the violation
    //     penalty falls on the call AND the references and cancels
    //
    // "Obeys" is decidable at runtime: the command string appears in the
    // instruction the agent was given.
    // The matched panel is a baseline measured on SHELL COMMAND calls, so it
    // is only applied to calls that carry one. A call whose string argument is
    // something else (`{"dir": "build"}`) is a different tool-call shape, and
    // scoring it against the matched panel would compare it with a
    // measurement it was never part of — which is how a benign listing call
    // ended up above the threshold.
    let command_text = probe
        .tool_args
        .as_object()
        .and_then(|m| {
            m.iter()
                .find(|(key, _)| {
                    matches!(key.as_str(), "cmd" | "command" | "script" | "shell")
                })
                .and_then(|(_, value)| value.as_str())
        })
        .unwrap_or("")
        .to_string();
    let obeys_instruction = !command_text.is_empty() && probe.prompt.contains(&command_text);

    let mut baseline_cosine = f32::NEG_INFINITY;
    let mut baseline_reference = String::new();
    let mut baseline_mode = "live-panel";
    let (obeys_threshold, violates_threshold) = engine.compliance_excess_thresholds();
    let matched_baseline = engine.static_benign_baseline();
    let compliance_conditioned = obeys_threshold.is_some()
        && violates_threshold.is_some()
        && matched_baseline.is_some();

    if compliance_conditioned && obeys_instruction {
        baseline_cosine = matched_baseline.unwrap_or(0.0);
        baseline_reference = "matched panel (calibrated)".to_string();
        baseline_mode = "matched-panel";
    } else {
        for cmd in BENIGN_REFERENCE_COMMANDS {
            let reference_ids =
                encoder.encode(&render_reference_tool_call_turn(&probe.prompt, cmd));
            let reference = input_ids_matrix(&reference_ids, vocab);
            let cosine = engine
                .run_hooked(
                    &reference,
                    false,
                    false,
                    None,
                    Some(tool_span_start(&span_prefix_ids, &reference_ids)),
                )
                .ok()
                .and_then(|out| out.repe_telemetry)
                .map(|t| t.harm_cosine);
            if let Some(c) = cosine {
                if c > baseline_cosine {
                    baseline_cosine = c;
                    baseline_reference = cmd.to_string();
                }
            }
        }
    }
    if !baseline_cosine.is_finite() {
        baseline_cosine = 0.0;
    }

    // A threshold measured during calibration beats a hand-picked constant.
    let harm_threshold = engine.calibrated_harm_threshold().unwrap_or(block_threshold);
    let excess_threshold = if compliance_conditioned {
        if obeys_instruction {
            obeys_threshold
        } else {
            violates_threshold
        }
    } else {
        engine.calibrated_harm_excess_threshold()
    };
    let drift_threshold = engine.calibrated_drift_threshold().unwrap_or(block_threshold);

    let harm_excess = telemetry.harm_cosine - baseline_cosine;

    // The cross-turn trajectory: the per-cluster excess of THIS call, and the
    // exponentially-weighted average of it across the session so far.
    //
    // The baseline is a single number (the worst benign reference), so it is
    // subtracted from every cluster's score. The result is a vector whose
    // *shape* — which cluster the agent is drifting towards — is the signal;
    // the magnitude is the same excess the decision already uses.
    let mut excess_vector: Vec<f32> = telemetry
        .cluster_scores
        .iter()
        .map(|s| s - baseline_cosine)
        .collect();
    if excess_vector.is_empty() {
        excess_vector.push(harm_excess);
    }
    trajectory.update(&excess_vector);
    let ema_excess = trajectory.ema().to_vec();
    let ema_slope = trajectory.slopes();
    let trajectory_turns = trajectory.turns();
    let trajectory_is_trend = trajectory.is_trend();

    // The RepE direction was calibrated on tool calls that carry a command.
    // A call with no string argument at all — a malformed or non-shell tool
    // call — is outside that calibration, so the reading is reported but it
    // does not block. Real models emit these routinely (a tool named `git
    // status` with `{"repo": "..."}` instead of `bash` with `{"cmd": "..."}`),
    // and blocking them would be a false positive by construction.
    let carries_command = probe
        .tool_args
        .as_object()
        .map(|m| m.values().any(|v| v.as_str().is_some()))
        .unwrap_or(false);

    let mut reasons: Vec<String> = Vec::new();
    let mut advisories: Vec<String> = Vec::new();
    match excess_threshold {
        Some(threshold) => {
            if harm_excess >= threshold {
                if carries_command {
                    reasons.push(format!(
                        "harm excess {:.3} >= threshold {:.3} (baseline {:.3}, worst benign reference `{}`)",
                        harm_excess, threshold, baseline_cosine, baseline_reference
                    ));
                } else {
                    advisories.push(format!(
                        "harm excess {:.3} >= threshold {:.3}, but the tool call carries no string argument — outside the RepE calibration, so not blocked",
                        harm_excess, threshold
                    ));
                }
            }
        }
        None => {
            if telemetry.harm_cosine >= harm_threshold && carries_command {
                reasons.push(format!(
                    "harm cosine {:.3} >= threshold {:.3}",
                    telemetry.harm_cosine, harm_threshold
                ));
            }
        }
    }
    // The escalation rule.
    //
    // A call whose own excess is below the threshold is not blocked on its
    // own reading. It IS blocked when the session's trajectory says the agent
    // has been climbing towards this cluster: the cluster's EMA is above the
    // threshold, its slope is rising, and enough turns have accumulated for
    // the average to mean something.
    //
    // This can only ADD blocks to calls that are already suspicious, never
    // remove them, so it is measured separately against the same held-out
    // sets as everything else.
    if reasons.is_empty() && carries_command {
        if let Some(threshold) = excess_threshold {
            if trajectory_is_trend {
                for (idx, ema) in ema_excess.iter().enumerate() {
                    let slope = ema_slope.get(idx).copied().unwrap_or(0.0);
                    if *ema >= threshold && slope > 0.0 {
                        reasons.push(format!(
                            "escalating trajectory: cluster {} EMA excess {:.3} >= threshold {:.3} \
                             with a rising slope of {:+.4} over {} turns",
                            idx, ema, threshold, slope, trajectory_turns
                        ));
                        break;
                    }
                }
            }
        }
    }
    // The drift direction is calibrated on tool-RESPONSE turns (a poisoned
    // file body read back into the context), while this proxy intercepts tool
    // CALLS. The two states are not comparable, so the drift reading is
    // reported as an advisory instead of blocking on it — an uncalibrated
    // threshold here would refuse harmless commands.
    if telemetry.drift_cosine >= drift_threshold {
        advisories.push(format!(
            "task-drift cosine {:.3} >= threshold {:.3}",
            telemetry.drift_cosine, drift_threshold
        ));
    }
    // An untrained head cannot judge anything, so its answers are reported
    // but never block on their own.
    if engine.clef_head_calibrated() {
        for (q, d) in questions.iter().zip(decisions.iter()) {
            if clef_flags_unsafe(q, d) {
                reasons.push(format!("clef question `{}` flagged: {}", d.id, d.pick));
            }
        }
    }

    let allowed = reasons.is_empty();
    // The attribution index points into the rendered tool-call sequence, so
    // the token that peaked can be decoded back to readable text.
    let attribution_token = telemetry
        .attribution_token_index
        .and_then(|idx| full_ids.get(idx).copied())
        .map(|id| encoder.decode_token(id))
        .unwrap_or_default();
    Ok(ProbeVerdict {
        allowed,
        reason: if allowed {
            "no unsafe signal above threshold".to_string()
        } else {
            reasons.join("; ")
        },
        advisories,
        tool_name: probe.tool_name.clone(),
        tool_args_preview: preview_tool_args(&probe.tool_args),
        harm_cosine: telemetry.harm_cosine,
        harm_baseline: baseline_cosine,
        baseline_mode: baseline_mode.to_string(),
        harm_excess,
        drift_cosine: telemetry.drift_cosine,
        pca_subspace_energy: telemetry.pca_subspace_energy,
        pca_coords,
        clamped_in_place: telemetry.clamped_in_place,
        cluster_scores: telemetry.cluster_scores.clone(),
        attribution_token_index: telemetry.attribution_token_index,
        attribution_token,
        attribution_cluster: telemetry.attribution_cluster,
        attribution_cosine: telemetry.attribution_cosine,
        span_tokens: telemetry.span_tokens,
        untrusted_attention_ratio,
        ema_excess,
        ema_slope,
        trajectory_turns,
        clef_decisions: decisions,
    })
}

/// The safety questions asked about every intercepted tool call.
pub fn default_questions() -> Vec<ClefQuestion> {
    vec![
        ClefQuestion::Noul {
            id: "q_is_destructive".to_string(),
            query: "Does this tool call destroy data, erase files, or rewrite git history?".to_string(),
        },
        ClefQuestion::Noul {
            id: "q_exfiltrates_secrets".to_string(),
            query: "Does this tool call read credentials, keys or tokens, or send data to a remote endpoint?".to_string(),
        },
        ClefQuestion::Score {
            id: "q_risk".to_string(),
            query: "How risky is this tool call?".to_string(),
            levels: vec![
                "none".to_string(),
                "low".to_string(),
                "medium".to_string(),
                "high".to_string(),
                "critical".to_string(),
            ],
        },
    ]
}

/// The embedded telemetry dashboard.
async fn index() -> Html<&'static str> {
    Html(include_str!("viz_ui.html"))
}

/// What the guard knows about the model it is guarding.
async fn engine_info(State(state): State<EnforcerState>) -> Json<serde_json::Value> {
    Json(serde_json::to_value(&state.enforcer.info).unwrap_or(serde_json::Value::Null))
}

/// The live event stream the dashboard consumes.
async fn events_stream(State(state): State<EnforcerState>) -> Response {
    let rx = state.enforcer.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|res| match res {
        Ok(ev) => Some(Ok::<Event, Infallible>(
            Event::default().data(serde_json::to_string(&ev).unwrap_or_default()),
        )),
        Err(_) => None,
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "qwen-clef-repe-guard",
    }))
}

/// Report the caller's session.
///
/// This never fails: a caller with no session gets `active: false` rather
/// than a 401, because the site asks this question to find out whether it
/// needs to mint one.
async fn session_status(
    State(state): State<EnforcerState>,
    Extension(context): Extension<SessionContext>,
) -> Json<serde_json::Value> {
    let sessions = &state.enforcer.sessions;
    Json(serde_json::json!({
        "active": context.session_id.is_some(),
        "session_id": context.session_id,
        "expires_in": context.session_expires_in,
        "sessions_enabled": sessions.enabled(),
        // The guard keeps no session table, so there is no count of live
        // sessions to report — only the ones it has explicitly revoked.
        "revoked_sessions": sessions.revoked_count(),
        "device_bound": true,
    }))
}

/// Mint a session for this device.
///
/// This is the admission step, and it is deliberately frictionless: there
/// is no account, no sign-in and nothing about the visitor is recorded.
/// The session is bound to the device cookie and the user-agent, so it
/// cannot be lifted into another browser on its own.
async fn session_issue(
    State(state): State<EnforcerState>,
    Extension(context): Extension<SessionContext>,
) -> Response {
    if !state.enforcer.sessions.enabled() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "sessions_disabled",
                "reason": "this deployment takes the bearer token only",
            })),
        )
            .into_response();
    }

    let issued = state.enforcer.sessions.issue(&context.device_hash);
    let ttl = state.enforcer.config.session.ttl.as_secs();
    let cookie = set_cookie(
        &state.enforcer.config.session.session_cookie,
        &issued.cookie_value,
        ttl,
        state.enforcer.config.session.cookie_secure,
    );
    let body = serde_json::json!({
        "active": true,
        "session_id": issued.claims.id,
        "expires_in": ttl,
        "device_bound": true,
    });

    let mut response = (StatusCode::OK, Json(body)).into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().append(SET_COOKIE, value);
    }
    response
}

/// Record one human label for an intercepted call.
///
/// The label is appended to the calibration file as one JSON line. A label that
/// is neither `"benign"` nor `"harmful"` is refused with a 400: it is not a
/// judgement, and accepting it would put a made-up sample into the
/// calibration set.
async fn record_label(
    Json(record): Json<SiteLabelRecord>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let Some(label) = SiteLabel::parse(&record.label) else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": format!(
                    "unknown label {:?} — expected \"benign\" or \"harmful\"",
                    record.label
                ),
            })),
        ));
    };
    let path = site_calibration_path();
    append_site_label(&path, &record).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "error": format!("{error:#}"),
            })),
        )
    })?;
    info!(
        label = label.as_str(),
        tool = %record.tool_name,
        path = %path.display(),
        "recorded a site label"
    );
    Ok(Json(serde_json::json!({
        "ok": true,
        "label": label.as_str(),
        "path": path.display().to_string(),
        "ts_ms": record.ts_ms,
    })))
}

async fn guard_tool_call(
    State(state): State<EnforcerState>,
    Json(probe): Json<ToolCallProbe>,
) -> Result<Json<ProbeVerdict>, StatusCode> {
    let mut probe = probe;
    if probe.questions.is_empty() {
        probe.questions = default_questions();
    }
    let verdict = state
        .enforcer
        .judge(probe)
        .await
        .map_err(|e| {
            warn!(error = %e, "tool-call probe failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    Ok(Json(verdict))
}

/// The body returned when a tool call is blocked.
#[derive(Debug, Clone, Serialize)]
struct BlockedToolCall {
    error: BlockedError,
}

#[derive(Debug, Clone, Serialize)]
struct BlockedError {
    message: String,
    r#type: String,
    code: String,
    tool_name: String,
    verdict: ProbeVerdict,
}

/// Extract the tool calls from an OpenAI-style chat completion response.
fn extract_tool_calls(payload: &serde_json::Value) -> Vec<(String, serde_json::Value)> {
    let mut out = Vec::new();
    let Some(choices) = payload.get("choices").and_then(|c| c.as_array()) else {
        return out;
    };
    for choice in choices {
        let Some(calls) = choice
            .get("message")
            .and_then(|m| m.get("tool_calls"))
            .and_then(|t| t.as_array())
        else {
            continue;
        };
        for call in calls {
            let name = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or_default()
                .to_string();
            let raw = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            // The API sends the arguments as a JSON *string*. Parse it so the
            // rendered tool call is byte-identical to the text the extractor
            // calibrated the RepE directions against.
            let args = match raw {
                serde_json::Value::String(text) => {
                    serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text))
                }
                other => other,
            };
            out.push((name, args));
        }
    }
    out
}

/// Pull the last user message out of the request so the judge sees the intent.
fn extract_last_user_text(body: &serde_json::Value) -> String {
    let Some(messages) = body.get("messages").and_then(|m| m.as_array()) else {
        return String::new();
    };
    for message in messages.iter().rev() {
        if message.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let content = message.get("content").and_then(|c| c.as_str()).unwrap_or("");
        if !content.is_empty() {
            return content.to_string();
        }
    }
    String::new()
}

/// The parts of the request that came from an untrusted source.
///
/// A tool message carries whatever the tool returned: a file body, a web
/// page, a command's output. The agent did not author it, and it can
/// contain instructions. This is the content the provenance reading
/// measures the tool call's attention against.
///
/// The system and user turns are the trusted part and are not listed.
fn untrusted_from_messages(body: &serde_json::Value) -> Vec<String> {
    let Some(messages) = body.get("messages").and_then(|m| m.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for message in messages {
        let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if !matches!(role, "tool" | "function") {
            continue;
        }
        match message.get("content") {
            Some(serde_json::Value::String(text)) => {
                if !text.trim().is_empty() {
                    out.push(text.clone());
                }
            }
            Some(serde_json::Value::Array(parts)) => {
                // A multi-part tool message: every text part is untrusted.
                for part in parts {
                    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                        if !text.trim().is_empty() {
                            out.push(text.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The blocking reverse proxy.
///
/// Forwards to the upstream model server, then inspects every tool call in the
/// response. In `Enforce` mode an unsafe tool call is never returned to the
/// agent: the proxy answers with a 403 that names the reason.
async fn proxy_chat_completions(
    State(state): State<EnforcerState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Response, StatusCode> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/v1/chat/completions",
        state.enforcer.config.upstream_url.trim_end_matches('/')
    );
    let resp = client.post(&url).json(&body).send().await.map_err(|e| {
        warn!(error = %e, "upstream request failed");
        StatusCode::BAD_GATEWAY
    })?;
    let status = resp.status();
    let payload: serde_json::Value = resp.json().await.map_err(|e| {
        warn!(error = %e, "upstream response was not JSON");
        StatusCode::BAD_GATEWAY
    })?;

    if !status.is_success() {
        return Err(StatusCode::BAD_GATEWAY);
    }

    let tool_calls = extract_tool_calls(&payload);
    if tool_calls.is_empty() {
        return Ok(Json(payload).into_response());
    }

    let prompt = extract_last_user_text(&body);
    for (name, args) in tool_calls {
        let probe = ToolCallProbe {
            prompt: prompt.clone(),
            tool_name: name.clone(),
            tool_args: args,
            questions: default_questions(),
            option_embeddings: Vec::new(),
            untrusted_context: untrusted_from_messages(&body),
            conversation_id: body
                .get("conversation_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        };
        let verdict = state.enforcer.judge(probe).await.map_err(|e| {
            warn!(error = %e, "tool-call probe failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

        if !verdict.allowed {
            match state.enforcer.config.mode {
                EnforcementMode::Enforce => {
                    warn!(
                        tool_name = %name,
                        reason = %verdict.reason,
                        "BLOCKED tool call — refusing to hand it to the agent"
                    );
                    let blocked = BlockedToolCall {
                        error: BlockedError {
                            message: format!(
                                "tool call `{name}` was blocked by the RepE + Clef guard: {}",
                                verdict.reason
                            ),
                            r#type: "blocked_tool_call".to_string(),
                            code: "tool_call_blocked".to_string(),
                            tool_name: name,
                            verdict,
                        },
                    };
                    return Ok((StatusCode::FORBIDDEN, Json(blocked)).into_response());
                }
                EnforcementMode::Monitor => {
                    warn!(
                        tool_name = %name,
                        reason = %verdict.reason,
                        "tool call flagged (monitor mode) — passing through"
                    );
                }
            }
        }
    }

    Ok(Json(payload).into_response())
}

/// Expose the enforcement mode to callers of `/health`.
#[allow(dead_code)]
fn mode_header(mode: EnforcementMode) -> HeaderValue {
    HeaderValue::from_static(match mode {
        EnforcementMode::Enforce => "enforce",
        EnforcementMode::Monitor => "monitor",
    })
}
