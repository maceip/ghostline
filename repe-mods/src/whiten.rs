//! Ledoit–Wolf shrinkage, Mahalanobis directions and Cholesky whitening.
//!
//! This module backs the whitening / Mahalanobis-direction component of the
//! RepE safety guard.  It is deliberately dependency-free (`std` only) and
//! performs every reduction in `f64`, so the guard's cost stays dominated by
//! the model forward pass rather than by the estimator.
//!
//! # Estimator
//!
//! The shrinkage intensity follows the classic Ledoit–Wolf (2004) "linear
//! shrinkage towards a scaled identity" estimator:
//!
//! * `S` — sample covariance, `S = (1/n) · Σ (x_i − μ)(x_i − μ)ᵀ`
//! * `F` — shrinkage target, `F = μ_target · I` with `μ_target = trace(S) / d`
//! * `beta`  — `(1/n) · Σ ‖(x_i − μ)(x_i − μ)ᵀ − S‖_F²` (estimation variance)
//! * `delta` — `(1/n) · Σ ‖x_i x_iᵀ − S‖_F²` (distance of the target from `S`)
//! * `shrinkage = min(beta, delta) / delta`, and `0` when `delta == 0`
//!
//! The shrunk covariance is `S_shrunk = (1 − λ)·S + λ·F` and `precision` is
//! `S_shrunk⁻¹`, obtained from a Cholesky factorisation — never from a naive
//! matrix inverse.
//!
//! # Parity
//!
//! `tools/whiten_reference.py` is a NumPy mirror of this file.  Both sides
//! evaluate the *same* sequence of floating-point operations in the *same*
//! order (the summation order is spelled out next to every reduction), so the
//! two implementations agree to within one ulp on every quantity the guard
//! consumes.  `src/bin/whiten_check.rs` is the harness that proves it.
//!
//! Nothing in this module performs I/O; every entry point is a pure function
//! over plain `f64` data.

/// Diagonal jitters tried, in order, when a Cholesky factorisation fails.
///
/// The first entry (`0.0`) is the unmodified matrix; the remaining entries are
/// only ever applied to the diagonal, and only after the previous attempt
/// failed.  The NumPy reference uses the identical ladder so that a
/// degenerate input degrades identically on both sides.
pub const CHOLESKY_JITTERS: [f64; 4] = [0.0, 1.0e-12, 1.0e-10, 1.0e-8];

/// Smallest diagonal pivot accepted by the triangular solves.
///
/// Cholesky factors are positive, so this only ever rejects a factor that is
/// numerically zero (or not finite).
const PIVOT_EPS: f64 = 1.0e-300;

/// A fitted Ledoit–Wolf shrinkage estimator.
///
/// `covariance` is the *shrunk* covariance and `precision` its inverse;
/// `sample_covariance` and `target` are kept for diagnostics so the caller
/// can report both the raw and the regularised spectrum.
#[derive(Debug, Clone)]
pub struct LedoitWolf {
    /// Shrinkage intensity in `[0, 1]`; `0` leaves `S` untouched, `1` replaces
    /// it entirely by the target `F`.
    pub shrinkage: f64,
    /// Shrunk covariance `(1 − shrinkage) · S + shrinkage · F`.
    pub covariance: Vec<Vec<f64>>,
    /// Inverse of `covariance`.
    pub precision: Vec<Vec<f64>>,
    /// Sample mean of the fitted data (the columns' means).
    pub mean: Vec<f64>,
    /// Unshrunk sample covariance `S`.
    pub sample_covariance: Vec<Vec<f64>>,
    /// Shrinkage target `F = target_scale · I`.
    pub target: Vec<Vec<f64>>,
    /// `trace(S) / d`, the scale of the identity target.
    pub target_scale: f64,
    /// Diagonal jitter that had to be added to `covariance` before it could be
    /// factorised (`0.0` when the plain factorisation succeeded).
    pub jitter: f64,
}

/// Fits the Ledoit–Wolf estimator to `samples`.
///
/// `samples` is a row-major `[n][d]` matrix of observations.  Every row must
/// have the same length `d`, `n` must be non-zero and `d` must be non-zero.
///
/// # Errors
///
/// Returns a message describing the offending input when the matrix is
/// empty, zero-dimensional or ragged.
///
/// # Numerical contract
///
/// The reductions are ordered so that the NumPy reference reproduces them
/// exactly:
///
/// * the mean accumulates over rows in ascending row order, then divides;
/// * the covariance accumulates over rows in ascending row order, then
///   divides by `n`;
/// * `beta` and `delta` accumulate one Frobenius norm per row (rows in
///   ascending order, entries in ascending `(a, b)` order), then divide.
pub fn fit(samples: &[Vec<f64>]) -> Result<LedoitWolf, String> {
    // `dimensions` validates the matrix shape (non-empty, non-ragged, `d > 0`);
    // the row count itself is re-derived inside each reduction.
    let (_n, d) = dimensions(samples)?;

    let mu = mean(samples);
    let s = sample_covariance(samples, &mu);

    let mu_target = trace(&s) / d as f64;
    let mut target = vec![vec![0.0; d]; d];
    for index in 0..d {
        target[index][index] = mu_target;
    }

    // `beta` uses the centred outer products, `delta` the raw ones; the
    // difference between the two is exactly the term that makes the
    // estimator consistent for non-zero-mean data.
    let beta = scatter_deviation(samples, &mu, &s, true);
    let delta = scatter_deviation(samples, &mu, &s, false);

    // Pinned comparison so both sides agree even for NaN inputs.
    let beta_hat = if beta <= delta { beta } else { delta };
    let shrinkage = if delta == 0.0 { 0.0 } else { beta_hat / delta };

    let mut covariance = vec![vec![0.0; d]; d];
    for a in 0..d {
        for b in 0..d {
            covariance[a][b] = (1.0 - shrinkage) * s[a][b] + shrinkage * target[a][b];
        }
    }

    let (factor, jitter) = cholesky_with_jitter(&covariance)?;
    if jitter != 0.0 {
        // Keep the stored covariance consistent with the factor we inverted.
        for index in 0..d {
            covariance[index][index] += jitter;
        }
    }
    let precision = invert_via_cholesky(&factor)?;

    Ok(LedoitWolf {
        shrinkage,
        covariance,
        precision,
        mean: mu,
        sample_covariance: s,
        target,
        target_scale: mu_target,
        jitter,
    })
}

/// Validates the shape of a sample matrix and returns `(n, d)`.
fn dimensions(samples: &[Vec<f64>]) -> Result<(usize, usize), String> {
    let n = samples.len();
    if n == 0 {
        return Err("fit: no samples supplied".to_string());
    }
    let d = samples[0].len();
    if d == 0 {
        return Err("fit: samples are zero-dimensional".to_string());
    }
    for (index, row) in samples.iter().enumerate() {
        if row.len() != d {
            return Err(format!(
                "fit: row {index} has dimension {} but row 0 has {d}",
                row.len()
            ));
        }
    }
    Ok((n, d))
}

/// Column means of `samples`.
///
/// Summation order: rows are visited in ascending index order and the
/// accumulated sum is divided by `n` **after** the loop.  The NumPy reference
/// performs the identical reduction.
pub fn mean(samples: &[Vec<f64>]) -> Vec<f64> {
    let n = samples.len();
    let d = samples[0].len();
    let mut mu = vec![0.0; d];
    for column in 0..d {
        let mut acc = 0.0;
        for sample in samples {
            acc += sample[column];
        }
        mu[column] = acc / n as f64;
    }
    mu
}

/// Sample covariance `S = (1/n) · Σ (x_i − μ)(x_i − μ)ᵀ`.
///
/// Summation order: for every entry `(a, b)` the rows are visited in
/// ascending index order and the accumulated sum is divided by `n` after the
/// loop.
pub fn sample_covariance(samples: &[Vec<f64>], mu: &[f64]) -> Vec<Vec<f64>> {
    let n = samples.len();
    let d = mu.len();
    let mut s = vec![vec![0.0; d]; d];
    for a in 0..d {
        for b in 0..d {
            let mut acc = 0.0;
            for sample in samples {
                acc += (sample[a] - mu[a]) * (sample[b] - mu[b]);
            }
            s[a][b] = acc / n as f64;
        }
    }
    s
}

/// Trace of a square matrix: the diagonal entries summed in ascending index
/// order.
pub fn trace(matrix: &[Vec<f64>]) -> f64 {
    let mut acc = 0.0;
    for index in 0..matrix.len() {
        acc += matrix[index][index];
    }
    acc
}

/// `(1/n) · Σ ‖outer_i − S‖_F²`.
///
/// When `centered` is `true` the outer product uses `(x_i − μ)(x_i − μ)ᵀ`,
/// otherwise the raw `x_i x_iᵀ`.
///
/// Summation order: one Frobenius norm is accumulated per row (entries in
/// ascending `(a, b)` order), the per-row norms are summed in ascending row
/// order and the total is divided by `n` after the loop.
fn scatter_deviation(
    samples: &[Vec<f64>],
    mu: &[f64],
    s: &[Vec<f64>],
    centered: bool,
) -> f64 {
    let n = samples.len();
    let d = mu.len();
    let mut total = 0.0;
    for sample in samples {
        let mut acc = 0.0;
        for a in 0..d {
            let va = if centered { sample[a] - mu[a] } else { sample[a] };
            for b in 0..d {
                let vb = if centered { sample[b] - mu[b] } else { sample[b] };
                let deviation = va * vb - s[a][b];
                acc += deviation * deviation;
            }
        }
        total += acc;
    }
    total / n as f64
}

/// Cholesky factorisation `A = L · Lᵀ` with `L` lower triangular.
///
/// Summation order: for every entry `(i, j)` the previous columns `k < j` are
/// visited in ascending order and subtracted from `A[i][j]` one at a time.
///
/// # Errors
///
/// Fails when `A` is not square, is ragged, or has a non-positive pivot (i.e.
/// `A` is not positive definite).
pub fn cholesky(matrix: &[Vec<f64>]) -> Result<Vec<Vec<f64>>, String> {
    let d = matrix.len();
    let mut l = vec![vec![0.0; d]; d];
    for i in 0..d {
        if matrix[i].len() != d {
            return Err(format!("cholesky: row {i} has length {} but expected {d}", matrix[i].len()));
        }
        for j in 0..=i {
            let mut acc = matrix[i][j];
            for k in 0..j {
                acc -= l[i][k] * l[j][k];
            }
            if i == j {
                if !(acc > 0.0) || !acc.is_finite() {
                    return Err(format!(
                        "cholesky: non-positive pivot at ({i}, {i}): {acc:.6e}"
                    ));
                }
                l[i][j] = acc.sqrt();
            } else {
                l[i][j] = acc / l[j][j];
            }
        }
    }
    Ok(l)
}

/// Cholesky factorisation with the diagonal-jitter fallback.
///
/// The jitters in [`CHOLESKY_JITTERS`] are tried in order; the first one that
/// yields a valid factorisation wins.  Only the diagonal is perturbed.
///
/// Returns the factor and the jitter that was applied (`0.0` when the
/// unmodified matrix sufficed).
pub fn cholesky_with_jitter(matrix: &[Vec<f64>]) -> Result<(Vec<Vec<f64>>, f64), String> {
    let d = matrix.len();
    let mut last_error = String::new();
    for jitter in CHOLESKY_JITTERS {
        let mut candidate = matrix.to_vec();
        if jitter != 0.0 {
            for index in 0..d {
                if index >= candidate[index].len() {
                    return Err(format!(
                        "cholesky: row {index} has length {} but expected {d}",
                        candidate[index].len()
                    ));
                }
                candidate[index][index] += jitter;
            }
        }
        match cholesky(&candidate) {
            Ok(factor) => return Ok((factor, jitter)),
            Err(message) => last_error = message,
        }
    }
    Err(format!("cholesky: no jitter produced a valid factorisation ({last_error})"))
}

/// Forward substitution: solves `L · y = b` for a lower-triangular `L`.
///
/// Summation order: the already-solved components `k < i` are visited in
/// ascending order.
pub fn solve_lower(l: &[Vec<f64>], b: &[f64]) -> Result<Vec<f64>, String> {
    let d = l.len();
    if b.len() != d {
        return Err(format!(
            "solve_lower: right-hand side has length {} but expected {d}",
            b.len()
        ));
    }
    let mut y = vec![0.0; d];
    for i in 0..d {
        let mut acc = b[i];
        for k in 0..i {
            acc -= l[i][k] * y[k];
        }
        let pivot = l[i][i];
        if !pivot.is_finite() || pivot.abs() <= PIVOT_EPS {
            return Err(format!("solve_lower: degenerate pivot at {i}: {pivot:.6e}"));
        }
        y[i] = acc / pivot;
    }
    Ok(y)
}

/// Backward substitution: solves `Lᵀ · x = b` for a lower-triangular `L`.
///
/// Summation order: the already-solved components `k > i` are visited in
/// ascending order.
pub fn solve_upper_transpose(l: &[Vec<f64>], b: &[f64]) -> Result<Vec<f64>, String> {
    let d = l.len();
    if b.len() != d {
        return Err(format!(
            "solve_upper_transpose: right-hand side has length {} but expected {d}",
            b.len()
        ));
    }
    let mut x = vec![0.0; d];
    for i in (0..d).rev() {
        let mut acc = b[i];
        for k in (i + 1)..d {
            acc -= l[k][i] * x[k];
        }
        let pivot = l[i][i];
        if !pivot.is_finite() || pivot.abs() <= PIVOT_EPS {
            return Err(format!(
                "solve_upper_transpose: degenerate pivot at {i}: {pivot:.6e}"
            ));
        }
        x[i] = acc / pivot;
    }
    Ok(x)
}

/// Solves `(L · Lᵀ) · x = b` given the lower-triangular Cholesky factor `L`.
///
/// The solve is performed as a forward substitution (`L · y = b`) followed by
/// a backward substitution (`Lᵀ · x = y`); it is *not* a matrix inverse.
///
/// # Errors
///
/// Fails on a shape mismatch or a degenerate pivot.
pub fn solve_cholesky(l: &[Vec<f64>], b: &[f64]) -> Result<Vec<f64>, String> {
    let y = solve_lower(l, b)?;
    solve_upper_transpose(l, &y)
}

/// Inverse of `A = L · Lᵀ`, obtained by solving `A · x = e_j` for every
/// column `j` of the identity (never a naive matrix inverse).
pub fn invert_via_cholesky(l: &[Vec<f64>]) -> Result<Vec<Vec<f64>>, String> {
    let d = l.len();
    let mut inverse = vec![vec![0.0; d]; d];
    for column in 0..d {
        let mut unit = vec![0.0; d];
        unit[column] = 1.0;
        let solution = solve_cholesky(l, &unit)?;
        for row in 0..d {
            inverse[row][column] = solution[row];
        }
    }
    Ok(inverse)
}

/// Matrix-vector product `A · v`.
///
/// Summation order: the components `k` are visited in ascending order.
pub fn mat_vec(matrix: &[Vec<f64>], vector: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; matrix.len()];
    for row in 0..matrix.len() {
        let mut acc = 0.0;
        for column in 0..vector.len() {
            acc += matrix[row][column] * vector[column];
        }
        out[row] = acc;
    }
    out
}

/// L2-normalises a vector.
///
/// Summation order: the squared components are accumulated in ascending index
/// order before the square root is taken.
///
/// # Errors
///
/// Fails when the vector is empty or has zero length.
pub fn l2_normalize(vector: &[f64]) -> Result<Vec<f64>, String> {
    if vector.is_empty() {
        return Err("l2_normalize: empty vector".to_string());
    }
    let mut norm_squared = 0.0;
    for value in vector {
        norm_squared += value * value;
    }
    let norm = norm_squared.sqrt();
    if !(norm > 0.0) || !norm.is_finite() {
        return Err("l2_normalize: degenerate (zero-length) vector".to_string());
    }
    Ok(vector.iter().map(|value| value / norm).collect())
}

/// Whitened (Mahalanobis-metric) unit direction for `direction` under
/// `covariance`.
///
/// The whitened direction is `C^{-1/2} · v` normalised to unit L2 length.
/// With `C = L · Lᵀ` the exact symmetric square root would need an SVD; the
/// standard *triangular-solve* whitening is used instead:
///
/// ```text
/// C^{-1/2} · v  ≈  L^{-T} · v,   obtained by solving Lᵀ · y = v
/// ```
///
/// (i.e. one backward substitution against the transposed Cholesky factor).
/// The result is then L2-normalised, so the metric is carried by the
/// direction's orientation rather than by its magnitude.
///
/// This is a pure function: no I/O, no global state.
///
/// # Errors
///
/// Fails when `covariance` cannot be factorised, when the dimensions do not
/// match, or when the whitened direction degenerates to zero length.
pub fn whiten_direction(
    covariance: &[Vec<f64>],
    direction: &[f64],
) -> Result<Vec<f64>, String> {
    if covariance.len() != direction.len() {
        return Err(format!(
            "whiten_direction: covariance has dimension {} but the direction has {}",
            covariance.len(),
            direction.len()
        ));
    }
    let (factor, _jitter) = cholesky_with_jitter(covariance)?;
    // C = L Lᵀ  =>  C^{-1/2} v ≈ L^{-T} v  =>  solve Lᵀ y = v.
    let whitened = solve_upper_transpose(&factor, direction)?;
    l2_normalize(&whitened)
}

/// Whitens several directions under one covariance, factorising it once.
///
/// This is [`whiten_direction`] applied to a list of directions: the
/// arithmetic is identical (one backward substitution against the transposed
/// Cholesky factor, then an L2 normalisation), but the covariance is
/// factorised a single time instead of once per direction.
///
/// # Errors
///
/// Fails when the covariance cannot be factorised, when a direction does not
/// match the covariance's dimension, or when a whitened direction degenerates
/// to zero length.
pub fn whiten_directions(
    covariance: &[Vec<f64>],
    directions: &[Vec<f64>],
) -> Result<Vec<Vec<f64>>, String> {
    let (factor, _jitter) = cholesky_with_jitter(covariance)?;
    let mut out = Vec::with_capacity(directions.len());
    for direction in directions {
        if covariance.len() != direction.len() {
            return Err(format!(
                "whiten_directions: covariance has dimension {} but a direction has {}",
                covariance.len(),
                direction.len()
            ));
        }
        // C = L Lᵀ  =>  C^{-1/2} v  ≈  L^{-T} v  =>  solve Lᵀ y = v.
        let whitened = solve_upper_transpose(&factor, direction)?;
        out.push(l2_normalize(&whitened)?);
    }
    Ok(out)
}

/// Mahalanobis direction `precision · (point − mean)`.
///
/// Summation order: the components `b` are visited in ascending order.
///
/// # Panics
///
/// Panics when `point` does not match the fitted dimension.
pub fn mahalanobis_direction(w: &LedoitWolf, point: &[f64]) -> Vec<f64> {
    let d = w.mean.len();
    assert_eq!(
        point.len(),
        d,
        "mahalanobis_direction: point has dimension {} but the fit has {d}",
        point.len()
    );
    let centered: Vec<f64> = (0..d).map(|index| point[index] - w.mean[index]).collect();
    mat_vec(&w.precision, &centered)
}
