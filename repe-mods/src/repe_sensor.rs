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
    format!(
        "<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n<tool_call>\n{tool_name}({tool_args})"
    )
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
}

/// How the residual stream is collapsed over the tool-call span.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Pooling {
    /// The mean residual over the span, then a single cosine.
    ///
    /// The historical reading. A 30-token tool call dilutes a two-token
    /// destructive command into the average of the whole JSON envelope.
    Mean,
    /// Token-wise LogSumExp pooling: the cluster score is pooled across the
    /// span's tokens with a temperature, so the strongest token dominates.
    ///
    /// `S_c = max_t s_c(t) + (1/beta) * ln sum_t exp(beta * (s_c(t) - max))`
    ///
    /// `beta` is the inverse temperature: large values approach a hard max,
    /// small values approach the mean. The pooled value stays on the cosine
    /// scale, so a threshold calibrated under this pooling is comparable in
    /// magnitude to a mean-pooled one — but it is a *different statistic* and
    /// has to be calibrated separately.
    LogSumExp { beta: f32 },
}

impl Default for Pooling {
    fn default() -> Self {
        Pooling::Mean
    }
}

impl Pooling {
    /// Parse the `pooling` key of the artifact metadata.
    ///
    /// `mean` (the default) and `lse` / `lse:<beta>` are understood. An
    /// unknown value falls back to the mean rather than silently changing
    /// the reading the artifact was calibrated under.
    pub fn from_metadata(meta: &HashMap<String, String>) -> Self {
        match meta.get("pooling").map(|s| s.as_str()) {
            Some("lse") => Pooling::LogSumExp { beta: 12.0 },
            Some(spec) if spec.starts_with("lse:") => spec["lse:".len()..]
                .parse::<f32>()
                .ok()
                .filter(|b| b.is_finite() && *b > 0.0)
                .map(|beta| Pooling::LogSumExp { beta })
                .unwrap_or_default(),
            _ => Pooling::Mean,
        }
    }

    /// The metadata string that reproduces this pooling in the extractor.
    pub fn metadata_string(&self) -> String {
        match self {
            Pooling::Mean => "mean".to_string(),
            Pooling::LogSumExp { beta } => format!("lse:{beta}"),
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
    let span = h_layer.index((0, start..seq_len, ..)).as_type::<f32>()?;
    let span_len = (seq_len - start) as usize;
    let n_clusters = cfg.directions.len();
    if n_clusters == 0 {
        anyhow::bail!("token_score_table needs at least one direction");
    }

    // Shift away from the trusted anchor, per token.
    let span = match cfg.anchor.as_ref() {
        Some(anchor) => subtract(&span, anchor)?,
        None => span,
    };

    // Unit length along the feature axis.
    let sq = multiply(&span, &span)?;
    let norm = sqrt(&sum_axis(&sq, -1, true)?)?;
    let mut unit = divide(&span, &add(&norm, &Array::from_f32(1e-6))?)?;

    // Project the copy channel out of every token, then renormalise.
    if let Some(copy) = cfg.copy_dir.as_ref() {
        let copy_b = copy.reshape(&[1, 1, -1])?;
        let proj = sum_axis(&multiply(&unit, &copy_b)?, -1, true)?;
        let projected = subtract(&unit, &multiply(&copy_b, &proj)?)?;
        let sq2 = multiply(&projected, &projected)?;
        let norm2 = sqrt(&sum_axis(&sq2, -1, true)?)?;
        unit = divide(&projected, &add(&norm2, &Array::from_f32(1e-6))?)?;
    }

    // One row of per-token cosines per direction.
    let mut per_direction: Vec<Vec<f32>> = Vec::with_capacity(n_clusters);
    for dir in &cfg.directions {
        let dir_b = dir.reshape(&[1, 1, -1])?;
        let dots = sum_axis(&multiply(&unit, &dir_b)?, -1, false)?;
        dots.eval()?;
        per_direction.push(dots.as_slice::<f32>().to_vec());
    }
    // Re-order to token-major so a token's scores sit next to each other.
    let mut scores = vec![0f32; span_len * n_clusters];
    for (c, row) in per_direction.iter().enumerate() {
        for t in 0..span_len {
            scores[t * n_clusters + c] = row[t];
        }
    }

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

/// LogSumExp pooling of one cluster's token scores.
///
/// `S = max_t s(t) + (1/beta) * ln sum_t exp(beta * (s(t) - max))`
///
/// `beta` is the inverse temperature: large values approach a hard max,
/// small values approach the mean. The result stays on the cosine scale.
pub fn lse_pool(table: &TokenScoreTable, cluster: usize, beta: f32) -> (f32, usize, f32) {
    let (peak_idx, peak_val) = argmax_row(table, cluster);
    let mut acc = 0f32;
    for t in 0..table.span_len {
        let v = table.scores[t * table.n_clusters + cluster];
        acc += (beta * (v - peak_val)).exp();
    }
    let pooled = peak_val + acc.ln() / beta;
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
        let matched_baseline = read_scalar("benign_baseline_matched")
            .or_else(|| read_scalar("benign_baseline"));

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
            v_drift: Self::unit_norm(v_drift)?,
            pca_basis: pca_basis.as_type::<f32>()?,
            trusted_user_anchor: None,
            clamp_threshold,
            calibrated_harm_threshold: read_scalar("harm_threshold"),
            calibrated_drift_threshold: read_scalar("drift_threshold"),
            calibrated_harm_excess_threshold: read_scalar("harm_excess_threshold"),
            static_benign_baseline: matched_baseline,
            harm_excess_threshold_obeys: read_scalar("harm_excess_threshold_obeys"),
            harm_excess_threshold_violates: read_scalar("harm_excess_threshold_violates"),
            layer_profile: Vec::new(),
            last_pca_coords: Vec::new(),
            absolute_harm_reading: absolute_harm_reading,
            pooling,
            whitening,
            whitening_shrinkage,
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
            last_pca_coords: Vec::new(),
            absolute_harm_reading: false,
            pooling: Pooling::default(),
            whitening: None,
            whitening_shrinkage: None,
        })
    }

    #[inline]
    pub fn unit_norm(v: &Array) -> Result<Array> {
        let vf = v.as_type::<f32>()?;
        let norm = sqrt(&sum(&multiply(&vf, &vf)?, true)?)?;
        Ok(divide(&vf, &add(&norm, &Array::from_f32(1e-6))?)?)
    }

    /// Pool the residual over the tool-call span.
    ///
    /// `span_start` is the index of the first token of the span. When it is
    /// unknown the last token is used — the historical behaviour. Averaging
    /// over the span instead of reading one trailing token keeps the user's
    /// own wording out of the measurement.
    fn pooled_state(&self, h_layer: &Array, span_start: Option<usize>) -> Result<Array> {
        let seq_len = h_layer.shape()[1];
        let start = match span_start {
            Some(s) => (s as i32).min(seq_len.saturating_sub(1)),
            None => seq_len.saturating_sub(1),
        };
        let slice = h_layer.index((0, start..seq_len, ..)).as_type::<f32>()?;
        let pooled = mean_axes(&slice, &[0], false)?;
        pooled.eval()?;
        Ok(pooled)
    }

    /// The mean residual over every token of the sequence.
    fn mean_state(h_layer: &Array) -> Result<Array> {
        let seq_len = h_layer.shape()[1];
        let slice = h_layer.index((0, 0..seq_len, ..)).as_type::<f32>()?;
        let pooled = mean_axes(&slice, &[0], false)?;
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
        anchor.eval()?;
        self.trusted_user_anchor = Some(anchor);
        Ok(())
    }

    /// The harm cosine of a residual state, measured the same way the inline
    /// hook measures it (relative to the trusted anchor when one is locked).
    pub fn probe_cosine(&self, h_layer: &Array, span_start: Option<usize>) -> Result<f32> {
        let (harm, _) = self.span_harm_reading(h_layer, span_start)?;
        Ok(harm)
    }

    /// The projection of the inspected state onto the PCA basis.
    pub fn pca_coordinates(&self, h_layer: &Array, span_start: Option<usize>) -> Result<Vec<f32>> {
        let pooled = self.pooled_state(h_layer, span_start)?;
        let h_unit = Self::unit_norm(&pooled)?;
        let coords = matmul(&self.pca_basis, &h_unit)?;
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

        let (cluster_scores, peak_token, peak_cosine) = match self.pooling {
            Pooling::Mean => {
                // The mean-pooled reading is a statistic of the *pooled* state,
                // not of the tokens: recompute it exactly as `harm_cosine_of`
                // does so the calibrated threshold keeps its meaning.
                let pooled = self.pooled_state(h_layer, span_start)?;
                let probe = self.probe_of(&pooled)?;
                let mut scores = Vec::with_capacity(dims.len());
                for dir in &dims {
                    let projection = multiply(&probe, dir)?;
                    let value = sum(&projection, false)?;
                    value.eval()?;
                    scores.push(value.item_exact::<f32>());
                }
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
        let seq_len = h_layer.shape()[1];
        let pooled = self.pooled_state(h_layer, span_start)?;
        let h_unit = Self::unit_norm(&pooled)?;

        // 1. Harm reading: the component of the *shift* the tool call caused
        //    along the harm directions, pooled the way the artifact was
        //    calibrated. Under mean pooling this is the cosine of the pooled
        //    state; under LogSumExp pooling it is the temperature-pooled
        //    maximum over the span's own tokens, with the token that peaked
        //    kept as the attribution.
        let (harm_cosine, span_scores) = self.span_harm_reading(h_layer, span_start)?;

        // 2. TaskTracker Activation Delta: <unit(h_curr - h_user), v_drift>
        let drift_cos_arr = if let Some(ref anchor) = self.trusted_user_anchor {
            let delta = subtract(&pooled, anchor)?;
            let delta_unit = Self::unit_norm(&delta)?;
            sum(&multiply(&delta_unit, &self.v_drift)?, false)?
        } else {
            Array::from_f32(0.0)
        };

        // 3. K-dimensional PCA Subspace Energy: ||pca_basis @ h_unit||_2
        let pca_coords = matmul(&self.pca_basis, &h_unit)?;
        let energy_arr = sqrt(&sum(&multiply(&pca_coords, &pca_coords)?, false)?)?;

        mlx_rs::transforms::eval([&drift_cos_arr, &energy_arr, &pca_coords])?;
        self.last_pca_coords = pca_coords.as_slice::<f32>().to_vec();

        let drift_cosine = drift_cos_arr.item_exact::<f32>();
        let pca_subspace_energy = energy_arr.item_exact::<f32>();

        // 4. Optional In-Place Orthogonal Clamping on the last token:
        //    h' = h - max(0, h · v_harm) * v_harm
        //    The clamp still applies to the final token — that is the state
        //    the model continues from — while the *measurement* above uses
        //    the pooled tool-call span.
        let mut clamped_in_place = false;
        if let Some(thresh) = self.clamp_threshold {
            if harm_cosine > thresh {
                let h_last = h_layer.index((0, seq_len - 1, ..)).as_type::<f32>()?;
                let dot = sum(&multiply(&h_last, &self.v_harm)?, true)?;
                let pos_proj = maximum(&dot, &Array::from_f32(0.0))?;
                let correction = multiply(&pos_proj, &self.v_harm)?;
                let h_clamped = subtract(&h_last, &correction)?.reshape(&[1, 1, -1])?;

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

    /// Calibrate top-K PCA directions via SVD from paired difference vectors `deltas` [N, D]
    pub fn fit_pca_subspace(deltas: &Array, k: i32) -> Result<Array> {
        let deltas_f32 = deltas.as_type::<f32>()?;
        // MLX has no GPU implementation of the SVD — run it on the CPU stream.
        let cpu = mlx_rs::Stream::cpu();
        let (_u, _s, vt) = mlx_rs::with_stream(&cpu, || svd(&deltas_f32))?;
        let top_k = vt.index((0..k, ..));

        // Align signs so each PC has positive average dot product with the positive deltas
        let proj = matmul(&deltas_f32, &transpose_axes(&top_k, &[1, 0])?)?;
        let mean_proj = mean_axes(&proj, &[0], false)?;
        let signs = sign(&mean_proj)?.reshape(&[k, 1])?;
        let aligned = multiply(&top_k, &signs)?;
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
