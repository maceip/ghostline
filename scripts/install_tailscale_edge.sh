#!/usr/bin/env bash
#
# install_tailscale_edge.sh — serve the site over Tailscale, from this Mac.
#
#   bash scripts/install_tailscale_edge.sh
#   bash scripts/install_tailscale_edge.sh --port 8443
#   bash scripts/install_tailscale_edge.sh --dry-run
#
# WHAT IT DOES
#
#   1. Checks that this is an Apple Mac, that Tailscale is up, and reads
#      this Mac's tailnet address.
#   2. Makes sure a Caddy WITH the rate_limit module exists at
#      ~/.local/bin/caddy — it uses one that is already there, builds one
#      with xcaddy, or says exactly what to run.
#   3. Writes ~/.config/zcode/Caddyfile — the SHIPPED deploy/Caddyfile, byte
#      for byte — and ~/.config/zcode/caddy.env: the same environment the
#      cloud box runs, with the tailnet address in place of a public
#      domain.
#   4. Validates that configuration BEFORE loading it.
#   5. Installs a launchd agent (com.zcode.caddy) and starts it.
#   6. Checks, by measuring:
#        - the site is served
#        - the guard answers a visitor with a session and a real reading
#        - the rate limiter really refuses the excess
#        - the listener is on the tailnet address and NOT on the LAN one
#
# WHY PLAIN HTTP
#
#   The tailnet's WireGuard tunnel already encrypts the connection from
#   end to end, so there is no certificate to obtain and no ACME contact
#   to set up.  The cost is that the session cookie cannot carry
#   `Secure` — a browser drops a Secure cookie from a plain-HTTP page —
#   so the guard has to be installed with `--session-cookie-secure false`.
#   The cookie still travels only inside the encrypted tunnel.
#
#   Tailscale Serve and `tailscale serve --tcp` were both measured and
#   rejected: this tailnet's account cannot issue TLS certificates, and a
#   TCP forward collapses every client to 127.0.0.1 at the listener (which
#   would leave the edge's rate limiter with ONE bucket for the whole
#   tailnet) while also opening the port on the local LAN.
#
# WHY THE EDGE BINDS THE TAILNET ADDRESS
#
#   Because the limiter keys on the address Caddy saw on the socket.  On
#   a tailnet that address is the peer's own 100.x number, so the limit
#   is per device — which is what "keyed by client IP" has to mean here.
#   Binding to the LAN interface instead would key every device in the
#   house into one bucket.
#
set -euo pipefail

ZCODE_DIR="${ZCODE_DIR:-$HOME/zune-code}"
EDGE_PORT="${ZCODE_EDGE_PORT:-8443}"
DRY_RUN=0
TS_IP=""
FORCE_IP=""

while [ $# -gt 0 ]; do
    case "$1" in
        --dir)       ZCODE_DIR="${2:-}"; shift 2 ;;
        --dir=*)     ZCODE_DIR="${1#*=}"; shift ;;
        --port)      EDGE_PORT="${2:-}"; shift 2 ;;
        --port=*)    EDGE_PORT="${1#*=}"; shift ;;
        --ip)        FORCE_IP="${2:-}"; shift 2 ;;
        --ip=*)      FORCE_IP="${1#*=}"; shift ;;
        --dry-run)   DRY_RUN=1; shift ;;
        -h|--help)   sed -n '2,45p' "$0"; exit 0 ;;
        *)           echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '\033[32m    ok\033[0m   %s\n' "$*"; }
warn()  { printf '\033[33m    warn\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }
plan()  { printf '    \033[2m[dry-run]\033[0m %s\n' "$*"; }

# XML-escape a value for a plist.  A path with an ampersand in it would
# otherwise produce a plist that plutil refuses.
xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

case "$EDGE_PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac

# ---------------------------------------------------------------------------
# 0. the ground we are standing on
# ---------------------------------------------------------------------------
bold "Tailscale edge"

[ "$(uname -s)" = "Darwin" ] || die "this script installs a launchd agent, so it is macOS only"
case "$(uname -m)" in
    arm64) ;;
    *) warn "this Mac reports $(uname -m); the guard needs Apple Silicon for MLX" ;;
esac

command -v tailscale >/dev/null 2>&1 || die "Tailscale is not installed (https://tailscale.com/download)"
if ! tailscale status >/dev/null 2>&1; then
    die "Tailscale is installed but not logged in — run 'tailscale up' first"
fi

if [ -n "$FORCE_IP" ]; then
    TS_IP="$FORCE_IP"
else
    TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1)"
fi
[ -n "$TS_IP" ] || die "this Mac has no Tailscale IPv4 address — is it logged in?"
ok "tailnet address  $TS_IP"

TS_NAME="$(tailscale status --json 2>/dev/null | python3 -c \
    "import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null || true)"
[ -n "$TS_NAME" ] && ok "tailnet name     $TS_NAME"

[ -d "$ZCODE_DIR" ] || die "no checkout at $ZCODE_DIR — pass --dir"
[ -f "$ZCODE_DIR/deploy/Caddyfile" ] || die "no deploy/Caddyfile in $ZCODE_DIR — is this the right checkout?"
[ -d "$ZCODE_DIR/clef-site" ] || die "no clef-site/ in $ZCODE_DIR"

CONFIG_DIR="$HOME/.config/zcode"
LOG_DIR="$HOME/Library/Logs/zcode"
CADDY_BIN="$HOME/.local/bin/caddy"
CADDYFILE="$CONFIG_DIR/Caddyfile"
CADDY_ENV="$CONFIG_DIR/caddy.env"
AGENTS_DIR="$HOME/Library/LaunchAgents"
CADDY_PLIST="$AGENTS_DIR/com.zcode.caddy.plist"
GUARD_PORT="${ZCODE_GUARD_PORT:-8090}"
GEN_PORT="${ZCODE_GEN_PORT:-8080}"

mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$AGENTS_DIR" "$HOME/.local/bin" "$CONFIG_DIR/caddy-storage"

# ---------------------------------------------------------------------------
# 1. a Caddy that can actually rate limit
#
# Stock Caddy has no rate limiter.  `rate_limit` is a module, and a
# Caddyfile that uses it on a stock binary is a PARSE ERROR — it fails
# loudly, which is the right way to fail, but it means the binary has to
# be built with the module before anything here can work.
# ---------------------------------------------------------------------------
have_module() {
    "$1" list-modules 2>/dev/null | grep -q "http.handlers.rate_limit"
}

if [ -x "$CADDY_BIN" ] && have_module "$CADDY_BIN"; then
    ok "caddy           $CADDY_BIN (has the rate_limit module)"
elif have_module /opt/homebrew/bin/caddy 2>/dev/null; then
    ok "caddy           /opt/homebrew/bin/caddy (has the rate_limit module)"
else
    info "building a Caddy with the rate_limit module -> $CADDY_BIN"
    if ! command -v xcaddy >/dev/null 2>&1 && [ -x "$HOME/go/bin/xcaddy" ]; then
        PATH="$HOME/go/bin:$PATH"; export PATH
    fi
    if ! command -v xcaddy >/dev/null 2>&1; then
        die "xcaddy is not installed.  Install Go, then:
    go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
    xcaddy build --with github.com/mholt/caddy-ratelimit --output $CADDY_BIN"
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        plan "xcaddy build --with github.com/mholt/caddy-ratelimit --output $CADDY_BIN"
    else
        xcaddy build --with github.com/mholt/caddy-ratelimit --output "$CADDY_BIN" \
            || die "the Caddy build failed"
        have_module "$CADDY_BIN" || die "the built Caddy has no rate_limit module"
        ok "caddy           $CADDY_BIN (built with the rate_limit module)"
    fi
fi

# ---------------------------------------------------------------------------
# 2. the configuration
#
# The Caddyfile is the SHIPPED one, copied byte for byte.  The environment
# is the same one the cloud box runs, with three differences:
#
#   CLEF_DOMAIN  the tailnet address instead of a public hostname
#   ACME_EMAIL   inert here: there is no certificate to obtain, but the
#                Caddyfile asks for it, and asking is deliberate
#   BIND_ADDR    the tailnet address, so the edge is not on the LAN
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
    plan "write $CADDYFILE   (the shipped deploy/Caddyfile, byte for byte)"
    plan "write $CADDY_ENV"
else
    install -m 0644 "$ZCODE_DIR/deploy/Caddyfile" "$CADDYFILE"
    {
        printf 'CLEF_DOMAIN=http://%s:%s\n' "$TS_IP" "$EDGE_PORT"
        printf 'ACME_EMAIL=zcode@localhost\n'
        printf 'GUARD_PORT=%s\n' "$GUARD_PORT"
        printf 'GEN_PORT=%s\n' "$GEN_PORT"
        printf 'SITE_ROOT=%s\n' "$ZCODE_DIR/clef-site"
        printf 'BIND_ADDR=%s\n' "$TS_IP"
        printf 'RL_TOOL_CALL_EVENTS=%s\n' "${ZCODE_RL_TOOL_CALL_EVENTS:-30}"
        printf 'RL_TOOL_CALL_WINDOW=%s\n' "${ZCODE_RL_TOOL_CALL_WINDOW:-1m}"
        printf 'RL_API_EVENTS=%s\n' "${ZCODE_RL_API_EVENTS:-60}"
        printf 'RL_API_WINDOW=%s\n' "${ZCODE_RL_API_WINDOW:-1m}"
        printf 'RL_GEN_EVENTS=%s\n' "${ZCODE_RL_GEN_EVENTS:-6}"
        printf 'RL_GEN_WINDOW=%s\n' "${ZCODE_RL_GEN_WINDOW:-1m}"
        printf 'RL_GEN_GLOBAL_EVENTS=%s\n' "${ZCODE_RL_GEN_GLOBAL_EVENTS:-20}"
        printf 'RL_GEN_GLOBAL_WINDOW=%s\n' "${ZCODE_RL_GEN_GLOBAL_WINDOW:-1m}"
        printf 'CADDY_ACCESS_LOG=%s/caddy-access.log\n' "$LOG_DIR"
        printf 'CADDY_STORAGE=%s/caddy-storage\n' "$CONFIG_DIR"
    } > "$CADDY_ENV"
    chmod 0600 "$CADDY_ENV"
    ok "configuration   $CADDYFILE"
    ok "environment    $CADDY_ENV (mode 0600)"
fi

# ---------------------------------------------------------------------------
# 3. validate before loading
#
# A configuration that fails to load must fail HERE, where the message can
# still be read, rather than in a launchd log nobody is watching.
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
    plan "$CADDY_BIN validate --config $CADDYFILE --envfile $CADDY_ENV"
else
    if ! validate_output="$("$CADDY_BIN" validate --config "$CADDYFILE" --envfile "$CADDY_ENV" 2>&1)"; then
        printf '%s\n' "$validate_output" >&2
        die "the configuration does not validate"
    fi
    ok "the configuration validates"
fi

# ---------------------------------------------------------------------------
# 4. the launchd agent
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
    plan "write $CADDY_PLIST   (caddy run --config ... --envfile ...)"
    plan "launchctl bootout gui/$UID/com.zcode.caddy ; bootstrap ; kickstart"
else
    cat > "$CADDY_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.zcode.caddy</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(xml_escape "$CADDY_BIN")</string>
		<string>run</string>
		<string>--config</string>
		<string>$(xml_escape "$CADDYFILE")</string>
		<string>--envfile</string>
		<string>$(xml_escape "$CADDY_ENV")</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml_escape "$CONFIG_DIR")</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG_DIR/caddy.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG_DIR/caddy.err.log")</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$(xml_escape "$HOME")</string>
		<key>PATH</key>
		<string>$(xml_escape "${PATH}")</string>
	</dict>
</dict>
</plist>
PLIST
    plutil -lint "$CADDY_PLIST" >/dev/null || die "the plist is not well-formed"
    ok "agent          $CADDY_PLIST"

    # bootout first: a bootout returns before the service has left the
    # domain, and bootstrapping a name that is still there fails with
    # "service already loaded".  Wait for it to go, then load it.
    launchctl bootout "gui/$UID/com.zcode.caddy" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
        launchctl print "gui/$UID/com.zcode.caddy" >/dev/null 2>&1 || break
        sleep 0.5
    done
    for _ in $(seq 1 10); do
        if launchctl bootstrap "gui/$UID" "$CADDY_PLIST" 2>/dev/null; then break; fi
        sleep 1
    done
    launchctl enable "gui/$UID/com.zcode.caddy" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/$UID/com.zcode.caddy" >/dev/null 2>&1 || true
    ok "com.zcode.caddy is loaded"
fi

# ---------------------------------------------------------------------------
# 5. the checks
#
# Every one of these is a measurement, not an assumption.
# ---------------------------------------------------------------------------
printf '\n'
if [ "$DRY_RUN" -eq 1 ]; then
    plan "check the site answers on http://$TS_IP:$EDGE_PORT/"
    plan "check a visitor gets a session and a real reading"
    plan "check the rate limiter refuses the excess"
    plan "check the listener is on $TS_IP and not on the LAN address"
    exit 0
fi

# the guard has to be up, or none of this means anything
if ! curl -fsS --max-time 5 "http://127.0.0.1:${GUARD_PORT}/health" >/dev/null 2>&1; then
    die "the guard is not answering on 127.0.0.1:$GUARD_PORT.
    Install it first:
      bash $ZCODE_DIR/scripts/install_guard.sh --dir $ZCODE_DIR --session-cookie-secure false --trust-proxy"
fi
ok "the guard is up on 127.0.0.1:$GUARD_PORT"

for _ in $(seq 1 30); do
    curl -fsS --max-time 2 "http://${TS_IP}:${EDGE_PORT}/health" >/dev/null 2>&1 && break
    sleep 1
done

site_code="$(curl -s -o /tmp/zcode-edge-site.html -w '%{http_code}' --max-time 10 "http://${TS_IP}:${EDGE_PORT}/index.html" 2>/dev/null || true)"
site_code="${site_code:-000}"
if [ "$site_code" = "200" ] && grep -q "PEEK INTO" /tmp/zcode-edge-site.html; then
    ok "the site is served on http://${TS_IP}:${EDGE_PORT}/"
else
    die "the site answered '$site_code' — the edge is not serving.
    Check $LOG_DIR/caddy.err.log and $LOG_DIR/caddy.log."
fi

# a visitor: no token, no session -> the handshake, then a real reading
rm -f /tmp/zcode-edge-jar.txt
session_code="$(curl -s -c /tmp/zcode-edge-jar.txt -o /dev/null -w '%{http_code}' \
    --max-time 10 -X POST "http://${TS_IP}:${EDGE_PORT}/api/session" 2>/dev/null || true)"
session_code="${session_code:-000}"
read_code="$(curl -s -b /tmp/zcode-edge-jar.txt -o /tmp/zcode-edge-read.json -w '%{http_code}' \
    --max-time 30 -X POST "http://${TS_IP}:${EDGE_PORT}/v1/guard/tool-call" \
    -H 'Content-Type: application/json' \
    -d '{"prompt":"Clean up the temporary build artifacts.","tool_name":"bash","tool_args":{"cmd":"rm -rf /var/lib/mysql/production"}}' 2>/dev/null || true)"
read_code="${read_code:-000}"
if [ "$session_code" = "200" ] && [ "$read_code" = "200" ]; then
    excess="$(python3 -c "import json;print(json.load(open('/tmp/zcode-edge-read.json')).get('harm_excess'))" 2>/dev/null || echo '?')"
    ok "a visitor gets a session and a real reading (harm_excess $excess)"
else
    die "the visitor path answered session=$session_code reading=$read_code.
    If the reading is 401, the guard was installed with the Secure cookie
    attribute on — which a browser drops on a plain-HTTP page.  Reinstall it:
      bash $ZCODE_DIR/scripts/install_guard.sh --dir $ZCODE_DIR --session-cookie-secure false --trust-proxy"
fi

# the limiter has to actually refuse
codes=""
for _ in $(seq 1 12); do
    # WITH the session cookie, so this measures the limiter and not the
    # admission gate: the first requests must answer 200, and the excess
    # must answer 429.
    one="$(curl -s -b /tmp/zcode-edge-jar.txt -o /dev/null -w '%{http_code}' --max-time 30 \
        -X POST "http://${TS_IP}:${EDGE_PORT}/v1/guard/tool-call" \
        -H 'Content-Type: application/json' \
        -d '{"prompt":"x","tool_name":"bash","tool_args":{"cmd":"ls"}}' 2>/dev/null || true)"
    codes="$codes${one:-000} "
done
if printf '%s' "$codes" | grep -q 429 && printf '%s' "$codes" | grep -q 200; then
    ok "the edge limiter refuses the excess ($codes)"
    info "that check spent this address's budget for /v1/* — the next minute's"
    info "judgments from this machine will be refused.  That is the limiter working."
else
    die "the limiter did not behave: $codes
    The first requests must answer 200 and the excess must answer 429 —
    the edge is not rate limiting, which is the whole point of it."
fi

# and the listener must be on the tailnet address, not on the LAN one
if command -v lsof >/dev/null 2>&1; then
    bound="$(lsof -nP -iTCP:"$EDGE_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | sort -u | tr '\n' ' ')"
    if printf '%s' "$bound" | grep -q "$TS_IP"; then
        ok "the listener is bound to the tailnet address ($bound)"
    else
        warn "the listener is bound to '$bound', not to $TS_IP"
    fi
fi
lan_ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [ -n "$lan_ip" ]; then
    lan_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${lan_ip}:${EDGE_PORT}/health" 2>/dev/null || true)"
    lan_code="${lan_code:-000}"
    if [ "$lan_code" = "000" ]; then
        ok "the edge does NOT answer on the LAN address ($lan_ip)"
    else
        die "the edge answered $lan_code on the LAN address $lan_ip
    It must be reachable over the tailnet and nowhere else."
    fi
fi

printf '\n'
bold "the edge is up"
printf '    site      http://%s:%s/\n' "$TS_IP" "$EDGE_PORT"
[ -n "$TS_NAME" ] && printf '    name      http://%s:%s/   (tailnet name)\n' "$TS_NAME" "$EDGE_PORT"
printf '\n'
printf '    The edge is reachable from any device on the tailnet and from\n'
printf '    nowhere else.  It is plain HTTP on purpose: the tailnet tunnel\n'
printf '    already encrypts the connection, and this account cannot issue\n'
printf '    TLS certificates (measured: "your Tailscale account does not\n'
printf '    support getting TLS certs").\n\n'
printf '    The guard needs --session-cookie-secure false for this, because a\n'
printf '    browser drops a Secure cookie from a plain-HTTP page:\n'
printf '      bash %s/scripts/install_guard.sh --dir %s --session-cookie-secure false --trust-proxy\n\n' "$ZCODE_DIR" "$ZCODE_DIR"
printf '    restart     launchctl kickstart -k gui/$UID/com.zcode.caddy\n'
printf '    stop        launchctl bootout gui/$UID/com.zcode.caddy\n'
printf '    logs        %s/caddy-access.log\n\n' "$LOG_DIR"
