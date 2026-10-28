#!/usr/bin/env bash
#
# check-notarization.sh — why does my Zode still warn, and what is missing?
#
# Run this on the Mac that has the problem:
#
#     ./scripts/check-notarization.sh                      # the last build
#     ./scripts/check-notarization.sh path/to/zode.dmg     # a downloaded copy
#
# It answers three questions:
#
#   1. Is the app signed with a real Developer ID, or only ad-hoc?
#   2. Is it notarised by Apple, and is the ticket stapled to it?
#   3. Is the copy on this machine carrying the quarantine attribute, which
#      is the thing that makes Gatekeeper stop and ask?
#
# It changes nothing. It only looks.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
if [ ! -t 1 ]; then RED=""; GREEN=""; YELLOW=""; BOLD=""; OFF=""; fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$GREEN" "$OFF" "$*"; }
bad()  { printf '  %s✘%s %s\n' "$RED" "$OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
head_() { printf '\n%s%s%s\n' "$BOLD" "$*" "$OFF"; }

# ---------------------------------------------------------------------------
# 1. The identity on this machine
# ---------------------------------------------------------------------------
head_ "1. The signing identity on this Mac"

IDENTITY=""
if command -v security >/dev/null 2>&1; then
    # "Developer ID Application: Name (TEAMID)" is the one that matters for
    # shipping outside the App Store.
    IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
        | grep "Developer ID Application" \
        | head -1 | sed 's/.*"\(.*\)".*/\1/')
fi

if [ -n "$IDENTITY" ]; then
    ok "a Developer ID Application identity: $IDENTITY"
else
    warn "no 'Developer ID Application' identity on this Mac"
    say "     Ad-hoc signing is what the current release uses. Gatekeeper"
    say "     does not trust it, so a downloaded copy is blocked."
fi

# ---------------------------------------------------------------------------
# 2. The artefact
# ---------------------------------------------------------------------------
DMG="${1:-}"
APP=""

if [ -n "$DMG" ]; then
    [ -f "$DMG" ] || { bad "no such file: $DMG"; exit 1; }
    DMG="$(cd "$(dirname "$DMG")" && pwd)/$(basename "$DMG")"
    head_ "2. The disk image"
    say "  $DMG"

    # Is this copy quarantined?  Only files that came from the internet
    # (a browser, Mail, AirDrop) get this attribute, and it is the reason
    # Gatekeeper asks at all.
    if command -v xattr >/dev/null 2>&1 && xattr -p com.apple.quarantine "$DMG" >/dev/null 2>&1; then
        warn "the disk image is quarantined (it came from the internet)"
        say "     This is what makes macOS ask. A copy you built yourself"
        say "     does not have this attribute, and opens with no prompt."
    else
        ok "the disk image is not quarantined — it will not be blocked"
    fi

    head_ "3. The application inside the disk image"
    # Mount it read-only, quietly, and look at the app inside.
    MOUNTPOINT="$(mktemp -d)"
    if hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNTPOINT" >/dev/null 2>&1; then
        APP="$(find "$MOUNTPOINT" -maxdepth 2 -name '*.app' -type d 2>/dev/null | head -1)"
        hdiutil detach "$MOUNTPOINT" >/dev/null 2>&1
    else
        warn "the disk image could not be mounted"
    fi
fi

if [ -z "$APP" ]; then
    # Fall back to a build in this checkout.
    for candidate in \
        "shells/macos/build/Zode.app" \
        "shells/macos/build/dmg/Zode.app" \
        "$(find . -maxdepth 5 -name 'Zode.app' -type d 2>/dev/null | head -1)"
    do
        [ -n "$candidate" ] && [ -d "$candidate" ] && { APP="$candidate"; break; }
    done
fi

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
    head_ "2. The application"
    warn "no Zode.app found — build one with ./scripts/build-on-mac.sh,"
    say "     or point this script at a disk image:"
    say "         ./scripts/check-notarization.sh zode-macos-0.1.0-universal.dmg"
    exit 0
fi

say "  $APP"

head_ "4. The signature"
if command -v codesign >/dev/null 2>&1; then
    if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
        ok "the signature is valid"
    else
        bad "the signature does not verify"
    fi

    DETAILS=$(codesign -dv --verbose=2 "$APP" 2>&1)
    if echo "$DETAILS" | grep -q "Authority=Developer ID Application"; then
        ok "signed with a Developer ID Application certificate"
    elif echo "$DETAILS" | grep -q "Signature=adhoc"; then
        warn "signed AD-HOC — no certificate, so Gatekeeper will not trust it"
    else
        warn "signed with something that is not a Developer ID"
    fi

    if echo "$DETAILS" | grep -q "flags=.*runtime"; then
        ok "the hardened runtime is on"
    else
        bad "the hardened runtime is OFF — notarisation requires it"
    fi
fi

head_ "5. The notarisation ticket"
if command -v xcrun >/dev/null 2>&1; then
    if xcrun stapler validate "$APP" >/dev/null 2>&1; then
        ok "the ticket is stapled to the app — it opens offline, no warning"
    elif xcrun notarytool history --no-output >/dev/null 2>&1; then
        : # history works but the ticket is not here
    fi

    if xcrun stapler validate "$APP" >/dev/null 2>&1; then
        :
    else
        TICKET=$(xcrun stapler ticket "$APP" 2>/dev/null | head -c 40)
        if [ -n "$TICKET" ]; then
            warn "a ticket exists but is not stapled"
        else
            bad "no notarisation ticket at all"
            say "     This is the reason for the 'downloaded from the internet'"
            say "     warning. Only Apple can put the ticket here."
        fi
    fi
fi

head_ "6. What Gatekeeper thinks right now"
if command -v spctl >/dev/null 2>&1; then
    if spctl --assess --type execute --verbose=4 "$APP" 2>&1 | grep -q "accepted"; then
        ok "Gatekeeper accepts it"
    else
        warn "Gatekeeper would not accept this copy"
        spctl --assess --type execute --verbose=4 "$APP" 2>&1 | sed 's/^/     /' | head -4
    fi
fi

head_ "7. What to do next"
if [ -n "$IDENTITY" ] && [ -n "$APP" ]; then
    say "  You have a Developer ID. To notarise:"
    say "     xcrun notarytool submit --apple-id <id> --team-id <team> \\"
    say "         --password <app-specific-password> --wait <path>"
    say "     xcrun stapler staple <path>"
    say "  Or add the five GitHub secrets and let the release workflow do it:"
    say "     MACOS_CERTIFICATE, MACOS_CERTIFICATE_PASSWORD, APPLE_ID,"
    say "     APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID"
    say "  See docs/RELEASING.md."
elif [ -n "$APP" ]; then
    say "  To get a disk image that opens without a warning you need a"
    say "  Developer ID Application certificate and a paid Apple Developer"
    say "  account — that is Apple's rule, and no local flag can replace it."
    say
    say "  In the meantime, for a copy you built yourself there is no"
    say "  warning at all (nothing is quarantined). For a downloaded copy:"
    say "     xattr -dr com.apple.quarantine <path>/Zode.app"
    say "  or right-click the app and choose Open once."
    say
    say "  The full setup is in docs/RELEASING.md."
fi
say ""
