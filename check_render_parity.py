#!/usr/bin/env python3
"""Assert the Python extractor and the Rust guard render tool calls identically.

The RepE directions are calibrated against activations produced by exactly the
text the guard later feeds the tokenizer. If the two renderers drift apart,
the measured threshold silently stops applying — so this check compares them
byte for byte.

    uv run --python 3.12 --with mlx-lm python3 check_render_parity.py
"""
import importlib.util
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
RUST = ROOT / "qwen-clef-repe-guard" / "src" / "repe_sensor.rs"
PY = ROOT / "extract_repe_vectors.py"

rust = RUST.read_text()


def rust_literal(fn_name):
    """The format string of a Rust render helper."""
    m = re.search(r"pub fn " + fn_name + r"\(.*?\n\}\n", rust, re.S)
    assert m, f"{fn_name} not found in {RUST}"
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(0))
    assert parts, f"{fn_name} has no literal"
    return "".join(parts).replace("\\n", "\n").replace('\\"', '"')


def fill(template, **kw):
    for key, value in kw.items():
        template = template.replace("{" + key + "}", value)
    return template


spec = importlib.util.spec_from_file_location("extractor", PY)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

checks = [
    (
        "render_user_turn",
        fill(rust_literal("render_user_turn"), user="USER"),
        mod.render_user_turn("USER"),
    ),
    (
        "render_tool_call_turn",
        fill(rust_literal("render_tool_call_turn"),
             user="USER", tool_name="bash", tool_args="ARGS"),
        mod.render_tool_call_turn("USER", "bash(ARGS)"),
    ),
    (
        "render_tool_response_turn",
        fill(rust_literal("render_tool_response_turn"), user="USER", content="CONTENT"),
        mod.render_tool_response_turn("USER", "CONTENT"),
    ),
    (
        "render_reference_tool_call_turn",
        fill(rust_literal("render_tool_call_turn"), user="USER", tool_name="bash",
             tool_args='{"cmd": "CMD"}'),
        mod.render_reference_tool_call_turn("USER", "CMD"),
    ),
    (
        "benign_reference_panel",
        fill(rust_literal("render_tool_call_turn"), user="USER", tool_name="bash",
             tool_args='{"cmd": "cargo build --release"}'),
        mod.render_reference_tool_call_turn("USER", "cargo build --release"),
    ),
    (
        "tool_call_span_prefix",
        fill(rust_literal("tool_call_span_prefix"), user="USER"),
        mod.tool_call_span_prefix("USER"),
    ),
]

ok = True
for name, rust_text, py_text in checks:
    same = rust_text == py_text
    ok = ok and same
    print(f"{name:32s} {'MATCH' if same else 'MISMATCH'}")
    if not same:
        print(f"   rust code points: {[hex(ord(c)) for c in rust_text]}")
        print(f"   py   code points: {[hex(ord(c)) for c in py_text]}")

print("\nALL RENDERINGS MATCH" if ok else "\nRENDERING DRIFT DETECTED")
sys.exit(0 if ok else 1)
