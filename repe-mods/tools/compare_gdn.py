#!/usr/bin/env python3
"""Compare the Rust and Python dumps of the hybrid clef-flash stack.

Reads the raw little-endian float32 binaries written by `gdn_probe` (Rust) and
`py_reference.py` (Python/mlx-lm) and reports the maximum absolute and
maximum relative error for every layer plus the final hidden state.

Usage:

    uv run --python 3.12 --with mlx-lm python3 tools/compare_gdn.py \
        --dir artifacts/gdn_probe
"""

import argparse
import json
from pathlib import Path

import numpy as np

# Relative error denominator floor: values below this are treated as zero.
REL_EPS = 1e-12


def load_f32(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype="<f4")
    if data.size == 0:
        raise RuntimeError(f"{path} is empty")
    return data.astype(np.float64)


def compare(name: str, rust: np.ndarray, py: np.ndarray) -> dict:
    if rust.shape != py.shape:
        raise RuntimeError(f"{name}: shape mismatch {rust.shape} vs {py.shape}")
    diff = np.abs(rust - py)
    denom = np.maximum(np.abs(py), REL_EPS)
    rel = diff / denom
    max_abs = float(diff.max())
    idx = int(diff.argmax())
    return {
        "name": name,
        "n": int(rust.size),
        "max_abs": max_abs,
        "max_rel": float(rel.max()),
        "mean_abs": float(diff.mean()),
        "ref_absmax": float(np.abs(py).max()),
        "normalized_linf": max_abs / max(float(np.abs(py).max()), REL_EPS),
        "argmax_index": idx,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default="artifacts/gdn_probe")
    parser.add_argument(
        "--tolerance",
        type=float,
        nargs=2,
        default=[1e-4, 1e-3],
        metavar=("LAYER0_ABS", "FULL_STACK_ABS"),
        help="acceptance tolerances for layer 0 and for the full stack",
    )
    args = parser.parse_args()

    root = Path(args.dir)
    results = []

    layer_ids = sorted(
        int(p.stem[len("py_layer") :]) for p in root.glob("py_layer*.f32")
    )
    for index in layer_ids:
        rust_path = root / f"rust_layer{index:02}.f32"
        py_path = root / f"py_layer{index:02}.f32"
        if not rust_path.exists():
            print(f"missing {rust_path}; skipping layer {index}")
            continue
        results.append(
            compare(f"layer{index:02}", load_f32(rust_path), load_f32(py_path))
        )

    rust_h = root / "rust_hfinal.f32"
    py_h = root / "py_hfinal.f32"
    if rust_h.exists() and py_h.exists():
        results.append(compare("h_final", load_f32(rust_h), load_f32(py_h)))

    if not results:
        raise SystemExit(f"no comparable dumps found in {root}")

    width = max(len(r["name"]) for r in results)
    header = (
        f"{'tensor':<{width}}  {'max_abs':>12}  {'max_rel':>12}  "
        f"{'mean_abs':>12}  {'ref_absmax':>12}  {'linf/ref':>10}"
    )
    print(header)
    print("-" * len(header))
    for r in results:
        print(
            f"{r['name']:<{width}}  {r['max_abs']:>12.6e}  {r['max_rel']:>12.6e}  "
            f"{r['mean_abs']:>12.6e}  {r['ref_absmax']:>12.6e}  {r['normalized_linf']:>10.3e}"
        )

    by_name = {r["name"]: r for r in results}
    layer0 = by_name.get("layer00")
    hfinal = by_name.get("h_final")
    layer3 = by_name.get("layer03")

    print()
    if layer0 is not None:
        ok = layer0["max_abs"] < args.tolerance[0]
        print(
            f"layer 0 max_abs = {layer0['max_abs']:.6e} "
            f"(tolerance {args.tolerance[0]:.0e}) -> {'PASS' if ok else 'FAIL'}"
        )
    if layer3 is not None:
        print(f"layer 3 max_abs = {layer3['max_abs']:.6e}")
    if hfinal is not None:
        ok = hfinal["max_abs"] < args.tolerance[1]
        print(
            f"full stack max_abs = {hfinal['max_abs']:.6e} "
            f"(tolerance {args.tolerance[1]:.0e}) -> {'PASS' if ok else 'FAIL'}"
        )

    worst = max(results, key=lambda r: r["max_abs"])
    print(f"worst tensor: {worst['name']} (max_abs {worst['max_abs']:.6e})")

    summary_path = root / "comparison.json"
    summary_path.write_text(json.dumps(results, indent=2))
    print(f"wrote {summary_path}")


if __name__ == "__main__":
    main()
