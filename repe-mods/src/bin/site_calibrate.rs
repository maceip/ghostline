//! The site calibration CLI.
//!
//! Turns the labels a human recorded in the guard's dashboard into a new
//! operating point and a new set of harm directions:
//!
//! * the **threshold** is a split-conformal quantile over the readings of the
//!   calls labelled BENIGN, so the false-positive rate is controlled rather
//!   than hoped for;
//! * the **directions** are refitted by re-probing every labelled call through
//!   the real backbone, because the label file holds readings and not the
//!   hidden states behind them.
//!
//! ```text
//! site-calibrate --model <path> --artifact <in.safetensors> \
//!                --labels <jsonl> --out <out.safetensors> \
//!                [--alpha 0.05] [--min-labels 5]
//! ```
//!
//! The library lives in `src/site_calibration.rs` and is included here rather
//! than exported from `lib.rs`, so that the crate's module list stays
//! untouched.

use anyhow::{Context, Result};
use clap::Parser;
use mlx_rs::Array;
use qwen_clef_repe_guard::enforcer_proxy::SiteLabel;
use qwen_clef_repe_guard::repe_sensor::Pooling;
use std::collections::HashMap;
use std::path::PathBuf;

#[path = "../site_calibration.rs"]
mod site_calibration;

use site_calibration::{
    build_engine, conformal_upper_threshold, read_artifact_clusters, read_artifact_metadata,
    read_labels, refit, remeasure_labels,
};

/// The tensors the refit does not touch and therefore carries over.
const CARRIED_OVER: [&str; 5] = [
    "v_drift",
    "pca_basis",
    "target_layer_idx",
    "harm_threshold",
    "drift_threshold",
];

#[derive(Parser, Debug)]
struct Args {
    /// The checkpoint directory (HF safetensors layout).
    #[arg(long)]
    model: PathBuf,
    /// The artifact the refit starts from. Its fingerprint, drift direction,
    /// PCA basis and decision mode are carried over; its harm directions are
    /// replaced.
    #[arg(long)]
    artifact: PathBuf,
    /// The JSONL file of human labels, as the guard's `/api/label` wrote it.
    #[arg(long)]
    labels: PathBuf,
    /// Where the new artifact is written. Never the input artifact.
    #[arg(long)]
    out: PathBuf,
    /// The target false-positive rate the conformal threshold targets.
    #[arg(long, default_value_t = 0.05)]
    alpha: f64,
    /// The smallest number of labels that may be fitted at all. Below it the
    /// tool refuses to write a threshold.
    #[arg(long, default_value_t = 5)]
    min_labels: usize,
    /// Path to `tokenizer.json` inside the checkpoint.
    #[arg(long)]
    tokenizer: Option<PathBuf>,
    /// The decoder layer to probe. Defaults to the artifact's own layer.
    #[arg(long)]
    layer: Option<usize>,
}

fn main() -> Result<()> {
    let args = Args::parse();

    if args.out == args.artifact {
        anyhow::bail!(
            "the output path is the input artifact ({}) — the calibrated artifact is never \
             overwritten",
            args.artifact.display()
        );
    }

    // ---------------------------------------------------------------------
    // 1. The labels.
    // ---------------------------------------------------------------------
    let labels = read_labels(&args.labels)?;
    println!(
        "[*] labels: {} records ({} benign, {} harmful) from {}",
        labels.records.len(),
        labels.benign().len(),
        labels.harmful().len(),
        args.labels.display()
    );
    if labels.malformed > 0 || labels.unknown_label > 0 {
        println!(
            "[!] labels: {} malformed lines skipped, {} records with an unknown label skipped",
            labels.malformed, labels.unknown_label
        );
    }
    if labels.records.len() < args.min_labels {
        anyhow::bail!(
            "refusing to write a threshold from {} labels (--min-labels is {}): a threshold \
             fitted on that many samples is not a conformal guarantee",
            labels.records.len(),
            args.min_labels
        );
    }

    // ---------------------------------------------------------------------
    // 2. The conformal threshold.
    // ---------------------------------------------------------------------
    let benign = labels.benign_excess();
    let harmful = labels.harmful_excess();
    let fit = conformal_upper_threshold(&benign, &harmful, args.alpha)?;
    println!("[*] {}", fit.summary());
    if fit.unbounded {
        anyhow::bail!(
            "refusing to write an artifact: the conformal quantile asks for rank {} of {} benign \
             readings, so no finite threshold can carry a false-positive rate of {} — \
             collect more benign labels",
            fit.rank,
            fit.benign_count,
            args.alpha
        );
    }
    println!(
        "[*] benign readings: min {:+.6}, max {:+.6}, mean {:+.6}",
        benign.iter().cloned().fold(f64::INFINITY, f64::min),
        benign.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
        benign.iter().sum::<f64>() / benign.len().max(1) as f64
    );
    if !harmful.is_empty() {
        println!(
            "[*] harmful readings: min {:+.6}, max {:+.6}, mean {:+.6}",
            harmful.iter().cloned().fold(f64::INFINITY, f64::min),
            harmful.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
            harmful.iter().sum::<f64>() / harmful.len().max(1) as f64
        );
    }

    // ---------------------------------------------------------------------
    // 3. The artifact the refit starts from.
    // ---------------------------------------------------------------------
    let metadata = read_artifact_metadata(&args.artifact)?;
    let previous_clusters = read_artifact_clusters(&args.artifact)?;
    let input_tensors = Array::load_safetensors(&args.artifact)
        .with_context(|| format!("Failed loading the artifact {:?}", args.artifact))?;
    let decision_mode = metadata
        .get("decision_mode")
        .cloned()
        .unwrap_or_else(|| "absolute".to_string());
    let pooling = Pooling::from_metadata(&metadata);
    let previous_layer = match input_tensors.get("target_layer_idx") {
        Some(value) => {
            let value = value.clone();
            value.eval()?;
            value.item_exact::<i32>().max(0) as usize
        }
        None => 0,
    };
    println!(
        "[*] artifact {}: decision mode {decision_mode}, pooling {}, {} layers, {} clusters",
        args.artifact.display(),
        pooling.metadata_string(),
        previous_clusters.len(),
        previous_clusters.len()
    );

    // ---------------------------------------------------------------------
    // 4. The refit.
    // ---------------------------------------------------------------------
    let tokenizer_path = args
        .tokenizer
        .clone()
        .unwrap_or_else(|| args.model.join("tokenizer.json"));
    let tokenizer = tokenizers::Tokenizer::from_file(&tokenizer_path).map_err(|error| {
        anyhow::anyhow!("Failed loading the tokenizer at {tokenizer_path:?}: {error}")
    })?;
    let (mut engine, layer_count, d_model, vocab_size) =
        build_engine(&args.model, Some(args.layer.unwrap_or(previous_layer)))?;
    let architecture = metadata
        .get("fingerprint_architecture")
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());
    println!(
        "[*] probing {layer_count} layers of {} (d_model {d_model})",
        args.model.display()
    );

    let refit = refit(
        &mut engine,
        &tokenizer,
        &labels,
        &previous_clusters,
        pooling,
    )?;
    println!(
        "[*] refit: {} harmful examples + {} benign examples (the extractor's 18 calibration \
         pairs are the base), {} echo-vs-goal copy pairs",
        refit.harmful_examples, refit.benign_examples, refit.copy_pairs
    );
    if refit.skipped_labels > 0 {
        println!(
            "[!] refit: {} labelled calls were skipped because their label was neither benign \
             nor harmful",
            refit.skipped_labels
        );
    }
    match refit.whitening_shrinkage {
        Some(shrinkage) => println!(
            "[*] whitening: Ledoit-Wolf over {} cluster centroids, shrinkage {shrinkage:.12}",
            refit.whitened_clusters.len()
        ),
        None => println!("[!] whitening: no shrinkage was fitted"),
    }
    for (index, movement) in refit.cluster_movement.iter().enumerate() {
        println!(
            "[*] cluster {index}: cosine with the previous artifact's direction {movement:+.6}"
        );
    }
    println!(
        "[*] matched benign panel, re-measured under the refitted clusters: echo baseline \
         {:+.6}, natural baseline {:+.6}",
        refit.matched_baseline, refit.natural_baseline
    );

    // ---------------------------------------------------------------------
    // 5. Did the refit move the statistic the threshold was fitted on?
    // ---------------------------------------------------------------------
    let readings = remeasure_labels(
        &mut engine,
        &tokenizer,
        &labels,
        &refit.copy_dir,
        &refit.whitened_clusters,
        refit.matched_baseline,
        pooling,
    )?;
    let mut mean_shift = 0.0;
    let mut mean_abs_shift = 0.0;
    let mut flips = 0usize;
    let mut compared = 0usize;
    let mut benign_flips = 0usize;
    let mut harmful_flips = 0usize;
    for reading in readings.iter() {
        let shift = reading.remeasured_excess - reading.recorded_excess;
        mean_shift += shift;
        mean_abs_shift += shift.abs();
        compared += 1;
        let recorded_blocked = reading.recorded_excess >= fit.threshold;
        let remeasured_blocked = reading.remeasured_excess >= fit.threshold;
        if recorded_blocked != remeasured_blocked {
            flips += 1;
            match reading.label {
                SiteLabel::Benign => benign_flips += 1,
                SiteLabel::Harmful => harmful_flips += 1,
            }
        }
    }
    if compared > 0 {
        println!(
            "[*] transfer check: the refit moved the recorded excess by {:+.6} on average \
             ({:.6} absolute) over {compared} re-measured labels; {} labels change their \
             blocked/allowed state under the conformal threshold ({} benign, {} harmful)",
            mean_shift / compared as f64,
            mean_abs_shift / compared as f64,
            flips,
            benign_flips,
            harmful_flips
        );
    }

    // ---------------------------------------------------------------------
    // 6. The new artifact.
    // ---------------------------------------------------------------------
    let mut tensors: HashMap<String, Array> = HashMap::new();
    for name in CARRIED_OVER {
        if let Some(value) = input_tensors.get(name) {
            tensors.insert(name.to_string(), value.clone());
        }
    }
    let raw_matrix = mlx_rs::ops::stack(&refit.raw_clusters, 0)?;
    let whitened_matrix = mlx_rs::ops::stack(&refit.whitened_clusters, 0)?;
    let v_harm = site_calibration::unit_normalize(
        &mlx_rs::ops::mean_axes(&raw_matrix, &[0], false)?,
    )?;
    tensors.insert("v_harm".to_string(), v_harm.as_type::<f32>()?);
    tensors.insert("v_harm_clusters".to_string(), raw_matrix.as_type::<f32>()?);
    tensors.insert(
        "v_harm_clusters_whitened".to_string(),
        whitened_matrix.as_type::<f32>()?,
    );
    tensors.insert("v_copy_mode".to_string(), refit.copy_dir.as_type::<f32>()?);
    tensors.insert(
        "v_benign_shell".to_string(),
        refit.shell_dir.as_type::<f32>()?,
    );
    tensors.insert(
        "benign_panel".to_string(),
        refit.panel_states.as_type::<f32>()?,
    );
    tensors.insert(
        "benign_panel_natural".to_string(),
        refit.panel_natural_states.as_type::<f32>()?,
    );
    tensors.insert(
        "benign_baseline_matched".to_string(),
        Array::from_slice(&[refit.matched_baseline], &[1]),
    );
    let threshold = fit.threshold as f32;
    tensors.insert(
        "harm_excess_threshold".to_string(),
        Array::from_slice(&[threshold], &[1]),
    );
    // The compliance split cannot be recovered from the label file: it holds
    // no prompt, so a label cannot be told apart from a call that obeyed the
    // instruction from one that violated it. Both groups therefore run the
    // single conformal threshold, and the metadata says so.
    tensors.insert(
        "harm_excess_threshold_obeys".to_string(),
        Array::from_slice(&[threshold], &[1]),
    );
    tensors.insert(
        "harm_excess_threshold_violates".to_string(),
        Array::from_slice(&[threshold], &[1]),
    );
    if !tensors.contains_key("target_layer_idx") {
        tensors.insert(
            "target_layer_idx".to_string(),
            Array::from_slice(&[previous_layer as i32], &[1]),
        );
    }

    let mut out_metadata: HashMap<String, String> = HashMap::new();
    out_metadata.insert("model".to_string(), args.model.display().to_string());
    out_metadata.insert("target_layer".to_string(), previous_layer.to_string());
    out_metadata.insert("num_layers".to_string(), layer_count.to_string());
    out_metadata.insert("d_model".to_string(), d_model.to_string());
    out_metadata.insert(
        "fingerprint_architecture".to_string(),
        architecture.clone(),
    );
    out_metadata.insert("fingerprint_num_layers".to_string(), layer_count.to_string());
    out_metadata.insert("fingerprint_d_model".to_string(), d_model.to_string());
    out_metadata.insert("fingerprint_vocab_size".to_string(), vocab_size.to_string());
    out_metadata.insert("decision_mode".to_string(), decision_mode.clone());
    out_metadata.insert("pooling".to_string(), pooling.metadata_string());
    // How the baseline was chosen: the matched benign panel, re-measured under
    // the refitted clusters so the baseline matches the directions it belongs to.
    out_metadata.insert("baseline_mode".to_string(), "matched-panel".to_string());
    out_metadata.insert(
        "site_calibration_baseline_source".to_string(),
        "matched benign panel, re-measured with the refitted clusters".to_string(),
    );
    out_metadata.insert(
        "benign_baseline_matched".to_string(),
        format!("{:.6}", refit.matched_baseline),
    );
    out_metadata.insert(
        "benign_baseline_matched_natural".to_string(),
        format!("{:.6}", refit.natural_baseline),
    );
    out_metadata.insert(
        "harm_excess_threshold".to_string(),
        format!("{threshold:.6}"),
    );
    out_metadata.insert(
        "harm_excess_threshold_obeys".to_string(),
        format!("{threshold:.6}"),
    );
    out_metadata.insert(
        "harm_excess_threshold_violates".to_string(),
        format!("{threshold:.6}"),
    );
    out_metadata.insert("compliance_conditioned".to_string(), "true".to_string());
    out_metadata.insert(
        "site_calibration_compliance_split".to_string(),
        "not recoverable from the label file (it carries no prompt); both groups use the single \
         conformal threshold"
            .to_string(),
    );
    out_metadata.insert(
        "site_calibration_alpha".to_string(),
        format!("{:.6}", fit.alpha),
    );
    out_metadata.insert(
        "site_calibration_conformal_rank".to_string(),
        fit.rank.to_string(),
    );
    out_metadata.insert(
        "site_calibration_empirical_fp_rate".to_string(),
        format!("{:.6}", fit.empirical_fp_rate),
    );
    out_metadata.insert(
        "site_calibration_false_positives".to_string(),
        fit.false_positives.to_string(),
    );
    out_metadata.insert(
        "site_calibration_harmful_blocked".to_string(),
        fit.harmful_blocked.to_string(),
    );
    out_metadata.insert(
        "site_calibration_labels".to_string(),
        labels.records.len().to_string(),
    );
    out_metadata.insert(
        "site_calibration_benign_labels".to_string(),
        labels.benign().len().to_string(),
    );
    out_metadata.insert(
        "site_calibration_harmful_labels".to_string(),
        labels.harmful().len().to_string(),
    );
    out_metadata.insert(
        "site_calibration_refit_harmful_examples".to_string(),
        refit.harmful_examples.to_string(),
    );
    out_metadata.insert(
        "site_calibration_refit_benign_examples".to_string(),
        refit.benign_examples.to_string(),
    );
    out_metadata.insert(
        "site_calibration_cluster_movement".to_string(),
        refit
            .cluster_movement
            .iter()
            .map(|value| format!("{value:.6}"))
            .collect::<Vec<String>>()
            .join(","),
    );
    out_metadata.insert("copy_mode_orthogonalized".to_string(), "true".to_string());
    out_metadata.insert(
        "copy_channel_pairs".to_string(),
        refit.copy_pairs.to_string(),
    );
    out_metadata.insert("whitening".to_string(), "ledoit-wolf".to_string());
    out_metadata.insert("whitening_applied".to_string(), "true".to_string());
    if let Some(shrinkage) = refit.whitening_shrinkage {
        out_metadata.insert("whitening_shrinkage".to_string(), format!("{shrinkage:.12}"));
    }
    out_metadata.insert(
        "whitening_samples".to_string(),
        refit.whitened_clusters.len().to_string(),
    );
    for key in ["harm_threshold", "drift_threshold"] {
        if let Some(value) = metadata.get(key) {
            out_metadata.insert(key.to_string(), value.clone());
        }
    }

    if let Some(parent) = args.out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    Array::save_safetensors(tensors, Some(&out_metadata), &args.out)?;
    println!(
        "[+] Saved {} (d_model={d_model}, layer={previous_layer}, threshold {threshold:+.6})",
        args.out.display()
    );

    // The artifact has to be loadable by the guard: the same loader, the same
    // fingerprint block, the same tensor names.
    let loaded = qwen_clef_repe_guard::repe_sensor::RepeSensor::load_safetensors(
        &args.out,
        previous_layer,
        None,
    )
    .with_context(|| format!("The new artifact {:?} does not load", args.out))?;
    println!(
        "[+] the new artifact loads: {} clusters, threshold {:+.6}, matched baseline {:+.6}, \
         pooling {}",
        loaded.v_harm_clusters.len(),
        loaded.calibrated_harm_excess_threshold.unwrap_or(f32::NAN),
        loaded.static_benign_baseline.unwrap_or(f32::NAN),
        loaded.pooling.metadata_string()
    );
    Ok(())
}
