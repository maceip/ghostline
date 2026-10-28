#!/usr/bin/env bash
#
# Build (and archive) the Zode macOS shell.
#
#   ./build.sh                 # Release archive + export
#   ./build.sh --debug         # Debug build (no archive)
#   ./build.sh --unsigned      # build without a development team
#   ./build.sh --stage-only    # only stage the resources and the project
#                              # (build-dmg.sh does its own xcodebuild)
#
# Environment
#   ZODE_TEAM_ID       the Apple Developer team id (required for signing)
#   ZODE_SIGN_IDENTITY the signing identity, e.g. "Developer ID Application: …"
#   ZODE_EXPORT_METHOD "developer-id" (default) or "app-store"
#
# The team id is NEVER invented here: if ZODE_TEAM_ID is not set the script
# explains what to do and stops (unless --unsigned is given).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PROJECT="${SCRIPT_DIR}/Zode.xcodeproj"
SCHEME="Zode"
WEB_SOURCE="${REPO_ROOT}/dist"
WEB_TARGET="${SCRIPT_DIR}/Zode/Resources/web"
HAPTICS_SOURCE="${REPO_ROOT}/packages/shared/haptics.json"
HAPTICS_TARGET="${SCRIPT_DIR}/Zode/Resources/haptics.json"
BUILD_DIR="${SCRIPT_DIR}/build"
ARCHIVE="${BUILD_DIR}/Zode.xcarchive"
EXPORT_DIR="${BUILD_DIR}/export"
EXPORT_OPTIONS="${BUILD_DIR}/ExportOptions.plist"

TEAM_ID="${ZODE_TEAM_ID:-}"
SIGN_IDENTITY="${ZODE_SIGN_IDENTITY:-}"
EXPORT_METHOD="${ZODE_EXPORT_METHOD:-developer-id}"
CONFIGURATION="Release"
UNSIGNED="no"
STAGE_ONLY="no"

log()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --debug)     CONFIGURATION="Debug"; shift ;;
        --unsigned)  UNSIGNED="yes"; shift ;;
        --stage-only) STAGE_ONLY="yes"; shift ;;
        --help|-h)   sed -n '2,20p' "$0"; exit 0 ;;
        *)           die "unknown option '$1' (try --help)" ;;
    esac
done

# -----------------------------------------------------------------------------
# 1. The environment
# -----------------------------------------------------------------------------
log "Zode macOS shell — $CONFIGURATION build"

if ! command -v xcodebuild >/dev/null 2>&1; then
    if [ "${STAGE_ONLY}" = "yes" ]; then
        # Staging only needs python3 and the web app — not a compiler.
        info "xcodebuild was not found; staging only, so that is fine"
    else
        die "xcodebuild was not found — this script needs Xcode (and its command line tools)."
    fi
fi

if command -v xcodebuild >/dev/null 2>&1; then
    info "xcodebuild    : $(xcodebuild -version | head -1 | sed 's/^Xcode //')"
fi
info "project       : ${PROJECT}"
info "team id       : ${TEAM_ID:-<not set>}"
info "identity      : ${SIGN_IDENTITY:-<from the keychain>}"
info "export method : ${EXPORT_METHOD}"

if [ "${UNSIGNED}" = "no" ] && [ "${STAGE_ONLY}" = "no" ] && [ -z "${TEAM_ID}" ]; then
    cat >&2 <<'EOF'

error: no signing team.

    Set ZODE_TEAM_ID to your Apple Developer team id, for example:

        ZODE_TEAM_ID=ABCDE12345 ./build.sh

    The team id is in Xcode ▸ Settings ▸ Accounts, or at
    https://developer.apple.com/account (membership details).
    Use "./sign.sh" to list the signing identities of this Mac.

    For a build without any signing use:  ./build.sh --unsigned
EOF
    exit 1
fi

# -----------------------------------------------------------------------------
# 2. The bundled resources
# -----------------------------------------------------------------------------
if [ ! -f "${WEB_SOURCE}/index.html" ]; then
    log "Building the web application (dist/)"
    ( cd "${REPO_ROOT}" && npm run build )
fi

if [ ! -d "${WEB_SOURCE}" ]; then
    die "the web application was not found at ${WEB_SOURCE}
       Run 'npm run build' in the repository root first."
fi

log "Copying the web application"
rm -rf "${WEB_TARGET}"
mkdir -p "${WEB_TARGET}"
# Everything but the VCS metadata and the build artefacts.
( cd "${WEB_SOURCE}" && tar --exclude='.git' --exclude='node_modules' --exclude='.DS_Store' -cf - . ) \
    | ( cd "${WEB_TARGET}" && tar -xf - )
if [ ! -f "${WEB_TARGET}/index.html" ]; then
    cat > "${WEB_TARGET}/index.html" <<'EOF'
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Zode</title></head>
<body><p>The web application was copied into this folder but it has no index.html.</p></body></html>
EOF
    info "warning: the web application has no index.html — wrote a placeholder"
fi
info "web app       : ${WEB_SOURCE} -> ${WEB_TARGET} ($(find "${WEB_TARGET}" -type f | wc -l | tr -d ' ') file(s))"

if [ -f "${HAPTICS_SOURCE}" ]; then
    cp "${HAPTICS_SOURCE}" "${HAPTICS_TARGET}"
    info "haptics       : ${HAPTICS_SOURCE} -> ${HAPTICS_TARGET}"
else
    die "the canonical haptic programs were not found at ${HAPTICS_SOURCE}"
fi

# -----------------------------------------------------------------------------
# 3. The project
# -----------------------------------------------------------------------------
log "Generating and validating the Xcode project"
python3 "${SCRIPT_DIR}/tools/generate_xcodeproj.py"
python3 "${SCRIPT_DIR}/tools/validate_pbxproj.py" >/dev/null || {
    python3 "${SCRIPT_DIR}/tools/validate_pbxproj.py"
    die "the generated project is not valid"
}
info "the project is valid"

# The web app decides which request types, intent names and event names
# exist — check that the shell implements all of them.
if [ -d "${WEB_SOURCE}/src/bridge" ]; then
    python3 "${SCRIPT_DIR}/tools/verify_against_web.py" || die "the shell and the web app do not match"
else
    info "skipping the web app cross-check (no src/bridge in ${WEB_SOURCE})"
fi

if [ "${STAGE_ONLY}" = "yes" ]; then
    log "Staged. The resources and the Xcode project are ready."
    exit 0
fi

# -----------------------------------------------------------------------------
# 4. Build
# -----------------------------------------------------------------------------
mkdir -p "${BUILD_DIR}"

if [ "${CONFIGURATION}" = "Debug" ]; then
    log "Building (Debug)"
    EXTRA_ARGS=()
    if [ -n "${SIGN_IDENTITY}" ]; then
        EXTRA_ARGS+=("CODE_SIGN_IDENTITY=${SIGN_IDENTITY}")
    fi
    xcodebuild \
        -project "${PROJECT}" \
        -scheme "${SCHEME}" \
        -configuration Debug \
        -destination 'platform=macOS' \
        CODE_SIGN_STYLE=Automatic \
        DEVELOPMENT_TEAM="${TEAM_ID}" \
        "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" \
        build
    info "the app is in ${BUILD_DIR}/Debug/Zode.app"
    exit 0
fi

log "Archiving (Release)"
xcodebuild \
    -project "${PROJECT}" \
    -scheme "${SCHEME}" \
    -configuration Release \
    -archivePath "${ARCHIVE}" \
    -destination 'generic/platform=macOS' \
    CODE_SIGN_STYLE=Automatic \
    DEVELOPMENT_TEAM="${TEAM_ID}" \
    -allowProvisioningUpdates \
    archive

# -----------------------------------------------------------------------------
# 5. Export
# -----------------------------------------------------------------------------
log "Exporting the app"
cat > "${EXPORT_OPTIONS}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>${EXPORT_METHOD}</string>
	<key>destination</key>
	<string>export</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>${TEAM_ID}</string>
$(if [ -n "${SIGN_IDENTITY}" ]; then printf '\t<key>signingCertificate</key>\n\t<string>%s</string>\n' "${SIGN_IDENTITY}"; fi)
</dict>
</plist>
EOF

rm -rf "${EXPORT_DIR}"
export_args=(
    -exportArchive
    -archivePath "${ARCHIVE}"
    -exportPath "${EXPORT_DIR}"
    -exportOptionsPlist "${EXPORT_OPTIONS}"
    DEVELOPMENT_TEAM="${TEAM_ID}"
)
xcodebuild "${export_args[@]}"

APP="${EXPORT_DIR}/Zode.app"
if [ ! -d "${APP}" ]; then
    die "the export did not produce ${APP}"
fi

log "Done"
info "app           : ${APP}"
info "bundle id     : $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${APP}/Contents/Info.plist" 2>/dev/null || echo unknown)"
info "version       : $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP}/Contents/Info.plist" 2>/dev/null || echo unknown)"
info "to notarise   : xcrun notarytool submit \"${APP}\" --keychain-profile <profile> --wait"
