#!/usr/bin/env bash
#
# keepawake.sh — hold this Mac awake while it is on mains power.
#
# The Tailscale edge is served from this Mac, so a sleeping Mac is a dead
# edge.  Nothing in the launchd stack holds a sleep assertion: the guard,
# the two model servers and Caddy all keep running while the machine is
# asleep, but they are not reachable, because the machine is not on the
# network.  The tailnet peers see the address go quiet, not an error.
#
# `caffeinate -i` takes a PreventUserIdleSystemSleep assertion, which is
# what keeps an IDLE Mac awake.  Two things this script is careful about:
#
#   * It only asserts while the Mac is on AC power.  A laptop held awake on
#     battery drains the battery for nothing, and the edge lives at home on
#     mains.
#   * It re-arms on a timer instead of holding one assertion forever, so a
#     change of power state is noticed within a minute rather than at the
#     next reboot.
#
# WHAT IT CANNOT DO
#
#   Closing the LID puts a MacBook to sleep regardless of any assertion.
#   That needs `sudo pmset disablesleep 1`, which this script does not and
#   cannot do.  Keep the lid open.
#
#   `caffeinate -s` (used here on AC) blocks a manual Sleep, but not a lid
#   close.
#
set -uo pipefail

CAFFEINATE="/usr/bin/caffeinate"
HOLD="${ZCODE_KEEPAWAKE_HOLD:-600}"   # seconds one assertion is held
POLL="${ZCODE_KEEPAWAKE_POLL:-60}"    # seconds between power-state checks

on_ac() {
    pmset -g batt 2>/dev/null | grep -q "AC Power"
}

while true; do
    if on_ac; then
        # -i: do not sleep while idle.  -s: do not sleep at all (AC only).
        # -t: release the assertion after HOLD seconds so the loop can
        #     re-check the power state.
        "$CAFFEINATE" -i -s -t "$HOLD" || true
    else
        sleep "$POLL"
    fi
done
