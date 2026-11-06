#!/usr/bin/env python3
"""Python reference for the Cloudflare/clef-flash hybrid stack.

Loads the model with `mlx-lm` (the same code path the Rust port mirrors),
forces float32 everywhere, runs a fixed 16-token prompt and dumps the
intermediate activations as raw little-endian float32 binaries so the Rust
implementation can be compared element by element.

Usage:

    uv run --python 3.12 --with mlx-lm python3 tools/py_reference.py \
        --model-dir <snapshot> --out-dir artifacts/gdn_probe
"""

import argparse
import json
from pathlib import Path

import mlx.core as mx
import numpy as np
from mlx.utils import tree_flatten, tree_map

DEFAULT_MODEL_DIR = (
    "/Users/mac/.cache/huggingface/hub/models--Cloudflare--clef-flash/snapshots/"
    "fb4417d31c1d0f9e7e77f1141b40aaede7491e00"
)
DEFAULT_OUT_DIR = "artifacts/gdn_probe"

# The fixed 16-token prompt used by both sides.
# "The capital of France is Paris, and the capital of Germany is Berlin, too"
# encoded with the clef-flash tokenizer (no special tokens).
PROMPT_TOKEN_IDS = [
    760, 6511, 314, 9338, 369, 11751, 11, 321,
    279, 6511, 314, 9564, 369, 19241, 11, 2166,
]


def dump_f32(path: Path, array: mx.array) -> None:
    """Write a raw little-endian float32 binary."""
    data = np.ascontiguousarray(np.asarray(array.astype(mx.float32)))
    assert data.dtype == np.float32, data.dtype
    data.tofile(str(path))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    parser.add_argument(
        "--gdn",
        choices=["kernel", "ops"],
        default="kernel",
        help=(
            "which Gated DeltaNet recurrence the reference runs: 'kernel' is "
            "mlx-lm's default eval-mode Metal kernel, 'ops' is the "
            "`gated_delta_ops` formulation the Rust port implements"
        ),
    )
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    from mlx_lm.models import qwen3_5 as q35
    from mlx_lm.utils import load_model

    print(f"model dir : {args.model_dir}")
    print(f"output dir: {out_dir}")
    print(f"token ids : {PROMPT_TOKEN_IDS}")

    model, _config = load_model(Path(args.model_dir))

    # Force float32 compute on every parameter (the Rust loader reads the same
    # bfloat16 checkpoint tensors and widens them to float32).
    model.update(tree_map(lambda x: x.astype(mx.float32), model.parameters()))
    mx.eval(model.parameters())
    flat_params = dict(tree_flatten(model.parameters()))
    dtypes = {str(p.dtype) for p in flat_params.values()}
    print(f"parameter dtypes: {sorted(dtypes)}")
    assert dtypes == {"mlx.core.float32"}, dtypes

    # `mlx_lm` runs the hand-written Metal Gated DeltaNet kernel in eval mode;
    # the ops-based `_gated_delta_step_ops` formulation (the one the Rust port
    # implements) is only selected in training mode. The two use different
    # reduction orders and therefore differ from each other by ~1e-5 at
    # layer 0, so the choice is explicit here.
    if args.gdn == "ops":
        _original_update = q35.gated_delta_update

        def _ops_update(*a, **kw):
            kw["use_kernel"] = False
            return _original_update(*a, **kw)

        q35.gated_delta_update = _ops_update
    print(f"gdn recurrence: {args.gdn}")

    # Hook the decoder layers instead of reimplementing them.
    captured = {}
    original_call = q35.DecoderLayer.__call__

    def patched_call(self, x, mask=None, cache=None):
        out = original_call(self, x, mask=mask, cache=cache)
        captured[id(self)] = out
        return out

    q35.DecoderLayer.__call__ = patched_call

    text_model = model.language_model.model
    token_ids = mx.array([PROMPT_TOKEN_IDS], dtype=mx.int32)

    # `Qwen3_5TextModel.__call__` returns the hidden state after the final
    # norm and before the LM head.
    h_final = text_model(token_ids)
    mx.eval(h_final)
    mx.eval(list(captured.values()))

    for index, layer in enumerate(text_model.layers):
        out = captured.get(id(layer))
        if out is None:
            raise RuntimeError(f"layer {index} was not captured")
        dump_f32(out_dir / f"py_layer{index:02}.f32", out)
    dump_f32(out_dir / "py_hfinal.f32", h_final)

    # End-to-end sanity check through the LM head.
    lm_head = model.language_model.lm_head.weight
    logits = h_final @ lm_head.T
    next_token = int(mx.argmax(logits[0, -1]))
    print(f"next-token argmax id: {next_token}")

    summary = {
        "token_ids": PROMPT_TOKEN_IDS,
        "next_token_argmax": next_token,
        "h_final_shape": list(h_final.shape),
        "layer_shape": list(captured[id(text_model.layers[0])].shape),
    }
    (out_dir / "py_summary.json").write_text(json.dumps(summary, indent=2))
    print(f"wrote {len(text_model.layers)} layer dumps + py_hfinal.f32 to {out_dir}")


if __name__ == "__main__":
    main()
