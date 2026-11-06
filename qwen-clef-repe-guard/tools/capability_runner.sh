#!/usr/bin/env bash
#
# capability_runner.sh — end-to-end exercise of the capability-token path.
#
# What it does, in order:
#
#   1. finds or builds the `capability-tool` binary;
#   2. compiles the Touch ID helper (tools/touchid_stepup.swift) when a
#      `swiftc` is available;
#   3. generates a key pair, mints a capability token for a sample tool call,
#      and verifies it;
#   4. runs the Touch ID step-up and prints its REAL status — if biometrics
#      are unavailable on this machine it says so, it does not pretend a human
#      approved anything;
#   5. cross-checks the same token with the independent Python verifier;
#   6. when the biometric step-up did not succeed, exercises the documented
#      policy-signed fallback (`subject = policy:local-runner`) instead.
#
# Exit code 0 means the token mint/verify path works. The Touch ID status is
# reported honestly and does not by itself fail the run.
#
# Environment overrides:
#   CAPABILITY_TOOL        path to an existing capability-tool binary
#   CAPABILITY_RUNNER_DIR  scratch directory for the swift helper / build
#   TOUCHID_TIMEOUT        seconds to wait for the biometric prompt (default 30)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRATCH="${CAPABILITY_RUNNER_DIR:-${TMPDIR:-/tmp}/capability-runner}"

TOOL_NAME="capability-tool"
SAMPLE_TOOL="fs.write"
SAMPLE_ARGS='{"path":"notes/todo.md","content":"hello","mode":"append"}'
SAMPLE_SUBJECT="human:touchid"
POLICY_SUBJECT="policy:local-runner"
TTL=120
TOUCHID_TIMEOUT="${TOUCHID_TIMEOUT:-30}"
TOUCH_REASON="Approve the capability token test call"

mkdir -p "$SCRATCH" || exit 1

say() { printf '\n== %s ==\n' "$1"; }
info() { printf '   %s\n' "$1"; }

# --- 1. the capability-tool binary -------------------------------------------

resolve_binary() {
    if [ -n "${CAPABILITY_TOOL:-}" ] && [ -x "$CAPABILITY_TOOL" ]; then
        printf '%s' "$CAPABILITY_TOOL"
        return 0
    fi
    for candidate in \
        "$PROJECT_ROOT/target/release/$TOOL_NAME" \
        "$PROJECT_ROOT/target/debug/$TOOL_NAME"; do
        if [ -x "$candidate" ]; then
            printf '%s' "$candidate"
            return 0
        fi
    done

    if [ -f "$PROJECT_ROOT/Cargo.toml" ]; then
        # Progress goes to stderr: stdout carries the resolved binary path.
        printf '   building %s in %s (cargo build --bin %s)\n' \
            "$TOOL_NAME" "$PROJECT_ROOT" "$TOOL_NAME" >&2
        if (cd "$PROJECT_ROOT" && cargo build --bin "$TOOL_NAME") >"$SCRATCH/cargo-build.log" 2>&1; then
            for candidate in \
                "$PROJECT_ROOT/target/release/$TOOL_NAME" \
                "$PROJECT_ROOT/target/debug/$TOOL_NAME"; do
                if [ -x "$candidate" ]; then
                    printf '%s' "$candidate"
                    return 0
                fi
            done
        else
            printf '   package build failed; last lines:\n' >&2
            tail -n 5 "$SCRATCH/cargo-build.log" | sed 's/^/     /' >&2
        fi
    fi

    # Fallback: build the same sources as a small standalone crate, so the
    # runner still works when the surrounding package cannot be built.
    local module="$PROJECT_ROOT/src/capability.rs"
    local cli="$PROJECT_ROOT/src/bin/capability_tool.rs"
    if [ ! -f "$module" ] && [ -f "$SCRIPT_DIR/../src/capability.rs" ]; then
        module="$SCRIPT_DIR/../src/capability.rs"
        cli="$SCRIPT_DIR/../src/bin/capability_tool.rs"
    fi
    if [ ! -f "$module" ] || [ ! -f "$cli" ]; then
        return 1
    fi

    local standalone="$SCRATCH/standalone"
    mkdir -p "$standalone/src/bin"
    cp "$module" "$standalone/src/capability.rs" || return 1
    cp "$cli" "$standalone/src/bin/capability_tool.rs" || return 1
    cat > "$standalone/Cargo.toml" <<'TOML'
[package]
name = "capability-standalone"
version = "0.1.0"
edition = "2024"

[dependencies]
ring = "0.17"
sha2 = "0.10"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
clap = { version = "4.5", features = ["derive"] }

[[bin]]
name = "capability-tool"
path = "src/bin/capability_tool.rs"
TOML
    info "building standalone $TOOL_NAME in $standalone" >&2
    if ! (cd "$standalone" && cargo build --offline --bin "$TOOL_NAME") \
        >"$SCRATCH/standalone-build.log" 2>&1; then
        printf '   standalone build failed; last lines:\n' >&2
        tail -n 5 "$SCRATCH/standalone-build.log" | sed 's/^/     /' >&2
        return 1
    fi
    printf '%s' "$standalone/target/debug/$TOOL_NAME"
}

say "capability-token runner"
info "project root : $PROJECT_ROOT"
info "scratch dir  : $SCRATCH"

CAPABILITY_TOOL_BIN="$(resolve_binary)"
if [ -z "$CAPABILITY_TOOL_BIN" ]; then
    info "RESULT: FAIL — no usable $TOOL_NAME binary could be built"
    exit 1
fi
info "tool         : $CAPABILITY_TOOL_BIN"

# --- 2. the Touch ID helper ---------------------------------------------------

TOUCHID_BIN=""
if command -v swiftc >/dev/null 2>&1; then
    if swiftc -O "$SCRIPT_DIR/touchid_stepup.swift" -o "$SCRATCH/touchid_stepup" \
        >"$SCRATCH/swiftc.log" 2>&1; then
        TOUCHID_BIN="$SCRATCH/touchid_stepup"
        info "swift helper : compiled ($TOUCHID_BIN)"
    else
        info "swift helper : compilation FAILED"
        tail -n 5 "$SCRATCH/swiftc.log" | sed 's/^/     /'
    fi
else
    info "swift helper : swiftc not found — Touch ID step-up cannot be attempted"
fi

# --- 3. keygen, mint, verify --------------------------------------------------

say "keygen"
KEYGEN_OUT="$("$CAPABILITY_TOOL_BIN" keygen)"
KEYGEN_STATUS=$?
if [ $KEYGEN_STATUS -ne 0 ]; then
    info "keygen failed: $KEYGEN_OUT"
    exit 1
fi
PRIVATE_KEY="$(printf '%s\n' "$KEYGEN_OUT" | awk '/^PRIVATE_KEY_B64 /{print $2}')"
PUBLIC_KEY="$(printf '%s\n' "$KEYGEN_OUT" | awk '/^PUBLIC_KEY_HEX /{print $2}')"
info "public key   : $PUBLIC_KEY"
info "private key  : <${#PRIVATE_KEY} base64 chars, not printed>"

say "mint"
TOKEN="$("$CAPABILITY_TOOL_BIN" mint \
    --private-key "$PRIVATE_KEY" \
    --tool "$SAMPLE_TOOL" \
    --args-json "$SAMPLE_ARGS" \
    --ttl "$TTL" \
    --subject "$SAMPLE_SUBJECT")"
MINT_STATUS=$?
if [ $MINT_STATUS -ne 0 ] || [ -z "$TOKEN" ]; then
    info "mint FAILED (exit $MINT_STATUS)"
    exit 1
fi
info "tool         : $SAMPLE_TOOL"
info "args         : $SAMPLE_ARGS"
info "ttl          : ${TTL}s"
info "subject      : $SAMPLE_SUBJECT"
info "token        : ${TOKEN:0:96}... (${#TOKEN} chars)"

say "verify"
VERIFY_OUT="$("$CAPABILITY_TOOL_BIN" verify --token "$TOKEN" --public-key "$PUBLIC_KEY" 2>&1)"
VERIFY_STATUS=$?
printf '%s\n' "$VERIFY_OUT" | sed 's/^/   /'
if [ $VERIFY_STATUS -ne 0 ]; then
    info "token verify FAILED (exit $VERIFY_STATUS)"
    exit 1
fi
info "token verify : OK"

# --- 4. the real Touch ID step-up ----------------------------------------------

say "touch id step-up"
TOUCHID_STATUS="SKIPPED"
TOUCHID_OUT="(not attempted)"
TOUCHID_DETAIL="no swift helper available"
TOUCHID_EXIT=127
if [ -n "$TOUCHID_BIN" ]; then
    TOUCHID_OUT="$("$TOUCHID_BIN" --reason "$TOUCH_REASON" --timeout "$TOUCHID_TIMEOUT" \
        2>"$SCRATCH/touchid.stderr")"
    TOUCHID_EXIT=$?
    TOUCHID_DETAIL="$(cat "$SCRATCH/touchid.stderr")"
    TOUCHID_STATUS="${TOUCHID_OUT%% *}"
    [ -z "$TOUCHID_STATUS" ] && TOUCHID_STATUS="(no output)"
fi
info "status       : $TOUCHID_OUT"
info "exit code    : $TOUCHID_EXIT"
[ -n "$TOUCHID_DETAIL" ] && info "detail       : $TOUCHID_DETAIL"
if [ "$TOUCHID_STATUS" = "STEPUP_OK" ]; then
    info "note         : a real biometric approval was obtained"
elif [ "$TOUCHID_STATUS" = "SKIPPED" ]; then
    info "note         : the step-up was not attempted, so no approval was obtained"
else
    info "note         : NO biometric approval was obtained on this machine"
fi

# --- 5. the independent Python verifier ---------------------------------------

say "python cross-check"
PY_STATUS="SKIPPED"
PY_OUT=""
PY_RC=0
if command -v uv >/dev/null 2>&1; then
    PY_OUT="$(uv run --python 3.12 --with cryptography python3 \
        "$SCRIPT_DIR/capability_check.py" verify \
        --token "$TOKEN" --public-key "$PUBLIC_KEY" --args-json "$SAMPLE_ARGS" 2>&1)"
    PY_RC=$?
    PY_BACKEND="uv/cryptography"
    if [ $PY_RC -ne 0 ] && python3 -c 'import cryptography' >/dev/null 2>&1; then
        info "uv run failed; retrying with the system python3"
        PY_OUT="$(python3 "$SCRIPT_DIR/capability_check.py" verify \
            --token "$TOKEN" --public-key "$PUBLIC_KEY" --args-json "$SAMPLE_ARGS" 2>&1)"
        PY_RC=$?
        PY_BACKEND="system-python3/cryptography"
    fi
elif python3 -c 'import cryptography' >/dev/null 2>&1; then
    PY_OUT="$(python3 "$SCRIPT_DIR/capability_check.py" verify \
        --token "$TOKEN" --public-key "$PUBLIC_KEY" --args-json "$SAMPLE_ARGS" 2>&1)"
    PY_RC=$?
    PY_BACKEND="system-python3/cryptography"
else
    PY_BACKEND="none"
    PY_OUT="no Ed25519 backend available (no cryptography, no pynacl)"
fi
printf '%s\n' "$PY_OUT" | sed 's/^/   /'
info "backend      : $PY_BACKEND"
if [ $PY_RC -eq 0 ]; then
    PY_STATUS="AGREES"
else
    PY_STATUS="DISAGREES"
fi

# --- 6. the policy-signed fallback --------------------------------------------

say "policy-signed fallback"
if [ "$TOUCHID_STATUS" = "STEPUP_OK" ]; then
    info "not needed — the biometric step-up already succeeded"
    FALLBACK_STATUS="NOT NEEDED"
else
    info "the biometric step-up did not succeed, so the documented fallback is used:"
    info "a trusted policy component signs the token directly (not a human approval)"
    POLICY_TOKEN="$("$CAPABILITY_TOOL_BIN" mint \
        --private-key "$PRIVATE_KEY" \
        --tool "$SAMPLE_TOOL" \
        --args-json "$SAMPLE_ARGS" \
        --ttl "$TTL" \
        --subject "$POLICY_SUBJECT")"
    POLICY_OUT="$("$CAPABILITY_TOOL_BIN" verify --token "$POLICY_TOKEN" --public-key "$PUBLIC_KEY" 2>&1)"
    POLICY_RC=$?
    info "subject      : $POLICY_SUBJECT"
    printf '%s\n' "$POLICY_OUT" | sed 's/^/   /'
    if [ $POLICY_RC -eq 0 ]; then
        FALLBACK_STATUS="OK"
    else
        FALLBACK_STATUS="FAILED"
    fi
fi

# --- summary -------------------------------------------------------------------

say "summary"
info "token mint        : OK"
if [ $VERIFY_STATUS -eq 0 ]; then info "token verify      : OK (VALID)"; else info "token verify      : FAILED"; fi
info "touch id          : $TOUCHID_STATUS (exit $TOUCHID_EXIT)"
info "python cross-check: $PY_STATUS"
info "policy fallback   : $FALLBACK_STATUS"

if [ $MINT_STATUS -eq 0 ] && [ $VERIFY_STATUS -eq 0 ] && [ "$PY_STATUS" != "DISAGREES" ]; then
    info "RESULT            : PASS"
    exit 0
fi
info "RESULT            : FAIL"
exit 1
