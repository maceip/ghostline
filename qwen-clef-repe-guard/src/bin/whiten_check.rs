//! Parity / self-test harness for the whitening module.
//!
//! Fits the Ledoit–Wolf estimator on a deterministic synthetic dataset and
//! prints the results in a machine-parsable form, so the same numbers can be
//! compared against the NumPy reference in `tools/whiten_reference.py`.
//!
//! Usage:
//!
//! ```text
//! whiten-check                                  # synthetic data (default)
//! whiten-check <dump.f64> --dim 8               # fit a binary dump
//! whiten-check --write-dump <dump.f64> [--dim D]  # also write the dataset out
//! ```
//!
//! The dump format is raw little-endian `float64`, laid out row-major as
//! `[n_samples][d]`; `d` is taken from `--dim`.
//!
//! The synthetic generator (a 64-bit LCG plus an Irwin–Hall(12) normal
//! approximation) is mirrored bit-for-bit by the Python reference, so the two
//! implementations see identical inputs without exchanging any data.

#[path = "../whiten.rs"]
// The module carries the full runtime API; this harness only exercises part of
// it, so the unused entry points are expected here.
#[allow(dead_code)]
mod whiten;

use anyhow::{bail, Context, Result};

use std::sync::atomic::{AtomicBool, Ordering};

use whiten::{fit, whiten_direction, LedoitWolf};

/// Set by `--full-precision`: print round-tripping decimals instead of the
/// 13-significant-digit default, so the parity check can measure the
/// algorithm rather than the print precision.
static FULL_PRECISION: AtomicBool = AtomicBool::new(false);

/// Multiplier of the 64-bit linear congruential generator.
const LCG_MULTIPLIER: u64 = 6364136223846793005;
/// Increment of the 64-bit linear congruential generator.
const LCG_INCREMENT: u64 = 1442695040888963407;
/// Seed of the generator (a fixed constant so both sides agree).
const LCG_SEED: u64 = 0x2545F491_4F6CDD1D;
/// `2^53`, used to turn the top 53 random bits into a `[0, 1)` double.
const TWO_POW_53: f64 = 9007199254740992.0;
/// Number of uniform deviates summed for the Irwin–Hall normal approximation.
const IRWIN_HALL_TERMS: usize = 12;
/// Off-diagonal decay of the synthetic lower-triangular factor.
const CORRELATION: f64 = 0.55;
/// Default number of synthetic samples.
const DEFAULT_SAMPLES: usize = 200;
/// Default synthetic dimension.
const DEFAULT_DIM: usize = 8;

/// A deterministic 64-bit linear congruential generator.
///
/// The state update is `state = state * M + C (mod 2^64)`; the Python
/// reference masks the same multiplication with `0xFFFF_FFFF_FFFF_FFFF`.
struct Lcg {
    state: u64,
}

impl Lcg {
    /// Creates a generator seeded with `seed`.
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    /// Advances the state and returns the raw 64-bit output.
    fn next_u64(&mut self) -> u64 {
        self.state = self
            .state
            .wrapping_mul(LCG_MULTIPLIER)
            .wrapping_add(LCG_INCREMENT);
        self.state
    }

    /// Draws a double in `[0, 1)` from the top 53 random bits.
    ///
    /// The shift and the scaling by `2^-53` are exact in binary floating
    /// point, so this matches the Python reference bit for bit.
    fn next_unit(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64) * (1.0 / TWO_POW_53)
    }

    /// Draws a standard normal deviate.
    ///
    /// Uses the Irwin–Hall approximation: the sum of twelve `U(0, 1)` draws
    /// minus six has mean `0` and variance `1` and a kurtosis very close to
    /// the normal one.  Only additions are used, so the result is identical
    /// on both sides of the parity check.
    fn next_normal(&mut self) -> f64 {
        let mut acc = 0.0;
        for _ in 0..IRWIN_HALL_TERMS {
            acc += self.next_unit();
        }
        acc - 6.0
    }
}

/// Lower-triangular factor `L` of the synthetic covariance `C = L · Lᵀ`.
///
/// `L[i][j] = r^(i-j)` for `j <= i` and `0` otherwise, with `r = 0.55`; the
/// powers are built by repeated multiplication so the Python reference
/// reproduces them exactly.
fn synth_factor(dim: usize) -> Vec<Vec<f64>> {
    let mut factor = vec![vec![0.0; dim]; dim];
    for row in 0..dim {
        let mut value = 1.0;
        for column in (0..=row).rev() {
            factor[row][column] = value;
            value *= CORRELATION;
        }
    }
    factor
}

/// Builds the synthetic dataset `x_i = L · z_i + offset`.
fn synth_samples(count: usize, dim: usize, rng: &mut Lcg) -> Vec<Vec<f64>> {
    let factor = synth_factor(dim);
    let offset: Vec<f64> = (0..dim).map(|index| index as f64 * 0.25 - 0.75).collect();
    let mut samples = Vec::with_capacity(count);
    for _ in 0..count {
        let noise: Vec<f64> = (0..dim).map(|_| rng.next_normal()).collect();
        let mut row = vec![0.0; dim];
        for a in 0..dim {
            let mut acc = 0.0;
            for j in 0..=a {
                acc += factor[a][j] * noise[j];
            }
            row[a] = acc + offset[a];
        }
        samples.push(row);
    }
    samples
}

/// The known reference direction: `(-0.5)^j`.
///
/// Every component is an exact power of two, so both implementations agree
/// without any rounding slack.
fn reference_direction(dim: usize) -> Vec<f64> {
    let mut direction = Vec::with_capacity(dim);
    let mut value = 1.0;
    for _ in 0..dim {
        direction.push(value);
        value *= -0.5;
    }
    direction
}

/// Formats a float the way the Python reference does.
///
/// Rust prints `1.0e5` where Python prints `1.0e+05`; the reference strips
/// the exponent's `+` so the two outputs diff cleanly.  The `+` sign flag is
/// used on both sides (a leading *space* sign flag is not expressible in
/// Rust's format syntax, because a leading space is parsed as the fill
/// character).
fn fmt(value: f64) -> String {
    if FULL_PRECISION.load(Ordering::Relaxed) {
        // Shortest round-tripping decimal: the value survives a re-parse
        // exactly, so the parity check measures the algorithm rather than the
        // print precision.
        return format!("{value:?}");
    }
    format!("{:+.12e}", value)
}

/// Formats a vector as space-separated `{: .12e}` values.
fn fmt_vector(values: &[f64]) -> String {
    values
        .iter()
        .map(|value| fmt(*value))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Formats a matrix row-major as space-separated `{: .12e}` values.
fn fmt_matrix(matrix: &[Vec<f64>]) -> String {
    let mut parts = Vec::with_capacity(matrix.len() * matrix.len());
    for row in matrix {
        for value in row {
            parts.push(fmt(*value));
        }
    }
    parts.join(" ")
}

/// Writes a dataset as raw little-endian `float64`, row-major `[n][d]`.
fn write_dump(path: &std::path::Path, samples: &[Vec<f64>]) -> Result<()> {
    let mut bytes = Vec::with_capacity(samples.len() * samples[0].len() * 8);
    for row in samples {
        for value in row {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    std::fs::write(path, &bytes)
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

/// Reads a dataset from a raw little-endian `float64` dump of shape `[n][d]`.
fn read_dump(path: &std::path::Path, dim: usize) -> Result<Vec<Vec<f64>>> {
    if dim == 0 {
        bail!("--dim must be a positive integer");
    }
    let bytes = std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    if bytes.len() % (dim * 8) != 0 {
        bail!(
            "dump {} holds {} bytes, which is not a multiple of {dim} float64 values",
            path.display(),
            bytes.len()
        );
    }
    let count = bytes.len() / (dim * 8);
    if count == 0 {
        bail!("dump {} is empty", path.display());
    }
    let mut samples = Vec::with_capacity(count);
    for index in 0..count {
        let mut row = Vec::with_capacity(dim);
        for column in 0..dim {
            let start = (index * dim + column) * 8;
            let mut chunk = [0u8; 8];
            chunk.copy_from_slice(&bytes[start..start + 8]);
            row.push(f64::from_le_bytes(chunk));
        }
        samples.push(row);
    }
    Ok(samples)
}

/// Prints the fitted model in the machine-parsable form shared with the
/// Python reference.
fn report(mode: &str, samples: &[Vec<f64>], model: &LedoitWolf, direction: &[f64]) {
    let dim = samples[0].len();
    let whitened = whiten_direction(&model.covariance, direction)
        .expect("whiten_direction failed on the fitted covariance");
    let diagonal: Vec<f64> = (0..dim).map(|index| model.covariance[index][index]).collect();

    println!("mode = {mode}");
    println!("n = {}", samples.len());
    println!("d = {dim}");
    println!("shrinkage = {}", fmt(model.shrinkage));
    println!("trace = {}", fmt(whiten::trace(&model.covariance)));
    println!("mean = {}", fmt_vector(&model.mean));
    println!("cov_diag = {}", fmt_vector(&diagonal));
    println!("cov = {}", fmt_matrix(&model.covariance));
    println!("precision = {}", fmt_matrix(&model.precision));
    println!("direction = {}", fmt_vector(&whitened));
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut dump_path: Option<String> = None;
    let mut write_path: Option<String> = None;
    let mut dim: Option<usize> = None;

    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "--dim" => {
                index += 1;
                let value = args
                    .get(index)
                    .context("--dim requires a value")?
                    .parse::<usize>()
                    .context("--dim expects a positive integer")?;
                dim = Some(value);
            }
            "--write-dump" => {
                index += 1;
                write_path = Some(
                    args.get(index)
                        .context("--write-dump requires a path")?
                        .to_string(),
                );
            }
            "--full-precision" => {
                FULL_PRECISION.store(true, Ordering::Relaxed);
            }
            other if other.starts_with("--dim=") => {
                dim = Some(
                    other[6..]
                        .parse::<usize>()
                        .context("--dim expects a positive integer")?,
                );
            }
            other if other.starts_with("--write-dump=") => {
                write_path = Some(other[12..].to_string());
            }
            other if other.starts_with("--") => {
                bail!("unknown argument: {other}");
            }
            other => {
                if dump_path.is_some() {
                    bail!("unexpected extra positional argument: {other}");
                }
                dump_path = Some(other.to_string());
            }
        }
        index += 1;
    }

    let (mode, samples) = match &dump_path {
        Some(path) => {
            let dim = dim.context("--dim D is required when a dump file is given")?;
            ("dump", read_dump(std::path::Path::new(path), dim)?)
        }
        None => {
            let dim = dim.unwrap_or(DEFAULT_DIM);
            let mut rng = Lcg::new(LCG_SEED);
            ("synthetic", synth_samples(DEFAULT_SAMPLES, dim, &mut rng))
        }
    };

    if let Some(path) = &write_path {
        write_dump(std::path::Path::new(path), &samples)?;
        eprintln!("wrote dump {path} ({} samples, dim {})", samples.len(), samples[0].len());
    }

    let model = fit(&samples).map_err(|message| anyhow::anyhow!("{message}"))?;
    let direction = reference_direction(samples[0].len());
    report(mode, &samples, &model, &direction);
    Ok(())
}
