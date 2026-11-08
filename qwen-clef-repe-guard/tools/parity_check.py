#!/usr/bin/env python3
"""Rust guard vs mlx_lm reference: the same calls must read the same.

Catches a broken Rust forward pass (e.g. the dropped Qwen2 q/k/v biases).
Usage: uv run --python 3.12 --with mlx-lm python3 tools/parity_check.py PORT MODEL ARTIFACT
Exits 1 when any cluster score differs by more than TOL.
"""
import http.cookiejar, json, sys, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import mlx.core as mx
from mlx_lm import load
import extract_repe_vectors as E

TOL = 0.03  # Metal f32 GEMM runs at ~fp16 precision; a broken forward misses by 0.1-0.3
port, model_dir, artifact = sys.argv[1], sys.argv[2], sys.argv[3]
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
H = {"Content-Type": "application/json"}
op.open(urllib.request.Request(f"http://127.0.0.1:{port}/api/session", data=b"{}", headers=H))
model, tok = load(model_dir)
# The Rust guard computes in float32; compare like with like.
model.set_dtype(mx.float32)
bb = E.get_backbone(model)
w = mx.load(artifact)
C, cp = w["v_harm_clusters"], w["v_copy_mode"]
layer = int(w["target_layer_idx"].item())
worst = 0.0
for prompt, cmd in [("Show the date.", "date"), ("Clean up the temporary build artifacts.", "rm -rf ~/*"),
                    ("Run the tests.", "pytest -q"), ("Check the config.", "cat ~/.ssh/id_ed25519")]:
    text = E.render_tool_call_turn(prompt, 'bash({"cmd": "%s"})' % cmd)
    start = E.span_start_for(tok, text, E.tool_call_span_prefix(prompt))
    pooled, _ = E.forward_to_layer_tool_span(bb, tok.encode(text), layer, start)
    u = E.unit_normalize(pooled)
    u = E.unit_normalize(u - cp * mx.sum(u * cp))
    py = (C @ u).tolist()
    body = json.dumps({"prompt": prompt, "tool_name": "bash", "tool_args": {"cmd": cmd}}).encode()
    rs = json.load(op.open(urllib.request.Request(f"http://127.0.0.1:{port}/v1/guard/tool-call", data=body, headers=H), timeout=300))["cluster_scores"]
    d = max(abs(a - b) for a, b in zip(py, rs))
    worst = max(worst, d)
    print(f"{'ok  ' if d <= TOL else 'FAIL'} maxdiff={d:.4f}  py={[round(x,3) for x in py]} rust={[round(x,3) for x in rs]}  {cmd}")
print(f"worst {worst:.4f} (tol {TOL})")
sys.exit(0 if worst <= TOL else 1)
