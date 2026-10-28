#!/usr/bin/env bash
#
# Show the codesigning identities of this Mac and explain which one to use.
#
#   ./sign.sh                 # list the identities
#   ./sign.sh --verify path   # verify the signature of a built app
#
# Environment
#   ZODE_SIGN_IDENTITY  pick one identity (a substring is enough)
#   ZODE_TEAM_ID        the team id that belongs to the identity
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

VERIFY_PATH=""
while [ $# -gt 0 ]; do
    case "$1" in
        --verify) VERIFY_PATH="${2:-}"; shift 2 ;;
        --help|-h) sed -n '2,14p' "$0"; exit 0 ;;
        *) die "unknown option '$1'" ;;
    esac
done

# -----------------------------------------------------------------------------
# Verify a built app
# -----------------------------------------------------------------------------
if [ -n "${VERIFY_PATH}" ]; then
    [ -e "${VERIFY_PATH}" ] || die "${VERIFY_PATH} does not exist"
    log "Verifying ${VERIFY_PATH}"
    codesign --verify --deep --strict --verbose=4 "${VERIFY_PATH}" 2>&1 | sed 's/^/    /'
    log "Signature"
    codesign --display --verbose=4 "${VERIFY_PATH}" 2>&1 | sed 's/^/    /'
    log "Entitlements"
    codesign --display --entitlements :- "${VERIFY_PATH}" 2>&1 | sed 's/^/    /'
    exit 0
fi

# -----------------------------------------------------------------------------
# List the identities
# -----------------------------------------------------------------------------
if ! command -v security >/dev/null 2>&1; then
    die "the 'security' command was not found — this is not macOS."
fi

log "Codesigning identities on this Mac"
IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"

if [ -z "${IDENTITIES}" ]; then
    cat >&2 <<'EOF'

    No codesigning identity was found.

    Install one in Xcode ▸ Settings ▸ Accounts:
      * "Apple Development"  — for a local run on your own Mac,
      * "Developer ID Application" — to ship the app outside the App Store,
      * "Mac App Distribution" — to ship the app through the Mac App Store.

    The certificates are created by Xcode (or in the developer portal).
EOF
    exit 1
fi

printf '%s\n' "${IDENTITIES}" | sed 's/^/    /'

COUNT="$(printf '%s\n' "${IDENTITIES}" | grep -c ')' || true)"
info ""
info "${COUNT} identity/identities available"

# -----------------------------------------------------------------------------
# Which one to use?
# -----------------------------------------------------------------------------
cat <<'EOF'

    Which identity to use
    ---------------------
    Developer ID Application: <Company> (<TEAMID>)
        Signs the app for distribution *outside* the App Store. The app is
        notarised with `xcrun notarytool` and the user right-clicks ▸ Open
        the first time. This is what `build.sh` uses by default
        (ZODE_EXPORT_METHOD=developer-id).

    Apple Development: <Name> (<TEAMID>)
        Signs the app for a local run on this Mac only. The app is not
        distributable and not notarisable.

    Mac App Distribution: <Company> (<TEAMID>)
        Signs the app for the Mac App Store. `build.sh` uses it when
        ZODE_EXPORT_METHOD=app-store.

    The team id is the part in brackets. Put it into ZODE_TEAM_ID:

        export ZODE_TEAM_ID=ABCDE12345
        export ZODE_SIGN_IDENTITY="Developer ID Application: …"
        ./build.sh
EOF

if [ -n "${ZODE_SIGN_IDENTITY:-}" ]; then
    log "ZODE_SIGN_IDENTITY = ${ZODE_SIGN_IDENTITY}"
    if printf '%s\n' "${IDENTITIES}" | grep -qF "${ZODE_SIGN_IDENTITY}"; then
        info "matches one of the identities above"
    else
        info "warning: this string does not appear in the list above"
    fi
fi

if [ -n "${ZODE_TEAM_ID:-}" ]; then
    log "ZODE_TEAM_ID = ${ZODE_TEAM_ID}"
    if printf '%s\n' "${IDENTITIES}" | grep -qF "(${ZODE_TEAM_ID})"; then
        info "the team id appears in the list above"
    else
        info "warning: no identity of this team was found on this Mac"
    fi
fi
