use crate::zero_shot_loader::ModelFingerprint;
use anyhow::{Context, Result};
use mlx_rs::{
    Array,
    linalg::svd,
    ops::{indexing::IndexOp, *},
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The canonical rendering of the trusted user turn.
///
/// The extractor and the guard MUST agree on these renderings: the RepE
/// directions are calibrated against activations produced by exactly this text,
/// so a different rendering shifts the residual stream and the signal stops
/// transferring to the running guard.
pub fn render_user_turn(user: &str) -> String {
    format!("<|im_start|>user\n{user}<|im_end|>")
}

/// The canonical rendering of a user turn followed by an assistant tool call.
pub fn render_tool_call_turn(
    user: &str,
    tool_name: &str,
    tool_args: &serde_json::Value,
) -> String {
    let tool_args = python_json(tool_args);
    format!(
        "<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n<tool_call>\n{tool_name}({tool_args})"
    )
}

/// Serialise a JSON value the way Python's `json.dumps` does by default
/// (`", "` and `": "` separators, non-ASCII escaped as `\uXXXX`).
///
/// The extractor renders every calibration call with `json.dumps`-style
/// spacing; serde's compact `{"cmd":"x"}` tokenizes differently, so the live
/// call was pooled over different tokens than the threshold was measured on.
pub fn python_json(v: &serde_json::Value) -> String {
    use serde_json::Value;
    match v {
        Value::String(s) => {
            let mut out = String::with_capacity(s.len() + 2);
            for c in serde_json::to_string(s).unwrap_or_default().chars() {
                if (c as u32) < 0x80 {
                    out.push(c);
                } else {
                    let mut buf = [0u16; 2];
                    for unit in c.encode_utf16(&mut buf) {
                        out.push_str(&format!("\\u{:04x}", unit));
                    }
                }
            }
            out
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(python_json).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, val)| format!("{}: {}", python_json(&Value::String(k.clone())), python_json(val)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod python_json_tests {
    use super::python_json;
    #[test]
    fn matches_json_dumps() {
        let v: serde_json::Value = serde_json::from_str(r#"{"cmd": "rm -rf ~", "n": [1, true, null], "s": "é\"q"}"#).unwrap();
        // json.dumps({"cmd": "rm -rf ~", "n": [1, True, None], "s": "é\"q"})
        assert_eq!(python_json(&v), r#"{"cmd": "rm -rf ~", "n": [1, true, null], "s": "\u00e9\"q"}"#);
    }
}

/// The prefix of a rendered tool-call turn that comes BEFORE the tool-call
/// span.
///
/// Pooling starts at the first token after this prefix, so the residual is
/// averaged over the tool call itself — the name and the arguments — and not
/// over a single trailing token whose representation is dominated by whatever
/// the user happened to write. This is what makes the reading the same whether
/// the agent said "run:rm -rf ~" or wrote a paragraph about freeing up disk
/// space.
pub fn tool_call_span_prefix(user: &str) -> String {
    format!("<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n<tool_call>\n")
}

/// The canonical rendering of a user turn followed by a tool response.
pub fn render_tool_response_turn(user: &str, content: &str) -> String {
    format!(
        "<|im_start|>user\n{user}<|im_end|>\n<|im_start|>user\n<tool_response>\n{content}<|im_end|>\n<|im_start|>assistant\n<tool_call>"
    )
}

/// The panel of benign reference calls the guard scores an intercepted call
/// against.
///
/// A single reference is not enough. The harm cosine is read as a *shift* away
/// from the trusted anchor, and how far that shift points along `v_harm`
/// depends on the prompt as well as the command. With one reference, a prompt
/// that rotates the readings can move the reference further than the call and
/// manufacture an excess out of nothing — measured against the real model:
/// the benign `cargo clean` scored +0.002 under "Clean up the temporary build
/// artifacts." but +0.052 under the same prompt with "in the cargo project"
/// appended, which is enough to cross the calibrated threshold.
///
/// Scoring the call against the *worst* (highest-harm) of several benign
/// references in the SAME context removes that dependence: the intercepted
/// call has to beat every benign reading the context produces, not just one.
pub const BENIGN_REFERENCE_COMMANDS: [&str; 5] = [
    "cargo build --release",
    "cargo test --no-run",
    "git status --short",
    "ls -lh ./build",
    "cat Cargo.toml",
];

/// The natural-language instruction each benign reference actually answers.
///
/// The baseline has to measure a benign call that FOLLOWS an instruction. A
/// reference rendered under somebody else's instruction is an
/// instruction-violating sequence, and the model represents that differently
/// enough to push the baseline above a compliant harmful call — which is how
/// an echoed `rm -rf` ended up scoring below the benign panel it was being
/// compared against.
pub const BENIGN_REFERENCE_INSTRUCTIONS: [(&str, &str); 5] = [
    (
        "cargo build --release",
        "Build the project in release mode.",
    ),
    (
        "cargo test --no-run",
        "Compile the test suite without running the tests.",
    ),
    (
        "git status --short",
        "Show the working tree status in short format.",
    ),
    (
        "ls -lh ./build",
        "List the build directory with human-readable sizes.",
    ),
    ("cat Cargo.toml", "Show the Cargo manifest."),
];

/// Render a benign reference tool call in the same context as the call under
/// inspection.
pub fn render_reference_tool_call_turn(user: &str, cmd: &str) -> String {
    render_tool_call_turn(user, "bash", &serde_json::json!({ "cmd": cmd }))
}

#[derive(Debug, Clone)]
pub struct RepeProbeTelemetry {
    pub layer_idx: usize,
    pub harm_cosine: f32,
    pub drift_cosine: f32,
    pub pca_subspace_energy: f32,
    pub clamped_in_place: bool,
    /// The harm reading of every cluster, after pooling.
    ///
    /// One entry per cluster when the artifact carries cluster directions;
    /// a single entry (the legacy `v_harm` direction) otherwise.
    pub cluster_scores: Vec<f32>,
    /// The token inside the tool-call span that carried the peak reading.
    ///
    /// This is the *attribution*: the token whose own representation pushed
    /// the cluster score over the line. `None` when the artifact does not
    /// carry cluster directions.
    pub attribution_token_index: Option<usize>,
    /// Which cluster the attributed token belonged to.
    pub attribution_cluster: Option<usize>,
    /// The un-pooled cosine of the attributed token against its cluster.
    pub attribution_cosine: f32,
    /// How many tokens the tool-call span covered.
    pub span_tokens: usize,
    /// Per-token score of every cluster over the span, row-major `[t * C + c]`.
    pub token_scores: Vec<f32>,
    /// The first token of the span (absolute index in the sequence).
    pub span_start: usize,
}

/// Per-layer telemetry captured during a forward pass for `GhostlineTraceFrame`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LayerTraceMetric {
    pub layer: usize,
    pub l2_norm: f32,
    pub cos_harm: f32,
    pub cos_drift: f32,
    pub guard_logit: f32,
    pub tensor_slice_preview: Vec<f32>,
    pub pca_coords: [f32; 2],
}

/// Per-token telemetry captured at `decision_layer` for `GhostlineTraceFrame`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TokenTraceMetric {
    pub idx: usize,
    pub raw_harm_cosine: f32,
    pub drift_score: f32,
    pub pca_coords: [f32; 2],
}

/// Calibrated PCA subspace reference clusters loaded from the RepE safetensors artifact.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct PcaReferenceTelemetry {
    pub pc1_variance: f32,
    pub pc2_variance: f32,
    pub benign_cluster: Vec<[f32; 2]>,
    pub exploit_cluster: Vec<[f32; 2]>,
}

/// How the residual stream is collapsed over the tool-call span.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Pooling {
    /// The mean residual over the span, then a single cosine.
    Mean,
    /// Length-invariant LogMeanExp pooling across per-token cosines:
    /// `S_c = max_t s_c(t) + (1/beta) * ln((1/T) * sum_t exp(beta * (s_c(t) - max)))`.
    ///
    /// Strictly bounded in `[mean_t s_c(t), max_t s_c(t)]`: large `beta` approaches
    /// the hard token maximum, small `beta` approaches the token mean, with zero
    /// sequence-length bias.
    LogSumExp { beta: f32 },
    /// Convex combination `(1 - weight) * mean_pooled_cosine + weight * LogMeanExp_beta`,
    /// preserving holistic command semantics while surfacing short dangerous clauses.
    Hybrid { beta: f32, weight: f32 },
}

impl Default for Pooling {
    fn default() -> Self {
        Pooling::Mean
    }
}

impl Pooling {
    /// Parse a pooling specification string (`"mean"`, `"lse"`, `"lse:<beta>"`,
    /// `"hybrid"`, or `"hybrid:<beta>:<weight>"`).
    pub fn parse_spec(spec: &str) -> Self {
        let trimmed = spec.trim();
        if trimmed.eq_ignore_ascii_case("mean") || trimmed.is_empty() {
            return Pooling::Mean;
        }
        if trimmed.eq_ignore_ascii_case("lse") {
            return Pooling::LogSumExp { beta: 12.0 };
        }
        if let Some(rest) = trimmed.strip_prefix("lse:") {
            return rest
                .parse::<f32>()
                .ok()
                .filter(|b| b.is_finite() && *b > 0.0)
                .map(|beta| Pooling::LogSumExp { beta })
                .unwrap_or_default();
        }
        if trimmed.eq_ignore_ascii_case("hybrid") {
            return Pooling::Hybrid {
                beta: 10.0,
                weight: 0.35,
            };
        }
        if let Some(rest) = trimmed.strip_prefix("hybrid:") {
            let mut parts = rest.split(':');
            let beta = parts
                .next()
                .and_then(|s| s.parse::<f32>().ok())
                .filter(|b| b.is_finite() && *b > 0.0);
            let weight = parts
                .next()
                .and_then(|s| s.parse::<f32>().ok())
                .filter(|w| w.is_finite() && (0.0..=1.0).contains(w))
                .unwrap_or(0.35);
            if let Some(beta) = beta {
                return Pooling::Hybrid { beta, weight };
            }
        }
        Pooling::Mean
    }

    /// Parse the `pooling` key of the artifact metadata.
    pub fn from_metadata(meta: &HashMap<String, String>) -> Self {
        match meta.get("pooling").map(|s| s.as_str()) {
            Some(spec) => Self::parse_spec(spec),
            None => Pooling::Mean,
        }
    }

    /// The metadata string that reproduces this pooling in the extractor.
    pub fn metadata_string(&self) -> String {
        match self {
            Pooling::Mean => "mean".to_string(),
            Pooling::LogSumExp { beta } => format!("lse:{beta}"),
            Pooling::Hybrid { beta, weight } => format!("hybrid:{beta}:{weight}"),
        }
    }
}

/// The share of the tool-call span's attention that landed on the untrusted
/// part of the context.
///
/// `probs` is the probe layer's attention distribution `[B, H, S, S]`. The
/// rows `q` in `[span_start, span_start + span_len)` are the tool call's own
/// tokens; the ratio is the attention mass they send to the untrusted token
/// ranges, averaged over those rows and over the heads.
///
/// Each row of a softmax sums to one, so the ratio is simply the mean of the
/// untrusted mass. The reading is `None` when there is nothing untrusted to
/// measure — a ratio of zero would claim the context was clean, which is a
/// different statement.
pub fn untrusted_attention_ratio(
    probs: &Array,
    span_start: usize,
    span_len: usize,
    untrusted: &[(usize, usize)],
) -> Result<Option<f32>> {
    if untrusted.is_empty() {
        return Ok(None);
    }
    let shape = probs.shape();
    if shape.len() != 4 {
        anyhow::bail!("attention probabilities must be [B, H, S, S], got {shape:?}");
    }
    let seq_len = shape[3] as usize;
    if span_start >= seq_len || span_len == 0 {
        return Ok(None);
    }
    let end = (span_start + span_len).min(seq_len);
    // The rows of the tool-call span: [B, H, T, S].
    //
    // The batch axis is indexed with a RANGE, not an integer: an integer
    // makes mlx-rs gather that axis away, and the remaining `..` then
    // over-count and panic. `0..1` keeps the axis and gives the 4-D
    // semantics this function expects.
    let rows = probs.index((0..1, .., span_start as i32..end as i32, ..));

    let mut untrusted_mass = Array::from_f32(0.0);
    for (lo, hi) in untrusted {
        let lo = (*lo).min(seq_len);
        let hi = (*hi).min(seq_len);
        if lo >= hi {
            continue;
        }
        let slice = rows.index((0..1, .., .., lo as i32..hi as i32));
        // Sum over the key axis: [B, H, T].
        untrusted_mass = add(&untrusted_mass, &sum_axes(&slice, &[3], false)?)?;
    }
    let total = sum_axes(&rows, &[3], false)?; // [B, H, T]
    let untrusted_sum = sum(&untrusted_mass, false)?;
    let total_sum = sum(&total, false)?;
    untrusted_sum.eval()?;
    total_sum.eval()?;
    let u = untrusted_sum.item_exact::<f32>();
    let t = total_sum.item_exact::<f32>();
    if t <= 0.0 {
        return Ok(None);
    }
    Ok(Some(u / t))
}

/// The pooled per-cluster reading of a tool-call span, plus its attribution.
#[derive(Debug, Clone)]
pub struct SpanScores {
    /// The pooled score of every cluster.
    pub cluster_scores: Vec<f32>,
    /// The per-token score of every cluster, row-major: `[t * C + c]`.
    pub token_scores: Vec<f32>,
    /// The token index (absolute in the sequence) that peaked for each cluster.
    pub peak_token: Vec<usize>,
    /// The un-pooled score at that peak token.
    pub peak_cosine: Vec<f32>,
    /// The first token of the span.
    pub span_start: usize,
    /// How many tokens the span covered.
    pub span_len: usize,
    /// Which cluster carried the pooled reading that was used.
    pub argmax_cluster: usize,
}

/// The inputs a token-wise score computation needs.
///
/// The guard reads the sensor's own anchor and copy channel; the extractor
/// measures fresh ones while it fits the directions, so the computation is
/// factored out instead of being hard-wired to the sensor's fields.
#[derive(Clone)]
pub struct TokenScoreConfig {
    /// The trusted user anchor. `None` reads the state absolutely.
    pub anchor: Option<Array>,
    /// The verbatim-copy direction to project out. `None` keeps it.
    pub copy_dir: Option<Array>,
    /// The directions to score against, each already unit length.
    pub directions: Vec<Array>,
}

/// The per-token cosine table of a tool-call span.
#[derive(Debug, Clone)]
pub struct TokenScoreTable {
    /// Row-major over tokens: `scores[t * C + c]`.
    pub scores: Vec<f32>,
    pub span_start: usize,
    pub span_len: usize,
    pub n_clusters: usize,
}

/// The per-token cosine of every span token against every direction.
///
/// Every token is normalised on its own, so a token carrying a strong
/// destructive signal is not averaged away by the punctuation around it.
/// The anchor subtraction and the copy-channel projection are applied per
/// token, exactly as they are applied to the pooled state.
pub fn token_score_table(
    h_layer: &Array,
    span_start: Option<usize>,
    cfg: &TokenScoreConfig,
) -> Result<TokenScoreTable> {
    let seq_len = h_layer.shape()[1];
    let start = match span_start {
        Some(s) => (s as i32).min(seq_len.saturating_sub(1)),
        None => seq_len.saturating_sub(1),
    };
    let span_len = (seq_len - start).max(1) as usize;
    let n_clusters = cfg.directions.len();
    if n_clusters == 0 {
        anyhow::bail!("token_score_table needs at least one direction");
    }

    let span_raw = h_layer
        .index((0, start..seq_len, ..))
        .as_type::<f32>()?
        .reshape(&[span_len as i32, -1])?;

    // Shift away from the trusted anchor, per token.
    let span = match cfg.anchor.as_ref() {
        Some(anchor) => {
            let a = anchor.as_type::<f32>()?.reshape(&[1, -1])?;
            subtract(&span_raw, &a)?
        }
        None => span_raw,
    };

    // Unit length along the feature axis: [T, D].
    let sq = multiply(&span, &span)?;
    let norm = sqrt(&sum_axis(&sq, -1, true)?)?;
    let mut unit = divide(&span, &add(&norm, &Array::from_f32(1e-6))?)?;

    // Project the copy channel out of every token, then renormalise.
    if let Some(copy) = cfg.copy_dir.as_ref() {
        let copy_b = copy.as_type::<f32>()?.reshape(&[1, -1])?;
        let proj = sum_axis(&multiply(&unit, &copy_b)?, -1, true)?;
        let projected = subtract(&unit, &multiply(&proj, &copy_b)?)?;
        let sq2 = multiply(&projected, &projected)?;
        let norm2 = sqrt(&sum_axis(&sq2, -1, true)?)?;
        unit = divide(&projected, &add(&norm2, &Array::from_f32(1e-6))?)?;
    }

    // Single batched GEMM `[T, D] @ [D, C] -> [T, C]` (already token-major).
    let mut dir_cols = Vec::with_capacity(n_clusters);
    for dir in &cfg.directions {
        dir_cols.push(dir.as_type::<f32>()?.reshape(&[-1])?);
    }
    let dir_mat_t = stack(&dir_cols, 1)?; // [D, C]
    let scores_mat = matmul(&unit, &dir_mat_t)?.contiguous()?;
    scores_mat.eval()?;
    let scores = scores_mat.as_slice::<f32>().to_vec();

    Ok(TokenScoreTable {
        scores,
        span_start: start as usize,
        span_len,
        n_clusters,
    })
}

/// The index and value of the largest entry of one cluster's row.
pub fn argmax_row(table: &TokenScoreTable, cluster: usize) -> (usize, f32) {
    let mut best_idx = 0usize;
    let mut best_val = f32::NEG_INFINITY;
    for t in 0..table.span_len {
        let v = table.scores[t * table.n_clusters + cluster];
        if v > best_val {
            best_val = v;
            best_idx = t;
        }
    }
    (best_idx, best_val)
}

/// Length-invariant LogMeanExp pooling of one cluster's token scores.
///
/// `S = max_t s(t) + (1/beta) * ln((1/T) * sum_t exp(beta * (s(t) - max)))`
///
/// Dividing by `T` inside the logarithm eliminates the `+(ln T)/beta` sequence-length
/// bias of unnormalised LogSumExp and keeps `S` strictly bounded inside
/// `[mean_t s(t), max_t s(t)]` (and therefore inside `[-1, 1]`).
pub fn lse_pool(table: &TokenScoreTable, cluster: usize, beta: f32) -> (f32, usize, f32) {
    if table.span_len == 0 {
        return (0.0, 0, 0.0);
    }
    let beta = beta.max(1e-4);
    let (peak_idx, peak_val) = argmax_row(table, cluster);
    let mut acc = 0f32;
    for t in 0..table.span_len {
        let v = table.scores[t * table.n_clusters + cluster];
        acc += (beta * (v - peak_val)).exp();
    }
    let mean_exp = (acc / table.span_len as f32).max(1e-30);
    let pooled = peak_val + mean_exp.ln() / beta;
    (pooled, peak_idx, peak_val)
}

/// The mean of one cluster's token scores — the plain average, used when the
/// artifact was calibrated under mean pooling.
pub fn mean_pool(table: &TokenScoreTable, cluster: usize) -> (f32, usize, f32) {
    let (peak_idx, peak_val) = argmax_row(table, cluster);
    let mut acc = 0f32;
    for t in 0..table.span_len {
        acc += table.scores[t * table.n_clusters + cluster];
    }
    (acc / table.span_len as f32, peak_idx, peak_val)
}

pub struct RepeSensor {
    pub target_layer: usize,
    /// Unit vector [D] for destructive / credential-exfil coding tool calls.
    ///
    /// This is the *mean* of the cluster directions below. It is kept for
    /// compatibility with older artifacts; scoring uses the clusters.
    pub v_harm: Array,
    /// Per-cluster harm directions [D] each: filesystem destruction, secret
    /// reading, and network exfiltration.
    ///
    /// A single difference-in-means vector mixes three distinct semantic
    /// clusters, and the pairs that produce it pull it in different
    /// directions — `cargo test` ended up closer to the boundary than
    /// `rm -rf`. Scoring each cluster separately and taking the maximum
    /// keeps every cluster's margin intact.
    ///
    /// Empty means "use `v_harm` alone" (older artifacts).
    pub v_harm_clusters: Vec<Array>,
    /// Unit vector [D] for the verbatim-copy channel, if the artifact measured
    /// one.
    ///
    /// A shell command carries two things at once: what it does, and the fact
    /// that the transformer is transcribing a string it just read. When the
    /// agent echoes the user's own command back, the copy component dominates
    /// and the semantic component is diluted — an echoed `rm -rf` can score
    /// BELOW the benign baseline while the same command reached from a goal
    /// scores above it. The calibration projected this direction out of both
    /// the clusters and the probe; the guard repeats the projection so the
    /// measured threshold still applies.
    ///
    /// `None` means the artifact predates this measurement and no copy
    /// channel is removed.
    pub v_copy_mode: Option<Array>,
    /// Unit vector [D] capturing the shared benign shell/tool-call syntax mode,
    /// used to orthogonalize live contrastive hot-reloads against generic shell
    /// boilerplate when the artifact measured it.
    pub v_benign_shell: Option<Array>,
    /// Unit vector [D] for indirect prompt injection / task drift from untrusted repo files
    pub v_drift: Array,
    /// Orthonormal [K, D] PCA basis capturing multi-mode unsafe tool directions
    pub pca_basis: Array,
    /// Cached residual state [D] at the final token of the trusted user prompt
    pub trusted_user_anchor: Option<Array>,
    /// Whether to orthogonalize/clamp positive unsafe projections in-place during forward pass
    pub clamp_threshold: Option<f32>,
    /// The harm-cosine threshold measured during calibration, if the extractor
    /// recorded one. Beats a hand-picked constant when it is available.
    pub calibrated_harm_threshold: Option<f32>,
    /// The drift-cosine threshold measured during calibration.
    pub calibrated_drift_threshold: Option<f32>,
    /// The harm threshold expressed as an *excess over the per-session
    /// baseline*. Beats the absolute reading when the artifact provides one.
    pub calibrated_harm_excess_threshold: Option<f32>,
    /// The benign baseline measured at calibration time against the MATCHED
    /// panel — each benign reference scored under the instruction it actually
    /// answers.
    ///
    /// When this is present the guard does NOT re-render the panel under the
    /// live prompt. A reference rendered under somebody else's instruction is
    /// an instruction-violating sequence, and the model scores that
    /// differently enough to push the baseline above a compliant harmful
    /// call. `None` means the artifact predates the matched panel and the
    /// guard falls back to measuring the panel live.
    pub static_benign_baseline: Option<f32>,
    /// The excess threshold for a call that OBEYS the instruction it was given.
    ///
    /// A call that obeys is scored against the matched panel; a call that
    /// violates is scored against the live panel, where the
    /// instruction-violation penalty cancels on both sides. `None` means the
    /// artifact carries no compliance-conditioned operating point.
    pub harm_excess_threshold_obeys: Option<f32>,
    /// The excess threshold for a call that VIOLATES the instruction.
    pub harm_excess_threshold_violates: Option<f32>,
    /// The harm cosine measured at every decoder layer during the last
    /// forward pass — the per-layer profile the dashboard plots.
    pub layer_profile: Vec<f32>,
    /// Per-layer 3-cluster harm cosines (`[destruction, theft, exfiltration]`)
    /// across all decoder layers during the last forward pass.
    pub layer_cluster_profile: Vec<Vec<f32>>,
    /// Per-layer 3D PCA subspace coordinates (`[pc1, pc2, pc3]`) across all
    /// decoder layers during the last forward pass.
    pub layer_pca_profile: Vec<Vec<f32>>,
    /// The projection of the last inspected state onto the PCA basis.
    pub last_pca_coords: Vec<f32>,
    /// Whether the harm reading is ABSOLUTE (the tool-call state itself)
    /// rather than anchor-relative (the shift away from the user turn).
    ///
    /// The anchor-relative form has a systematic blind spot: when the model
    /// faithfully turns the request into a command, the shift from the user's
    /// own words to that command is small — exactly the case a guard has to
    /// catch — while a benign command that does NOT implement the request
    /// produces a large shift and becomes the baseline. The absolute form
    /// reads the command's own representation instead. The artifact records
    /// which form it was calibrated under.
    pub absolute_harm_reading: bool,
    /// How the residual is collapsed over the tool-call span.
    ///
    /// `Mean` is the historical reading. `LogSumExp` pools the *per-token*
    /// cluster scores with a temperature, so a two-token destructive command
    /// inside a thirty-token JSON envelope is not diluted by its punctuation.
    /// The artifact records which pooling its thresholds were calibrated under,
    /// because the two statistics are not interchangeable.
    pub pooling: Pooling,
    /// The whitening applied to the cluster directions, if any.
    ///
    /// The artifact records the method it used (`ledoit-wolf`), and the
    /// sensor reports it here so the telemetry can state which directions the
    /// thresholds were fitted on. `None` means the artifact carries no
    /// whitened directions and the cluster directions are used exactly as they
    /// were measured.
    pub whitening: Option<String>,
    /// The Ledoit-Wolf shrinkage coefficient of the fitted whitening, if any.
    pub whitening_shrinkage: Option<f32>,
    /// Per-channel AWQ activation salience scales `[D]` calibrated from the
    /// artifact's reference/contrastive activations (`s_j = RMS_j^alpha`).
    pub awq_channel_scales: Option<Array>,
    /// Ratio of maximum to minimum AWQ channel scale (`max(s_j) / min(s_j)`).
    pub awq_salience_ratio: Option<f32>,
    /// Per-layer user anchor vectors `[D]` captured during Pass 1.
    pub user_anchor_by_layer: Vec<Array>,
    /// Per-layer full trace telemetry (`l2_norm`, `cos_harm`, `cos_drift`, `guard_logit`, `tensor_slice_preview`).
    pub layer_trace: Vec<LayerTraceMetric>,
    /// Per-token trace telemetry at `target_layer` (`idx`, `raw_harm_cosine`, `drift_score`, `pca_coords`).
    pub token_trace: Vec<TokenTraceMetric>,
    /// Calibrated PCA subspace reference clusters (`pc1_variance`, `pc2_variance`, `benign_cluster`, `exploit_cluster`).
    pub pca_reference: PcaReferenceTelemetry,
}

impl RepeSensor {
    pub fn load_safetensors(
        path: impl AsRef<Path>,
        fallback_target_layer: usize,
        clamp_threshold: Option<f32>,
    ) -> Result<Self> {
        let tensors: HashMap<String, Array> = Array::load_safetensors(path.as_ref())
            .with_context(|| format!("Failed to load RepE vectors from {:?}", path.as_ref()))?;

        let v_harm = tensors
            .get("v_harm")
            .context("Missing `v_harm` [D] tensor in RepE safetensors")?;
        let v_drift = tensors
            .get("v_drift")
            .context("Missing `v_drift` [D] tensor in RepE safetensors")?;
        let pca_basis = tensors
            .get("pca_basis")
            .context("Missing `pca_basis` [K, D] tensor in RepE safetensors")?;

        // The extractor records the layer it calibrated against; prefer it.
        let resolved_layer = match tensors.get("target_layer_idx") {
            Some(layer_arr) => {
                layer_arr.eval()?;
                layer_arr.item_exact::<i32>().max(0) as usize
            }
            None => fallback_target_layer,
        };

        // The artifact records which reading it was calibrated under.
        let meta = safetensors_metadata(path.as_ref()).unwrap_or_default();
        let absolute_harm_reading = meta
            .get("decision_mode")
            .map(|mode| mode.eq_ignore_ascii_case("absolute"))
            .unwrap_or(false);
        // ...and how the residual was pooled over the tool-call span.
        let pooling = Pooling::from_metadata(&meta);

        let read_scalar = |key: &str| -> Option<f32> {
            let arr = tensors.get(key)?;
            arr.eval().ok()?;
            arr.item_exact::<f32>().into()
        };
        let has_compliance_split = tensors.contains_key("harm_excess_threshold_obeys")
            && tensors.contains_key("harm_excess_threshold_violates");
        let matched_baseline = if has_compliance_split {
            read_scalar("benign_baseline_matched").or_else(|| read_scalar("benign_baseline"))
        } else {
            read_scalar("benign_baseline")
        };

        // The whitened cluster directions take precedence over the raw ones.
        //
        // An artifact calibrated on the whitened directions carries thresholds
        // that only apply to those directions, so the sensor has to read the
        // same ones the calibration measured. Artifacts without the whitened
        // tensor are read exactly as before.
        let whitened_clusters = tensors.get("v_harm_clusters_whitened");
        let using_whitened = whitened_clusters.is_some();
        let cluster_source = match whitened_clusters {
            Some(whitened) => Some(whitened),
            None => tensors.get("v_harm_clusters"),
        };
        // Whether the artifact's whitening was actually applied. An artifact
        // that predates the key is trusted as long as it carries the tensor.
        let whitening_applied = match meta.get("whitening_applied") {
            Some(value) => value.eq_ignore_ascii_case("true"),
            None => using_whitened,
        };
        let whitening = if using_whitened && whitening_applied {
            meta.get("whitening").cloned()
        } else {
            None
        };
        let whitening_shrinkage = if using_whitened && whitening_applied {
            meta.get("whitening_shrinkage")
                .and_then(|value| value.trim().parse::<f32>().ok())
        } else {
            None
        };

        let (awq_channel_scales, awq_salience_ratio) = match tensors
            .get("awq_channel_scales")
            .cloned()
            .or_else(|| {
                tensors
                    .get("benign_panel")
                    .and_then(|panel| crate::mlx_loader::compute_awq_channel_scales(panel, 0.5).ok())
            })
            .or_else(|| {
                cluster_source
                    .and_then(|clusters| crate::mlx_loader::compute_awq_channel_scales(clusters, 0.5).ok())
            }) {
            Some(scales) => {
                let sf = scales.as_type::<f32>().ok().and_then(|a| a.contiguous().ok());
                let ratio = sf.and_then(|a| {
                    a.eval().ok()?;
                    let sl = a.as_slice::<f32>();
                    let min_s = sl.iter().copied().fold(f32::INFINITY, f32::min);
                    let max_s = sl.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                    if min_s > 0.0 && max_s.is_finite() {
                        Some(max_s / min_s)
                    } else {
                        None
                    }
                });
                (Some(scales), ratio)
            }
            None => (None, None),
        };

        let pca_basis_f32 = pca_basis.as_type::<f32>()?;
        let evr_vec: Vec<f32> = meta
            .get("harm_evr_top_k")
            .and_then(|s| serde_json::from_str::<Vec<f32>>(s).ok())
            .unwrap_or_default();
        let pc1_variance = evr_vec.first().copied().unwrap_or(0.0);
        let pc2_variance = evr_vec.get(1).copied().unwrap_or(0.0);

        let project_2d = |vec_1d: &Array| -> Option<[f32; 2]> {
            let u = Self::unit_norm(vec_1d).ok()?;
            let c = matmul(&pca_basis_f32, &u).ok()?;
            c.eval().ok()?;
            let sl = c.as_slice::<f32>();
            Some([
                sl.first().copied().unwrap_or(0.0),
                sl.get(1).copied().unwrap_or(0.0),
            ])
        };

        let mut benign_cluster = Vec::new();
        for key in ["benign_panel", "benign_panel_natural"] {
            if let Some(panel) = tensors.get(key) {
                if let Ok(pf) = panel.as_type::<f32>() {
                    let rows = pf.shape().first().copied().unwrap_or(0);
                    for r in 0..rows {
                        let row = pf.index((r, ..));
                        if let Some(pt) = project_2d(&row) {
                            benign_cluster.push(pt);
                        }
                    }
                }
            }
        }
        if let Some(bs) = tensors.get("v_benign_shell") {
            if let Some(pt) = project_2d(bs) {
                benign_cluster.push(pt);
            }
        }

        let mut exploit_cluster = Vec::new();
        if let Some(hpanel) = tensors.get("harmful_panel") {
            if let Ok(hf) = hpanel.as_type::<f32>() {
                let rows = hf.shape().first().copied().unwrap_or(0);
                for r in 0..rows {
                    let row = hf.index((r, ..));
                    if let Some(pt) = project_2d(&row) {
                        exploit_cluster.push(pt);
                    }
                }
            }
        }
        if exploit_cluster.is_empty() {
            for key in ["v_harm_clusters", "v_harm_clusters_whitened"] {
                if let Some(cl) = tensors.get(key) {
                    if let Ok(cf) = cl.as_type::<f32>() {
                        let rows = cf.shape().first().copied().unwrap_or(0);
                        for r in 0..rows {
                            let row = cf.index((r, ..));
                            if let Some(pt) = project_2d(&row) {
                                exploit_cluster.push(pt);
                            }
                        }
                    }
                }
            }
            if let Some(pt) = project_2d(v_harm) {
                exploit_cluster.push(pt);
            }
            if let Some(pt) = project_2d(v_drift) {
                exploit_cluster.push(pt);
            }
        }

        Ok(Self {
            target_layer: resolved_layer,
            v_harm: Self::unit_norm(v_harm)?,
            v_harm_clusters: match cluster_source {
                Some(clusters) => {
                    let c = clusters.as_type::<f32>()?;
                    let n = c.shape()[0] as usize;
                    let mut out = Vec::with_capacity(n);
                    for i in 0..n {
                        let row = c.index((i as i32, ..));
                        out.push(Self::unit_norm(&row)?);
                    }
                    out
                }
                None => Vec::new(),
            },
            v_copy_mode: match tensors.get("v_copy_mode") {
                Some(copy) => Some(Self::unit_norm(copy)?),
                None => None,
            },
            v_benign_shell: match tensors.get("v_benign_shell") {
                Some(bs) => Some(Self::unit_norm(bs)?),
                None => None,
            },
            v_drift: Self::unit_norm(v_drift)?,
            pca_basis: pca_basis_f32,
            trusted_user_anchor: None,
            clamp_threshold,
            calibrated_harm_threshold: read_scalar("harm_threshold"),
            calibrated_drift_threshold: read_scalar("drift_threshold"),
            calibrated_harm_excess_threshold: read_scalar("harm_excess_threshold"),
            static_benign_baseline: matched_baseline,
            harm_excess_threshold_obeys: read_scalar("harm_excess_threshold_obeys"),
            harm_excess_threshold_violates: read_scalar("harm_excess_threshold_violates"),
            layer_profile: Vec::new(),
            layer_cluster_profile: Vec::new(),
            layer_pca_profile: Vec::new(),
            last_pca_coords: Vec::new(),
            absolute_harm_reading: absolute_harm_reading,
            pooling,
            whitening,
            whitening_shrinkage,
            awq_channel_scales,
            awq_salience_ratio,
            user_anchor_by_layer: Vec::new(),
            layer_trace: Vec::new(),
            token_trace: Vec::new(),
            pca_reference: PcaReferenceTelemetry {
                pc1_variance,
                pc2_variance,
                benign_cluster,
                exploit_cluster,
            },
        })
    }

    pub fn uncalibrated_zeros(num_layers: usize, d_model: i32) -> Result<Self> {
        let target_layer = ((num_layers as f32) * 0.68).round() as usize;
        let v_harm = Array::zeros::<f32>(&[d_model])?;
        let v_drift = Array::zeros::<f32>(&[d_model])?;
        let pca_basis = Array::zeros::<f32>(&[3, d_model])?;
        Ok(Self {
            target_layer,
            v_harm,
            v_harm_clusters: Vec::new(),
            v_copy_mode: None,
            v_benign_shell: None,
            v_drift,
            pca_basis,
            trusted_user_anchor: None,
            clamp_threshold: Some(0.45),
            calibrated_harm_threshold: None,
            calibrated_drift_threshold: None,
            calibrated_harm_excess_threshold: None,
            static_benign_baseline: None,
            harm_excess_threshold_obeys: None,
            harm_excess_threshold_violates: None,
            layer_profile: Vec::new(),
            layer_cluster_profile: Vec::new(),
            layer_pca_profile: Vec::new(),
            last_pca_coords: Vec::new(),
            absolute_harm_reading: false,
            pooling: Pooling::default(),
            whitening: None,
            whitening_shrinkage: None,
            awq_channel_scales: None,
            awq_salience_ratio: None,
            user_anchor_by_layer: Vec::new(),
            layer_trace: Vec::new(),
            token_trace: Vec::new(),
            pca_reference: PcaReferenceTelemetry::default(),
        })
    }

    /// Construct a calibrated `RepeSensor` directly in memory from RepE direction
    /// tensors without requiring a `.safetensors` file on disk.
    pub fn from_directions(
        target_layer: usize,
        harm_clusters: Vec<Array>,
        v_drift: Array,
        pca_basis: Option<Array>,
        pooling: Pooling,
        absolute_harm_reading: bool,
    ) -> Result<Self> {
        let v_drift_norm = Self::unit_norm(&v_drift)?;
        let d_model = v_drift_norm.shape().first().copied().unwrap_or(0);
        if d_model <= 0 {
            anyhow::bail!("from_directions: v_drift must be a non-empty 1-D vector");
        }
        let mut norm_clusters = Vec::with_capacity(harm_clusters.len());
        for c in &harm_clusters {
            norm_clusters.push(Self::unit_norm(c)?);
        }
        let v_harm = if norm_clusters.is_empty() {
            Array::zeros::<f32>(&[d_model])?
        } else {
            let stacked = stack(&norm_clusters, 0)?;
            let mean_dir = mean_axes(&stacked, &[0], false)?;
            Self::unit_norm(&mean_dir)?
        };
        let pca_basis = match pca_basis {
            Some(b) => b.as_type::<f32>()?,
            None => Array::zeros::<f32>(&[3, d_model])?,
        };
        mlx_rs::transforms::eval([&v_harm, &v_drift_norm, &pca_basis])?;
        Ok(Self {
            target_layer,
            v_harm,
            v_harm_clusters: norm_clusters,
            v_copy_mode: None,
            v_benign_shell: None,
            v_drift: v_drift_norm,
            pca_basis,
            trusted_user_anchor: None,
            clamp_threshold: None,
            calibrated_harm_threshold: None,
            calibrated_drift_threshold: None,
            calibrated_harm_excess_threshold: None,
            static_benign_baseline: None,
            harm_excess_threshold_obeys: None,
            harm_excess_threshold_violates: None,
            layer_profile: Vec::new(),
            layer_cluster_profile: Vec::new(),
            layer_pca_profile: Vec::new(),
            last_pca_coords: Vec::new(),
            absolute_harm_reading,
            pooling,
            whitening: None,
            whitening_shrinkage: None,
            awq_channel_scales: None,
            awq_salience_ratio: None,
            user_anchor_by_layer: Vec::new(),
            layer_trace: Vec::new(),
            token_trace: Vec::new(),
            pca_reference: PcaReferenceTelemetry::default(),
        })
    }

    /// Attach a verbatim-copy nuisance direction `[D]` to project out at probe time.
    pub fn with_copy_direction(mut self, v_copy: Array) -> Result<Self> {
        let c = Self::unit_norm(&v_copy)?;
        c.eval()?;
        self.v_copy_mode = Some(c);
        Ok(self)
    }

    /// Attach a shared shell-syntax direction `[D]` for live contrastive orthogonalization.
    pub fn with_shell_direction(mut self, v_shell: Array) -> Result<Self> {
        let s = Self::unit_norm(&v_shell)?;
        s.eval()?;
        self.v_benign_shell = Some(s);
        Ok(self)
    }

    /// Configure static benign baseline and calibrated excess/drift thresholds.
    pub fn with_thresholds(
        mut self,
        static_benign_baseline: Option<f32>,
        harm_excess_threshold: Option<f32>,
        drift_threshold: Option<f32>,
    ) -> Self {
        self.static_benign_baseline = static_benign_baseline;
        self.calibrated_harm_excess_threshold = harm_excess_threshold;
        self.calibrated_drift_threshold = drift_threshold;
        self
    }

    #[inline]
    pub fn unit_norm(v: &Array) -> Result<Array> {
        let vf = v.as_type::<f32>()?;
        let norm = sqrt(&sum(&multiply(&vf, &vf)?, true)?)?;
        Ok(divide(&vf, &add(&norm, &Array::from_f32(1e-6))?)?)
    }

    /// Lazy mean residual over the tool-call span `[D]` (does not force a GPU sync).
    #[inline]
    fn pooled_state_lazy(&self, h_layer: &Array, span_start: Option<usize>) -> Result<Array> {
        let seq_len = h_layer.shape()[1];
        let start = match span_start {
            Some(s) => (s as i32).min(seq_len.saturating_sub(1)),
            None => seq_len.saturating_sub(1),
        };
        let slice = h_layer.index((0, start..seq_len, ..)).as_type::<f32>()?;
        Ok(mean_axes(&slice, &[0], false)?)
    }

    /// Pool the residual over the tool-call span (`[D]`, evaluated).
    ///
    /// `span_start` is the index of the first token of the span. When it is
    /// unknown the last token is used — the historical behaviour. Averaging
    /// over the span instead of reading one trailing token keeps the user's
    /// own wording out of the measurement.
    pub fn pooled_state(&self, h_layer: &Array, span_start: Option<usize>) -> Result<Array> {
        let pooled = self.pooled_state_lazy(h_layer, span_start)?;
        pooled.eval()?;
        Ok(pooled)
    }

    /// Lazy mean residual over every token of the sequence `[D]`.
    #[inline]
    fn mean_state_lazy(h_layer: &Array) -> Result<Array> {
        let seq_len = h_layer.shape()[1];
        let slice = h_layer.index((0, 0..seq_len, ..)).as_type::<f32>()?;
        Ok(mean_axes(&slice, &[0], false)?)
    }

    /// The mean residual over every token of the sequence.
    fn mean_state(h_layer: &Array) -> Result<Array> {
        let pooled = Self::mean_state_lazy(h_layer)?;
        pooled.eval()?;
        Ok(pooled)
    }

    /// Lock the residual stream state of the trusted user prompt.
    ///
    /// The anchor is the *mean* over the user turn's tokens, not its last
    /// token: the final token of a prompt is dominated by how the request
    /// happened to be worded, which is exactly the dependence the decision
    /// statistic has to shed.
    pub fn record_user_anchor(&mut self, h_layer: &Array) -> Result<()> {
        let anchor = Self::mean_state(h_layer)?;
        self.trusted_user_anchor = Some(anchor);
        Ok(())
    }

    /// Record a lazy mean user-turn anchor vector for `layer_idx` without forcing
    /// a per-layer Metal synchronization; call `finalize_user_anchors` once after
    /// `target_layer` to evaluate all layer anchors in a single batch.
    pub fn record_layer_anchor_lazy(&mut self, layer_idx: usize, h_layer: &Array) -> Result<()> {
        if layer_idx == 0 {
            self.user_anchor_by_layer.clear();
        }
        let anchor = Self::mean_state_lazy(h_layer)?;
        if layer_idx == self.target_layer {
            self.trusted_user_anchor = Some(anchor.clone());
        }
        if layer_idx == self.user_anchor_by_layer.len() {
            self.user_anchor_by_layer.push(anchor);
        } else if layer_idx < self.user_anchor_by_layer.len() {
            self.user_anchor_by_layer[layer_idx] = anchor;
        }
        Ok(())
    }

    /// Evaluate all queued user-turn layer anchors in a single GPU batch.
    pub fn finalize_user_anchors(&mut self) -> Result<()> {
        if !self.user_anchor_by_layer.is_empty() {
            mlx_rs::transforms::eval(&self.user_anchor_by_layer)?;
        }
        if let Some(ref anchor) = self.trusted_user_anchor {
            anchor.eval()?;
        }
        Ok(())
    }

    /// Record the mean user-turn anchor vector for a specific decoder layer `layer_idx`.
    pub fn record_layer_anchor(&mut self, layer_idx: usize, h_layer: &Array) -> Result<()> {
        self.record_layer_anchor_lazy(layer_idx, h_layer)?;
        if let Some(last) = self.user_anchor_by_layer.get(layer_idx) {
            last.eval()?;
        }
        Ok(())
    }

    /// The harm cosine of a residual state, measured the same way the inline
    /// hook measures it (relative to the trusted anchor when one is locked).
    pub fn probe_cosine(&self, h_layer: &Array, span_start: Option<usize>) -> Result<f32> {
        let (harm, _) = self.span_harm_reading(h_layer, span_start)?;
        Ok(harm)
    }

    /// Measure `(harm_cosine, cluster_scores, pca_coords)` for one decoder layer.
    pub fn probe_layer_telemetry(
        &self,
        h_layer: &Array,
        span_start: Option<usize>,
    ) -> Result<(f32, Vec<f32>, Vec<f32>)> {
        let (harm, scores) = self.span_harm_reading(h_layer, span_start)?;
        let pca = self.pca_coordinates(h_layer, span_start)?;
        Ok((harm, scores.cluster_scores, pca))
    }

    /// Fused per-layer telemetry capture: computes `layer_profile`,
    /// `layer_cluster_profile`, `layer_pca_profile`, and `layer_trace` in a single
    /// batched MLX evaluation instead of 10+ synchronous per-layer `.eval()` calls.
    ///
    /// When `need_span_scores` is true (e.g. at `target_layer`), returns the cached
    /// `(harm_cosine, SpanScores, pca_coords)` so `inspect_and_maybe_clamp_with_cached`
    /// can reuse them directly without recomputation.
    pub fn record_full_layer_telemetry(
        &mut self,
        layer_idx: usize,
        h_layer: &Array,
        span_start: Option<usize>,
        need_span_scores: bool,
    ) -> Result<Option<(f32, SpanScores, Vec<f32>)>> {
        let pooled = self.pooled_state_lazy(h_layer, span_start)?;
        let norm_arr = sqrt(&sum(&multiply(&pooled, &pooled)?, false)?)?;
        let h_unit = Self::unit_norm(&pooled)?;
        let pca_arr = matmul(&self.pca_basis, &h_unit)?.contiguous()?;

        let seq_len = h_layer.shape()[1];
        let d_model = h_layer.shape()[2];
        let slice_len = d_model.min(8);
        let last_slice = h_layer
            .index((0, seq_len.saturating_sub(1), 0..slice_len))
            .as_type::<f32>()?
            .contiguous()?;

        let anchor_ref = self
            .user_anchor_by_layer
            .get(layer_idx)
            .or(self.trusted_user_anchor.as_ref());
        let dot_opt = match anchor_ref {
            Some(anchor) => {
                let a_unit = Self::unit_norm(anchor)?;
                Some(sum(&multiply(&h_unit, &a_unit)?, false)?)
            }
            None => None,
        };

        let (cos_harm, cluster_scores, pca_vec, cached_span) =
            if !need_span_scores && matches!(self.pooling, Pooling::Mean) {
                let dims = self.harm_directions();
                let probe = self.probe_of(&pooled)?;
                let dir_mat = stack(&dims, 0)?; // [C, D]
                let cluster_arr = matmul(&dir_mat, &probe)?.contiguous()?;
                if let Some(ref dot_arr) = dot_opt {
                    mlx_rs::transforms::eval([
                        &norm_arr,
                        &cluster_arr,
                        &pca_arr,
                        &last_slice,
                        dot_arr,
                    ])?;
                } else {
                    mlx_rs::transforms::eval([&norm_arr, &cluster_arr, &pca_arr, &last_slice])?;
                }
                let clusters = cluster_arr.as_slice::<f32>().to_vec();
                let harm = clusters
                    .iter()
                    .copied()
                    .fold(f32::NEG_INFINITY, f32::max);
                let pca_v = pca_arr.as_slice::<f32>().to_vec();
                (harm, clusters, pca_v, None)
            } else {
                if let Some(ref dot_arr) = dot_opt {
                    mlx_rs::transforms::eval([&norm_arr, &pca_arr, &last_slice, dot_arr])?;
                } else {
                    mlx_rs::transforms::eval([&norm_arr, &pca_arr, &last_slice])?;
                }
                let (harm, scores) = self.span_harm_reading(h_layer, span_start)?;
                let clusters = scores.cluster_scores.clone();
                let pca_v = pca_arr.as_slice::<f32>().to_vec();
                let cached = if need_span_scores {
                    Some((harm, scores, pca_v.clone()))
                } else {
                    None
                };
                (harm, clusters, pca_v, cached)
            };

        let l2_norm = norm_arr.item_exact::<f32>();
        let cos_drift = match dot_opt {
            Some(dot_arr) => (1.0 - dot_arr.item_exact::<f32>()).clamp(0.0, 2.0),
            None => 0.0,
        };
        let tensor_slice_preview = last_slice.as_slice::<f32>().to_vec();
        let pca_coords_2d = [
            pca_vec.first().copied().unwrap_or(0.0),
            pca_vec.get(1).copied().unwrap_or(0.0),
        ];

        let base = self.static_benign_baseline.unwrap_or(0.0);
        let thr = self
            .calibrated_harm_excess_threshold
            .or(self.harm_excess_threshold_violates)
            .unwrap_or(0.011);
        let guard_logit = (cos_harm - base) - thr;

        self.layer_profile.push(cos_harm);
        self.layer_cluster_profile.push(cluster_scores);
        self.layer_pca_profile.push(pca_vec);
        self.layer_trace.push(LayerTraceMetric {
            layer: layer_idx,
            l2_norm,
            cos_harm,
            cos_drift,
            guard_logit,
            tensor_slice_preview,
            pca_coords: pca_coords_2d,
        });

        Ok(cached_span)
    }

    /// Record a `LayerTraceMetric` (`l2_norm`, `cos_harm`, `cos_drift`, `guard_logit`,
    /// and the first 8 floats of `h_l[last_token]`) for `GhostlineTraceFrame`.
    pub fn record_layer_trace(
        &mut self,
        layer_idx: usize,
        h_layer: &Array,
        span_start: Option<usize>,
        cos_harm: f32,
    ) -> Result<()> {
        let pooled = self.pooled_state_lazy(h_layer, span_start)?;
        let norm_arr = sqrt(&sum(&multiply(&pooled, &pooled)?, false)?)?;
        let h_unit = Self::unit_norm(&pooled)?;
        let pca_arr = matmul(&self.pca_basis, &h_unit)?.contiguous()?;
        let seq_len = h_layer.shape()[1];
        let d_model = h_layer.shape()[2];
        let slice_len = d_model.min(8);
        let last_slice = h_layer
            .index((0, seq_len.saturating_sub(1), 0..slice_len))
            .as_type::<f32>()?
            .contiguous()?;

        let anchor_ref = self
            .user_anchor_by_layer
            .get(layer_idx)
            .or(self.trusted_user_anchor.as_ref());
        let cos_drift = if let Some(anchor) = anchor_ref {
            let a_unit = Self::unit_norm(anchor)?;
            let dot_arr = sum(&multiply(&h_unit, &a_unit)?, false)?;
            mlx_rs::transforms::eval([&norm_arr, &dot_arr, &pca_arr, &last_slice])?;
            (1.0 - dot_arr.item_exact::<f32>()).clamp(0.0, 2.0)
        } else {
            mlx_rs::transforms::eval([&norm_arr, &pca_arr, &last_slice])?;
            0.0
        };
        let l2_norm = norm_arr.item_exact::<f32>();
        let tensor_slice_preview = last_slice.as_slice::<f32>().to_vec();

        let base = self.static_benign_baseline.unwrap_or(0.0);
        let thr = self
            .calibrated_harm_excess_threshold
            .or(self.harm_excess_threshold_violates)
            .unwrap_or(0.011);
        let guard_logit = (cos_harm - base) - thr;

        let pca_sl = pca_arr.as_slice::<f32>();
        let pca_coords = [
            pca_sl.first().copied().unwrap_or(0.0),
            pca_sl.get(1).copied().unwrap_or(0.0),
        ];

        self.layer_trace.push(LayerTraceMetric {
            layer: layer_idx,
            l2_norm,
            cos_harm,
            cos_drift,
            guard_logit,
            tensor_slice_preview,
            pca_coords,
        });
        Ok(())
    }

    /// Span-aware contrastive hot-reload: extracts tool-call span representations
    /// in the sensor's active probe basis, computes the paired contrastive direction
    /// `unit(probe(h_adv) - probe(h_benign))` orthogonalized against nuisance axes,
    /// and updates BOTH the best-matching cluster in `v_harm_clusters` and `v_harm`.
    pub fn hot_reload_contrastive_spans(
        &mut self,
        h_benign_layer: &Array,
        benign_span_start: Option<usize>,
        h_adv_layer: &Array,
        adv_span_start: Option<usize>,
    ) -> Result<(f32, f32, [f32; 2], [f32; 2])> {
        let b_pooled = match benign_span_start {
            Some(s) => self.pooled_state_lazy(h_benign_layer, Some(s))?,
            None => Self::mean_state_lazy(h_benign_layer)?,
        };
        let a_pooled = match adv_span_start {
            Some(s) => self.pooled_state_lazy(h_adv_layer, Some(s))?,
            None => Self::mean_state_lazy(h_adv_layer)?,
        };
        let raw_delta = subtract(&a_pooled, &b_pooled)?;
        let delta_norm_arr = sqrt(&sum(&multiply(&raw_delta, &raw_delta)?, false)?)?;

        let b_unit = Self::unit_norm(&b_pooled)?;
        let a_unit = Self::unit_norm(&a_pooled)?;
        let b_probe = self.probe_of(&b_pooled)?;
        let a_probe = self.probe_of(&a_pooled)?;

        // Paired difference in the sensor's active probe basis cancels shared lexical
        // and cone components between the matched benign and adversarial calls.
        let mut delta_orth = subtract(&a_probe, &b_probe)?;
        if let Some(ref shell) = self.v_benign_shell {
            let proj_s = sum(&multiply(&delta_orth, shell)?, false)?;
            delta_orth = subtract(&delta_orth, &multiply(shell, &proj_s)?)?;
        }
        if let Some(ref copy) = self.v_copy_mode {
            let proj_c = sum(&multiply(&delta_orth, copy)?, false)?;
            delta_orth = subtract(&delta_orth, &multiply(copy, &proj_c)?)?;
        }
        let v_contrastive = Self::unit_norm(&delta_orth)?;

        let align_val = if !self.v_harm_clusters.is_empty() {
            let dir_mat = stack(&self.v_harm_clusters, 0)?; // [C, D]
            let dots = matmul(&dir_mat, &v_contrastive)?.contiguous()?;
            dots.eval()?;
            let sl = dots.as_slice::<f32>();
            let (best_idx, best_align) = sl
                .iter()
                .copied()
                .enumerate()
                .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap_or((0, 0.0));
            for (c_idx, &align_c) in sl.iter().enumerate() {
                if c_idx == best_idx {
                    let blended = add(
                        &multiply(&self.v_harm_clusters[c_idx], &Array::from_f32(0.65))?,
                        &multiply(&v_contrastive, &Array::from_f32(0.35))?,
                    )?;
                    let updated = Self::unit_norm(&blended)?;
                    updated.eval()?;
                    self.v_harm_clusters[c_idx] = updated;
                } else if align_c < 0.0 {
                    // Suppress false-positive cone alignment on any other cluster that
                    // scored the benign command higher than the adversarial command,
                    // while leaving orthogonal clusters untouched.
                    let step = (-align_c * 0.50).min(0.35);
                    let corrected = add(
                        &self.v_harm_clusters[c_idx],
                        &multiply(&v_contrastive, &Array::from_f32(step))?,
                    )?;
                    let updated = Self::unit_norm(&corrected)?;
                    updated.eval()?;
                    self.v_harm_clusters[c_idx] = updated;
                }
            }

            let updated_mat = stack(&self.v_harm_clusters, 0)?;
            let mean_harm = mean_axes(&updated_mat, &[0], false)?;
            self.v_harm = Self::unit_norm(&mean_harm)?;
            best_align
        } else {
            let align_arr = sum(&multiply(&v_contrastive, &self.v_harm)?, false)?;
            align_arr.eval()?;
            let prev_align = align_arr.item_exact::<f32>();
            let blended = add(
                &multiply(&self.v_harm, &Array::from_f32(0.75))?,
                &multiply(&v_contrastive, &Array::from_f32(0.25))?,
            )?;
            self.v_harm = Self::unit_norm(&blended)?;
            prev_align
        };

        let pca_b = matmul(&self.pca_basis, &b_unit)?.contiguous()?;
        let pca_a = matmul(&self.pca_basis, &a_unit)?.contiguous()?;
        mlx_rs::transforms::eval([&delta_norm_arr, &self.v_harm, &pca_b, &pca_a])?;

        let b_sl = pca_b.as_slice::<f32>();
        let a_sl = pca_a.as_slice::<f32>();
        let b_pt = [
            b_sl.first().copied().unwrap_or(0.0),
            b_sl.get(1).copied().unwrap_or(0.0),
        ];
        let a_pt = [
            a_sl.first().copied().unwrap_or(0.0),
            a_sl.get(1).copied().unwrap_or(0.0),
        ];
        self.pca_reference.benign_cluster.push(b_pt);
        self.pca_reference.exploit_cluster.push(a_pt);

        Ok((delta_norm_arr.item_exact::<f32>(), align_val, b_pt, a_pt))
    }

    /// Recompute a contrastive activation difference vector `\Delta h_l = h_l^{adv} - h_l^{benign}`
    /// from two live residual tensors at `target_layer`, orthogonalize `\Delta h_l` against existing
    /// benign axes, and hot-reload the active probe direction.
    pub fn hot_reload_contrastive(
        &mut self,
        h_benign_layer: &Array,
        h_adv_layer: &Array,
    ) -> Result<(f32, f32, [f32; 2], [f32; 2])> {
        self.hot_reload_contrastive_spans(h_benign_layer, None, h_adv_layer, None)
    }

    /// Clear all per-layer profile buffers before a new forward pass.
    pub fn clear_profiles(&mut self) {
        self.layer_profile.clear();
        self.layer_cluster_profile.clear();
        self.layer_pca_profile.clear();
        self.layer_trace.clear();
        self.token_trace.clear();
    }

    /// The projection of the inspected state onto the PCA basis.
    pub fn pca_coordinates(&self, h_layer: &Array, span_start: Option<usize>) -> Result<Vec<f32>> {
        let pooled = self.pooled_state_lazy(h_layer, span_start)?;
        let h_unit = Self::unit_norm(&pooled)?;
        let coords = matmul(&self.pca_basis, &h_unit)?.contiguous()?;
        coords.eval()?;
        Ok(coords.as_slice::<f32>().to_vec())
    }

    /// Build the probe vector a residual state is scored with.
    ///
    /// Two projections happen here, and the calibration applied exactly the
    /// same two, so a threshold measured offline still applies online:
    ///
    /// 1. *Absolute* reading: project the tool-call state itself.
    ///    *Anchor-relative* reading: project the shift away from the trusted
    ///    user turn, when one is locked.
    /// 2. Discount the verbatim-copy channel: project it out and renormalise,
    ///    so a command the agent merely echoes back is scored on what it does
    ///    rather than on the fact that it was copied.
    fn probe_of(&self, state: &Array) -> Result<Array> {
        let probe = if self.absolute_harm_reading {
            Self::unit_norm(state)?
        } else {
            match self.trusted_user_anchor.as_ref() {
                Some(anchor) => {
                    let delta = subtract(state, anchor)?;
                    Self::unit_norm(&delta)?
                }
                None => Self::unit_norm(state)?,
            }
        };
        let probe = match self.v_copy_mode.as_ref() {
            Some(copy) => {
                let proj = sum(&multiply(&probe, copy)?, false)?;
                let projected = subtract(&probe, &multiply(copy, &proj)?)?;
                Self::unit_norm(&projected)?
            }
            None => probe,
        };
        Ok(probe)
    }

    /// The harm directions this sensor scores against: the cluster directions
    /// when the artifact carries them, otherwise the legacy single vector.
    fn harm_directions(&self) -> Vec<Array> {
        if self.v_harm_clusters.is_empty() {
            vec![self.v_harm.clone()]
        } else {
            self.v_harm_clusters.clone()
        }
    }

    /// The per-token cosine of every token in the tool-call span against every
    /// harm direction.
    ///
    /// The returned table is row-major over tokens: `scores[t * C + c]`.
    ///
    /// Every token is normalised on its own, so a token that carries a strong
    /// destructive signal is not averaged away by the punctuation around it.
    /// The copy channel is projected out per token, exactly as `probe_of`
    /// does for a pooled state.
    pub fn token_cluster_scores(
        &self,
        h_layer: &Array,
        span_start: Option<usize>,
    ) -> Result<SpanScores> {
        let dims = self.harm_directions();
        let cfg = TokenScoreConfig {
            anchor: if self.absolute_harm_reading {
                None
            } else {
                self.trusted_user_anchor.clone()
            },
            copy_dir: self.v_copy_mode.clone(),
            directions: dims.clone(),
        };
        let table = token_score_table(h_layer, span_start, &cfg)?;

        let mean_pooled_scores = |sensor: &Self| -> Result<Vec<f32>> {
            let pooled = sensor.pooled_state_lazy(h_layer, span_start)?;
            let probe = sensor.probe_of(&pooled)?;
            let dir_mat = stack(&dims, 0)?; // [C, D]
            let proj = matmul(&dir_mat, &probe)?.contiguous()?;
            proj.eval()?;
            Ok(proj.as_slice::<f32>().to_vec())
        };

        let (cluster_scores, peak_token, peak_cosine) = match self.pooling {
            Pooling::Mean => {
                let scores = mean_pooled_scores(self)?;
                let mut peak_token = Vec::with_capacity(dims.len());
                let mut peak_cosine = Vec::with_capacity(dims.len());
                for c in 0..dims.len() {
                    let (idx, val) = argmax_row(&table, c);
                    peak_token.push(table.span_start + idx);
                    peak_cosine.push(val);
                }
                (scores, peak_token, peak_cosine)
            }
            Pooling::LogSumExp { beta } => {
                let mut scores = Vec::with_capacity(dims.len());
                let mut peak_token = Vec::with_capacity(dims.len());
                let mut peak_cosine = Vec::with_capacity(dims.len());
                for c in 0..dims.len() {
                    let (pooled, idx, val) = lse_pool(&table, c, beta);
                    scores.push(pooled);
                    peak_token.push(table.span_start + idx);
                    peak_cosine.push(val);
                }
                (scores, peak_token, peak_cosine)
            }
            Pooling::Hybrid { beta, weight } => {
                let w = weight.clamp(0.0, 1.0);
                let mean_scores = mean_pooled_scores(self)?;
                let mut scores = Vec::with_capacity(dims.len());
                let mut peak_token = Vec::with_capacity(dims.len());
                let mut peak_cosine = Vec::with_capacity(dims.len());
                for (c, &m_val) in mean_scores.iter().enumerate() {
                    let (lse_val, idx, val) = lse_pool(&table, c, beta);
                    scores.push((1.0 - w) * m_val + w * lse_val);
                    peak_token.push(table.span_start + idx);
                    peak_cosine.push(val);
                }
                (scores, peak_token, peak_cosine)
            }
        };

        let argmax_cluster = cluster_scores
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, _)| i)
            .unwrap_or(0);

        Ok(SpanScores {
            cluster_scores,
            token_scores: table.scores,
            peak_token,
            peak_cosine,
            span_start: table.span_start,
            span_len: table.span_len,
            argmax_cluster,
        })
    }

    /// The harm reading of a tool-call span, pooled the way the artifact was
    /// calibrated.
    ///
    /// This is the single entry point the extractor and the live guard both
    /// use, so a threshold measured offline applies online unchanged.
    pub fn span_harm_reading(&self, h_layer: &Array, span_start: Option<usize>) -> Result<(f32, SpanScores)> {
        let scores = self.token_cluster_scores(h_layer, span_start)?;
        let harm = scores
            .cluster_scores
            .iter()
            .copied()
            .fold(f32::NEG_INFINITY, f32::max);
        Ok((harm, scores))
    }

    /// THE INLINE HOOK: Called inside Qwen's decoder loop right after
    /// `layers[self.target_layer]`. Reads the `<tool_call>` residual state
    /// `h` [batch=1, seq_len, d_model] and optionally clamps it.
    pub fn inspect_and_maybe_clamp(
        &mut self,
        h_layer: &mut Array,
        span_start: Option<usize>,
    ) -> Result<RepeProbeTelemetry> {
        self.inspect_and_maybe_clamp_with_cached(h_layer, span_start, None)
    }

    /// Inline hook variant that reuses `(harm_cosine, SpanScores, pca_coords)` when
    /// `record_full_layer_telemetry` already computed them at `target_layer`, and
    /// vectorizes the entire per-token PCA + drift trace into one GPU GEMM.
    pub fn inspect_and_maybe_clamp_with_cached(
        &mut self,
        h_layer: &mut Array,
        span_start: Option<usize>,
        cached: Option<(f32, SpanScores, Vec<f32>)>,
    ) -> Result<RepeProbeTelemetry> {
        let seq_len = h_layer.shape()[1];
        let pooled = self.pooled_state_lazy(h_layer, span_start)?;

        let (harm_cosine, span_scores, pca_vec) = match cached {
            Some(c) => c,
            None => {
                let h_unit = Self::unit_norm(&pooled)?;
                let pca_arr = matmul(&self.pca_basis, &h_unit)?.contiguous()?;
                pca_arr.eval()?;
                let pca_v = pca_arr.as_slice::<f32>().to_vec();
                let (harm, scores) = self.span_harm_reading(h_layer, span_start)?;
                (harm, scores, pca_v)
            }
        };

        // TaskTracker Activation Delta: <unit(h_curr - h_user), v_drift>
        let drift_cos_arr = if let Some(ref anchor) = self.trusted_user_anchor {
            let delta = subtract(&pooled, anchor)?;
            let delta_unit = Self::unit_norm(&delta)?;
            sum(&multiply(&delta_unit, &self.v_drift)?, false)?
        } else {
            Array::from_f32(0.0)
        };

        self.last_pca_coords = pca_vec.clone();
        let pca_subspace_energy = pca_vec.iter().map(|v| v * v).sum::<f32>().sqrt();

        // Vectorized per-token [PC1, PC2] coordinates and drift scores across the span:
        // single `[T, D] @ [D, K]` matmul instead of `T` sequential `.eval()` calls.
        self.token_trace.clear();
        let n_clusters = span_scores.cluster_scores.len().max(1);
        let start_i = (span_scores.span_start as i32).min(seq_len.saturating_sub(1));
        let end_i = ((span_scores.span_start + span_scores.span_len) as i32).min(seq_len);
        let eff_len = (end_i - start_i).max(0) as usize;

        let drift_cosine = if eff_len > 0 {
            let tok_slice = h_layer
                .index((0, start_i..end_i, ..))
                .as_type::<f32>()?
                .reshape(&[eff_len as i32, -1])?;
            let tok_sq = multiply(&tok_slice, &tok_slice)?;
            let tok_norm = sqrt(&sum_axis(&tok_sq, -1, true)?)?;
            let tok_unit = divide(&tok_slice, &add(&tok_norm, &Array::from_f32(1e-6))?)?;

            let pca_f32 = self.pca_basis.as_type::<f32>()?;
            let pca_k = pca_f32.shape().first().copied().unwrap_or(0).max(0) as usize;
            let pca_t = transpose_axes(&pca_f32, &[1, 0])?; // [D, K]
            let tok_pca_mat = matmul(&tok_unit, &pca_t)?.contiguous()?; // [T, K]

            let anchor_opt = self
                .user_anchor_by_layer
                .get(self.target_layer)
                .or(self.trusted_user_anchor.as_ref());
            let tok_dots_opt = match anchor_opt {
                Some(anchor) => {
                    let a_col = Self::unit_norm(anchor)?.reshape(&[-1, 1])?; // [D, 1]
                    Some(
                        matmul(&tok_unit, &a_col)?
                            .reshape(&[eff_len as i32])?
                            .contiguous()?,
                    )
                }
                None => None,
            };

            if let Some(ref tok_dots) = tok_dots_opt {
                mlx_rs::transforms::eval([&drift_cos_arr, &tok_pca_mat, tok_dots])?;
            } else {
                mlx_rs::transforms::eval([&drift_cos_arr, &tok_pca_mat])?;
            }

            let pca_sl = tok_pca_mat.as_slice::<f32>();
            let dots_sl = tok_dots_opt.as_ref().map(|d| d.as_slice::<f32>());
            self.token_trace.reserve(eff_len);
            for t in 0..eff_len {
                let pc1 = if pca_k >= 1 { pca_sl[t * pca_k] } else { 0.0 };
                let pc2 = if pca_k >= 2 { pca_sl[t * pca_k + 1] } else { 0.0 };
                let tok_drift = match dots_sl {
                    Some(ds) => (1.0 - ds[t]).clamp(0.0, 1.0),
                    None => 0.0,
                };
                let row_start = t * n_clusters;
                let raw_harm = span_scores.token_scores
                    [row_start..(row_start + n_clusters).min(span_scores.token_scores.len())]
                    .iter()
                    .copied()
                    .fold(f32::NEG_INFINITY, f32::max);
                self.token_trace.push(TokenTraceMetric {
                    idx: t,
                    raw_harm_cosine: if raw_harm.is_finite() { raw_harm } else { 0.0 },
                    drift_score: tok_drift,
                    pca_coords: [pc1, pc2],
                });
            }
            drift_cos_arr.item_exact::<f32>()
        } else {
            drift_cos_arr.eval()?;
            drift_cos_arr.item_exact::<f32>()
        };

        // Optional In-Place Orthogonal Clamping when `harm_cosine > thresh`:
        // project out the tripped cluster direction (and any other cluster direction
        // exceeding `thresh`) on the final token, respecting `absolute_harm_reading`.
        let mut clamped_in_place = false;
        if let Some(thresh) = self.clamp_threshold {
            if harm_cosine > thresh {
                let dirs = self.harm_directions();
                let mut h_last = h_layer.index((0, seq_len - 1, ..)).as_type::<f32>()?;
                for (c_idx, dir) in dirs.iter().enumerate() {
                    let c_score = span_scores
                        .cluster_scores
                        .get(c_idx)
                        .copied()
                        .unwrap_or(harm_cosine);
                    if c_idx == span_scores.argmax_cluster || c_score > thresh {
                        let ref_vec = if self.absolute_harm_reading {
                            h_last.clone()
                        } else if let Some(ref anchor) = self.trusted_user_anchor {
                            subtract(&h_last, anchor)?
                        } else {
                            h_last.clone()
                        };
                        let dot = sum(&multiply(&ref_vec, dir)?, true)?;
                        let pos_proj = maximum(&dot, &Array::from_f32(0.0))?;
                        let correction = multiply(&pos_proj, dir)?;
                        h_last = subtract(&h_last, &correction)?;
                    }
                }
                let h_clamped = h_last.reshape(&[1, 1, -1])?;
                if seq_len > 1 {
                    let prefix = h_layer.index((.., 0..(seq_len - 1), ..));
                    *h_layer = concatenate(&[prefix, h_clamped], 1)?;
                } else {
                    *h_layer = h_clamped;
                }
                clamped_in_place = true;
            }
        }

        Ok(RepeProbeTelemetry {
            token_scores: span_scores.token_scores.clone(),
            span_start: span_scores.span_start,
            layer_idx: self.target_layer,
            harm_cosine,
            drift_cosine,
            pca_subspace_energy,
            clamped_in_place,
            cluster_scores: span_scores.cluster_scores.clone(),
            attribution_token_index: span_scores
                .peak_token
                .get(span_scores.argmax_cluster)
                .copied(),
            attribution_cluster: Some(span_scores.argmax_cluster),
            attribution_cosine: span_scores
                .peak_cosine
                .get(span_scores.argmax_cluster)
                .copied()
                .unwrap_or(0.0),
            span_tokens: span_scores.span_len,
        })
    }

    /// Calibrate top-K PCA directions via centered SVD from difference/state vectors `deltas` [N, D].
    ///
    /// Centers `deltas` along axis 0 when `N > 1` so PC1 captures genuine variance
    /// rather than the uncentered mean direction, and guarantees strictly unit-norm
    /// rows (`+/- 1` sign orientation, never zeroed by `sign(0.0)`).
    pub fn fit_pca_subspace(deltas: &Array, k: i32) -> Result<Array> {
        let deltas_f32 = deltas.as_type::<f32>()?;
        let rows = deltas_f32.shape().first().copied().unwrap_or(0);
        let cols = deltas_f32.shape().get(1).copied().unwrap_or(0);
        let k_eff = k.min(rows).min(cols).max(1);

        let centered = if rows > 1 {
            let mu = mean_axes(&deltas_f32, &[0], true)?;
            subtract(&deltas_f32, &mu)?
        } else {
            deltas_f32.clone()
        };

        // MLX has no GPU implementation of the SVD — run it on the CPU stream.
        let cpu = mlx_rs::Stream::cpu();
        let (_u, _s, vt) = mlx_rs::with_stream(&cpu, || svd(&centered))?;
        let top_k = vt.index((0..k_eff, ..));

        // Orient signs against uncentered `deltas` so positive harm deltas project positively,
        // avoiding `sign(0.0) == 0.0` which would annihilate zero-mean principal axes.
        let proj = matmul(&deltas_f32, &transpose_axes(&top_k, &[1, 0])?)?;
        let mean_proj = mean_axes(&proj, &[0], false)?.contiguous()?;
        mean_proj.eval()?;
        let sign_vals: Vec<f32> = mean_proj
            .as_slice::<f32>()
            .iter()
            .map(|&v| if v < 0.0 { -1.0 } else { 1.0 })
            .collect();
        let signs = Array::from_slice(&sign_vals, &[k_eff, 1]);
        let oriented = multiply(&top_k, &signs)?;

        // Normalize each row to unit length and pad to `k` rows if `rows < k`.
        let sq = multiply(&oriented, &oriented)?;
        let norm = sqrt(&sum_axis(&sq, -1, true)?)?;
        let mut aligned = divide(&oriented, &add(&norm, &Array::from_f32(1e-6))?)?;
        if k_eff < k {
            let pad = Array::zeros::<f32>(&[k - k_eff, cols])?;
            aligned = concatenate(&[aligned, pad], 0)?;
        }
        aligned.eval()?;
        Ok(aligned)
    }
}

// ------------------------------------------------------------------------------
// Cached-vector inspection
// ------------------------------------------------------------------------------

/// Read the `__metadata__` header of a safetensors file.
///
/// The header is the first 8 bytes (little-endian length) followed by that many
/// bytes of JSON, so this needs no third-party parser.
pub fn safetensors_metadata(path: impl AsRef<Path>) -> Result<HashMap<String, String>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path.as_ref())
        .with_context(|| format!("Failed to open {:?}", path.as_ref()))?;
    let mut len_buf = [0u8; 8];
    file.read_exact(&mut len_buf)?;
    let header_len = u64::from_le_bytes(len_buf) as usize;
    let mut header = vec![0u8; header_len];
    file.read_exact(&mut header)?;
    let json: serde_json::Value = serde_json::from_slice(&header)
        .with_context(|| format!("Failed to parse the safetensors header of {:?}", path.as_ref()))?;

    let mut out = HashMap::new();
    if let Some(obj) = json.get("__metadata__").and_then(|m| m.as_object()) {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    Ok(out)
}

/// A cached set of RepE vectors plus the model structure they were built for.
pub struct RepeVectorsCache {
    pub path: PathBuf,
    pub fingerprint: ModelFingerprint,
}

impl RepeVectorsCache {
    /// Open the cache and read its fingerprint, if the file carries one.
    pub fn open(path: impl AsRef<Path>) -> Result<Option<Self>> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Ok(None);
        }
        let meta = safetensors_metadata(&path)?;
        match ModelFingerprint::from_metadata(&meta) {
            Some(fingerprint) => Ok(Some(Self { path, fingerprint })),
            None => Ok(None),
        }
    }
}


/// Persist a set of RepE vectors together with the model fingerprint they
/// were derived from, so a later run can tell whether they still apply.
pub fn save_repe_vectors(
    path: impl AsRef<Path>,
    v_harm: &Array,
    v_drift: &Array,
    pca_basis: &Array,
    fingerprint: &ModelFingerprint,
    probe_layer: usize,
    calibration_mode: &str,
) -> Result<()> {
    let mut tensors: HashMap<String, Array> = HashMap::new();
    tensors.insert("v_harm".to_string(), v_harm.clone());
    tensors.insert("v_drift".to_string(), v_drift.clone());
    tensors.insert("pca_basis".to_string(), pca_basis.clone());
    tensors.insert(
        "target_layer_idx".to_string(),
        Array::from_slice(&[probe_layer as i32], &[1]),
    );

    let mut metadata: HashMap<String, String> =
        fingerprint.to_metadata().into_iter().collect();
    metadata.insert("calibration_mode".to_string(), calibration_mode.to_string());
    metadata.insert("target_layer".to_string(), probe_layer.to_string());

    if let Some(parent) = path.as_ref().parent() {
        std::fs::create_dir_all(parent)?;
    }
    Array::save_safetensors(tensors, Some(&metadata), path.as_ref())?;
    Ok(())
}

#[cfg(test)]
mod index_forms {
    use super::*;

    /// The n-d index forms this module relies on.
    ///
    /// An integer index makes mlx-rs gather that axis away, and the trailing
    /// `..` then over-count and panic ("the len is 3 but the index is 3").
    /// A RANGE on the same axis keeps it and gives the 4-D semantics the
    /// attention reading needs. This test pins that down so the form cannot
    /// be "simplified" back into a panic.
    #[test]
    fn batch_axis_must_be_a_range() {
        let a = Array::zeros::<f32>(&[2, 3, 4, 5]).unwrap();

        let rows = a.index((0..1, .., 1..3, ..));
        assert_eq!(rows.shape(), vec![1, 3, 2, 5], "the span rows keep four axes");

        let cols = rows.index((0..1, .., .., 1..3));
        assert_eq!(cols.shape(), vec![1, 3, 2, 2], "the key range keeps four axes");
    }
}

#[cfg(test)]
mod whitening_load {
    use super::*;

    /// The raw cluster directions of the synthetic artifact: three unit rows.
    const RAW_CLUSTERS: [[f32; 4]; 3] = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
    ];
    /// The whitened directions: a different orientation, also unit length.
    const WHITENED_CLUSTERS: [[f32; 4]; 3] = [
        [0.0, 0.0, 0.0, 1.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
    ];

    /// Writes a synthetic artifact, with or without the whitened tensor.
    fn write_artifact(name: &str, with_whitened: bool) -> PathBuf {
        let mut tensors: HashMap<String, Array> = HashMap::new();
        tensors.insert(
            "v_harm".to_string(),
            Array::from_slice(&[1.0f32, 0.0, 0.0, 0.0], &[4]),
        );
        tensors.insert(
            "v_drift".to_string(),
            Array::from_slice(&[0.0f32, 1.0, 0.0, 0.0], &[4]),
        );
        tensors.insert("pca_basis".to_string(), Array::zeros::<f32>(&[1, 4]).unwrap());
        let raw: Vec<f32> = RAW_CLUSTERS.iter().flatten().copied().collect();
        tensors.insert("v_harm_clusters".to_string(), Array::from_slice(&raw, &[3, 4]));

        let mut metadata: HashMap<String, String> = HashMap::new();
        if with_whitened {
            let whitened: Vec<f32> = WHITENED_CLUSTERS.iter().flatten().copied().collect();
            tensors.insert(
                "v_harm_clusters_whitened".to_string(),
                Array::from_slice(&whitened, &[3, 4]),
            );
            metadata.insert("whitening".to_string(), "ledoit-wolf".to_string());
            metadata.insert(
                "whitening_shrinkage".to_string(),
                "0.437500000000".to_string(),
            );
            metadata.insert("whitening_applied".to_string(), "true".to_string());
            metadata.insert("whitening_samples".to_string(), "3".to_string());
        }

        let mut path = std::env::temp_dir();
        path.push(format!("repe_whitening_{name}.safetensors"));
        Array::save_safetensors(tensors, Some(&metadata), &path).unwrap();
        path
    }

    /// The values of a small array, as a plain vector.
    fn values(array: &Array) -> Vec<f32> {
        let contiguous = array.contiguous().unwrap();
        contiguous.eval().unwrap();
        contiguous.as_slice::<f32>().to_vec()
    }

    /// Asserts that a loaded direction matches the expected one.
    fn assert_direction(loaded: &Array, expected: &[f32; 4], label: &str) {
        let values = values(loaded);
        for (index, (a, b)) in values.iter().zip(expected.iter()).enumerate() {
            assert!(
                (a - b).abs() < 1e-6,
                "{label}: component {index} is {a}, expected {b} (whole row {values:?})"
            );
        }
    }

    /// The sensor must read the whitened directions when the artifact carries
    /// them: the artifact's thresholds were fitted against those.
    #[test]
    fn whitening_prefers_the_whitened_cluster_directions() {
        let path = write_artifact("whitened", true);
        let sensor = RepeSensor::load_safetensors(&path, 0, None).unwrap();
        assert_eq!(sensor.v_harm_clusters.len(), 3);
        for (index, expected) in WHITENED_CLUSTERS.iter().enumerate() {
            assert_direction(&sensor.v_harm_clusters[index], expected, "whitened cluster");
        }
        assert_eq!(sensor.whitening.as_deref(), Some("ledoit-wolf"));
        assert_eq!(sensor.whitening_shrinkage, Some(0.4375));
        let _ = std::fs::remove_file(&path);
    }

    /// An artifact without the whitened tensor must load exactly as before.
    #[test]
    fn legacy_artifacts_load_without_whitening() {
        let path = write_artifact("legacy", false);
        let sensor = RepeSensor::load_safetensors(&path, 0, None).unwrap();
        assert_eq!(sensor.v_harm_clusters.len(), 3);
        for (index, expected) in RAW_CLUSTERS.iter().enumerate() {
            assert_direction(&sensor.v_harm_clusters[index], expected, "raw cluster");
        }
        assert!(sensor.whitening.is_none());
        assert!(sensor.whitening_shrinkage.is_none());
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod repe_math_and_pooling_tests {
    use super::*;

    #[test]
    fn lse_pool_is_length_invariant_and_bounded() {
        let short = TokenScoreTable {
            scores: vec![0.25, 0.25],
            span_start: 0,
            span_len: 2,
            n_clusters: 1,
        };
        let long = TokenScoreTable {
            scores: vec![0.25; 64],
            span_start: 0,
            span_len: 64,
            n_clusters: 1,
        };
        let (s_short, _, _) = lse_pool(&short, 0, 12.0);
        let (s_long, _, _) = lse_pool(&long, 0, 12.0);
        assert!(
            (s_short - 0.25).abs() < 1e-6 && (s_long - 0.25).abs() < 1e-6,
            "uniform token cosines must be strictly invariant to span length: short={s_short}, long={s_long}"
        );

        let mixed = TokenScoreTable {
            scores: vec![-0.1, 0.0, 0.2, 0.85],
            span_start: 3,
            span_len: 4,
            n_clusters: 1,
        };
        let (pooled, peak_idx, peak_val) = lse_pool(&mixed, 0, 10.0);
        let (avg, _, _) = mean_pool(&mixed, 0);
        assert_eq!(peak_idx, 3);
        assert!((peak_val - 0.85).abs() < 1e-6);
        assert!(
            pooled >= avg - 1e-6 && pooled <= peak_val + 1e-6,
            "LogMeanExp ({pooled}) must lie inside [mean={avg}, max={peak_val}]"
        );
    }

    #[test]
    fn centered_pca_subspace_recovers_variance_axis_instead_of_cone_mean() {
        // 4 vectors in R^4 sharing a huge cone offset [10, 0, 0, 0] with true variance along axis 1.
        let data: [f32; 16] = [
            10.0, -3.0, 0.1, 0.0,
            10.0, -1.0, -0.1, 0.0,
            10.0, 1.0, -0.1, 0.0,
            10.0, 3.0, 0.1, 0.0,
        ];
        let arr = Array::from_slice(&data, &[4, 4]);
        let basis = RepeSensor::fit_pca_subspace(&arr, 2).unwrap();
        let b = basis.contiguous().unwrap();
        b.eval().unwrap();
        let sl = b.as_slice::<f32>();
        // PC1 (row 0) must align with axis 1 (|sl[1]| > 0.99), NOT the mean offset axis 0!
        assert!(
            sl[1].abs() > 0.99 && sl[0].abs() < 1e-4,
            "centered PC1 should align with axis 1, got row0={:?}",
            &sl[0..4]
        );
        // PC2 (row 1) must be unit-norm (never zeroed by sign(0)) and align with axis 2.
        let row1_norm: f32 = sl[4..8].iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!(
            (row1_norm - 1.0).abs() < 1e-4 && sl[6].abs() > 0.99,
            "centered PC2 must be unit length along axis 2, got row1={:?}",
            &sl[4..8]
        );
    }

    #[test]
    fn hot_reload_contrastive_updates_matching_cluster_in_multi_cluster_sensor() {
        let c0 = Array::from_slice(&[1.0f32, 0.0, 0.0, 0.0], &[4]);
        let c1 = Array::from_slice(&[0.0f32, 1.0, 0.0, 0.0], &[4]);
        let drift = Array::from_slice(&[0.0f32, 0.0, 0.0, 1.0], &[4]);
        let mut sensor = RepeSensor::from_directions(
            2,
            vec![c0, c1],
            drift,
            None,
            Pooling::Hybrid {
                beta: 10.0,
                weight: 0.35,
            },
            true,
        )
        .unwrap();

        // Benign and adversarial tool-call spans [1, 3, 4], span_start = 1:
        // cluster 1 initially points along axis 1; live exploit shifts along axis 1 + axis 2.
        let h_benign = Array::from_slice(
            &[
                0.5f32, 0.0, 0.0, 0.0, // prompt token
                0.8, -0.2, -0.4, 0.0,  // benign span token 1
                0.8, -0.2, -0.4, 0.0,  // benign span token 2
            ],
            &[1, 3, 4],
        );
        let h_adv = Array::from_slice(
            &[
                0.5f32, 0.0, 0.0, 0.0, // prompt token
                0.8, 0.5, 0.7, 0.0,    // adv span token 1
                0.8, 0.5, 0.7, 0.0,    // adv span token 2
            ],
            &[1, 3, 4],
        );
        let (before_adv, _) = sensor.span_harm_reading(&h_adv, Some(1)).unwrap();
        let (before_ben, _) = sensor.span_harm_reading(&h_benign, Some(1)).unwrap();
        let (delta_norm, _align, _, _) = sensor
            .hot_reload_contrastive_spans(&h_benign, Some(1), &h_adv, Some(1))
            .unwrap();
        assert!(delta_norm > 0.5);
        let (after_adv, _) = sensor.span_harm_reading(&h_adv, Some(1)).unwrap();
        let (after_ben, _) = sensor.span_harm_reading(&h_benign, Some(1)).unwrap();
        assert!(
            (after_adv - after_ben) > (before_adv - before_ben),
            "multi-cluster hot reload must widen margin: before=({before_adv} - {before_ben}), after=({after_adv} - {after_ben})"
        );
    }
}
