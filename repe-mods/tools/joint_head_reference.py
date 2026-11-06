#!/usr/bin/env python3
"""PyTorch reference + parity check for the Rust port of the Clef joint schema head.

The authoritative implementation is `joint_schema_model.py` in the upstream
Clef-Flash snapshot; this script imports it directly (no re-implementation) and:

  1. writes a deterministic synthetic case to ``tools/fixtures/input/``
     (hidden states, input ids, attention mask, output embedding, case metadata),
  2. runs the upstream ``JointSchemaHead`` on that case and dumps the logits
     plus per-stage intermediates to ``tools/fixtures/py/``,
  3. compares those against the Rust probe's output in ``tools/fixtures/rust/``.

Usage:
    uv run --python 3.12 --with torch --with mlx-lm python3 tools/joint_head_reference.py
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = REPO_ROOT / "tools" / "fixtures"
INPUT_DIR = FIXTURES / "input"
PY_DIR = FIXTURES / "py"
RUST_DIR = FIXTURES / "rust"

SNAPSHOT = Path(
    "/Users/mac/.cache/huggingface/hub/models--Cloudflare--clef-flash/snapshots/"
    "fb4417d31c1d0f9e7e77f1141b40aaede7491e00"
)

# --- synthetic case definition -------------------------------------------------
BATCH = 2
SEQ_LEN = 96
HIDDEN_SIZE = 4096
VOCAB_SIZE = 512
HIDDEN_SEED = 20240611
IDS_SEED = 20240612
EMBED_SEED = 20240613

RECORDS = [
    {
        "record_id": "record-0",
        "length": 80,
        "questions": [
            {
                "question_id": "q0",
                "question_type": 0,
                "question_span": [10, 18],
                "option_spans": [[30, 35], [40, 44]],
                "option_ids": ["true", "false"],
            },
            {
                "question_id": "q1",
                "question_type": 1,
                "question_span": [48, 56],
                "option_spans": [[58, 62], [63, 66], [67, 71]],
                "option_ids": ["alpha", "beta", "gamma"],
            },
        ],
    },
    {
        "record_id": "record-1",
        "length": 64,
        "questions": [
            {
                "question_id": "q0",
                "question_type": 2,
                "question_span": [20, 28],
                "option_spans": [[32, 36], [37, 41], [42, 46], [47, 51]],
                "option_ids": ["0", "1", "2", "3"],
            },
        ],
    },
]


def write_f32(path: Path, values) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = bytearray()
    chunk = 65536
    values = list(values)
    for start in range(0, len(values), chunk):
        piece = values[start : start + chunk]
        data += struct.pack(f"<{len(piece)}f", *piece)
    path.write_bytes(bytes(data))


def write_i32(path: Path, values) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = bytearray()
    chunk = 65536
    values = list(values)
    for start in range(0, len(values), chunk):
        piece = values[start : start + chunk]
        data += struct.pack(f"<{len(piece)}i", *piece)
    path.write_bytes(bytes(data))


def read_f32(path: Path):
    raw = path.read_bytes()
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def compare(name: str, left, right):
    """Max absolute and max relative difference between two float sequences."""
    if len(left) != len(right):
        print(f"  {name:<20} LENGTH MISMATCH py={len(left)} rust={len(right)}")
        return None
    max_abs = 0.0
    max_rel = 0.0
    max_ref = 0.0
    worst = 0
    for index, (a, b) in enumerate(zip(left, right)):
        diff = abs(a - b)
        if diff > max_abs:
            max_abs = diff
            worst = index
        max_ref = max(max_ref, abs(b))
        if abs(b) > 1e-12:
            max_rel = max(max_rel, diff / abs(b))
    print(
        f"  {name:<20} max_abs={max_abs:.6e}  max_rel={max_rel:.6e}  "
        f"max|ref|={max_ref:.4e}  (n={len(left)}, worst idx {worst})"
    )
    return max_abs, max_rel


def main() -> int:
    import torch

    sys.path.insert(0, str(SNAPSHOT))
    from joint_schema_model import EncodedQuestion, EncodedRecord, JointSchemaHead

    from safetensors.torch import load_file

    head_config = json.loads((SNAPSHOT / "joint_head_config.json").read_text())
    head = JointSchemaHead(**head_config)

    tensors = load_file(SNAPSHOT / "joint_head.safetensors")
    own = set(head.state_dict().keys())
    theirs = set(tensors.keys())
    missing = sorted(own - theirs)
    unexpected = sorted(theirs - own)
    print(f"state_dict: {len(own)} module params, {len(theirs)} file tensors")
    if missing:
        print(f"  MISSING from file : {missing}")
    if unexpected:
        print(f"  UNEXPECTED in file: {unexpected}")
    if missing or unexpected:
        print("  !! state_dict key mismatch")
        return 1
    head.load_state_dict(tensors, strict=True)
    print("  load_state_dict(strict=True): OK")
    head = head.eval().to(torch.float32)

    # --- synthetic case ------------------------------------------------------
    generator = torch.Generator().manual_seed(HIDDEN_SEED)
    hidden_states = torch.randn(
        BATCH, SEQ_LEN, HIDDEN_SIZE, generator=generator, dtype=torch.float32
    )
    generator = torch.Generator().manual_seed(IDS_SEED)
    input_ids = torch.randint(
        0, VOCAB_SIZE, (BATCH, SEQ_LEN), generator=generator, dtype=torch.long
    )
    generator = torch.Generator().manual_seed(EMBED_SEED)
    output_embedding = torch.randn(
        VOCAB_SIZE, HIDDEN_SIZE, generator=generator, dtype=torch.float32
    )

    attention_mask = torch.zeros(BATCH, SEQ_LEN, dtype=torch.long)
    for index, record in enumerate(RECORDS):
        attention_mask[index, : record["length"]] = 1

    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    write_f32(INPUT_DIR / "hidden_states.f32", hidden_states.reshape(-1).tolist())
    write_i32(INPUT_DIR / "input_ids.i32", input_ids.reshape(-1).tolist())
    write_i32(INPUT_DIR / "attention_mask.i32", attention_mask.reshape(-1).tolist())
    write_f32(INPUT_DIR / "output_embedding.f32", output_embedding.reshape(-1).tolist())
    (INPUT_DIR / "case.json").write_text(
        json.dumps(
            {
                "batch": BATCH,
                "seq_len": SEQ_LEN,
                "hidden_size": HIDDEN_SIZE,
                "vocab_size": VOCAB_SIZE,
                "records": RECORDS,
            },
            indent=2,
        )
    )
    print(f"wrote synthetic case to {INPUT_DIR}")

    encoded = [
        EncodedRecord(
            input_ids=tuple(input_ids[index].tolist()),
            questions=tuple(
                EncodedQuestion(
                    question_id=question["question_id"],
                    question_type=question["question_type"],
                    question_span=tuple(question["question_span"]),
                    option_spans=tuple(tuple(span) for span in question["option_spans"]),
                    option_ids=tuple(question["option_ids"]),
                )
                for question in record["questions"]
            ),
            record_id=record["record_id"],
        )
        for index, record in enumerate(RECORDS)
    ]

    # --- stage capture -------------------------------------------------------
    captured: dict[str, list] = {}

    def forward_hook(name):
        def hook(module, args, output):
            captured.setdefault(name, []).append(output.detach().to(torch.float32).cpu())

        return hook

    def pre_hook(name):
        def hook(module, args):
            captured.setdefault(name, []).append(args[0].detach().to(torch.float32).cpu())

        return hook

    head.hidden_norm.register_forward_hook(forward_hook("normalized_hidden"))
    head.memory_projection.register_forward_hook(forward_hook("memory"))
    head.question_projection.register_forward_pre_hook(pre_hook("question_vectors"))
    head.evidence_layers[0].register_forward_pre_hook(pre_hook("option_queries"))
    head.evidence_layers[-1].register_forward_hook(forward_hook("routed_options"))
    head.field_norm.register_forward_hook(forward_hook("fields"))

    # Diagnostic run first: grad enabled (so the fused MHA fast path is skipped)
    # and the math SDPA backend, i.e. the explicit
    # `softmax(q @ k^T * scale) @ v` formula the Rust port implements.
    from torch.nn.attention import SDPBackend, sdpa_kernel

    with torch.enable_grad(), sdpa_kernel(SDPBackend.MATH):
        logits_math = head(hidden_states, input_ids, attention_mask, encoded, output_embedding)
    flat_math: list[float] = []
    for record_logits in logits_math:
        for question_logits in record_logits:
            flat_math.extend(question_logits.detach().to(torch.float32).reshape(-1).tolist())

    # Primary run: eval-mode no-grad, matching the upstream inference path.
    captured.clear()
    with torch.no_grad():
        logits = head(hidden_states, input_ids, attention_mask, encoded, output_embedding)

    flat: list[float] = []
    for record_logits in logits:
        for question_logits in record_logits:
            flat.extend(question_logits.detach().to(torch.float32).reshape(-1).tolist())

    # --- dump ----------------------------------------------------------------
    PY_DIR.mkdir(parents=True, exist_ok=True)
    stages = []

    def dump_stage(name: str, index: int, tensor) -> None:
        tensor = tensor.detach().to(torch.float32).cpu()
        file_name = f"stage_{name}_{index}.f32"
        write_f32(PY_DIR / file_name, tensor.reshape(-1).tolist())
        stages.append(
            {"name": name, "index": index, "file": file_name, "shape": list(tensor.shape)}
        )

    write_f32(PY_DIR / "logits.f32", flat)
    write_f32(PY_DIR / "logits_math.f32", flat_math)
    dump_stage("normalized_hidden", 0, captured["normalized_hidden"][0])
    for index, tensor in enumerate(captured["memory"]):
        dump_stage("memory", index, tensor.unsqueeze(0))
    for index, tensor in enumerate(captured["question_vectors"]):
        dump_stage("question_vectors", index, tensor)
    for index, tensor in enumerate(captured["option_queries"]):
        dump_stage("option_queries", index, tensor)
    for index, tensor in enumerate(captured["routed_options"]):
        dump_stage("routed_options", index, tensor)
    for index, tensor in enumerate(captured["fields"]):
        dump_stage("fields", index, tensor.unsqueeze(0))
    (PY_DIR / "manifest.json").write_text(
        json.dumps(
            {"logits": {"file": "logits.f32", "shape": [len(flat)]}, "stages": stages},
            indent=2,
        )
    )
    print(f"wrote {len(flat)} logits and {len(stages)} stage tensors to {PY_DIR}")
    print(f"logits (inference_mode): {['%.6f' % v for v in flat]}")

    # --- compare -------------------------------------------------------------
    print("\nPyTorch inference_mode vs PyTorch math-SDPA backend:")
    compare("logits", flat_math, flat)

    rust_logits = RUST_DIR / "logits.f32"
    if not rust_logits.exists():
        print(f"\nNo Rust output at {rust_logits}; run `cargo run --bin joint_head_probe` first.")
        return 0

    print("\nRust port vs PyTorch:")
    rust_flat = read_f32(rust_logits)
    result = compare("logits", flat, rust_flat)
    compare("logits (math ref)", flat_math, rust_flat)

    rust_manifest = json.loads((RUST_DIR / "manifest.json").read_text())
    py_stages = {(s["name"], s["index"]): s for s in stages}
    for stage in rust_manifest["stages"]:
        key = (stage["name"], stage["index"])
        if key not in py_stages:
            print(f"  {stage['name']:<20} stage {stage['index']} missing on the PyTorch side")
            continue
        py_values = read_f32(PY_DIR / py_stages[key]["file"])
        rust_values = read_f32(RUST_DIR / stage["file"])
        compare(f"{stage['name']}[{stage['index']}]", py_values, rust_values)

    if result is not None:
        max_abs = result[0]
        print(f"\nFINAL max abs error on logits: {max_abs:.6e} (tolerance 1e-4)")
        if max_abs >= 1e-4:
            print("FAIL: exceeds tolerance")
            return 1
        print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
