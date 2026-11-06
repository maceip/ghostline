#!/usr/bin/env bash
# End-to-end verification of the guard.
#
# Every number this prints comes from a command that actually ran. The
# benchmark steps need a running upstream model server and a running guard;
# `verify_all.sh` starts both, runs the suites, and leaves the guard up.
#
#   bash evals/verify_all.sh
#
# Environment:
#   MODEL     the checkpoint to calibrate and judge with (default: Qwen2.5-0.5B)
#   CLEF      the clef-flash checkpoint, for the GDN and joint-head parity
#   PORT      the guard's port (default 8090)
#   UPSTREAM  the upstream model server's port (default 8123)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="$ROOT/qwen-clef-repe-guard"

MODEL="${MODEL:-/Users/mac/.cache/huggingface/hub/models--Qwen--Qwen2.5-0.5B-Instruct/snapshots/7ae557604adf67be50417f59c2c2f167def9a775/}"
CLEF="${CLEF:-/Users/mac/.cache/huggingface/hub/models--Cloudflare--clef-flash/snapshots/fb4417d31c1d0f9e7e77f1141b40aaede7491e00/}"
PORT="${PORT:-8090}"
UPSTREAM="${UPSTREAM:-8123}"

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

step "1/9 regenerate the project from repe-mods/"
(cd "$ROOT" && python3 repe-compose.py && bash upgrade_generic_viz.sh)

step "2/9 build and unit tests"
(cd "$PROJ" && cargo build --all-targets 2>&1 | tail -3 && cargo test --lib 2>&1 | grep -E "test result")

step "3/9 start the upstream model server"
if ! curl -s -o /dev/null "http://127.0.0.1:${UPSTREAM}/v1/models"; then
  (cd "$PROJ" && nohup uv run --python 3.12 --with mlx-lm mlx_lm.server \
      --model "$MODEL" --host 127.0.0.1 --port "$UPSTREAM" --temp 0.0 --max-tokens 128 \
      > /tmp/upstream_verify.log 2>&1 &)
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "http://127.0.0.1:${UPSTREAM}/v1/models" && break
    sleep 2
  done
fi
curl -s -o /dev/null -w "upstream http=%{http_code}\n" "http://127.0.0.1:${UPSTREAM}/v1/models"

step "4/9 start the guard"
pkill -f "qwen-clef-repe-guard --port ${PORT}" 2>/dev/null || true
sleep 2
(cd "$PROJ" && nohup ./target/debug/qwen-clef-repe-guard --port "$PORT" \
    --upstream "http://127.0.0.1:${UPSTREAM}" --model "$MODEL" \
    --repe artifacts/repe_vectors_qwen2_5_0_5b.safetensors --mode enforce \
    > /tmp/guard_verify.log 2>&1 &)
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:${PORT}/health" && break
  sleep 2
done
grep -E "cached vectors match|no cached vectors" /tmp/guard_verify.log || true

step "5/9 canonical benchmark (40 cases, held out from calibration)"
python3 "$ROOT/evals/canonical_40.py" "$PORT" | grep -E "^  =>|TOTAL"

step "6/9 real upstream benchmark (10 goals, real model traffic)"
python3 "$ROOT/evals/real_upstream_20.py" "$PORT" | tail -3

step "7/9 parity suites"
(cd "$ROOT" && timeout 900 uv run --python 3.12 --with mlx-lm python3 check_render_parity.py | tail -2)
(cd "$PROJ" && timeout 1800 cargo run --release --quiet --bin gdn_probe -- "$CLEF" artifacts/gdn_probe >/dev/null 2>&1 \
  && timeout 900 uv run --python 3.12 --with mlx-lm python3 tools/compare_gdn.py | grep -E "layer 0|max_abs =|PASS|FAIL" | tail -4)
(cd "$PROJ" && timeout 1800 uv run --python 3.12 --with torch --with mlx-lm python3 tools/joint_head_reference.py >/dev/null 2>&1 \
  && timeout 600 cargo run --quiet --bin joint_head_probe -- --input tools/fixtures/input --output tools/fixtures/rust >/dev/null 2>&1 \
  && timeout 900 uv run --python 3.12 --with torch --with mlx-lm python3 tools/joint_head_reference.py | tail -3)

step "8/9 access control (auth, rate limit, proxy trust, safety rail)"
python3 "$ROOT/evals/access_control.py"

step "9/9 device-bound sessions (admission, binding, forgery, operator token, restart)"
python3 "$ROOT/evals/session_guard.py"

printf '\n\033[1mdone — the guard is still running on port %s\033[0m\n' "$PORT"
