#!/usr/bin/env python3
"""NumPy reference for the Rust whitening module.

Mirrors `repe-mods/src/whiten.rs` operation for operation: the Ledoit-Wolf
estimator, the Cholesky factorisation, the triangular solves and the
whitened direction are all evaluated with the *same* sequence of float64
operations in the *same* order, so both implementations agree to within one
ulp.

Usage:

    uv run --python 3.12 --with numpy python3 tools/whiten_reference.py
    uv run --python 3.12 --with numpy python3 tools/whiten_reference.py \\
        --dump artifacts/whiten/synth_200x8.f64
    uv run --python 3.12 --with numpy python3 tools/whiten_reference.py \\
        --fit artifacts/whiten/synth_200x8.f64 --dim 8
    uv run --python 3.12 --with numpy python3 tools/whiten_reference.py \\
        --artifact artifacts/repe_vectors_whiten.safetensors

`--dump` writes the dataset as raw little-endian float64, row-major
`[n_samples][d]`, which is the format `whiten-check <dump> --dim D` reads.

`--artifact` checks a calibrated artifact end to end: it re-fits the
Ledoit-Wolf estimator on the artifact's own `v_harm_clusters` centroids,
re-whitens them, and compares the result with the artifact's
`v_harm_clusters_whitened` tensor and its `whitening_shrinkage` metadata.
`--centroid-dump` writes those centroids as a raw float64 dump, so the Rust
harness can reproduce the fit with its own ordered loops:

    uv run --python 3.12 --with numpy python3 tools/whiten_reference.py \\
        --artifact artifacts/repe_vectors_whiten.safetensors \\
        --centroid-dump artifacts/whiten/centroids_3x896.f64
    ./target/debug/whiten-check artifacts/whiten/centroids_3x896.f64 --dim 896

The default (synthetic) run prints the same machine-parsable fields as the
Rust harness, so the two outputs can be diffed directly.
"""

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# Constants shared with src/bin/whiten_check.rs -- keep both files in sync.
# ---------------------------------------------------------------------------
LCG_MULTIPLIER = 6364136223846793005
LCG_INCREMENT = 1442695040888963407
LCG_SEED = 0x2545F4914F6CDD1D
U64_MASK = 0xFFFFFFFFFFFFFFFF
TWO_POW_53 = 9007199254740992.0
IRWIN_HALL_TERMS = 12
CORRELATION = 0.55
DEFAULT_SAMPLES = 200
DEFAULT_DIM = 8
CHOLESKY_JITTERS = (0.0, 1e-12, 1e-10, 1e-8)
PIVOT_EPS = 1.0e-300


def f64(value) -> np.float64:
    """Casts to a numpy float64 scalar so every operation stays in double
    precision (and behaves exactly like Rust's `f64`)."""
    return np.float64(value)


# ---------------------------------------------------------------------------
# Estimator -- mirrors of the Rust functions, reduction order preserved.
# ---------------------------------------------------------------------------
def dimensions(samples) -> tuple[int, int]:
    n = len(samples)
    if n == 0:
        raise ValueError("fit: no samples supplied")
    d = len(samples[0])
    if d == 0:
        raise ValueError("fit: samples are zero-dimensional")
    for index, row in enumerate(samples):
        if len(row) != d:
            raise ValueError(
                f"fit: row {index} has dimension {len(row)} but row 0 has {d}"
            )
    return n, d


def mean(samples) -> np.ndarray:
    """Column means: rows are summed in ascending order, then divided by n."""
    n = len(samples)
    d = len(samples[0])
    mu = np.zeros(d, dtype=np.float64)
    for column in range(d):
        acc = f64(0.0)
        for sample in samples:
            acc = acc + f64(sample[column])
        mu[column] = acc / f64(n)
    return mu


def sample_covariance(samples, mu) -> np.ndarray:
    """S = (1/n) * sum_i (x_i - mu)(x_i - mu)^T."""
    n = len(samples)
    d = len(mu)
    s = np.zeros((d, d), dtype=np.float64)
    for a in range(d):
        for b in range(d):
            acc = f64(0.0)
            for sample in samples:
                acc = acc + (f64(sample[a]) - mu[a]) * (f64(sample[b]) - mu[b])
            s[a, b] = acc / f64(n)
    return s


def trace(matrix) -> np.float64:
    """Diagonal sum, ascending index order."""
    acc = f64(0.0)
    for index in range(len(matrix)):
        acc = acc + matrix[index, index]
    return acc


def scatter_deviation(samples, mu, s, centered: bool) -> np.float64:
    """(1/n) * sum_i ||outer_i - S||_F^2."""
    n = len(samples)
    d = len(mu)
    total = f64(0.0)
    for sample in samples:
        acc = f64(0.0)
        for a in range(d):
            va = (f64(sample[a]) - mu[a]) if centered else f64(sample[a])
            for b in range(d):
                vb = (f64(sample[b]) - mu[b]) if centered else f64(sample[b])
                deviation = va * vb - s[a, b]
                acc = acc + deviation * deviation
        total = total + acc
    return total / f64(n)


def cholesky(matrix) -> np.ndarray:
    """A = L * L^T with L lower triangular."""
    d = matrix.shape[0]
    l = np.zeros((d, d), dtype=np.float64)
    for i in range(d):
        for j in range(i + 1):
            acc = f64(matrix[i, j])
            for k in range(j):
                acc = acc - l[i, k] * l[j, k]
            if i == j:
                if not (acc > 0.0) or not np.isfinite(acc):
                    raise ValueError(
                        f"cholesky: non-positive pivot at ({i}, {i}): {acc:.6e}"
                    )
                l[i, j] = np.sqrt(acc)
            else:
                l[i, j] = acc / l[j, j]
    return l


def cholesky_with_jitter(matrix):
    """Cholesky with the diagonal-jitter fallback ladder."""
    d = matrix.shape[0]
    last_error = ""
    for jitter in CHOLESKY_JITTERS:
        candidate = np.array(matrix, dtype=np.float64, copy=True)
        if jitter != 0.0:
            for index in range(d):
                candidate[index, index] = candidate[index, index] + f64(jitter)
        try:
            return cholesky(candidate), f64(jitter)
        except ValueError as message:
            last_error = str(message)
    raise ValueError(
        f"cholesky: no jitter produced a valid factorisation ({last_error})"
    )


def solve_lower(l, b) -> np.ndarray:
    """Forward substitution: solves L * y = b."""
    d = l.shape[0]
    if len(b) != d:
        raise ValueError(
            f"solve_lower: right-hand side has length {len(b)} but expected {d}"
        )
    y = np.zeros(d, dtype=np.float64)
    for i in range(d):
        acc = f64(b[i])
        for k in range(i):
            acc = acc - l[i, k] * y[k]
        pivot = l[i, i]
        if not np.isfinite(pivot) or abs(pivot) <= PIVOT_EPS:
            raise ValueError(f"solve_lower: degenerate pivot at {i}: {pivot:.6e}")
        y[i] = acc / pivot
    return y


def solve_upper_transpose(l, b) -> np.ndarray:
    """Backward substitution: solves L^T * x = b."""
    d = l.shape[0]
    if len(b) != d:
        raise ValueError(
            "solve_upper_transpose: right-hand side has length "
            f"{len(b)} but expected {d}"
        )
    x = np.zeros(d, dtype=np.float64)
    for i in range(d - 1, -1, -1):
        acc = f64(b[i])
        for k in range(i + 1, d):
            acc = acc - l[k, i] * x[k]
        pivot = l[i, i]
        if not np.isfinite(pivot) or abs(pivot) <= PIVOT_EPS:
            raise ValueError(
                f"solve_upper_transpose: degenerate pivot at {i}: {pivot:.6e}"
            )
        x[i] = acc / pivot
    return x


def solve_cholesky(l, b) -> np.ndarray:
    """Solves (L * L^T) * x = b via forward then backward substitution."""
    return solve_upper_transpose(l, solve_lower(l, b))


def invert_via_cholesky(l) -> np.ndarray:
    """Inverse of L * L^T by solving against every unit vector."""
    d = l.shape[0]
    inverse = np.zeros((d, d), dtype=np.float64)
    for column in range(d):
        unit = np.zeros(d, dtype=np.float64)
        unit[column] = 1.0
        solution = solve_cholesky(l, unit)
        for row in range(d):
            inverse[row, column] = solution[row]
    return inverse


def l2_normalize(vector) -> np.ndarray:
    """Scales to unit L2 length; squared terms are summed in index order."""
    norm_squared = f64(0.0)
    for value in vector:
        norm_squared = norm_squared + value * value
    norm = np.sqrt(norm_squared)
    if not (norm > 0.0) or not np.isfinite(norm):
        raise ValueError("l2_normalize: degenerate (zero-length) vector")
    return np.array([value / norm for value in vector], dtype=np.float64)


def whiten_direction(covariance, direction) -> np.ndarray:
    """Whitened unit direction: solve L^T y = v, then normalise."""
    factor, _ = cholesky_with_jitter(covariance)
    whitened = solve_upper_transpose(factor, direction)
    return l2_normalize(whitened)


def fit(samples) -> dict:
    """Ledoit-Wolf fit; mirrors `whiten::fit`."""
    n, d = dimensions(samples)
    mu = mean(samples)
    s = sample_covariance(samples, mu)

    mu_target = trace(s) / f64(d)
    target = np.zeros((d, d), dtype=np.float64)
    for index in range(d):
        target[index, index] = mu_target

    beta = scatter_deviation(samples, mu, s, True)
    delta = scatter_deviation(samples, mu, s, False)
    beta_hat = beta if beta <= delta else delta
    shrinkage = f64(0.0) if delta == 0.0 else beta_hat / delta

    covariance = np.zeros((d, d), dtype=np.float64)
    for a in range(d):
        for b in range(d):
            covariance[a, b] = (f64(1.0) - shrinkage) * s[a, b] + shrinkage * target[a, b]

    factor, jitter = cholesky_with_jitter(covariance)
    if jitter != 0.0:
        for index in range(d):
            covariance[index, index] = covariance[index, index] + jitter
    precision = invert_via_cholesky(factor)

    return {
        "shrinkage": shrinkage,
        "covariance": covariance,
        "precision": precision,
        "mean": mu,
        "sample_covariance": s,
        "target": target,
        "target_scale": mu_target,
        "jitter": jitter,
    }


# ---------------------------------------------------------------------------
# Synthetic generator -- mirrors src/bin/whiten_check.rs exactly.
# ---------------------------------------------------------------------------
class Lcg:
    """64-bit linear congruential generator with wrapping arithmetic."""

    def __init__(self, seed: int):
        self.state = seed & U64_MASK

    def next_u64(self) -> int:
        self.state = (self.state * LCG_MULTIPLIER + LCG_INCREMENT) & U64_MASK
        return self.state

    def next_unit(self) -> np.float64:
        """Double in [0, 1) built from the top 53 random bits."""
        return f64(self.next_u64() >> 11) * (1.0 / TWO_POW_53)

    def next_normal(self) -> np.float64:
        """Irwin-Hall(12) normal approximation: mean 0, variance 1."""
        acc = f64(0.0)
        for _ in range(IRWIN_HALL_TERMS):
            acc = acc + self.next_unit()
        return acc - f64(6.0)


def synth_factor(dim: int) -> np.ndarray:
    """Lower-triangular factor L with L[i][j] = r^(i-j) for j <= i."""
    factor = np.zeros((dim, dim), dtype=np.float64)
    for row in range(dim):
        value = f64(1.0)
        for column in range(row, -1, -1):
            factor[row, column] = value
            value = value * CORRELATION
    return factor


def synth_samples(count: int, dim: int, rng: Lcg) -> np.ndarray:
    """x_i = L * z_i + offset."""
    factor = synth_factor(dim)
    offset = np.array(
        [index * 0.25 - 0.75 for index in range(dim)], dtype=np.float64
    )
    samples = np.zeros((count, dim), dtype=np.float64)
    for row in range(count):
        noise = np.array([rng.next_normal() for _ in range(dim)], dtype=np.float64)
        for a in range(dim):
            acc = f64(0.0)
            for j in range(a + 1):
                acc = acc + factor[a, j] * noise[j]
            samples[row, a] = acc + offset[a]
    return samples


def reference_direction(dim: int) -> np.ndarray:
    """Known direction (-0.5)^j; every entry is an exact power of two."""
    direction = np.zeros(dim, dtype=np.float64)
    value = f64(1.0)
    for index in range(dim):
        direction[index] = value
        value = value * f64(-0.5)
    return direction


# ---------------------------------------------------------------------------
# Vectorised cross-check (independent of the ordered-loop implementation).
# ---------------------------------------------------------------------------
def vectorised_fit(samples: np.ndarray) -> dict:
    """Same maths expressed with plain NumPy/BLAS operations."""
    n, d = samples.shape
    mu = samples.mean(axis=0)
    centered = samples - mu
    s = centered.T @ centered / n
    mu_target = np.trace(s) / d
    target = np.eye(d) * mu_target

    outer_centered = centered[:, :, None] * centered[:, None, :]
    outer_raw = samples[:, :, None] * samples[:, None, :]
    beta = float(np.sum((outer_centered - s) ** 2, axis=(1, 2)).sum()) / n
    delta = float(np.sum((outer_raw - s) ** 2, axis=(1, 2)).sum()) / n
    beta_hat = min(beta, delta)
    shrinkage = 0.0 if delta == 0.0 else beta_hat / delta

    covariance = (1.0 - shrinkage) * s + shrinkage * target
    factor = np.linalg.cholesky(covariance)
    precision = np.linalg.solve(factor.T, np.linalg.solve(factor, np.eye(d)))
    return {
        "shrinkage": shrinkage,
        "covariance": covariance,
        "precision": precision,
        "mean": mu,
        "target_scale": mu_target,
        "factor": factor,
    }


# ---------------------------------------------------------------------------
# Artifact reader -- the calibrated RepE artifact, end to end.
# ---------------------------------------------------------------------------
SAFETENSORS_DTYPES = {"F32": "<f4", "F64": "<f8", "I32": "<i4"}


def read_safetensors(path: Path) -> tuple[dict, dict]:
    """Reads the metadata and the tensors of a safetensors file.

    The file is an 8-byte little-endian header length, the JSON header and
    the raw tensor data, so no third-party reader is needed.
    """
    with path.open("rb") as handle:
        header_len = struct.unpack("<Q", handle.read(8))[0]
        header = json.loads(handle.read(header_len))
        blob = handle.read()

    metadata = header.get("__metadata__", {})
    tensors = {}
    for name, entry in header.items():
        if name == "__metadata__":
            continue
        begin, end = entry["data_offsets"]
        dtype = SAFETENSORS_DTYPES.get(entry["dtype"])
        if dtype is None:
            raise ValueError(f"unsupported dtype {entry['dtype']} for tensor {name}")
        raw = blob[begin:end]
        tensors[name] = np.frombuffer(raw, dtype=dtype).reshape(entry["shape"])
    return metadata, tensors


def vectorised_whiten(covariance, directions) -> list[np.ndarray]:
    """Whitens directions under a covariance, mirroring the jitter ladder.

    Same arithmetic as `whiten_direction`, but the triangular solve is done
    with LAPACK: the ordered reference mirror is O(d^3) in pure Python, which
    is not runnable at the artifact's dimension.
    """
    factor = None
    for jitter in CHOLESKY_JITTERS:
        candidate = np.array(covariance, dtype=np.float64, copy=True)
        if jitter != 0.0:
            candidate[np.diag_indices_from(candidate)] += f64(jitter)
        try:
            factor = np.linalg.cholesky(candidate)
            break
        except np.linalg.LinAlgError:
            continue
    if factor is None:
        raise ValueError("cholesky: no jitter produced a valid factorisation")
    return [
        l2_normalize(np.linalg.solve(factor.T, direction)) for direction in directions
    ]


def check_artifact(path: Path, tolerance: float) -> dict:
    """Re-derives an artifact's whitening and compares it with what it holds.

    The artifact's `v_harm_clusters` holds the raw centroids, so the fit can
    be reproduced from the artifact alone; the result is compared with the
    stored `v_harm_clusters_whitened` and with the `whitening_shrinkage`
    metadata.
    """
    metadata, tensors = read_safetensors(path)
    for required in ("v_harm_clusters", "v_harm_clusters_whitened"):
        if required not in tensors:
            raise ValueError(f"the artifact carries no `{required}` tensor")

    centroids = np.asarray(tensors["v_harm_clusters"], dtype=np.float64)
    stored = np.asarray(tensors["v_harm_clusters_whitened"], dtype=np.float64)
    n, d = centroids.shape

    model = vectorised_fit(centroids)
    whitened = np.stack(vectorised_whiten(model["covariance"], [row for row in centroids]))

    results = {"n": n, "d": d}
    results["shrinkage_recomputed"] = float(model["shrinkage"])
    stored_shrinkage = metadata.get("whitening_shrinkage")
    results["shrinkage_stored"] = stored_shrinkage
    if stored_shrinkage is None:
        raise ValueError("the artifact carries no `whitening_shrinkage` metadata")
    stored_value = float(stored_shrinkage)
    results["shrinkage_rel_err"] = abs(stored_value - results["shrinkage_recomputed"]) / max(
        abs(results["shrinkage_recomputed"]), 1e-300
    )
    results["direction_max_abs_err"] = float(np.max(np.abs(stored - whitened)))
    results["stored_unit_norm_max_err"] = float(
        np.max(np.abs(np.linalg.norm(stored, axis=1) - 1.0))
    )
    results["whitening_method"] = metadata.get("whitening", "")
    results["whitening_applied"] = metadata.get("whitening_applied", "")
    results["whitening_samples"] = metadata.get("whitening_samples", "")
    results["tolerance"] = tolerance
    results["passed"] = (
        results["shrinkage_rel_err"] < tolerance
        and results["direction_max_abs_err"] < tolerance
    )
    return results


# ---------------------------------------------------------------------------
# Output helpers.
# ---------------------------------------------------------------------------
def fmt(value) -> str:
    """Formats like Rust's `{:+.12e}`.

    Rust prints the exponent without a `+` sign and without zero padding
    (`e-1`, `e0`), while Python prints `e-01` / `e+00`; the exponent is
    normalised here so the two outputs diff byte for byte.
    """
    text = f"{float(value):+.12e}"
    mantissa, exponent = text.split("e")
    digits = exponent.lstrip("+-")
    sign = "-" if exponent.startswith("-") and any(d != "0" for d in digits) else ""
    digits = digits.lstrip("0") or "0"
    return f"{mantissa}e{sign}{digits}"


def fmt_vector(values) -> str:
    return " ".join(fmt(value) for value in values)


def fmt_matrix(matrix) -> str:
    return " ".join(fmt(value) for row in matrix for value in row)


def write_dump(path: Path, samples: np.ndarray) -> None:
    """Writes raw little-endian float64, row-major [n][d]."""
    path.parent.mkdir(parents=True, exist_ok=True)
    samples.astype("<f8").tofile(str(path))


def read_dump(path: Path, dim: int) -> np.ndarray:
    """Reads a raw little-endian float64 dump of shape [n][d]."""
    if dim <= 0:
        raise ValueError("--dim must be a positive integer")
    raw = np.fromfile(str(path), dtype="<f8")
    if raw.size == 0:
        raise ValueError(f"dump {path} is empty")
    if raw.size % dim != 0:
        raise ValueError(
            f"dump {path} holds {raw.size} values, which is not a multiple of {dim}"
        )
    return raw.reshape(raw.size // dim, dim)


def parse_rust_output(path: Path) -> dict:
    """Parses the `key = v1 v2 ...` block written by the Rust harness."""
    fields: dict[str, list[float]] = {}
    for line in path.read_text().splitlines():
        if "=" not in line:
            continue
        key, _, payload = line.partition("=")
        key = key.strip()
        payload = payload.strip()
        if not payload:
            fields[key] = []
            continue
        values: list[float] = []
        for token in payload.split():
            try:
                values.append(float(token))
            except ValueError:
                values = []
                break
        fields[key] = values
    return fields


def compare_with_rust(fields: dict, model: dict, whitened: np.ndarray, tolerance: float):
    """Measures the Rust-vs-Python deviation on every reported quantity.

    The acceptance thresholds are the ones from the parity contract:
    a relative error below `tolerance` for the shrinkage coefficient and for
    every shrunk-covariance entry, and a maximum absolute difference below
    `tolerance` for the whitened direction.
    """
    rel_eps = 1e-300
    results = {}

    rust_shrinkage = fields["shrinkage"][0]
    py_shrinkage = float(model["shrinkage"])
    results["shrinkage_rel_err"] = abs(rust_shrinkage - py_shrinkage) / max(
        abs(py_shrinkage), rel_eps
    )

    rust_cov = np.array(fields["cov"], dtype=np.float64)
    py_cov = model["covariance"].reshape(-1)
    cov_abs = np.abs(rust_cov - py_cov)
    results["cov_max_abs_err"] = float(cov_abs.max()) if cov_abs.size else 0.0
    results["cov_max_rel_err"] = float(
        (cov_abs / np.maximum(np.abs(py_cov), rel_eps)).max()
    ) if cov_abs.size else 0.0

    rust_dir = np.array(fields["direction"], dtype=np.float64)
    dir_abs = np.abs(rust_dir - whitened)
    results["direction_max_abs_err"] = float(dir_abs.max()) if dir_abs.size else 0.0

    rust_prec = np.array(fields["precision"], dtype=np.float64)
    prec_abs = np.abs(rust_prec - model["precision"].reshape(-1))
    results["precision_max_abs_err"] = float(prec_abs.max()) if prec_abs.size else 0.0

    rust_mean = np.array(fields["mean"], dtype=np.float64)
    mean_abs = np.abs(rust_mean - model["mean"])
    results["mean_max_abs_err"] = float(mean_abs.max()) if mean_abs.size else 0.0

    passed = (
        results["shrinkage_rel_err"] < tolerance
        and results["cov_max_rel_err"] < tolerance
        and results["direction_max_abs_err"] < tolerance
    )
    results["tolerance"] = tolerance
    results["passed"] = passed
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dump",
        metavar="PATH",
        help="write the dataset as a raw little-endian float64 binary",
    )
    parser.add_argument(
        "--fit",
        metavar="PATH",
        help="fit a raw little-endian float64 dump instead of the synthetic data",
    )
    parser.add_argument(
        "--dim",
        type=int,
        default=DEFAULT_DIM,
        help=f"dimension of the data (default {DEFAULT_DIM})",
    )
    parser.add_argument(
        "--n",
        type=int,
        default=DEFAULT_SAMPLES,
        help=f"number of synthetic samples (default {DEFAULT_SAMPLES})",
    )
    parser.add_argument(
        "--seed",
        type=lambda value: int(value, 0),
        default=LCG_SEED,
        help="LCG seed for the synthetic generator",
    )
    parser.add_argument(
        "--selfcheck",
        action="store_true",
        help="also report the deviation against a vectorised NumPy implementation",
    )
    parser.add_argument(
        "--artifact",
        metavar="PATH",
        help="check a calibrated artifact: re-fit and re-whiten its centroids",
    )
    parser.add_argument(
        "--artifact-tolerance",
        type=float,
        default=1e-6,
        help=(
            "tolerance for the artifact check (default 1e-6); the artifact "
            "stores the whitened directions in float32, so the round-off of "
            "the storage itself bounds the deviation"
        ),
    )
    parser.add_argument(
        "--centroid-dump",
        metavar="PATH",
        help="write the artifact's cluster centroids as a raw float64 dump",
    )
    parser.add_argument(
        "--compare",
        metavar="PATH",
        help="compare against a `whiten-check` output file and report the errors",
    )
    parser.add_argument(
        "--tolerance",
        type=float,
        default=1e-9,
        help="parity tolerance for the acceptance check (default 1e-9)",
    )
    args = parser.parse_args()

    if args.artifact:
        artifact_path = Path(args.artifact)
        if args.centroid_dump:
            _meta, artifact_tensors = read_safetensors(artifact_path)
            centroids = np.asarray(
                artifact_tensors["v_harm_clusters"], dtype=np.float64
            )
            write_dump(Path(args.centroid_dump), centroids)
            print(
                f"wrote centroid dump {args.centroid_dump} "
                f"({centroids.shape[0]} samples, dim {centroids.shape[1]})",
                file=sys.stderr,
            )
        results = check_artifact(artifact_path, args.artifact_tolerance)
        print(f"artifact = {artifact_path}")
        print(f"artifact_n = {results['n']}")
        print(f"artifact_d = {results['d']}")
        print(f"artifact_whitening = {results['whitening_method']}")
        print(f"artifact_whitening_applied = {results['whitening_applied']}")
        print(f"artifact_whitening_samples = {results['whitening_samples']}")
        print(f"artifact_shrinkage_stored = {results['shrinkage_stored']}")
        print(f"artifact_shrinkage_recomputed = {fmt(results['shrinkage_recomputed'])}")
        print(f"artifact_shrinkage_rel_err = {fmt(results['shrinkage_rel_err'])}")
        print(
            "artifact_direction_max_abs_err = "
            f"{fmt(results['direction_max_abs_err'])}"
        )
        print(
            "artifact_stored_unit_norm_max_err = "
            f"{fmt(results['stored_unit_norm_max_err'])}"
        )
        print(f"artifact_tolerance = {fmt(results['tolerance'])}")
        print(f"artifact_result = {'PASS' if results['passed'] else 'FAIL'}")
        return 0 if results["passed"] else 1

    if args.fit:
        samples = read_dump(Path(args.fit), args.dim)
        mode = "dump"
    else:
        rng = Lcg(args.seed)
        samples = synth_samples(args.n, args.dim, rng)
        mode = "synthetic"

    if args.dump:
        write_dump(Path(args.dump), samples)
        print(f"wrote dump {args.dump}", file=sys.stderr)

    model = fit([row for row in samples])
    direction = reference_direction(samples.shape[1])
    whitened = whiten_direction(model["covariance"], direction)
    diagonal = np.array(
        [model["covariance"][index, index] for index in range(samples.shape[1])],
        dtype=np.float64,
    )

    print(f"mode = {mode}")
    print(f"n = {samples.shape[0]}")
    print(f"d = {samples.shape[1]}")
    print(f"shrinkage = {fmt(model['shrinkage'])}")
    print(f"trace = {fmt(trace(model['covariance']))}")
    print(f"mean = {fmt_vector(model['mean'])}")
    print(f"cov_diag = {fmt_vector(diagonal)}")
    print(f"cov = {fmt_matrix(model['covariance'])}")
    print(f"precision = {fmt_matrix(model['precision'])}")
    print(f"direction = {fmt_vector(whitened)}")

    if args.compare:
        fields = parse_rust_output(Path(args.compare))
        results = compare_with_rust(
            fields, model, whitened, tolerance=args.tolerance
        )
        print(f"compare_shrinkage_rel_err = {fmt(results['shrinkage_rel_err'])}")
        print(f"compare_cov_max_abs_err = {fmt(results['cov_max_abs_err'])}")
        print(f"compare_cov_max_rel_err = {fmt(results['cov_max_rel_err'])}")
        print(f"compare_direction_max_abs_err = {fmt(results['direction_max_abs_err'])}")
        print(f"compare_precision_max_abs_err = {fmt(results['precision_max_abs_err'])}")
        print(f"compare_mean_max_abs_err = {fmt(results['mean_max_abs_err'])}")
        print(f"compare_tolerance = {fmt(results['tolerance'])}")
        print(f"compare_result = {'PASS' if results['passed'] else 'FAIL'}")
        if not results["passed"]:
            return 1

    if args.selfcheck:
        reference = vectorised_fit(samples)
        deviations = []
        deviations.append(abs(float(model["shrinkage"]) - reference["shrinkage"]))
        deviations.append(
            float(np.max(np.abs(model["covariance"] - reference["covariance"])))
        )
        deviations.append(
            float(np.max(np.abs(model["precision"] - reference["precision"])))
        )
        deviations.append(float(np.max(np.abs(model["mean"] - reference["mean"]))))
        vector_whitened = l2_normalize(
            np.linalg.solve(reference["factor"].T, direction)
        )
        deviations.append(float(np.max(np.abs(whitened - vector_whitened))))
        scale = max(
            abs(float(reference["shrinkage"])),
            float(np.max(np.abs(reference["covariance"]))),
            1.0,
        )
        print(f"selfcheck_max_abs = {fmt(max(deviations))}")
        print(f"selfcheck_max_rel = {fmt(max(deviations) / scale)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
