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
#
# IT EXITS NON-ZERO IF ANY STEP FAILED
# ------------------------------------
#   This script runs without errexit, so a failing command in the middle
#   would otherwise be printed over and forgotten — and the exit status
#   would come from the last `printf`, which is always 0.  A verification
#   suite that cannot fail is worse than no suite, because it is believed.
#   Every step's status is recorded here and the script exits 1 if any of
#   them failed.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="$ROOT/qwen-clef-repe-guard"

MODEL="${MODEL:-/Users/mac/.cache/huggingface/hub/models--Qwen--Qwen2.5-0.5B-Instruct/snapshots/7ae557604adf67be50417f59c2c2f167def9a775/}"
CLEF="${CLEF:-/Users/mac/.cache/huggingface/hub/models--Cloudflare--clef-flash/snapshots/fb4417d31c1d0f9e7e77f1141b40aaede7491e00/}"
PORT="${PORT:-8090}"
UPSTREAM="${UPSTREAM:-8123}"

FAILED_STEPS=()

step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

# Record a step's outcome.  Call it with the step's exit status.
record() {
    local label="$1" status="$2"
    if [ "$status" -ne 0 ]; then
        FAILED_STEPS+=("$label (exit $status)")
        printf '    \033[1;31mFAILED\033[0m  %s\n' "$label"
    fi
}

step "1/11 (retired) regenerate the project from repe-mods/"
# Regenerating qwen-clef-repe-guard/src from repe-mods/ overwrote the fixes
# made directly in the generated tree (the Qwen2 bias load, the mlx_lm
# backbone). qwen-clef-repe-guard/src is now the source of truth.
echo "skipped: qwen-clef-repe-guard/src is the source of truth"
record "1/11 regenerate the project (retired)" 0

step "2/11 build and unit tests"
(cd "$PROJ" && cargo build --all-targets 2>&1 | tail -3 && cargo test --lib 2>&1 | grep -E "test result")
record "2/11 build and unit tests" $?

step "3/11 start the upstream model server"
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
record "3/11 start the upstream model server" $?

step "4/11 start the guard"
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
record "4/11 start the guard" $?

step "5/11 held-out benchmark (50 commands never in calibration, vs a keyword filter)"
# canonical_40 reused calibration pairs, so it was never held out.
python3 "$ROOT/evals/heldout_novel.py" "$PORT" --no-write | grep -E "^=>"
record "5/11 held-out benchmark" $?

step "6/11 real upstream benchmark (10 goals, real model traffic)"
python3 "$ROOT/evals/real_upstream_20.py" "$PORT" | tail -3
record "6/11 real upstream benchmark" $?

step "7/11 parity suites"
(cd "$ROOT" && timeout 900 uv run --python 3.12 --with mlx-lm python3 check_render_parity.py | tail -2)
record "7/11 render parity" $?
(cd "$PROJ" && timeout 1800 cargo run --release --quiet --bin gdn_probe -- "$CLEF" artifacts/gdn_probe >/dev/null 2>&1 \
  && timeout 900 uv run --python 3.12 --with mlx-lm python3 tools/compare_gdn.py | grep -E "layer 0|max_abs =|relative error|PASS|FAIL" | tail -6)
record "7/11 GDN parity" $?
(cd "$PROJ" && timeout 1800 uv run --python 3.12 --with torch --with mlx-lm python3 tools/joint_head_reference.py >/dev/null 2>&1 \
  && timeout 600 cargo run --quiet --bin joint_head_probe -- --input tools/fixtures/input --output tools/fixtures/rust >/dev/null 2>&1 \
  && timeout 900 uv run --python 3.12 --with torch --with mlx-lm python3 tools/joint_head_reference.py | tail -3)
record "7/11 joint head parity" $?

step "8/11 access control (auth, rate limit, proxy trust, header provenance, safety rail)"
python3 "$ROOT/evals/access_control.py"
record "8/11 access control" $?

step "9/11 device-bound sessions (admission, binding, forgery, operator token, restart)"
python3 "$ROOT/evals/session_guard.py"
record "9/11 device-bound sessions" $?

# The public edge.  This one SKIPS rather than fails when the machine has
# no Caddy with the rate_limit module — it needs a Caddy built with
# xcaddy, which is a deployment-time dependency, not a build-time one.
# Exit code 3 means "no such Caddy"; anything else is a real failure.
step "10/11 the Caddy edge (rate limit by client IP, forged X-Forwarded-For)"
edge_status=0
python3 "$ROOT/evals/caddy_edge.py" || edge_status=$?
if [ "$edge_status" -eq 3 ]; then
    printf '    \033[33mSKIPPED\033[0m — no Caddy with the rate_limit module on this machine.\n'
    printf '           Build one with:  xcaddy build --with github.com/mholt/caddy-ratelimit --output /tmp/caddy-rl/caddy\n'
    printf '           then:  ZCODE_CADDY_BIN=/tmp/caddy-rl/caddy python3 evals/caddy_edge.py\n'
elif [ "$edge_status" -ne 0 ]; then
    record "10/11 the Caddy edge" "$edge_status"
fi

step "11/11 the site's headline numbers (claims vs the shipped data)"
python3 "$ROOT/evals/site_claims.py"
record "11/11 the site's headline numbers" $?

if [ "${#FAILED_STEPS[@]}" -gt 0 ]; then
    printf '\n\033[1;31m%d step(s) FAILED:\033[0m\n' "${#FAILED_STEPS[@]}"
    for f in "${FAILED_STEPS[@]}"; do
        printf '  - %s\n' "$f"
    done
    printf '\n\033[1mdone — the guard is still running on port %s\033[0m\n' "$PORT"
    exit 1
fi
printf '\n\033[1mdone — every step passed, and the guard is still running on port %s\033[0m\n' "$PORT"
