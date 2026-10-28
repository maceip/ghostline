#!/usr/bin/env bash
#
# Build the Zode macOS disk image (.dmg), signed, notarised and stapled.
#
# WHY THIS EXISTS
# ---------------
# macOS quarantines every file it downloads (it sets the com.apple.quarantine
# attribute).  When Gatekeeper meets a quarantined app it cannot validate, it
# does not just refuse to open it — on modern macOS it *deletes* it and says
# "<app> was moved to your Trash".  That is the warning this script exists to
# prevent.
#
# The only supported way out is the full Apple pipeline:
#
#   1. sign the app with a **Developer ID Application** certificate
#      (an "Apple Development" certificate is NOT enough),
#   2. enable the **hardened runtime** (mandatory for notarisation),
#   3. **notarise** it with `xcrun notarytool` and wait for Apple's verdict,
#   4. **staple** the ticket to the app so it travels with the file,
#   5. do all of the above to the .dmg as well — the disk image is the thing
#      the user actually downloads, so the disk image is what must be
#      notarised and stapled,
#   6. sign the .dmg too, so the image itself has a valid signature.
#
# With that done, Gatekeeper validates the stapled ticket offline and the app
# opens normally, with no warning and no right-click dance.
#
# Without a Developer ID the image is signed ad-hoc, which does NOT satisfy
# Gatekeeper.  The script says so loudly and prints the one-line escape hatch
# a developer can use on their own machine.
#
# ENVIRONMENT
#   ZODE_TEAM_ID              Apple Developer team id (e.g. ABCDE12345)
#   ZODE_SIGN_IDENTITY        signing identity; defaults to the single
#                             "Developer ID Application:" identity found
#   ZODE_KEYCHAIN_PROFILE     notarytool keychain profile (optional)
#   ZODE_NOTARY_APPLE_ID      Apple id used for notarisation
#   ZODE_NOTARY_PASSWORD      app-specific password for that Apple id
#   ZODE_NOTARY_TEAM_ID       team id used for notarisation
#   ZODE_APP_VERSION          version stamped into the bundle (default 0.1.0)
#
# Usage
#   ./build-dmg.sh                # build, sign, notarise, staple
#   ./build-dmg.sh --no-notarize # build and sign only (no Apple account)
#   ./build-dmg.sh --skip-build  # reuse the app that is already in
#                              # build/DerivedData/Build/Products/Release
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

BUILD_DIR="${SCRIPT_DIR}/build"
STAGE_DIR="${BUILD_DIR}/dmg-stage"
DMG_PATH="${BUILD_DIR}/Zode.dmg"
APP_VERSION="${ZODE_APP_VERSION:-0.1.0}"

NOTARIZE="yes"
SKIP_BUILD="no"
NOTARIZED="no"

log()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    warning: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --no-notarize) NOTARIZE="no"; shift ;;
        --skip-build)  SKIP_BUILD="yes"; shift ;;
        --help|-h)     sed -n '2,40p' "$0"; exit 0 ;;
        *)             die "unknown option '$1'" ;;
    esac
done

# -----------------------------------------------------------------------------
# 1. Pick the signing identity
# -----------------------------------------------------------------------------
if [ -n "${ZODE_SIGN_IDENTITY:-}" ]; then
    IDENTITY="${ZODE_SIGN_IDENTITY}"
else
    # Prefer a Developer ID Application identity: that is the one that
    # notarisation accepts and the one Gatekeeper trusts.
    IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
        | grep 'Developer ID Application:' | head -1 | sed 's/.*"\(.*\)"/\1/')" || true
fi

if [ -z "${IDENTITY:-}" ]; then
    IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
        | head -1 | sed 's/.*"\(.*\)"/\1/')" || true
fi

HAVE_DEVELOPER_ID="no"
case "${IDENTITY:-}" in
    *"Developer ID Application"*) HAVE_DEVELOPER_ID="yes" ;;
esac

# -----------------------------------------------------------------------------
# 2. Stage the resources and build the app
# -----------------------------------------------------------------------------
# build.sh --stage-only copies the web app into the bundle and generates the
# Xcode project.  The compile itself is done here, because a Developer ID
# build is signed directly — no provisioning profile, no archive, no export
# dance.  That is both simpler and far more reliable in CI than
# archive + export-options + automatic signing.
log "Staging the resources and the Xcode project"
"${SCRIPT_DIR}/build.sh" --stage-only

DERIVED="${BUILD_DIR}/DerivedData"
APP="${DERIVED}/Build/Products/Release/Zode.app"
ENTITLEMENTS="${SCRIPT_DIR}/Zode.entitlements"

if [ "${SKIP_BUILD}" = "no" ]; then
    log "Building the app"
    rm -rf "${DERIVED}"

    # The build itself is always UNSIGNED.  A Developer ID build is signed by
    # hand afterwards, with the hardened runtime and the entitlements, which
    # is both simpler and far more reliable in CI than asking Xcode for
    # automatic signing (that wants a provisioning profile, which a
    # Developer ID app does not need and must not have).
    #
    # A universal binary (arm64 + x86_64) is preferred so Intel Macs can
    # install it too.  If the universal build fails for any reason, fall
    # back to the native architecture rather than failing the whole release.
    build_args=(
        -project "${SCRIPT_DIR}/Zode.xcodeproj"
        -scheme Zode
        -configuration Release
        -destination 'generic/platform=macOS'
        -derivedDataPath "${DERIVED}"
        CODE_SIGNING_ALLOWED=NO
        CODE_SIGNING_REQUIRED=NO
        CODE_SIGN_IDENTITY=""
    )

    if [ "${ZODE_UNIVERSAL:-1}" = "1" ]; then
        info "building universal (arm64 + x86_64)"
        if ! xcodebuild "${build_args[@]}" ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO build; then
            warn "the universal build failed — falling back to the native architecture"
            rm -rf "${DERIVED}"
            xcodebuild "${build_args[@]}" build || die "xcodebuild failed"
        fi
    else
        xcodebuild "${build_args[@]}" build || die "xcodebuild failed"
    fi
fi

[ -d "${APP}" ] || die "the app was not found at ${APP}"

# -----------------------------------------------------------------------------
# 3. Stamp the version, then sign
# -----------------------------------------------------------------------------
# The version has to be stamped BEFORE the signature: the Info.plist is part
# of the signed bundle, so editing it afterwards invalidates the signature
# and notarisation would reject the app.
if [ -f "${APP}/Contents/Info.plist" ]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${APP_VERSION}" \
        "${APP}/Contents/Info.plist" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${APP_VERSION}" \
        "${APP}/Contents/Info.plist" 2>/dev/null || true
    info "version     : ${APP_VERSION}"
fi

log "Signing the app"
if [ -n "${IDENTITY:-}" ] && codesign --force --options runtime --timestamp \
        --entitlements "${ENTITLEMENTS}" \
        --sign "${IDENTITY}" "${APP}" 2>/dev/null; then
    # --options runtime : the hardened runtime, required for notarisation
    # --timestamp       : the secure timestamp Apple requires
    # --entitlements    : the app needs the network + file entitlements
    info "signed with: ${IDENTITY}"
else
    # Ad-hoc: no usable identity on this machine.  Fine for local use,
    # useless for Gatekeeper.  No --timestamp (that needs a real
    # certificate).  A machine that has certificates without their private
    # key — a CI runner, for instance — ends up here too.
    if [ -n "${IDENTITY:-}" ]; then
        warn "could not sign with '${IDENTITY}' — falling back to an ad-hoc signature."
    fi
    codesign --force --entitlements "${ENTITLEMENTS}" --sign - "${APP}" \
        || die "ad-hoc codesign failed"
    warn "signed ad-hoc: no Developer ID Application certificate was usable."
    warn "ad-hoc signatures do NOT satisfy Gatekeeper; a downloaded copy will"
    warn "be moved to the Trash.  See docs/RELEASING.md."
fi

codesign --verify --deep --strict --verbose=1 "${APP}" 2>&1 | sed 's/^/    /' || true

# -----------------------------------------------------------------------------
# 4. Notarise and staple the app
# -----------------------------------------------------------------------------
notarize_one() {
    # $1 = path to sign+notarise (a .app bundle or a .dmg)
    local target="$1"
    local label="$2"

    if [ "${NOTARIZE}" = "no" ]; then
        info "notarisation skipped for ${label}"
        return 0
    fi

    if [ "${HAVE_DEVELOPER_ID}" != "yes" ]; then
        warn "skipping notarisation of ${label}: no 'Developer ID Application' identity."
        return 0
    fi

    local keychain_profile="${ZODE_KEYCHAIN_PROFILE:-zode-notary}"
    local submit_args=()

    if [ -n "${ZODE_KEYCHAIN_PROFILE:-}" ]; then
        submit_args=(--keychain-profile "${keychain_profile}")
    elif [ -n "${ZODE_NOTARY_APPLE_ID:-}" ] && [ -n "${ZODE_NOTARY_PASSWORD:-}" ]; then
        submit_args=(
            --apple-id "${ZODE_NOTARY_APPLE_ID}"
            --password "${ZODE_NOTARY_PASSWORD}"
            --team-id "${ZODE_NOTARY_TEAM_ID:-${ZODE_TEAM_ID:-}}"
        )
    else
        warn "no notarisation credentials for ${label}."
        warn "set ZODE_KEYCHAIN_PROFILE, or ZODE_NOTARY_APPLE_ID + ZODE_NOTARY_PASSWORD."
        return 0
    fi

    log "Notarising ${label}"
    # A failed notarisation must NOT take the whole build down.  The disk
    # image is still worth shipping — it just has to be labelled as "not
    # notarised", because a downloaded copy of it will be moved to the Trash
    # by Gatekeeper.  The status file tells the release workflow which of
    # the two it is.
    if ! xcrun notarytool submit "${target}" "${submit_args[@]}" --wait; then
        warn "notarisation of ${label} FAILED."
        warn "the artefact is signed but not notarised — a downloaded copy will"
        warn "be moved to the Trash.  See docs/RELEASING.md."
        NOTARIZED="no"
        return 0
    fi

    log "Stapling ${label}"
    if ! xcrun stapler staple "${target}"; then
        warn "stapling ${label} FAILED — the artefact is notarised but the"
        warn "ticket does not travel with it, so Gatekeeper has to go online."
        NOTARIZED="no"
        return 0
    fi

    if ! xcrun stapler validate "${target}"; then
        warn "the stapled ticket of ${label} is not valid."
        NOTARIZED="no"
        return 0
    fi

    info "${label} is notarised and stapled"
    NOTARIZED="yes"
}

# Where the release workflow looks to see whether the image is notarised.
STATUS_FILE="${BUILD_DIR}/notarization.status"

notarize_one "${APP}" "Zode.app"

# -----------------------------------------------------------------------------
# 5. Build the disk image
# -----------------------------------------------------------------------------
log "Building the disk image"
rm -rf "${STAGE_DIR}"
mkdir -p "${STAGE_DIR}"
cp -R "${APP}" "${STAGE_DIR}/"

# A symlink to /Applications so the user can drag the app across.
ln -s /Applications "${STAGE_DIR}/Applications"

rm -f "${DMG_PATH}"
hdiutil create \
    -volname "Zode" \
    -srcfolder "${STAGE_DIR}" \
    -ov \
    -format UDZO \
    -imagekey zlib-level=9 \
    "${DMG_PATH}" || die "hdiutil create failed"

info "image       : ${DMG_PATH}"
info "size        : $(du -h "${DMG_PATH}" | cut -f1)"

# -----------------------------------------------------------------------------
# 6. Sign the disk image, then notarise and staple it
# -----------------------------------------------------------------------------
# The .dmg is what the user downloads, so the .dmg is what Gatekeeper looks at.
log "Signing the disk image"
if [ -n "${IDENTITY:-}" ] && [ "${HAVE_DEVELOPER_ID}" = "yes" ]; then
    codesign --force --timestamp --sign "${IDENTITY}" "${DMG_PATH}" \
        || die "signing the disk image failed"
    info "signed with: ${IDENTITY}"
else
    codesign --force --sign - "${DMG_PATH}" 2>/dev/null \
        || warn "the disk image could not be signed ad-hoc"
fi

notarize_one "${DMG_PATH}" "Zode.dmg"

# -----------------------------------------------------------------------------
# 7. Verify — the same check Gatekeeper makes
# -----------------------------------------------------------------------------
log "Verifying with Gatekeeper"
if spctl --assess --type open --context context:primary-signature -v "${DMG_PATH}" 2>&1 | sed 's/^/    /'; then
    info "the disk image passes Gatekeeper — it will open without a warning"
else
    warn "the disk image does NOT pass Gatekeeper."
    warn "A downloaded copy will be moved to the Trash on open."
    warn "On your own Mac you can bypass it with:"
    warn "    xattr -dr com.apple.quarantine /Volumes/Zode/Zode.app"
    warn "See docs/RELEASING.md for the notarisation setup."
fi

# The status, so the release notes can say whether the image will open
# without a Gatekeeper warning.
if [ "${NOTARIZED}" = "yes" ]; then
    printf 'notarized\n' > "${STATUS_FILE}"
else
    printf 'not-notarized\n' > "${STATUS_FILE}"
fi

log "Done"
info "dmg         : ${DMG_PATH}"
info "app version : ${APP_VERSION}"
if [ "${NOTARIZED}" = "yes" ]; then
    info "notarised   : yes — it will open without a Gatekeeper warning"
else
    info "notarised   : NO — a downloaded copy will be moved to the Trash"
    info "             see docs/RELEASING.md for the one-time Apple setup"
fi
