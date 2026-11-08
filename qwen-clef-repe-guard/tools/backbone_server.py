#!/usr/bin/env python3
"""Serve the model's residual stream from mlx_lm, for the Rust guard.

The guard used to run its own hand-written Qwen decoder in Rust. That port
dropped the q/k/v biases and drifted from the reference, so the readings it
produced were not the model's. This server runs the model through mlx_lm —
the same library and the same layer loop the calibration script uses — and
hands the per-layer hidden states to the guard, which keeps doing the scoring.

Protocol (TCP, little-endian, one request per connection):
  request : u32 n, then n x u32 token ids
  response: u32 L, u32 S, u32 D, then L*S*D f32 (residual after each layer),
            then S*D f32 (final-normed hidden state)

Usage:
  uv run --python 3.12 --with mlx-lm python3 tools/backbone_server.py MODEL_DIR [PORT]
"""
import socketserver
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import mlx.core as mx  # noqa: E402
import numpy as np  # noqa: E402
from mlx_lm import load  # noqa: E402
from mlx_lm.models.base import create_attention_mask  # noqa: E402

import extract_repe_vectors as E  # noqa: E402

MODEL_DIR = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8093

model, _tok = load(MODEL_DIR)
backbone = E.get_backbone(model)
if any(getattr(layer, "is_linear", False) for layer in backbone.layers):
    sys.exit("hybrid linear-attention stacks need the SSM mask path; not wired here yet")


def all_layers(ids):
    """Every layer's residual — the same loop as forward_to_layer_tool_span."""
    h = backbone.embed_tokens(mx.array([ids], dtype=mx.int32))
    mask = create_attention_mask(h, None)
    states = []
    for layer in backbone.layers:
        h = layer(h, mask, None)
        if isinstance(h, tuple):
            h = h[0]
        states.append(h[0].astype(mx.float32))
    final = backbone.norm(h)[0].astype(mx.float32)
    stacked = mx.stack(states, axis=0)
    mx.eval(stacked, final)
    return np.asarray(stacked), np.asarray(final)


def read_exact(rfile, n):
    buf = rfile.read(n)
    if len(buf) != n:
        raise ConnectionError("short read")
    return buf


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        (n,) = struct.unpack("<I", read_exact(self.rfile, 4))
        ids = list(struct.unpack(f"<{n}I", read_exact(self.rfile, 4 * n)))
        layers, final = all_layers(ids)
        L, S, D = layers.shape
        self.wfile.write(struct.pack("<III", L, S, D))
        self.wfile.write(layers.astype("<f4").tobytes())
        self.wfile.write(final.astype("<f4").tobytes())


class Server(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"backbone_server: {MODEL_DIR} ({len(backbone.layers)} layers) on 127.0.0.1:{PORT}", flush=True)
    # Single-threaded on purpose: MLX evaluation is not re-entrant across threads.
    with Server(("127.0.0.1", PORT), Handler) as srv:
        srv.serve_forever()
