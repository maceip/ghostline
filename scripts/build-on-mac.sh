#!/usr/bin/env bash
#
# Build and verify Zode on a Mac.
#
#   ./scripts/build-on-mac.sh            # from the repository root
#   ./scripts/build-on-mac.sh /path/to/zode
#
# WHAT THIS DOES
# --------------
# Four stages, in order, and it does NOT stop at the first failure — it runs
# everything and prints one report at the end, so a single paste tells the
# whole story.
#
#   1. the static validators   (contract, web app, library sync, release
#                               tooling, Swift syntax)
#   2. the macOS shell COMPILES  (xcodebuild, unsigned)
#   3. the iOS client COMPILES    (xcodebuild for the simulator, unsigned)
#   4. the .dmg BUILDS            (ad-hoc signed, no Apple account needed)
#
# Unsigned is the point: proving the code compiles does not need a developer
# account, a provisioning profile or a team id.  Signing and notarisation are
# a separate step — see docs/RELEASING.md.
#
# EVERYTHING IS LOGGED.  Full logs land in build-on-mac.log next to this
# script; the report at the end is the short version.
#
set -uo pipefail

REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO" || { echo "cannot enter $REPO"; exit 1; }

LOG="$REPO/build-on-mac.log"
: > "$LOG"

BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
RESULTS=()
FAILURES=0

stage() { printf '\n%s=== %s ===%s\n' "$BOLD" "$1" "$OFF"; printf '\n=== %s ===\n' "$1" >> "$LOG"; }
say()   { printf '    %s\n' "$*"; printf '    %s\n' "$*" >> "$LOG"; }
ok()    { printf '    %sPASS%s  %s\n' "$GREEN" "$OFF" "$*"; printf '    PASS  %s\n' "$*" >> "$LOG"; }
bad()   { printf '    %sFAIL%s  %s\n' "$RED" "$OFF" "$*"; printf '    FAIL  %s\n' "$*" >> "$LOG"; FAILURES=$((FAILURES + 1)); }
note()  { printf '    %s%s%s\n' "$YELLOW" "$*" "$OFF"; printf '    %s\n' "$*" >> "$LOG"; }

record() { RESULTS+=("$1|$2"); }

say "repository : $REPO"
say "host       : $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m))"
say "xcode      : $(xcodebuild -version 2>/dev/null | head -1 || echo 'NOT FOUND')"
say "swift      : $(swift --version 2>/dev/null | head -1 || echo 'NOT FOUND')"
say "node       : $(node --version 2>/dev/null || echo 'not installed (the web self-check will be skipped)')"
say "log        : $LOG"

if ! command -v xcodebuild >/dev/null 2>&1; then
    note "xcodebuild was not found — install the Xcode command line tools:"
    note "    xcode-select --install"
fi

# ---------------------------------------------------------------------------
stage "1. static validators"
# ---------------------------------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
    for check in \
        "python3 scripts/export_library.py --check" \
        "python3 scripts/verify_release.py" \
        "python3 shells/macos/tools/validate_pbxproj.py" \
        "python3 shells/windows/tools/verify_shell.py" \
        "python3 mobile/ios/tools/validate_pbxproj.py"
    do
        if output=$($check 2>&1); then
            ok "$check"
        else
            bad "$check"
            echo "$output" | head -20 | sed 's/^/        /'
            echo "$output" | head -40 >> "$LOG"
        fi
    done

    # The web app's own contract self-check.  macOS does not ship Node, so
    # this one is optional — its absence is not a build failure.
    if command -v node >/dev/null 2>&1; then
        if output=$(node apps/web/selfcheck.mjs 2>&1); then
            ok "node apps/web/selfcheck.mjs ($(echo "$output" | grep -oE '[0-9]+/[0-9]+ checks passed' | tail -1))"
        else
            bad "node apps/web/selfcheck.mjs"
            echo "$output" | tail -20 | sed 's/^/        /'
        fi
    else
        note "node is not installed — skipping the web app self-check"
    fi

    # Every Swift file in the Sources build phase.
    if output=$(python3 shells/macos/tools/check_project_sources.py 2>&1); then
        ok "the macOS project compiles every Swift file"
    else
        bad "the macOS project compiles every Swift file"
        echo "$output" | sed 's/^/        /'
    fi
else
    note "python3 not found — skipping the validators"
fi

# ---------------------------------------------------------------------------
stage "2. the macOS shell compiles"
# ---------------------------------------------------------------------------
say "this is the important one: a real xcodebuild against the real macOS SDK"

# Stage the web app and regenerate the project first, exactly as build.sh does.
if ( cd shells/macos && ./build.sh --stage-only ) >> "$LOG" 2>&1; then
    ok "the web app is staged and the Xcode project is generated"
else
    bad "staging the web app / generating the Xcode project"
    tail -30 "$LOG" | sed 's/^/        /'
fi

if ( cd shells/macos && python3 tools/generate_xcodeproj.py ) >> "$LOG" 2>&1; then
    ok "the Xcode project regenerates"
else
    bad "the Xcode project does not regenerate"
fi

BUILD_LOG="$REPO/build-on-mac.xcodebuild.log"
if xcodebuild \
        -project shells/macos/Zode.xcodeproj \
        -scheme Zode \
        -configuration Release \
        -destination 'generic/platform=macOS' \
        -derivedDataPath "$REPO/.build-on-mac/macos" \
        CODE_SIGNING_ALLOWED=NO \
        CODE_SIGNING_REQUIRED=NO \
        CODE_SIGN_IDENTITY="" \
        build > "$BUILD_LOG" 2>&1; then
    ok "the macOS shell compiles (Release, unsigned)"
    say "product: .build-on-mac/macos/Build/Products/Release/Zode.app"
else
    bad "the macOS shell does not compile"
    echo "        --- errors ---"
    grep -E "error:" "$BUILD_LOG" | sort -u | head -40 | sed 's/^/        /'
    ERROR_COUNT=$(grep -c "error:" "$BUILD_LOG" || true)
    say "$ERROR_COUNT error line(s) in $BUILD_LOG"
fi

# Warnings are worth showing but they do not fail the build.
WARN_COUNT=$(grep -c "warning:" "$BUILD_LOG" 2>/dev/null || echo 0)
if [ "${WARN_COUNT:-0}" -gt 0 ]; then
    say "$WARN_COUNT warning(s) — first few:"
    grep -E "warning:" "$BUILD_LOG" | sort -u | head -8 | sed 's/^/        /'
fi

# ---------------------------------------------------------------------------
stage "3. the iOS client compiles"
# ---------------------------------------------------------------------------
if ( cd mobile/ios && python3 tools/generate_xcodeproj.py ) >> "$LOG" 2>&1; then
    ok "the iOS project regenerates"
else
    bad "the iOS project does not regenerate"
fi

IOS_LOG="$REPO/build-on-mac.ios.log"
if xcodebuild \
        -project mobile/ios/ZodeMobile.xcodeproj \
        -scheme ZodeMobile \
        -configuration Debug \
        -sdk iphonesimulator \
        -destination 'generic/platform=iOS Simulator' \
        -derivedDataPath "$REPO/.build-on-mac/ios" \
        CODE_SIGNING_ALLOWED=NO \
        CODE_SIGNING_REQUIRED=NO \
        CODE_SIGN_IDENTITY="" \
        build > "$IOS_LOG" 2>&1; then
    ok "the iOS client compiles (simulator, unsigned)"
else
    bad "the iOS client does not compile"
    echo "        --- errors ---"
    grep -E "error:" "$IOS_LOG" | sort -u | head -30 | sed 's/^/        /'
fi

# ---------------------------------------------------------------------------
stage "4. the .dmg builds"
# ---------------------------------------------------------------------------
# Ad-hoc signed, no notarisation: that needs an Apple account, which is a
# separate step.  This proves the disk image is produced.
if ( cd shells/macos && ./build-dmg.sh --no-notarize ) >> "$LOG" 2>&1; then
    if [ -f shells/macos/build/Zode.dmg ]; then
        ok "the disk image builds ($(du -h shells/macos/build/Zode.dmg | cut -f1))"
        say "shells/macos/build/Zode.dmg"
    else
        bad "the disk image script reported success but produced no .dmg"
    fi
else
    bad "the disk image does not build"
    tail -30 "$LOG" | sed 's/^/        /'
fi

# ---------------------------------------------------------------------------
stage "4b. the app in the disk image runs"
# ---------------------------------------------------------------------------
# The shell can prove itself: it resolves its resources the same way the
# app does and reports whether they are all there.  This is the check that
# catches an app bundle that was packaged without its web app.
DMG="shells/macos/build/Zode.dmg"
if [ -f "$DMG" ]; then
    MOUNT=$(mktemp -d)
    if hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" >/dev/null 2>&1; then
        if "$MOUNT/Zode.app/Contents/MacOS/Zode" --selftest; then
            ok "the app inside the disk image starts and finds its resources"
        else
            bad "the app inside the disk image does not pass its self test"
        fi
        hdiutil detach "$MOUNT" >/dev/null 2>&1
    else
        bad "the disk image could not be mounted"
    fi
else
    bad "no disk image to test"
fi

# ---------------------------------------------------------------------------
stage "5. report"
# ---------------------------------------------------------------------------
printf '\n%s  Zode on the Mac — summary%s\n' "$BOLD" "$OFF"
printf '  host: %s %s (%s)\n' "$(sw_vers -productName)" "$(sw_vers -productVersion)" "$(uname -m)"
printf '  xcode: %s\n\n' "$(xcodebuild -version 2>/dev/null | head -1)"

for entry in "${RESULTS[@]}"; do
    printf '  %s\n' "$entry"
done

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
    printf '  %sEVERYTHING PASSED%s\n' "$GREEN" "$OFF"
else
    printf '  %s%d stage(s) FAILED%s\n' "$RED" "$FAILURES" "$OFF"
    printf '  the full logs are in:\n    %s\n    %s\n    %s\n' \
        "$LOG" "$BUILD_LOG" "$IOS_LOG"
fi

printf '\n%s  ===== PASTE EVERYTHING ABOVE THIS LINE BACK TO ME =====%s\n' "$BOLD" "$OFF"
printf '  (and if something failed, the lines under "--- errors ---")\n'

exit $([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)
