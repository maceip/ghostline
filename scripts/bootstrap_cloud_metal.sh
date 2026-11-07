#!/usr/bin/env bash
#
# bootstrap_cloud_metal.sh — provision a cloud macOS box (EC2 Mac, MacStadium,
# any dedicated Metal Mac) to run the MLX tool-call guard behind Caddy.
#
#   sudo -u "$USER" bash scripts/bootstrap_cloud_metal.sh \
#       --domain clef.example.com --email ops@example.com
#
#   bash scripts/bootstrap_cloud_metal.sh --dry-run
#
# WHAT IT DOES, IN ORDER
# -----------------------
#   1. Identifies the machine (hw.model, architecture, EC2 instance metadata)
#      and refuses to continue on anything that is not an Apple Silicon Mac
#      with Metal.
#   2. Makes sure Homebrew, Go, xcaddy, uv and cargo are present.
#   3. Creates the service account and the /opt/zcode layout.
#   4. Clones the repository, builds the guard, downloads the model, writes
#      the bearer token.
#   5. Copies the static site to /opt/zcode/site.
#   6. BUILDS CADDY WITH THE RATE-LIMIT MODULE into /opt/zcode/bin/caddy.
#      The shipped Caddyfile uses the `rate_limit` directive, which stock
#      Caddy does not have — a config with it on a stock binary is a PARSE
#      ERROR, so the box would refuse to start rather than serve an
#      unprotected site.  This script builds the right binary so you never
#      hit that.
#   7. Writes deploy/Caddyfile to /opt/zcode/caddy/Caddyfile and materialises
#      the environment into /opt/zcode/caddy/caddy.env.
#   8. VALIDATES the Caddy config with `caddy validate` and only then loads
#      it — a broken config never reaches the running server.
#   9. Installs three launchd daemons (system-wide, so they survive a
#      reboot): com.zcode.upstream, com.zcode.guard, com.zcode.caddy.
#  10. Waits for the upstream and the guard, then prints the DNS/TLS steps
#      the operator still has to do.
#
# THE RATE LIMIT IS NOT OPTIONAL HERE
# -----------------------------------
#   The public deployment must rate limit at Caddy, keyed by client IP.
#   `rate_limit` is a community module (github.com/mholt/caddy-ratelimit)
#   that has to be compiled in with xcaddy, so this script installs Go and
#   xcaddy and builds the binary itself.  The zone lives in deploy/Caddyfile
#   and the limits are tunable in caddy.env — see deploy/README.md,
#   "Rate limiting belongs at THIS layer, keyed by IP".
#
# sudo IS USED — and only for the things that genuinely need it: the
# /opt/zcode tree, the /Library/LaunchDaemons plists, the service account,
# and the launchctl calls that manage system daemons.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# defaults
# ---------------------------------------------------------------------------
REPO_URL="${ZCODE_REPO_URL:-https://github.com/maceip/zune-code.git}"
OPT_ROOT="${ZCODE_OPT_ROOT:-/opt/zcode}"
INSTALL_DIR="${ZCODE_DIR:-$OPT_ROOT/zune-code}"
SITE_ROOT="${ZCODE_SITE_ROOT:-$OPT_ROOT/site}"
CADDY_DIR="${ZCODE_CADDY_DIR:-$OPT_ROOT/caddy}"
TOKEN_FILE="${ZCODE_TOKEN_FILE:-$OPT_ROOT/guard.token}"
SESSION_SECRET_FILE="${ZCODE_SESSION_SECRET_FILE:-$OPT_ROOT/session.secret}"
MODEL_ROOT="${ZCODE_MODEL_ROOT:-$OPT_ROOT/models}"
SERVICE_HOME="$OPT_ROOT/home"
LOG_DIR="/var/log/zcode"
LAUNCHD_DIR="/Library/LaunchDaemons"
ACME_STORAGE="/var/lib/caddy"

CLEF_DOMAIN="${ZCODE_DOMAIN:-}"
ACME_EMAIL="${ZCODE_ACME_EMAIL:-}"
GUARD_PORT="${ZCODE_GUARD_PORT:-8090}"
UPSTREAM_PORT="${ZCODE_UPSTREAM_PORT:-8123}"
# The generation model server.  This is a SECOND, larger model: the guard
# READS activations with the small model on UPSTREAM_PORT, while the site's
# glass room has a 4B model WRITE code, token by token.  It is a separate
# process with its own port, its own model and its own launchd label.
GEN_PORT="${ZCODE_GEN_PORT:-8080}"
RATE_LIMIT="${ZCODE_RATE_LIMIT:-30}"
# The edge rate limit, in caddy.env.  /v1/* is the expensive path (it runs
# the model); /api/* is JSON and the event stream; /gen/* is the most
# expensive of all (a 4B model writing code), so it gets the tightest
# budget — one per client IP and one shared by everybody.  The static site
# and /health are in no zone at all, so a visitor is never throttled for
# loading a page and the liveness probe is never throttled.
RL_TOOL_CALL_EVENTS="${ZCODE_RL_TOOL_CALL_EVENTS:-10}"
RL_TOOL_CALL_WINDOW="${ZCODE_RL_TOOL_CALL_WINDOW:-1m}"
RL_API_EVENTS="${ZCODE_RL_API_EVENTS:-60}"
RL_API_WINDOW="${ZCODE_RL_API_WINDOW:-1m}"
RL_GEN_EVENTS="${ZCODE_RL_GEN_EVENTS:-6}"
RL_GEN_WINDOW="${ZCODE_RL_GEN_WINDOW:-1m}"
RL_GEN_GLOBAL_EVENTS="${ZCODE_RL_GEN_GLOBAL_EVENTS:-20}"
RL_GEN_GLOBAL_WINDOW="${ZCODE_RL_GEN_GLOBAL_WINDOW:-1m}"
MODE="${ZCODE_GUARD_MODE:-enforce}"
THRESHOLD="${ZCODE_GUARD_THRESHOLD:-0.45}"
MODEL_REPO="Qwen/Qwen2.5-0.5B-Instruct"
# The generation model.  A 4-bit 4B instruct model: small enough to sit
# next to the guard on a 24 GiB Mac, big enough to write a plausible patch.
GEN_MODEL_REPO="${ZCODE_GEN_MODEL_REPO:-mlx-community/Qwen3-4B-Instruct-2507-4bit}"
REPE_REL="qwen-clef-repe-guard/artifacts/repe_vectors_qwen2_5_0_5b.safetensors"
SERVICE_USER="${ZCODE_SERVICE_USER:-zcode}"
SERVICE_UID="${ZCODE_SERVICE_UID:-505}"
MODEL_DIR_OVERRIDE="${ZCODE_MODEL_DIR:-}"
GEN_MODEL_DIR_OVERRIDE="${ZCODE_GEN_MODEL_DIR:-}"
GEN_ENABLED="${ZCODE_GEN_SERVER:-1}"
CADDYFILE_SRC=""

UPSTREAM_LABEL="com.zcode.upstream"
GEN_LABEL="com.zcode.gen"
GUARD_LABEL="com.zcode.guard"
CADDY_LABEL="com.zcode.caddy"

DRY_RUN=0
GUARD_BIN=""
HF_HOME="$MODEL_ROOT/hf"
CURRENT_USER="$(id -un)"
CURRENT_GROUP="$(id -gn)"

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

usage() {
    cat <<'USAGE'
bootstrap_cloud_metal.sh — provision a cloud macOS box for the MLX guard.

  --domain <name>      the public hostname Caddy serves (required)
  --email <address>    the ACME contact address (required)
  --port <n>           the guard's port (default 8090)
  --upstream-port <n>  the mlx_lm server's port (default 8123)
  --gen-port <n>       the generation model server's port (default 8080)
  --no-gen-server      do not install the generation model server; the site's
                       glass room then says the model is unavailable
  --gen-model-dir <path>  use an existing generation model snapshot
  --rate-limit <n>     requests per minute per client IP (0 = unlimited)
  --mode <enforce|monitor>  the guard's mode (default enforce)
  --threshold <f>      the harm-cosine threshold (default 0.45)
  --service-user <name>    the service account (default zcode)
  --model-dir <path>   use an existing model snapshot instead of downloading
  --dry-run            print the plan and touch nothing
  -h, --help           this text
USAGE
}

# Run a command as root, whether or not this script is already running as
# root.  Every use of it is printed, so the operator can see where the
# privilege boundary is.
as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

# ---------------------------------------------------------------------------
# arguments
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --domain)        CLEF_DOMAIN="${2:-}"; shift 2 ;;
        --domain=*)      CLEF_DOMAIN="${1#*=}"; shift ;;
        --email)         ACME_EMAIL="${2:-}"; shift 2 ;;
        --email=*)       ACME_EMAIL="${1#*=}"; shift ;;
        --port)          GUARD_PORT="${2:-}"; shift 2 ;;
        --port=*)        GUARD_PORT="${1#*=}"; shift ;;
        --upstream-port) UPSTREAM_PORT="${2:-}"; shift 2 ;;
        --upstream-port=*) UPSTREAM_PORT="${1#*=}"; shift ;;
        --gen-port)      GEN_PORT="${2:-}"; shift 2 ;;
        --gen-port=*)    GEN_PORT="${1#*=}"; shift ;;
        --no-gen-server) GEN_ENABLED=0; shift ;;
        --gen-model-dir) GEN_MODEL_DIR_OVERRIDE="${2:-}"; shift 2 ;;
        --gen-model-dir=*) GEN_MODEL_DIR_OVERRIDE="${1#*=}"; shift ;;
        --rate-limit)    RATE_LIMIT="${2:-}"; shift 2 ;;
        --rate-limit=*)  RATE_LIMIT="${1#*=}"; shift ;;
        --mode)          MODE="${2:-}"; shift 2 ;;
        --mode=*)        MODE="${1#*=}"; shift ;;
        --threshold)     THRESHOLD="${2:-}"; shift 2 ;;
        --threshold=*)   THRESHOLD="${1#*=}"; shift ;;
        --service-user)  SERVICE_USER="${2:-}"; shift 2 ;;
        --service-user=*) SERVICE_USER="${1#*=}"; shift ;;
        --model-dir)     MODEL_DIR_OVERRIDE="${2:-}"; shift 2 ;;
        --model-dir=*)   MODEL_DIR_OVERRIDE="${1#*=}"; shift ;;
        --dry-run)       DRY_RUN=1; shift ;;
        -h|--help)       usage; exit 0 ;;
        *)               printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done

case "$GUARD_PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac
case "$UPSTREAM_PORT" in ''|*[!0-9]*) die "--upstream-port must be a number" ;; esac
case "$GEN_PORT" in ''|*[!0-9]*) die "--gen-port must be a number" ;; esac
case "$RATE_LIMIT" in ''|*[!0-9]*) die "--rate-limit must be a number (0 = unlimited)" ;; esac
case "$MODE" in enforce|monitor) ;; *) die "--mode must be enforce or monitor" ;; esac

# The domain and the ACME contact are needed for a real run.  A dry run
# reports them as missing instead of failing, so the operator can see the
# whole plan first.
if [ -z "$CLEF_DOMAIN" ]; then
    if [ "$DRY_RUN" -eq 0 ]; then
        die "--domain is required: the public hostname Caddy will serve, e.g. --domain clef.example.com
       (or set ZCODE_DOMAIN)"
    fi
    DOMAIN_HOST="<your.public.hostname>"
    DOMAIN_REQUIRED=1
else
    DOMAIN_HOST="$CLEF_DOMAIN"
    DOMAIN_REQUIRED=0
fi
if [ -z "$ACME_EMAIL" ]; then
    if [ "$DRY_RUN" -eq 0 ]; then
        die "--email is required: the address Caddy registers with the ACME CA, e.g. --email ops@example.com
       (or set ZCODE_ACME_EMAIL)"
    fi
    EMAIL_HOST="<you@example.com>"
    EMAIL_REQUIRED=1
else
    EMAIL_HOST="$ACME_EMAIL"
    EMAIL_REQUIRED=0
fi

# ---------------------------------------------------------------------------
# 1. the machine
# ---------------------------------------------------------------------------
log "1. machine"
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ]; then
    die "this guard runs on macOS only (this machine reports $OS).  It uses mlx-rs for Metal;
       there is no Linux build.  Provision a macOS Apple Silicon instance."
fi
if [ "$ARCH" != "arm64" ]; then
    die "this guard needs Apple Silicon (arm64) with Metal, and this machine reports $ARCH.
       Intel Macs cannot run it.  Check with: uname -m   (it must print arm64)"
fi
HW_MODEL="$(sysctl -n hw.model 2>/dev/null || echo unknown)"
if [ "$HW_MODEL" != "unknown" ] && [ "${HW_MODEL#Mac}" = "$HW_MODEL" ]; then
    die "this machine reports hw.model '$HW_MODEL', which is not an Apple Mac.
       The guard needs an Apple Silicon Mac with Metal."
fi

CLOUD_KIND="none"
CLOUD_INSTANCE_ID=""
CLOUD_INSTANCE_TYPE=""

# EC2 instance metadata, IMDSv2 first.
#
# IMDSv2 requires a session token: you PUT to /latest/api/token and send
# the token back on every read.  A plain GET is IMDSv1, which an account
# with IMDSv2 enforced will refuse — so without this the script would
# report "not an EC2 instance" on a box that is one, and the operator
# would never learn the instance id or type.  Try v2, fall back to v1, and
# treat "neither worked" as "not EC2" without making a fuss about it.
IMDS_TOKEN=""
if command -v curl >/dev/null 2>&1; then
    IMDS_TOKEN="$(curl -fsS --max-time 3 -X PUT \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
        "http://169.254.169.254/latest/api/token" 2>/dev/null || true)"
fi

imds_get() {
    # imds_get <path> — print the value, or nothing.
    local path="$1"
    if [ -n "$IMDS_TOKEN" ]; then
        curl -fsS --max-time 3 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
            "http://169.254.169.254$path" 2>/dev/null || true
    else
        curl -fsS --max-time 3 "http://169.254.169.254$path" 2>/dev/null || true
    fi
}

CLOUD_INSTANCE_ID="$(imds_get "/latest/meta-data/instance-id")"
if [ -n "$CLOUD_INSTANCE_ID" ]; then
    CLOUD_KIND="ec2"
    CLOUD_INSTANCE_TYPE="$(imds_get "/latest/meta-data/instance-type")"
fi

printf '    %s\n' "────────────────────────────────────────────────────────────"
printf '    %sZCODE GUARD — cloud Metal box%s\n' "$C_BOLD" "$C_OFF"
printf '    %s\n' "────────────────────────────────────────────────────────────"
info "hw.model       $HW_MODEL"
info "architecture   $ARCH"
info "macOS          $(sw_vers -productVersion 2>/dev/null || echo unknown)"
if [ "$CLOUD_KIND" = "ec2" ]; then
    info "cloud          EC2 instance ${CLOUD_INSTANCE_ID:-unknown} (${CLOUD_INSTANCE_TYPE:-unknown type})"
else
    info "cloud          not an EC2 instance (no metadata at 169.254.169.254)"
    info "               — a dedicated Metal Mac (MacStadium, colo, your own rack)"
fi
info "operator       $CURRENT_USER"
info "service user   $SERVICE_USER (uid $SERVICE_UID)"
printf '    %s\n' "────────────────────────────────────────────────────────────"

# ---------------------------------------------------------------------------
# 2. dependencies
# ---------------------------------------------------------------------------
log "2. dependencies"
if ! command -v brew >/dev/null 2>&1; then
    die "Homebrew is not installed, and Caddy comes from Homebrew here.
       Install it with:
         /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"
       then run this script again as the same user."
fi
ok "brew   $(brew --prefix)"

CADDY_BIN="$OPT_ROOT/bin/caddy"

# Go and xcaddy are needed to build the rate-limited Caddy.  xcaddy is not
# in Homebrew, but `go install` puts it in $GOPATH/bin, which is a normal
# thing to do on a machine that already has Homebrew.
if ! command -v go >/dev/null 2>&1 && [ ! -x /usr/local/go/bin/go ]; then
    info "installing go (needed to build Caddy with the rate-limit module)"
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "brew install go"
    else
        brew install go || die "brew install go failed"
    fi
fi
GO_BIN="$(command -v go 2>/dev/null || printf '%s' /usr/local/go/bin/go)"
[ -x "$GO_BIN" ] || GO_BIN=""
if [ -n "$GO_BIN" ]; then
    ok "go     $($GO_BIN version 2>/dev/null | awk '{print $3}')"
fi

XCADDY_BIN="${ZCODE_XCADDY_BIN:-}"
if [ -z "$XCADDY_BIN" ]; then
    for candidate in "$(command -v xcaddy 2>/dev/null || true)" "$HOME/go/bin/xcaddy" "/usr/local/bin/xcaddy"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            XCADDY_BIN="$candidate"
            break
        fi
    done
fi
if [ -z "$XCADDY_BIN" ] && [ -n "$GO_BIN" ]; then
    info "installing xcaddy (it builds Caddy with the rate-limit module)"
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest"
    else
        GOBIN="$HOME/go/bin" "$GO_BIN" install github.com/caddyserver/xcaddy/cmd/xcaddy@latest \
            || die "could not install xcaddy — it is needed to build Caddy with the rate-limit module"
        [ -x "$HOME/go/bin/xcaddy" ] && XCADDY_BIN="$HOME/go/bin/xcaddy"
    fi
fi
[ -n "$XCADDY_BIN" ] || XCADDY_BIN=""
if [ -n "$XCADDY_BIN" ]; then
    ok "xcaddy $XCADDY_BIN"
fi

# The Homebrew build of Caddy is still useful as a CLI (fmt, adapt, list-modules),
# but it CANNOT serve the shipped config: `rate_limit` is not a directive it
# knows, and a Caddyfile that uses it is a parse error.  The binary that
# actually runs the box is built below, with the module compiled in.
if [ -x "$(brew --prefix)/bin/caddy" ]; then
    ok "caddy  $(brew --prefix)/bin/caddy (stock — CLI use only)"
else
    info "installing caddy (the CLI; the serving binary is built separately)"
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "brew install caddy"
    else
        brew install caddy || warn "brew install caddy failed — the serving binary is built from source anyway"
    fi
fi

# uv must live somewhere the SERVICE USER can reach, because the upstream
# daemon runs as that user.  Homebrew is the right home for it.
UV_BIN="$(brew --prefix)/bin/uv"
if [ ! -x "$UV_BIN" ]; then
    info "installing uv (for the upstream model server)"
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "brew install uv"
    else
        brew install uv || die "brew install uv failed"
        [ -x "$UV_BIN" ] || die "uv was installed but $UV_BIN is not there"
    fi
fi
[ -x "$UV_BIN" ] || UV_BIN="$(command -v uv 2>/dev/null || printf '%s' "$HOME/.local/bin/uv")"
ok "uv     $UV_BIN"

if ! command -v cargo >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
    info "installing cargo (rustup) into $HOME/.cargo"
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal"
    else
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
            | sh -s -- -y --no-modify-path --profile minimal \
            || die "the rustup installer failed"
        export PATH="$HOME/.cargo/bin:$PATH"
    fi
fi
export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null 2>&1 || die "cargo is not available — install Rust from https://rustup.rs and run this script again"
ok "cargo  $(command -v cargo)"

# ---------------------------------------------------------------------------
# 3. the service account and the /opt/zcode layout
# ---------------------------------------------------------------------------
log "3. layout"
if [ "$DRY_RUN" -eq 1 ]; then
    plan "create the service account $SERVICE_USER (uid $SERVICE_UID, home $SERVICE_HOME)"
    plan "install -d $OPT_ROOT $SITE_ROOT $CADDY_DIR $MODEL_ROOT $SERVICE_HOME $LOG_DIR $ACME_STORAGE"
else
    if dscl . -read "/Users/$SERVICE_USER" RecordName >/dev/null 2>&1; then
        ok "the service account $SERVICE_USER already exists"
    else
        info "creating the service account $SERVICE_USER"
        as_root dscl . -create "/Groups/$SERVICE_USER" PrimaryGroupID "$SERVICE_UID"
        as_root dscl . -create "/Users/$SERVICE_USER" \
            UserShell /usr/bin/false \
            UniqueID "$SERVICE_UID" \
            PrimaryGroupID "$SERVICE_UID" \
            NFSHomeDirectory "$SERVICE_HOME" \
            RealName "ZCode Guard Service"
        ok "created $SERVICE_USER (uid $SERVICE_UID)"
    fi

    as_root install -d -m 0755 -o root -g wheel "$OPT_ROOT"
    as_root install -d -m 0755 -o "$CURRENT_USER" -g "$CURRENT_GROUP" "$INSTALL_DIR"
    as_root install -d -m 0755 -o root -g wheel "$SITE_ROOT"
    as_root install -d -m 0755 -o root -g wheel "$CADDY_DIR"
    as_root install -d -m 0755 -o "$CURRENT_USER" -g "$CURRENT_GROUP" "$MODEL_ROOT"
    as_root install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SERVICE_HOME"
    as_root install -d -m 0755 -o root -g wheel "$LOG_DIR"
    as_root install -d -m 0700 -o root -g wheel "$ACME_STORAGE"
    ok "$OPT_ROOT is in place"
fi

# ---------------------------------------------------------------------------
# 4. the repository, the build, the model, the token
# ---------------------------------------------------------------------------
log "4. guard"
if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR/.git" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    die "$INSTALL_DIR exists and is not a git repository.
       Refusing to overwrite it.  Move it aside first."
fi
if [ -d "$INSTALL_DIR/.git" ]; then
    info "existing clone at $INSTALL_DIR"
    if [ "$DRY_RUN" -eq 0 ]; then
        git -C "$INSTALL_DIR" pull --ff-only || die "git pull failed in $INSTALL_DIR"
    else
        plan "git -C $INSTALL_DIR pull --ff-only"
    fi
else
    info "cloning $REPO_URL into $INSTALL_DIR"
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "git clone $REPO_URL $INSTALL_DIR"
    else
        git clone "$REPO_URL" "$INSTALL_DIR" || die "the clone failed"
    fi
fi

REPE_PATH="$INSTALL_DIR/$REPE_REL"
if [ "$DRY_RUN" -eq 0 ]; then
    [ -f "$REPE_PATH" ] || die "the calibrated RepE vectors are missing: $REPE_PATH"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    plan "cd $INSTALL_DIR/qwen-clef-repe-guard && cargo build --release"
    GUARD_BIN="$INSTALL_DIR/qwen-clef-repe-guard/target/release/qwen-clef-repe-guard"
else
    info "cargo build --release (the first build takes several minutes)"
    ( cd "$INSTALL_DIR/qwen-clef-repe-guard" && cargo build --release ) \
        || die "the build failed"
    GUARD_BIN="$INSTALL_DIR/qwen-clef-repe-guard/target/release/qwen-clef-repe-guard"
    [ -x "$GUARD_BIN" ] || die "the build finished but $GUARD_BIN is not there"
    # The service account has to be able to execute the binary.
    as_root chmod -R a+rX "$INSTALL_DIR"
    ok "$GUARD_BIN"
fi

cached_snapshot_dir() {
    local snapshots="$HF_HOME/hub/models--Qwen--Qwen2.5-0.5B-Instruct/snapshots"
    cached_dir_under "$snapshots"
}

# The newest snapshot under a models--ORG--NAME directory.
cached_dir_under() {
    local snapshots="$1"
    local newest
    [ -d "$snapshots" ] || return 1
    newest="$(find "$snapshots" -mindepth 1 -maxdepth 1 -type d \
        -exec stat -f '%m %N' {} + 2>/dev/null \
        | sort -rn | head -n 1 | cut -d' ' -f2-)"
    [ -n "$newest" ] || return 1
    [ -d "$newest" ] || return 1
    printf '%s\n' "$newest"
}

log "5. model"
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
    info "downloading $MODEL_REPO (~1 GB) into $HF_HOME"
    mkdir -p "$HF_HOME"
    if ! uv run --python 3.12 --with huggingface_hub python \
            -c 'from huggingface_hub import snapshot_download; print(snapshot_download("Qwen/Qwen2.5-0.5B-Instruct"))' \
            > /tmp/zcode-model-path.txt 2>&1; then
        tail -n 20 /tmp/zcode-model-path.txt >&2 || true
        die "the model download failed"
    fi
    MODEL_DIR="$(tail -n 1 /tmp/zcode-model-path.txt)"
    [ -d "$MODEL_DIR" ] || die "the download reported $MODEL_DIR, which is not a directory"
    as_root chmod -R a+rX "$MODEL_ROOT"
    ok "model  $MODEL_DIR"
fi

# ---------------------------------------------------------------------------
# 5b. the generation model
#
# A second, bigger model: the guard READS with the 0.5B above, while the
# site's glass room has a 4B model WRITE code, token by token, into the
# page.  It is a separate server on its own port.
#
# This one is OPTIONAL on purpose.  A box that cannot spare the memory, or
# an operator who does not want a public endpoint that generates text, can
# run with --no-gen-server: the site still deploys, and its glass room says
# the model is unavailable instead of pretending.
# ---------------------------------------------------------------------------
GEN_MODEL_DIR=""
# The huggingface cache names a repo directory after its path: org/name
# becomes models--org--name.
GEN_CACHE_NAME="models--$(printf '%s' "$GEN_MODEL_REPO" | sed 's|/|--|')"
if [ "$GEN_ENABLED" -eq 0 ]; then
    warn "the generation model server is disabled (--no-gen-server); the site's glass room will say the model is unavailable"
elif [ -n "$GEN_MODEL_DIR_OVERRIDE" ]; then
    [ -d "$GEN_MODEL_DIR_OVERRIDE" ] \
        || die "--gen-model-dir points at $GEN_MODEL_DIR_OVERRIDE, which is not a directory"
    GEN_MODEL_DIR="$GEN_MODEL_DIR_OVERRIDE"
    ok "using the generation model at $GEN_MODEL_DIR"
elif cached="$(cached_dir_under "$HF_HOME/hub/$GEN_CACHE_NAME/snapshots")"; then
    GEN_MODEL_DIR="$cached"
    ok "using the cached generation model at $GEN_MODEL_DIR"
elif [ "$DRY_RUN" -eq 1 ]; then
    GEN_MODEL_DIR="$HF_HOME/hub/$GEN_CACHE_NAME/snapshots/<revision>"
    plan "download $GEN_MODEL_REPO (~2.5 GB) into $HF_HOME with uv + huggingface_hub"
else
    info "downloading $GEN_MODEL_REPO (~2.5 GB) into $HF_HOME"
    mkdir -p "$HF_HOME"
    if ! uv run --python 3.12 --with huggingface_hub python \
            -c "from huggingface_hub import snapshot_download; print(snapshot_download(\"$GEN_MODEL_REPO\"))" \
            > /tmp/zcode-gen-model-path.txt 2>&1; then
        tail -n 20 /tmp/zcode-gen-model-path.txt >&2 || true
        die "the generation model download failed.  Re-run with --no-gen-server to deploy without it."
    fi
    GEN_MODEL_DIR="$(tail -n 1 /tmp/zcode-gen-model-path.txt)"
    [ -d "$GEN_MODEL_DIR" ] || die "the download reported $GEN_MODEL_DIR, which is not a directory"
    as_root chmod -R a+rX "$MODEL_ROOT"
    ok "generation model  $GEN_MODEL_DIR"
fi

log "6. token"
if [ -s "$TOKEN_FILE" ]; then
    ok "reusing $TOKEN_FILE"
else
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "openssl rand -hex 32 > $TOKEN_FILE (owner $SERVICE_USER, mode 0640)"
    else
        ( umask 077; openssl rand -hex 32 > /tmp/zcode-token.txt )
        as_root install -m 0640 -o "$SERVICE_USER" -g "$SERVICE_USER" /tmp/zcode-token.txt "$TOKEN_FILE"
        ok "wrote a new token to $TOKEN_FILE (mode 0640)"
    fi
fi

# The session secret signs the device-bound session cookies.  It is a
# DIFFERENT secret from the bearer token: rotating the token must not end
# every visitor's session, and rotating the session secret must not lock the
# operator out.  It is a file so the sessions survive a restart of the
# guard — a random per-process secret would end every session each time
# launchd restarted the daemon.
log "6b. session secret"
if [ -s "$SESSION_SECRET_FILE" ]; then
    ok "reusing $SESSION_SECRET_FILE"
else
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "openssl rand -hex 32 > $SESSION_SECRET_FILE (owner $SERVICE_USER, mode 0640)"
    else
        ( umask 077; openssl rand -hex 32 > /tmp/zcode-session-secret.txt )
        as_root install -m 0640 -o "$SERVICE_USER" -g "$SERVICE_USER" \
            /tmp/zcode-session-secret.txt "$SESSION_SECRET_FILE"
        ok "wrote a new session secret to $SESSION_SECRET_FILE (mode 0640)"
    fi
fi

# ---------------------------------------------------------------------------
# 7. the static site
# ---------------------------------------------------------------------------
log "7. site"
SITE_SRC="$INSTALL_DIR/clef-site"
if [ "$DRY_RUN" -eq 1 ]; then
    plan "copy $SITE_SRC/ to $SITE_ROOT/ (index.html, js/, styles.css, data/, vendor/, assets/)"
else
    [ -d "$SITE_SRC" ] || die "the static site is missing: $SITE_SRC"
    mkdir -p "$SITE_ROOT"
    if command -v rsync >/dev/null 2>&1; then
        rsync -a --exclude 'shots' --exclude '.DS_Store' "$SITE_SRC/" "$SITE_ROOT/"
    else
        cp -R "$SITE_SRC/." "$SITE_ROOT/"
    fi
    as_root chmod -R a+rX "$SITE_ROOT"
    ok "$SITE_ROOT"
fi

# ---------------------------------------------------------------------------
# 8. the Caddy front
# ---------------------------------------------------------------------------
find_caddyfile() {
    local d="$PWD"
    while [ "$d" != "/" ]; do
        if [ -f "$d/deploy/Caddyfile" ]; then
            printf '%s\n' "$d/deploy/Caddyfile"
            return 0
        fi
        d="$(dirname "$d")"
    done
    if [ -f "$INSTALL_DIR/deploy/Caddyfile" ]; then
        printf '%s\n' "$INSTALL_DIR/deploy/Caddyfile"
        return 0
    fi
    return 1
}

log "8. caddy"

# 8a. BUILD the serving binary.
#
# The shipped Caddyfile uses the `rate_limit` directive.  Stock Caddy does
# not know it, and a Caddyfile that uses it on a stock binary is a PARSE
# ERROR — Caddy refuses to load rather than quietly serving an unprotected
# site.  So the box needs a Caddy with the module compiled in, and that is
# what this builds.  Everything below — the validation and the launchd
# daemon — uses THIS binary, not the Homebrew one.
#
# The build is skipped if the binary is already there and already has the
# module, so a re-run does not recompile Caddy from scratch every time.
if [ "$DRY_RUN" -eq 1 ]; then
    plan "build Caddy with the rate_limit module -> $CADDY_BIN"
    plan "  xcaddy build --with github.com/mholt/caddy-ratelimit --output $CADDY_BIN"
else
    need_build=1
    if [ -x "$CADDY_BIN" ] && "$CADDY_BIN" list-modules 2>/dev/null | grep -q "http.handlers.rate_limit"; then
        ok "caddy (with the rate_limit module) is already built at $CADDY_BIN"
        need_build=0
    fi
    if [ "$need_build" -eq 1 ]; then
        [ -n "$XCADDY_BIN" ] || die "xcaddy is not available, so Caddy cannot be built with the
       rate_limit module.  The shipped Caddyfile needs it.  Install Go and run:
         go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest"
        info "building Caddy with the rate_limit module (a few minutes)"
        # Build as the OPERATOR, in a scratch directory.  xcaddy compiles Go
        # and drops a buildenv_* directory in the working directory, so it
        # must not run in the repository.  Building as root would also
        # leave root-owned files in the operator's Go cache and break
        # their next build; only the install needs root.
        build_dir="$(mktemp -d)"
        ( cd "$build_dir" && "$XCADDY_BIN" build \
            --with github.com/mholt/caddy-ratelimit \
            --output "$build_dir/caddy" ) || die "the Caddy build failed
       (scratch directory left at $build_dir — it is safe to delete)"
        [ -x "$build_dir/caddy" ] || die "the Caddy build reported success but produced no binary
       (scratch directory left at $build_dir — it is safe to delete)"
        as_root install -d -m 0755 -o root -g wheel "$(dirname "$CADDY_BIN")"
        as_root install -m 0755 -o root -g wheel "$build_dir/caddy" "$CADDY_BIN"
        # Clean up the scratch directory precisely — no recursive delete.
        rm -f "$build_dir/caddy"
        rmdir "$build_dir" 2>/dev/null || true
        [ -x "$CADDY_BIN" ] || die "the Caddy build reported success but $CADDY_BIN is not there"
    fi
    # Belt and braces: the config is validated with this binary, so a
    # missing module is a loud failure here rather than a silent one at
    # three in the morning.
    if ! "$CADDY_BIN" list-modules 2>/dev/null | grep -q "http.handlers.rate_limit"; then
        die "$CADDY_BIN has no rate_limit module.  The shipped Caddyfile uses the
       rate_limit directive and would be a parse error without it.  Rebuild with:
         xcaddy build --with github.com/mholt/caddy-ratelimit --output $CADDY_BIN"
    fi
    ok "caddy  $CADDY_BIN (with the rate_limit module)"
fi

if CADDYFILE_SRC="$(find_caddyfile)"; then
    info "Caddyfile: $CADDYFILE_SRC"
else
    CADDYFILE_SRC="$INSTALL_DIR/deploy/Caddyfile"
    info "Caddyfile: $CADDYFILE_SRC (from the clone)"
fi

CADDY_ENV="$CADDY_DIR/caddy.env"
CADDY_CONFIG="$CADDY_DIR/Caddyfile"

if [ "$DRY_RUN" -eq 1 ]; then
    plan "write $CADDY_CONFIG (from $CADDYFILE_SRC, mode 0644)"
    plan "write $CADDY_ENV    (CLEF_DOMAIN, GUARD_PORT, SITE_ROOT, ACME_EMAIL, RL_*; mode 0640)"

    # Actually check the configuration, with the environment the box will
    # run it with.  The shipped Caddyfile uses `rate_limit`, so only a
    # Caddy with that module can load it — which is the point: a stock
    # binary refusing the file is the deployment failing loudly instead
    # of serving unprotected.
    caddy_scratch="$(mktemp -d /tmp/zcode-caddy.XXXXXX)"
    install -m 0644 "$CADDYFILE_SRC" "$caddy_scratch/Caddyfile"
    {
        printf 'CLEF_DOMAIN=%s\n' "$CLEF_DOMAIN"
        printf 'GUARD_PORT=%s\n' "$GUARD_PORT"
        printf 'GEN_PORT=%s\n' "$GEN_PORT"
        printf 'SITE_ROOT=%s\n' "$SITE_ROOT"
        printf 'ACME_EMAIL=%s\n' "$ACME_EMAIL"
        printf 'RL_TOOL_CALL_EVENTS=%s\n' "$RL_TOOL_CALL_EVENTS"
        printf 'RL_TOOL_CALL_WINDOW=%s\n' "$RL_TOOL_CALL_WINDOW"
        printf 'RL_API_EVENTS=%s\n' "$RL_API_EVENTS"
        printf 'RL_API_WINDOW=%s\n' "$RL_API_WINDOW"
        printf 'RL_GEN_EVENTS=%s\n' "$RL_GEN_EVENTS"
        printf 'RL_GEN_WINDOW=%s\n' "$RL_GEN_WINDOW"
        printf 'RL_GEN_GLOBAL_EVENTS=%s\n' "$RL_GEN_GLOBAL_EVENTS"
        printf 'RL_GEN_GLOBAL_WINDOW=%s\n' "$RL_GEN_GLOBAL_WINDOW"
        # The access log and the ACME storage are the two paths a
        # non-root machine cannot create, so they point at the scratch
        # directory for the check.
        printf 'CADDY_ACCESS_LOG=%s/caddy-access.log\n' "$caddy_scratch"
        printf 'CADDY_STORAGE=%s/acme\n' "$caddy_scratch"
    } > "$caddy_scratch/caddy.env"

    module_caddy=""
    for candidate in "$OPT_ROOT/bin/caddy" "/tmp/caddy-rl/caddy" "$(command -v caddy || true)"; do
        [ -n "$candidate" ] && [ -x "$candidate" ] || continue
        if "$candidate" list-modules 2>/dev/null | grep -q "http.handlers.rate_limit"; then
            module_caddy="$candidate"
            break
        fi
    done
    if [ -n "$module_caddy" ]; then
        if "$module_caddy" validate --config "$caddy_scratch/Caddyfile" \
                --envfile "$caddy_scratch/caddy.env" >/dev/null 2>&1; then
            ok "the Caddy configuration validates ($module_caddy)"
        else
            validate_out="$("$module_caddy" validate --config "$caddy_scratch/Caddyfile" \
                --envfile "$caddy_scratch/caddy.env" 2>&1 || true)"
            rm -f "$caddy_scratch"/*
            rmdir "$caddy_scratch" 2>/dev/null || true
            die "the Caddy configuration did NOT validate — nothing was loaded:
$validate_out"
        fi
    else
        plan "caddy validate --config $CADDY_CONFIG --envfile $CADDY_ENV"
        info "no Caddy with the rate_limit module was found, so the configuration could not be checked here."
        info "Build one with: xcaddy build --with github.com/mholt/caddy-ratelimit --output /tmp/caddy-rl/caddy"
    fi
    rm -f "$caddy_scratch"/*
    rmdir "$caddy_scratch" 2>/dev/null || true

    plan "launchctl bootstrap system $LAUNCHD_DIR/$CADDY_LABEL.plist ; launchctl kickstart -k system/$CADDY_LABEL"
else
    install -m 0644 -o "$CURRENT_USER" -g "$CURRENT_GROUP" "$CADDYFILE_SRC" /tmp/zcode-Caddyfile
    as_root install -m 0644 -o root -g wheel /tmp/zcode-Caddyfile "$CADDY_CONFIG"

    # The environment the Caddy service loads.
    #
    # There is NO token in here on purpose.  The guard's bearer token is the
    # operator's credential — direct clients on the box send it themselves —
    # and the public path uses a device-bound session cookie that the guard
    # issues.  Injecting the operator token here would make the guard unable
    # to tell a visitor from the operator, and the session gate would be
    # decorative.  The token file still exists; only the guard reads it.
    {
        printf '# Environment for the Caddy service.  Loaded with --envfile.\n'
        printf '# There is no GUARD_TOKEN here on purpose — see deploy/README.md.\n'
        printf 'CLEF_DOMAIN=%s\n' "$CLEF_DOMAIN"
        printf 'GUARD_PORT=%s\n' "$GUARD_PORT"
        printf 'GEN_PORT=%s\n' "$GEN_PORT"
        printf 'SITE_ROOT=%s\n' "$SITE_ROOT"
        printf 'ACME_EMAIL=%s\n' "$ACME_EMAIL"
        # The edge rate limit.  /v1/* runs the model and is the expensive
        # one; /api/* is JSON and an event stream.  Both are keyed by the
        # client IP, at the Caddy layer, as required.
        printf 'RL_TOOL_CALL_EVENTS=%s\n' "$RL_TOOL_CALL_EVENTS"
        printf 'RL_TOOL_CALL_WINDOW=%s\n' "$RL_TOOL_CALL_WINDOW"
        printf 'RL_API_EVENTS=%s\n' "$RL_API_EVENTS"
        printf 'RL_API_WINDOW=%s\n' "$RL_API_WINDOW"
        printf 'RL_GEN_EVENTS=%s\n' "$RL_GEN_EVENTS"
        printf 'RL_GEN_WINDOW=%s\n' "$RL_GEN_WINDOW"
        printf 'RL_GEN_GLOBAL_EVENTS=%s\n' "$RL_GEN_GLOBAL_EVENTS"
        printf 'RL_GEN_GLOBAL_WINDOW=%s\n' "$RL_GEN_GLOBAL_WINDOW"
        # The generation model server, when there is one.
        printf 'GEN_PORT=%s\n' "$GEN_PORT"
    } > /tmp/zcode-caddy.env
    as_root install -m 0640 -o root -g wheel /tmp/zcode-caddy.env "$CADDY_ENV"
    ok "$CADDY_CONFIG and $CADDY_ENV"

    # Validate BEFORE the config is loaded.  A broken config never reaches
    # the running server.
    info "validating the Caddy configuration"
    if ! as_root "$CADDY_BIN" validate --config "$CADDY_CONFIG" --envfile "$CADDY_ENV"; then
        die "the Caddy configuration did not validate — nothing was loaded.
       Fix $CADDY_CONFIG and run this script again."
    fi
    ok "the Caddy configuration validates"
fi

# ---------------------------------------------------------------------------
# 9. the launchd daemons
# ---------------------------------------------------------------------------
xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

write_upstream_plist() {
    local plist="$1"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${UPSTREAM_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_escape "$UV_BIN")</string>
		<string>run</string>
		<string>--python</string>
		<string>3.12</string>
		<string>--with</string>
		<string>mlx-lm</string>
		<string>mlx_lm.server</string>
		<string>--model</string>
		<string>$(xml_escape "$MODEL_DIR")</string>
		<string>--host</string>
		<string>127.0.0.1</string>
		<string>--port</string>
		<string>${UPSTREAM_PORT}</string>
		<string>--temp</string>
		<string>0.0</string>
		<string>--max-tokens</string>
		<string>128</string>
	</array>
	<key>UserName</key>
	<string>$(xml_escape "$SERVICE_USER")</string>
	<key>GroupName</key>
	<string>$(xml_escape "$SERVICE_USER")</string>
	<key>WorkingDirectory</key>
	<string>$(xml_escape "$INSTALL_DIR")</string>
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
		<string>$(xml_escape "$SERVICE_HOME")</string>
		<key>HF_HOME</key>
		<string>$(xml_escape "$HF_HOME")</string>
		<key>PATH</key>
		<string>$(xml_escape "$PATH")</string>
	</dict>
</dict>
</plist>
PLIST
}

write_gen_plist() {
    local plist="$1"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${GEN_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_escape "$UV_BIN")</string>
		<string>run</string>
		<string>--python</string>
		<string>3.12</string>
		<string>--with</string>
		<string>mlx-lm</string>
		<string>mlx_lm.server</string>
		<string>--model</string>
		<string>$(xml_escape "$GEN_MODEL_DIR")</string>
		<string>--host</string>
		<string>127.0.0.1</string>
		<string>--port</string>
		<string>${GEN_PORT}</string>
		<string>--temp</string>
		<string>0.2</string>
		<string>--max-tokens</string>
		<string>256</string>
	</array>
	<key>UserName</key>
	<string>$(xml_escape "$SERVICE_USER")</string>
	<key>GroupName</key>
	<string>$(xml_escape "$SERVICE_USER")</string>
	<key>WorkingDirectory</key>
	<string>$(xml_escape "$INSTALL_DIR")</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG_DIR/gen.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG_DIR/gen.err.log")</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$(xml_escape "$SERVICE_HOME")</string>
		<key>HF_HOME</key>
		<string>$(xml_escape "$HF_HOME")</string>
		<key>PATH</key>
		<string>$(xml_escape "$PATH")</string>
	</dict>
</dict>
</plist>
PLIST
}

write_guard_plist() {
    local plist="$1"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${GUARD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_escape "$GUARD_BIN")</string>
		<string>--host</string>
		<string>127.0.0.1</string>
		<string>--port</string>
		<string>${GUARD_PORT}</string>
		<string>--upstream</string>
		<string>http://127.0.0.1:${UPSTREAM_PORT}</string>
		<string>--model</string>
		<string>$(xml_escape "$MODEL_DIR")</string>
		<string>--repe</string>
		<string>$(xml_escape "$REPE_PATH")</string>
		<string>--mode</string>
		<string>${MODE}</string>
		<string>--threshold</string>
		<string>${THRESHOLD}</string>
		<string>--auth-token-file</string>
		<string>$(xml_escape "$TOKEN_FILE")</string>
		<string>--rate-limit-rpm</string>
		<string>${RATE_LIMIT}</string>
		<string>--trust-proxy</string>
	</array>
	<key>UserName</key>
	<string>$(xml_escape "$SERVICE_USER")</string>
	<key>GroupName</key>
	<string>$(xml_escape "$SERVICE_USER")</string>
	<key>WorkingDirectory</key>
	<string>$(xml_escape "$INSTALL_DIR")</string>
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
		<string>$(xml_escape "$SERVICE_HOME")</string>
		<key>RUST_LOG</key>
		<string>info</string>
		<key>ZCODE_GUARD_TOKEN_FILE</key>
		<string>$(xml_escape "$TOKEN_FILE")</string>
		<key>ZCODE_SESSION_SECRET_FILE</key>
		<string>$(xml_escape "$SESSION_SECRET_FILE")</string>
		<key>ZCODE_GUARD_RATE_LIMIT_RPM</key>
		<string>${RATE_LIMIT}</string>
	</dict>
</dict>
</plist>
PLIST
}

write_caddy_plist() {
    local plist="$1"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${CADDY_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_escape "$CADDY_BIN")</string>
		<string>run</string>
		<string>--config</string>
		<string>$(xml_escape "$CADDY_CONFIG")</string>
		<string>--envfile</string>
		<string>$(xml_escape "$CADDY_ENV")</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml_escape "$CADDY_DIR")</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG_DIR/caddy.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG_DIR/caddy.err.log")</string>
</dict>
</plist>
PLIST
}

log "9. launchd daemons"
if [ "$DRY_RUN" -eq 1 ]; then
    plan "write $LAUNCHD_DIR/$UPSTREAM_LABEL.plist  (mlx_lm.server, runs as $SERVICE_USER)"
    if [ "$GEN_ENABLED" -eq 1 ]; then
        plan "write $LAUNCHD_DIR/$GEN_LABEL.plist       (the generation model server, mlx_lm.server on port $GEN_PORT)"
    fi
    plan "write $LAUNCHD_DIR/$GUARD_LABEL.plist     (the guard, runs as $SERVICE_USER, --trust-proxy)"
    plan "write $LAUNCHD_DIR/$CADDY_LABEL.plist      (caddy run --config ... --envfile ..., runs as root for :443)"

    # Write them for real, into a scratch directory, and check them with
    # plutil.  A property list launchd will not load is a deployment that
    # fails on the box, after the money is spent; a malformed one is the
    # cheapest thing in the world to catch here.  The writers take their
    # output path, so this is the same file the box would get.
    scratch="$(mktemp -d /tmp/zcode-plists.XXXXXX)"
    write_upstream_plist "$scratch/$UPSTREAM_LABEL.plist"
    if [ "$GEN_ENABLED" -eq 1 ]; then
        write_gen_plist "$scratch/$GEN_LABEL.plist"
    fi
    write_guard_plist "$scratch/$GUARD_LABEL.plist"
    write_caddy_plist "$scratch/$CADDY_LABEL.plist"
    for plist_file in "$scratch"/*.plist; do
        if plutil -lint "$plist_file" >/dev/null 2>&1; then
            ok "the plist $(basename "$plist_file") is well-formed"
        else
            lint_out="$(plutil -lint "$plist_file" 2>&1 || true)"
            rm -f "$scratch"/*.plist
            rmdir "$scratch" 2>/dev/null || true
            die "the plist $(basename "$plist_file") is malformed:
$lint_out"
        fi
    done
    rm -f "$scratch"/*.plist
    rmdir "$scratch" 2>/dev/null || true

    plan "launchctl bootout system/$UPSTREAM_LABEL ; launchctl bootstrap system $LAUNCHD_DIR/$UPSTREAM_LABEL.plist ; launchctl kickstart -k system/$UPSTREAM_LABEL"
    if [ "$GEN_ENABLED" -eq 1 ]; then
        plan "launchctl bootout system/$GEN_LABEL      ; launchctl bootstrap system $LAUNCHD_DIR/$GEN_LABEL.plist      ; launchctl kickstart -k system/$GEN_LABEL"
    fi
    plan "launchctl bootout system/$GUARD_LABEL    ; launchctl bootstrap system $LAUNCHD_DIR/$GUARD_LABEL.plist    ; launchctl kickstart -k system/$GUARD_LABEL"
    plan "launchctl bootout system/$CADDY_LABEL     ; launchctl bootstrap system $LAUNCHD_DIR/$CADDY_LABEL.plist     ; launchctl kickstart -k system/$CADDY_LABEL"
else
    write_upstream_plist "/tmp/zcode-$UPSTREAM_LABEL.plist"
    if [ "$GEN_ENABLED" -eq 1 ]; then
        write_gen_plist "/tmp/zcode-$GEN_LABEL.plist"
    fi
    write_guard_plist "/tmp/zcode-$GUARD_LABEL.plist"
    write_caddy_plist "/tmp/zcode-$CADDY_LABEL.plist"
    as_root install -m 0644 -o root -g wheel "/tmp/zcode-$UPSTREAM_LABEL.plist" "$LAUNCHD_DIR/$UPSTREAM_LABEL.plist"
    if [ "$GEN_ENABLED" -eq 1 ]; then
        as_root install -m 0644 -o root -g wheel "/tmp/zcode-$GEN_LABEL.plist" "$LAUNCHD_DIR/$GEN_LABEL.plist"
    fi
    as_root install -m 0644 -o root -g wheel "/tmp/zcode-$GUARD_LABEL.plist" "$LAUNCHD_DIR/$GUARD_LABEL.plist"
    as_root install -m 0644 -o root -g wheel "/tmp/zcode-$CADDY_LABEL.plist" "$LAUNCHD_DIR/$CADDY_LABEL.plist"

    # launchctl bootout returns before the service has actually left the
    # domain, and bootstrapping straight back in then fails with
    # "Input/output error" — so re-running this script on a box that is
    # already deployed would die exactly where a fresh box succeeds.
    # Wait for each agent to be gone.
    for label in "$UPSTREAM_LABEL" "$GEN_LABEL" "$GUARD_LABEL" "$CADDY_LABEL"; do
        as_root launchctl bootout "system/$label" >/dev/null 2>&1 || true
        waited=0
        while [ "$waited" -lt 100 ]; do
            as_root launchctl print "system/$label" >/dev/null 2>&1 || break
            sleep 0.2
            waited=$((waited + 1))
        done
    done

    # And retry the bootstrap: launchd sometimes refuses the first attempt
    # while it is still settling.
    bootstrap_agent() {
        local label="$1" plist="$2" attempt=0
        while [ "$attempt" -lt 5 ]; do
            if as_root launchctl bootstrap system "$plist" 2>/dev/null; then
                return 0
            fi
            attempt=$((attempt + 1))
            sleep 1
        done
        # One last time without the output swallowed, so the operator sees
        # why it failed.
        as_root launchctl bootstrap system "$plist" \
            || die "launchctl bootstrap failed for $label"
    }

    bootstrap_agent "$UPSTREAM_LABEL" "$LAUNCHD_DIR/$UPSTREAM_LABEL.plist"
    if [ "$GEN_ENABLED" -eq 1 ]; then
        bootstrap_agent "$GEN_LABEL" "$LAUNCHD_DIR/$GEN_LABEL.plist"
    fi
    bootstrap_agent "$GUARD_LABEL" "$LAUNCHD_DIR/$GUARD_LABEL.plist"
    bootstrap_agent "$CADDY_LABEL" "$LAUNCHD_DIR/$CADDY_LABEL.plist"
    for label in "$UPSTREAM_LABEL" "$GEN_LABEL" "$GUARD_LABEL" "$CADDY_LABEL"; do
        as_root launchctl kickstart -k "system/$label" >/dev/null 2>&1 || true
    done
    if [ "$GEN_ENABLED" -eq 1 ]; then
        ok "$UPSTREAM_LABEL, $GEN_LABEL, $GUARD_LABEL and $CADDY_LABEL are loaded"
    else
        ok "$UPSTREAM_LABEL, $GUARD_LABEL and $CADDY_LABEL are loaded"
    fi
fi

# ---------------------------------------------------------------------------
# 10. wait for the two services
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

log "10. health"
if [ "$DRY_RUN" -eq 1 ]; then
    plan "wait for 127.0.0.1:$UPSTREAM_PORT to accept a connection"
    if [ "$GEN_ENABLED" -eq 1 ]; then
        plan "wait for 127.0.0.1:$GEN_PORT to accept a connection  (the generation model)"
    fi
    plan "wait for http://127.0.0.1:$GUARD_PORT/health to answer"
else
    if ! wait_for_tcp "$UPSTREAM_PORT" 300; then
        as_root tail -n 40 "$LOG_DIR/upstream.err.log" >&2 2>/dev/null || true
        die "the upstream mlx_lm.server never opened port $UPSTREAM_PORT — see $LOG_DIR/upstream.err.log"
    fi
    ok "upstream is listening on 127.0.0.1:$UPSTREAM_PORT"

    if [ "$GEN_ENABLED" -eq 1 ]; then
        if ! wait_for_tcp "$GEN_PORT" 600; then
            as_root tail -n 40 "$LOG_DIR/gen.err.log" >&2 2>/dev/null || true
            die "the generation mlx_lm.server never opened port $GEN_PORT — see $LOG_DIR/gen.err.log
       The site's glass room will say the model is unavailable until it is up."
        fi
        ok "the generation model is listening on 127.0.0.1:$GEN_PORT"
    fi

    if ! wait_for_health "http://127.0.0.1:$GUARD_PORT/health" 120; then
        as_root tail -n 40 "$LOG_DIR/guard.err.log" >&2 2>/dev/null || true
        die "the guard never answered /health — see $LOG_DIR/guard.err.log"
    fi
    ok "the guard answers http://127.0.0.1:$GUARD_PORT/health"
fi

# ---------------------------------------------------------------------------
# 11. the operator steps
# ---------------------------------------------------------------------------
log "11. what is left for you"
if [ "$DOMAIN_REQUIRED" -eq 1 ] || [ "$EMAIL_REQUIRED" -eq 1 ]; then
    warn "the plan above was built without the values a real run needs:"
    [ "$DOMAIN_REQUIRED" -eq 1 ] && warn "  --domain <your.public.hostname>   the hostname Caddy will serve"
    [ "$EMAIL_REQUIRED" -eq 1 ] && warn "  --email <you@example.com>          the ACME contact address"
fi
cat <<SUMMARY
    public site        https://${DOMAIN_HOST}/
    guard API          https://${DOMAIN_HOST}/api/info
    tool-call probe    POST https://${DOMAIN_HOST}/v1/guard/tool-call
    glass room         https://${DOMAIN_HOST}/demo.html
    health             https://${DOMAIN_HOST}/health
    ACME contact       ${EMAIL_HOST}

    DNS AND TLS — you still have to do this:
      1. point an A (and AAAA) record for ${DOMAIN_HOST} at this box's
         public IP address.  Caddy cannot get a certificate for a name that
         does not resolve here.
      2. make sure TCP 80 and TCP 443 are open in the security group / firewall.
         Caddy answers the ACME challenge on port 80 and serves on 443.
      3. Caddy obtains and renews the certificate by itself.  There is no
         certificate file to manage.  Watch it happen with:
             sudo tail -f ${LOG_DIR}/caddy.log

    FILES
      Caddy config      ${CADDY_CONFIG}
      Caddy environment ${CADDY_ENV}        (no token in it, on purpose; mode 0640)
      guard token       ${TOKEN_FILE}   (mode 0640, owner ${SERVICE_USER})
      session secret    ${SESSION_SECRET_FILE}   (mode 0640, owner ${SERVICE_USER})
      static site       ${SITE_ROOT}
      model             ${MODEL_DIR}
      generation model  ${GEN_MODEL_DIR:-(not installed — --no-gen-server)}
      install root      ${INSTALL_DIR}

    LOGS
      ${LOG_DIR}/caddy.log, ${LOG_DIR}/caddy.err.log
      ${LOG_DIR}/caddy-access.log
      ${LOG_DIR}/guard.log, ${LOG_DIR}/guard.err.log
      ${LOG_DIR}/upstream.log, ${LOG_DIR}/upstream.err.log
      ${LOG_DIR}/gen.log, ${LOG_DIR}/gen.err.log

    CONTROLS
      reload the Caddy config      sudo caddy reload --config ${CADDY_CONFIG}
      restart Caddy (needed after  sudo launchctl kickstart -k system/${CADDY_LABEL}
        the token changes)
      restart the guard             sudo launchctl kickstart -k system/${GUARD_LABEL}
      restart the upstream          sudo launchctl kickstart -k system/${UPSTREAM_LABEL}
      restart the generation model  sudo launchctl kickstart -k system/${GEN_LABEL}   (only if installed)
      stop everything               sudo launchctl bootout system/${CADDY_LABEL}
                                    sudo launchctl bootout system/${GUARD_LABEL}
                                    sudo launchctl bootout system/${UPSTREAM_LABEL}
      check the rate limiter        for i in \$(seq 1 40); do curl -s -o /dev/null -w '%{http_code}\n' \\
                                       -X POST https://${DOMAIN_HOST}/v1/guard/tool-call \\
                                       -H 'Content-Type: application/json' -d '{}'; done

    BEFORE YOU OPEN THIS TO THE PUBLIC
      The deployment MUST rate limit at Caddy, keyed by client IP.  That
      is already done: this script builds a Caddy with the rate_limit
      module into ${CADDY_BIN}, the shipped Caddyfile carries the zones,
      and the daemon runs that binary.  The limits live in ${CADDY_ENV}:
          RL_TOOL_CALL_EVENTS  requests a minute on /v1/*  (default 10)
          RL_API_EVENTS        requests a minute on /api/*  (default 60)
          RL_GEN_EVENTS        requests a minute on /gen/*  (default 6)
          RL_GEN_GLOBAL_EVENTS requests a minute on /gen/* for EVERYONE at once
                               (default 20) — a per-IP limit alone does not
                               bound the total work
      The static site and /health are in no zone at all, so a visitor is
      never throttled for loading a page.
      Check it is live with:
          sudo ${CADDY_BIN} list-modules | grep rate_limit
      Full instructions: deploy/README.md —
      "Rate limiting belongs at THIS layer, keyed by IP".
SUMMARY
