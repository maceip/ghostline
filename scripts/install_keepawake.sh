#!/usr/bin/env bash
#
# install_keepawake.sh — keep this Mac awake, so the Tailscale edge stays up.
#
#   bash scripts/install_keepawake.sh
#   bash scripts/install_keepawake.sh --dry-run
#
# WHAT IT DOES
#
#   1. Checks that this is macOS, that caffeinate is present, and reads the
#      current power source.
#   2. Copies scripts/keepawake.sh to ~/.config/zcode/keepawake.sh — the
#      shipped script is the source of truth, the config directory holds
#      the runtime copy.
#   3. Writes and lints a launchd agent (com.zcode.keepawake).
#   4. Loads it and checks, by measuring, that the sleep assertion is
#      actually held.
#
# WHY THIS EXISTS
#
#   The edge is served from this Mac.  Nothing in the launchd stack holds a
#   sleep assertion, so macOS puts the machine to sleep when it goes idle,
#   and the tailnet peers see the address go quiet rather than an error.
#   Measured on this Mac before this script existed:
#
#     $ pmset -g assertions | grep -c PreventUserIdleSystemSleep
#     0
#     $ pgrep -fl caffeinate
#     (nothing)
#
#   A laptop held awake on battery drains the battery for nothing, so the
#   assertion is only taken while the Mac is on AC power.
#
# THE ONE THING IT CANNOT DO
#
#   Closing the LID sleeps a MacBook regardless of any assertion.  That
#   needs `sudo pmset disablesleep 1`.  Keep the lid open.
#
set -euo pipefail

ZCODE_DIR="${ZCODE_DIR:-$HOME/zune-code}"
DRY_RUN=0
LABEL="com.zcode.keepawake"

while [ $# -gt 0 ]; do
    case "$1" in
        --dir)       ZCODE_DIR="${2:-}"; shift 2 ;;
        --dir=*)     ZCODE_DIR="${1#*=}"; shift ;;
        --dry-run)   DRY_RUN=1; shift ;;
        -h|--help)   sed -n '2,35p' "$0"; exit 0 ;;
        *)           echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '\033[32m    ok\033[0m   %s\n' "$*"; }
warn()  { printf '\033[33m    warn\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }
plan()  { printf '    \033[2m[dry-run]\033[0m %s\n' "$*"; }

xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

bold "Keep the Mac awake"

[ "$(uname -s)" = "Darwin" ] || die "this script installs a launchd agent, so it is macOS only"

CAFFEINATE="/usr/bin/caffeinate"
[ -x "$CAFFEINATE" ] || die "caffeinate is not at $CAFFEINATE (it ships with macOS)"

SRC="$ZCODE_DIR/scripts/keepawake.sh"
[ -f "$SRC" ] || die "no scripts/keepawake.sh at $ZCODE_DIR — pass --dir"

CONFIG_DIR="$HOME/.config/zcode"
LOG_DIR="$HOME/Library/Logs/zcode"
AGENTS_DIR="$HOME/Library/LaunchAgents"
KEEP_SCRIPT="$CONFIG_DIR/keepawake.sh"
PLIST="$AGENTS_DIR/$LABEL.plist"

mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$AGENTS_DIR"

# the power source decides whether the assertion is taken at all
power="$(pmset -g batt 2>/dev/null | head -n 1)"
case "$power" in
    *"AC Power"*)   ok "power           $power" ;;
    *)              warn "power           $power" ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
    plan "copy $SRC -> $KEEP_SCRIPT"
    plan "write $PLIST   ($LABEL)"
    plan "launchctl bootout gui/$UID/$LABEL ; bootstrap ; kickstart"
    plan "check that pmset -g assertions reports a PreventUserIdleSystemSleep"
    exit 0
fi

# ---------------------------------------------------------------------------
# 1. the runtime script
# ---------------------------------------------------------------------------
install -m 0755 "$SRC" "$KEEP_SCRIPT"
ok "runtime        $KEEP_SCRIPT"

# ---------------------------------------------------------------------------
# 2. the launchd agent
# ---------------------------------------------------------------------------
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$(xml_escape "$KEEP_SCRIPT")</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml_escape "$CONFIG_DIR")</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG_DIR/keepawake.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG_DIR/keepawake.err.log")</string>
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
plutil -lint "$PLIST" >/dev/null || die "the plist is not well-formed"
ok "agent          $PLIST"

# bootout first: a bootout returns before the service has left the domain,
# and bootstrapping a name that is still there fails with "service already
# loaded".  Wait for it to go, then load it.
launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
    launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
done
for _ in $(seq 1 10); do
    if launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then break; fi
    sleep 1
done
launchctl enable "gui/$UID/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1 || true
ok "$LABEL is loaded"

# ---------------------------------------------------------------------------
# 3. the check
#
# The agent being loaded is not the claim.  The claim is that the Mac is
# held awake, and the only evidence of that is the assertion itself.
# ---------------------------------------------------------------------------
printf '\n'
# `|| true` matters: with `set -e` and `pipefail`, a grep that finds nothing
# exits 1, and that would abort the script at the very step that reports
# whether the assertion is held.
assertion=""
for _ in $(seq 1 30); do
    assertion="$(pmset -g assertions 2>/dev/null | grep 'PreventUserIdleSystemSleep' | grep -i caffeinate | head -n 1 || true)"
    [ -n "$assertion" ] && break
    sleep 1
done

if [ -n "$assertion" ]; then
    ok "the sleep assertion is held"
    info "$(printf '%s' "$assertion" | sed -e 's/^[[:space:]]*//')"
else
    die "no PreventUserIdleSystemSleep assertion from caffeinate.
    The agent is loaded but is not holding the Mac awake.
    Check $LOG_DIR/keepawake.err.log and $LOG_DIR/keepawake.log."
fi

if [ -n "$(pmset -g assertions 2>/dev/null | grep 'PreventSystemSleep' | grep -i caffeinate | head -n 1 || true)" ]; then
    ok "the system-sleep assertion is held too (AC power)"
fi

printf '\n'
bold "the Mac will stay awake on mains"
printf '    The edge at http://%s:%s/ stays reachable while the Mac is idle.\n\n' \
    "$(tailscale ip -4 2>/dev/null | head -n 1)" "${ZCODE_EDGE_PORT:-8443}"
printf '    Closing the LID still sleeps the Mac — that needs\n'
printf '    `sudo pmset disablesleep 1`, which this script does not do.\n'
printf '    Keep the lid open.\n\n'
printf '    restart     launchctl kickstart -k gui/%s/%s\n' "$UID" "$LABEL"
printf '    stop        launchctl bootout gui/%s/%s\n' "$UID" "$LABEL"
printf '    logs        %s/keepawake.log\n\n' "$LOG_DIR"
