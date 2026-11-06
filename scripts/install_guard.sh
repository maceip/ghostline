#!/usr/bin/env bash
#
# install_guard.sh — install and run the MLX tool-call safety guard on a
# fresh Apple Silicon Mac.
#
#   curl -fsSL https://raw.githubusercontent.com/maceip/zune-code/main/scripts/install_guard.sh | bash
#
#   bash scripts/install_guard.sh --dir "$HOME/zune-code" --port 8090
#   bash scripts/install_guard.sh --dry-run
#
# WHAT IT DOES, IN ORDER
# -----------------------
#   1. Checks that this is macOS on arm64.  The guard runs on Metal through
#      mlx-rs: it does NOT work on Intel Macs and does NOT work on Linux,
#      and it should say so here rather than deep inside the build.
#   2. Installs cargo (via rustup into $HOME/.cargo) and uv (into
#      $HOME/.local/bin) if they are missing, and re-PATHs them in this
#      script so the rest of the run works.
#   3. Clones the repository, or fast-forwards an existing clone with
#      `git pull --ff-only`.  A directory that exists but is NOT a git
#      repository is refused, never clobbered.
#   4. Builds the guard: cargo build --release inside qwen-clef-repe-guard/.
#   5. Downloads Qwen2.5-0.5B-Instruct into a stable cache so a second run
#      never re-downloads it.
#   6. Writes a bearer token to ~/.config/zcode/guard.token (mode 0600).
#   7. Installs two launchd agents under ~/Library/LaunchAgents:
#      com.zcode.upstream (the mlx_lm server) and com.zcode.guard.
#   8. Waits for the upstream port and for the guard's /health, and prints
#      the summary.
#
# IT NEVER RUNS sudo AND NEVER WRITES OUTSIDE THE USER'S HOME.
#
# The `curl | bash` form means $0 may be "bash", so nothing here reads a
# file relative to $0 or ${BASH_SOURCE[0]}.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# defaults
# ---------------------------------------------------------------------------
REPO_URL="${ZCODE_REPO_URL:-https://github.com/maceip/zune-code.git}"
ZCODE_DIR="${ZCODE_DIR:-}"
DIR_EXPLICIT=0
GUARD_PORT="${ZCODE_GUARD_PORT:-8090}"
UPSTREAM_PORT="${ZCODE_UPSTREAM_PORT:-8123}"
RATE_LIMIT="${ZCODE_RATE_LIMIT:-60}"
MODE="${ZCODE_GUARD_MODE:-enforce}"
THRESHOLD="${ZCODE_GUARD_THRESHOLD:-0.45}"
MODEL_REPO="Qwen/Qwen2.5-0.5B-Instruct"
REPE_REL="qwen-clef-repe-guard/artifacts/repe_vectors_qwen2_5_0_5b.safetensors"
TOKEN_FILE="${ZCODE_TOKEN_FILE:-$HOME/.config/zcode/guard.token}"
HF_HOME="${ZCODE_HF_HOME:-$HOME/.cache/zcode/huggingface}"
MODEL_DIR_OVERRIDE="${ZCODE_MODEL_DIR:-}"
LOG_DIR="$HOME/Library/Logs/zcode"
LOG_FILE="$LOG_DIR/install.log"

UPSTREAM_LABEL="com.zcode.upstream"
GUARD_LABEL="com.zcode.guard"

DRY_RUN=0
NO_SERVICE=0
GUARD_BIN=""

# ---------------------------------------------------------------------------
# output helpers — colours only when stdout is a terminal
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'
    C_YEL=$'\033[33m'; C_OFF=$'\033[0m'
else
    C_BOLD=''; C_RED=''; C_GRN=''; C_YEL=''; C_OFF=''
fi

log()  { printf '%s==>%s %s\n' "$C_BOLD" "$C_OFF" "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %sok%s   %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%swarning:%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

plan() { printf '    %s[dry-run]%s %s\n' "$C_YEL" "$C_OFF" "$*"; }

# Run a command for real, or describe it when this is a dry run.
run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "$*"
        return 0
    fi
    "$@"
}

logf() {
    if [ -d "$LOG_DIR" ]; then
        printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$LOG_FILE"
    fi
}

usage() {
    cat <<'USAGE'
install_guard.sh — install the MLX tool-call safety guard on macOS/arm64.

  --dir <path>          install root (default $ZCODE_DIR, else $HOME/zune-code)
  --port <n>            the guard's port (default 8090)
  --upstream-port <n>   the mlx_lm server's port (default 8123)
  --rate-limit <n>      requests per minute per client IP (0 = unlimited)
  --mode <enforce|monitor>   the guard's mode (default enforce)
  --threshold <f>       the harm-cosine threshold (default 0.45)
  --model-dir <path>    use an existing model snapshot instead of downloading
  --no-service          build and install, but do not install launchd agents
  --dry-run             print the plan and touch nothing
  -h, --help            this text
USAGE
}

# ---------------------------------------------------------------------------
# arguments
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --dir)            ZCODE_DIR="${2:-}"; DIR_EXPLICIT=1; shift 2 ;;
        --dir=*)          ZCODE_DIR="${1#*=}"; DIR_EXPLICIT=1; shift ;;
        --port)           GUARD_PORT="${2:-}"; shift 2 ;;
        --port=*)         GUARD_PORT="${1#*=}"; shift ;;
        --upstream-port)  UPSTREAM_PORT="${2:-}"; shift 2 ;;
        --upstream-port=*) UPSTREAM_PORT="${1#*=}"; shift ;;
        --rate-limit)     RATE_LIMIT="${2:-}"; shift 2 ;;
        --rate-limit=*)   RATE_LIMIT="${1#*=}"; shift ;;
        --mode)           MODE="${2:-}"; shift 2 ;;
        --mode=*)         MODE="${1#*=}"; shift ;;
        --threshold)      THRESHOLD="${2:-}"; shift 2 ;;
        --threshold=*)    THRESHOLD="${1#*=}"; shift ;;
        --model-dir)      MODEL_DIR_OVERRIDE="${2:-}"; shift 2 ;;
        --model-dir=*)    MODEL_DIR_OVERRIDE="${1#*=}"; shift ;;
        --no-service)     NO_SERVICE=1; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        -h|--help)        usage; exit 0 ;;
        *)                printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done

case "$GUARD_PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac
case "$UPSTREAM_PORT" in ''|*[!0-9]*) die "--upstream-port must be a number" ;; esac
case "$RATE_LIMIT" in ''|*[!0-9]*) die "--rate-limit must be a number (0 = unlimited)" ;; esac
case "$MODE" in enforce|monitor) ;; *) die "--mode must be enforce or monitor" ;; esac

if [ "$DIR_EXPLICIT" -eq 0 ] && [ -z "$ZCODE_DIR" ]; then
    # Standing inside a checkout?  Use it instead of cloning a second copy.
    if [ -d "$PWD/.git" ] && [ -f "$PWD/qwen-clef-repe-guard/Cargo.toml" ]; then
        ZCODE_DIR="$PWD"
    else
        ZCODE_DIR="$HOME/zune-code"
    fi
fi
if [ -z "$ZCODE_DIR" ]; then
    die "no install directory: pass --dir or set ZCODE_DIR"
fi

# ---------------------------------------------------------------------------
# 1. the platform gate
# ---------------------------------------------------------------------------
log "1. platform"
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ]; then
    die "this guard runs on macOS only (this machine reports $OS).
       It uses mlx-rs for Metal; there is no Linux or Windows build.
       Run it on an Apple Silicon Mac."
fi
if [ "$ARCH" != "arm64" ]; then
    die "this guard needs Apple Silicon (arm64) with Metal, and this machine reports $ARCH.
       Intel Macs cannot run it, and a Rosetta x86_64 shell cannot either.
       Check with: uname -m   (it must print arm64)"
fi
info "macOS on arm64 — Metal is available"
info "model  $(sysctl -n hw.model 2>/dev/null || echo unknown)"
info "macOS  $(sw_vers -productVersion 2>/dev/null || echo unknown)"

# ---------------------------------------------------------------------------
# 2. dependencies
# ---------------------------------------------------------------------------
need_network() {
    # $1 = url to probe, $2 = what it is for
    if ! curl -fsS --max-time 15 -o /dev/null "$1"; then
        die "cannot reach $1 — $2 needs network access.
       Check the connection and the proxy settings, then run this script again."
    fi
}

ensure_cargo() {
    if command -v cargo >/dev/null 2>&1; then
        ok "cargo  $(command -v cargo)"
        return 0
    fi
    if [ -x "$HOME/.cargo/bin/cargo" ]; then
        export PATH="$HOME/.cargo/bin:$PATH"
        ok "cargo  $HOME/.cargo/bin/cargo"
        return 0
    fi
    log "installing cargo (rustup) into $HOME/.cargo"
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal"
        return 0
    fi
    need_network "https://sh.rustup.rs" "the rustup installer"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --profile minimal >>"$LOG_FILE" 2>&1 \
        || die "rustup failed — see $LOG_FILE"
    export PATH="$HOME/.cargo/bin:$PATH"
    command -v cargo >/dev/null 2>&1 || die "rustup installed but cargo is still not on PATH"
    ok "cargo  $(command -v cargo)"
}

ensure_uv() {
    if command -v uv >/dev/null 2>&1; then
        ok "uv     $(command -v uv)"
        return 0
    fi
    if [ -x "$HOME/.local/bin/uv" ]; then
        export PATH="$HOME/.local/bin:$PATH"
        ok "uv     $HOME/.local/bin/uv"
        return 0
    fi
    log "installing uv into $HOME/.local/bin"
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "curl -LsSf https://astral.sh/uv/install.sh | sh   (UV_INSTALL_DIR=$HOME/.local/bin)"
        return 0
    fi
    need_network "https://astral.sh/uv/install.sh" "the uv installer"
    UV_INSTALL_DIR="$HOME/.local/bin" \
        curl -LsSf https://astral.sh/uv/install.sh \
        | sh >>"$LOG_FILE" 2>&1 \
        || die "the uv installer failed — see $LOG_FILE"
    export PATH="$HOME/.local/bin:$PATH"
    [ -x "$HOME/.local/bin/uv" ] || die "uv was installed but $HOME/.local/bin/uv is not there"
    ok "uv     $HOME/.local/bin/uv"
}

log "2. dependencies"
if [ "$DRY_RUN" -eq 0 ]; then
    mkdir -p "$LOG_DIR"
fi
ensure_cargo
ensure_uv
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export HF_HOME

# ---------------------------------------------------------------------------
# 3. the repository
# ---------------------------------------------------------------------------
log "3. repository"
if [ -e "$ZCODE_DIR" ] && [ ! -d "$ZCODE_DIR/.git" ]; then
    die "$ZCODE_DIR already exists and is not a git repository.
       Refusing to overwrite it.  Move it aside, or pass --dir with a different path."
fi
if [ -d "$ZCODE_DIR/.git" ]; then
    info "existing clone at $ZCODE_DIR"
    run git -C "$ZCODE_DIR" pull --ff-only
else
    info "cloning $REPO_URL into $ZCODE_DIR"
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "git clone $REPO_URL $ZCODE_DIR"
    else
        git clone "$REPO_URL" "$ZCODE_DIR" >>"$LOG_FILE" 2>&1 \
            || die "the clone failed — see $LOG_FILE"
    fi
fi
[ -f "$ZCODE_DIR/qwen-clef-repe-guard/Cargo.toml" ] \
    || die "$ZCODE_DIR does not contain qwen-clef-repe-guard/ — is this the right repository?"
REPE_PATH="$ZCODE_DIR/$REPE_REL"
[ -f "$REPE_PATH" ] \
    || die "the calibrated RepE vectors are missing: $REPE_PATH"

# ---------------------------------------------------------------------------
# 4. the model
# ---------------------------------------------------------------------------
cached_snapshot_dir() {
    local snapshots="$HF_HOME/hub/models--Qwen--Qwen2.5-0.5B-Instruct/snapshots"
    local newest
    [ -d "$snapshots" ] || return 1
    # The newest snapshot directory, by modification time.  find + stat
    # instead of ls, so a path with an unusual name cannot confuse it.
    newest="$(find "$snapshots" -mindepth 1 -maxdepth 1 -type d \
        -exec stat -f '%m %N' {} + 2>/dev/null \
        | sort -rn | head -n 1 | cut -d' ' -f2-)"
    [ -n "$newest" ] || return 1
    [ -d "$newest" ] || return 1
    printf '%s\n' "$newest"
}

download_model() {
    local out
    if ! out="$(uv run --python 3.12 --with huggingface_hub python \
            -c 'from huggingface_hub import snapshot_download; print(snapshot_download("Qwen/Qwen2.5-0.5B-Instruct"))' \
            2>>"$LOG_FILE")"; then
        printf '%s\n' "$out" >&2
        return 1
    fi
    printf '%s\n' "$out" | tail -n 1
}

log "4. model"
MODEL_DIR=""
if [ -n "$MODEL_DIR_OVERRIDE" ]; then
    [ -d "$MODEL_DIR_OVERRIDE" ] \
        || die "--model-dir points at $MODEL_DIR_OVERRIDE, which is not a directory"
    MODEL_DIR="$MODEL_DIR_OVERRIDE"
    ok "using the model at $MODEL_DIR"
elif cached="$(cached_snapshot_dir)"; then
    MODEL_DIR="$cached"
    ok "using the cached model at $MODEL_DIR"
elif [ "$DRY_RUN" -eq 1 ]; then
    MODEL_DIR="$HF_HOME/hub/models--Qwen--Qwen2.5-0.5B-Instruct/snapshots/<revision>"
    plan "download $MODEL_REPO (~1 GB) into $HF_HOME with uv + huggingface_hub"
else
    info "downloading $MODEL_REPO (~1 GB) into $HF_HOME — this takes a while"
    need_network "https://huggingface.co" "the model download"
    MODEL_DIR="$(download_model)" || die "the model download failed — see $LOG_FILE"
    [ -d "$MODEL_DIR" ] || die "the download reported $MODEL_DIR, which is not a directory"
    ok "model  $MODEL_DIR"
fi

# ---------------------------------------------------------------------------
# 5. the token
# ---------------------------------------------------------------------------
log "5. bearer token"
if [ -s "$TOKEN_FILE" ]; then
    ok "reusing $TOKEN_FILE"
else
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "openssl rand -hex 32 > $TOKEN_FILE (mode 0600)"
    else
        mkdir -p "$(dirname "$TOKEN_FILE")"
        ( umask 077; openssl rand -hex 32 > "$TOKEN_FILE" ) \
            || die "could not write $TOKEN_FILE"
        chmod 0600 "$TOKEN_FILE"
        ok "wrote a new token to $TOKEN_FILE (mode 0600)"
    fi
fi

# ---------------------------------------------------------------------------
# 6. the build
# ---------------------------------------------------------------------------
log "6. build"
if [ "$DRY_RUN" -eq 1 ]; then
    plan "cd $ZCODE_DIR/qwen-clef-repe-guard && cargo build --release"
else
    info "cargo build --release (the first build takes several minutes)"
    ( cd "$ZCODE_DIR/qwen-clef-repe-guard" && cargo build --release ) >>"$LOG_FILE" 2>&1 || {
        tail -n 30 "$LOG_FILE" >&2 || true
        die "the build failed — see $LOG_FILE"
    }
    GUARD_BIN="$ZCODE_DIR/qwen-clef-repe-guard/target/release/qwen-clef-repe-guard"
    [ -x "$GUARD_BIN" ] || die "the build finished but $GUARD_BIN is not there"
    ok "$GUARD_BIN"
fi

# ---------------------------------------------------------------------------
# 7. the launchd agents
# ---------------------------------------------------------------------------
xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

write_upstream_plist() {
    local plist="$1" uv_bin="$2" model_dir="$3" workdir="$4"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${UPSTREAM_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_escape "$uv_bin")</string>
		<string>run</string>
		<string>--python</string>
		<string>3.12</string>
		<string>--with</string>
		<string>mlx-lm</string>
		<string>mlx_lm.server</string>
		<string>--model</string>
		<string>$(xml_escape "$model_dir")</string>
		<string>--host</string>
		<string>127.0.0.1</string>
		<string>--port</string>
		<string>${UPSTREAM_PORT}</string>
		<string>--temp</string>
		<string>0.0</string>
		<string>--max-tokens</string>
		<string>128</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml_escape "$workdir")</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG_DIR/upstream.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG_DIR/upstream.err.log")</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$(xml_escape "$HOME")</string>
		<key>HF_HOME</key>
		<string>$(xml_escape "$HF_HOME")</string>
		<key>PATH</key>
		<string>$(xml_escape "${PATH}")</string>
	</dict>
</dict>
</plist>
PLIST
}

write_guard_plist() {
    local plist="$1" binary="$2" model_dir="$3" workdir="$4" token_file="$5"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${GUARD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_escape "$binary")</string>
		<string>--host</string>
		<string>127.0.0.1</string>
		<string>--port</string>
		<string>${GUARD_PORT}</string>
		<string>--upstream</string>
		<string>http://127.0.0.1:${UPSTREAM_PORT}</string>
		<string>--model</string>
		<string>$(xml_escape "$model_dir")</string>
		<string>--repe</string>
		<string>$(xml_escape "$REPE_PATH")</string>
		<string>--mode</string>
		<string>${MODE}</string>
		<string>--threshold</string>
		<string>${THRESHOLD}</string>
		<string>--auth-token-file</string>
		<string>$(xml_escape "$token_file")</string>
		<string>--rate-limit-rpm</string>
		<string>${RATE_LIMIT}</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml_escape "$workdir")</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG_DIR/guard.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG_DIR/guard.err.log")</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$(xml_escape "$HOME")</string>
		<key>RUST_LOG</key>
		<string>info</string>
		<key>ZCODE_GUARD_TOKEN_FILE</key>
		<string>$(xml_escape "$token_file")</string>
		<key>ZCODE_GUARD_RATE_LIMIT_RPM</key>
		<string>${RATE_LIMIT}</string>
	</dict>
</dict>
</plist>
PLIST
}

UID_NUM="$(id -u)"

bootout_agent() {
    launchctl bootout "gui/$UID_NUM/$1" >/dev/null 2>&1 || true
}

log "7. launchd agents"
AGENTS_DIR="$HOME/Library/LaunchAgents"
UPSTREAM_PLIST="$AGENTS_DIR/$UPSTREAM_LABEL.plist"
GUARD_PLIST="$AGENTS_DIR/$GUARD_LABEL.plist"
UV_BIN="$(command -v uv || printf '%s' "$HOME/.local/bin/uv")"

if [ "$NO_SERVICE" -eq 1 ]; then
    info "--no-service: not installing the launchd agents"
else
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "write $UPSTREAM_PLIST  (mlx_lm.server on 127.0.0.1:$UPSTREAM_PORT)"
        plan "write $GUARD_PLIST     (the guard on 127.0.0.1:$GUARD_PORT, token file $TOKEN_FILE)"
        plan "launchctl bootout gui/$UID_NUM/$UPSTREAM_LABEL ; launchctl bootstrap gui/$UID_NUM $UPSTREAM_PLIST ; launchctl kickstart -k gui/$UID_NUM/$UPSTREAM_LABEL"
        plan "launchctl bootout gui/$UID_NUM/$GUARD_LABEL    ; launchctl bootstrap gui/$UID_NUM $GUARD_PLIST    ; launchctl kickstart -k gui/$UID_NUM/$GUARD_LABEL"
    else
        mkdir -p "$AGENTS_DIR"
        write_upstream_plist "$UPSTREAM_PLIST" "$UV_BIN" "$MODEL_DIR" "$ZCODE_DIR"
        write_guard_plist "$GUARD_PLIST" "$GUARD_BIN" "$MODEL_DIR" "$ZCODE_DIR" "$TOKEN_FILE"

        # bootout first so a second run replaces the agent instead of
        # failing with "service already loaded".
        bootout_agent "$UPSTREAM_LABEL"
        bootout_agent "$GUARD_LABEL"
        launchctl bootstrap "gui/$UID_NUM" "$UPSTREAM_PLIST" \
            || die "launchctl bootstrap failed for $UPSTREAM_LABEL"
        launchctl bootstrap "gui/$UID_NUM" "$GUARD_PLIST" \
            || die "launchctl bootstrap failed for $GUARD_LABEL"
        launchctl enable "gui/$UID_NUM/$UPSTREAM_LABEL" >/dev/null 2>&1 || true
        launchctl enable "gui/$UID_NUM/$GUARD_LABEL" >/dev/null 2>&1 || true
        launchctl kickstart -k "gui/$UID_NUM/$UPSTREAM_LABEL"
        launchctl kickstart -k "gui/$UID_NUM/$GUARD_LABEL"
        ok "$UPSTREAM_LABEL and $GUARD_LABEL are loaded"
    fi
fi

# ---------------------------------------------------------------------------
# 8. wait for the two services
# ---------------------------------------------------------------------------
wait_for_tcp() {
    local port="$1" timeout="$2" waited=0
    while [ "$waited" -lt "$timeout" ]; do
        if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    return 1
}

wait_for_health() {
    local url="$1" timeout="$2" waited=0
    while [ "$waited" -lt "$timeout" ]; do
        if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    return 1
}

log "8. health"
if [ "$DRY_RUN" -eq 1 ]; then
    plan "wait for 127.0.0.1:$UPSTREAM_PORT to accept a connection"
    plan "wait for http://127.0.0.1:$GUARD_PORT/health to answer"
else
    if ! wait_for_tcp "$UPSTREAM_PORT" 180; then
        tail -n 40 "$LOG_DIR/upstream.err.log" >&2 2>/dev/null || true
        die "the upstream mlx_lm.server never opened port $UPSTREAM_PORT — see $LOG_DIR/upstream.err.log"
    fi
    ok "upstream is listening on 127.0.0.1:$UPSTREAM_PORT"

    if ! wait_for_health "http://127.0.0.1:$GUARD_PORT/health" 90; then
        tail -n 40 "$LOG_DIR/guard.err.log" >&2 2>/dev/null || true
        die "the guard never answered /health — see $LOG_DIR/guard.err.log"
    fi
    ok "the guard answers http://127.0.0.1:$GUARD_PORT/health"
fi

# ---------------------------------------------------------------------------
# 9. the summary
# ---------------------------------------------------------------------------
log "9. summary"
cat <<SUMMARY
    guard dashboard   http://127.0.0.1:${GUARD_PORT}/
    guard API         http://127.0.0.1:${GUARD_PORT}/api/info
    tool-call probe   POST http://127.0.0.1:${GUARD_PORT}/v1/guard/tool-call
    health            http://127.0.0.1:${GUARD_PORT}/health
    upstream model    http://127.0.0.1:${UPSTREAM_PORT}
    token             ${TOKEN_FILE}      (mode 0600)
    model             ${MODEL_DIR}
    binary            ${GUARD_BIN:-$ZCODE_DIR/qwen-clef-repe-guard/target/release/qwen-clef-repe-guard}
    install root      ${ZCODE_DIR}
    logs              ${LOG_DIR}/guard.log, ${LOG_DIR}/guard.err.log,
                      ${LOG_DIR}/upstream.log, ${LOG_DIR}/upstream.err.log

    start             launchctl kickstart -k gui/${UID_NUM}/${GUARD_LABEL}
    stop              launchctl bootout gui/${UID_NUM}/${GUARD_LABEL}
    upstream start    launchctl kickstart -k gui/${UID_NUM}/${UPSTREAM_LABEL}
    upstream stop     launchctl bootout gui/${UID_NUM}/${UPSTREAM_LABEL}

    the demo site talks to the guard on the same origin; to serve it locally:
      python3 ${ZCODE_DIR}/clef-site/tools/serve.py --port 8412 --guard http://127.0.0.1:${GUARD_PORT}

    the token is required on every route except /health:
      curl -H "Authorization: Bearer \$(cat ${TOKEN_FILE})" http://127.0.0.1:${GUARD_PORT}/api/info
SUMMARY
