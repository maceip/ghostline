#!/usr/bin/env bash
#
# Run every check that can be performed WITHOUT a Mac, a Windows box, or an
# Android SDK. This is the local counterpart of .github/workflows/ci.yml.
#
# Anything that needs a real toolchain is reported as SKIPPED rather than
# silently passing — the point is to be honest about what is actually verified.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
SKIP=0
FAILED_NAMES=()

hr() { printf '%s\n' "────────────────────────────────────────────────────────────"; }

run() {
  local name="$1"; shift
  hr
  printf '▶ %s\n' "$name"
  hr
  if "$@"; then
    printf '✅ %s\n\n' "$name"
    PASS=$((PASS + 1))
  else
    printf '❌ %s\n\n' "$name"
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$name")
  fi
}

skip() {
  hr
  printf '⏭  %s\n' "$1"
  printf '   %s\n\n' "$2"
  SKIP=$((SKIP + 1))
}

# ---------------------------------------------------------------------------
# Shared contract
# ---------------------------------------------------------------------------
check_shared() {
  python3 - <<'PY'
import json, sys, pathlib
root = pathlib.Path("packages/shared")
for f in ("contract.md", "haptics.json", "tokens.css"):
    p = root / f
    if not p.exists():
        print(f"MISSING {p}"); sys.exit(1)
d = json.load(open(root / "haptics.json"))
assert d["version"] == 1, "haptics.json version != 1"
for name in ("done", "working"):
    assert name in d["programs"], f"missing haptic program: {name}"
done = d["programs"]["done"]
assert len(done["tracks"]) == 3, "done must be a triple roll (3 tracks)"
working = d["programs"]["working"]
assert working["loop"] is True, "working must loop"
print(f"contract assets OK — {len(d['programs'])} haptic programs, "
      f"done={len(done['tracks'])} tracks, working loops")
PY
}

# ---------------------------------------------------------------------------
# Web app
# ---------------------------------------------------------------------------
check_web_parses() {
  local fail=0
  while IFS= read -r -d '' f; do
    node --check "$f" || { echo "PARSE FAIL: $f"; fail=1; }
  done < <(find src tests -name '*.js' -o -name '*.mjs' -print0)
  return $fail
}

check_web_no_bare_imports() {
  if grep -rnE "^[[:space:]]*import .*from ['\"][^./]" src/bridge --include='*.js' \
       | grep -v "from ['\"]node:"; then
    echo "bare specifier import found — the bridge must stay dependency-free"
    return 1
  fi
  echo "no bare imports in bridge"
}

check_web_selfcheck() {
  npm test
}

# ---------------------------------------------------------------------------
# Per-platform validators
# ---------------------------------------------------------------------------
run_macos_validator() {
  (cd shells/macos && ./build.sh --stage-only >/dev/null)
  python3 shells/macos/tools/validate_pbxproj.py
}
run_windows_validator() {
  python3 shells/windows/tools/verify_shell.py
}
run_ios_validator() {
  mkdir -p mobile/ios/ZodeMobile/Resources/web
  if [[ -d dist ]]; then
    cp -R dist/. mobile/ios/ZodeMobile/Resources/web/
  fi
  python3 mobile/ios/tools/validate_pbxproj.py
}
run_android_validator() {
  python3 mobile/android/tools/verify_android.py
}

# ---------------------------------------------------------------------------
# The library must be the SAME library on every platform.
# ---------------------------------------------------------------------------
check_library_sync() {
  python3 scripts/export_library.py --check
}

# ---------------------------------------------------------------------------
# Python syntax everywhere
# ---------------------------------------------------------------------------
check_python_compiles() {
  python3 -m compileall -q icons scripts shells mobile packages >/dev/null
}

# ---------------------------------------------------------------------------
# Shell script syntax
# ---------------------------------------------------------------------------
check_shell_syntax() {
  local fail=0
  while IFS= read -r -d '' f; do
    bash -n "$f" || { echo "SYNTAX FAIL: $f"; fail=1; }
  done < <(find . -name '*.sh' -not -path './.git/*' -not -path './node_modules/*' -print0)
  return $fail
}

# ---------------------------------------------------------------------------
# The release tooling — the workflow, the installer source, the disk image
# script.  Static checks only: it does not need a Mac, a Windows box or an
# Apple account.
# ---------------------------------------------------------------------------
check_release_tooling() {
  python3 scripts/verify_release.py
}

# ---------------------------------------------------------------------------
# Swift syntax.  `swiftc -parse` does not need the macOS SDK, so this runs
# on Linux too.  It is a syntax check, not a type check.
# ---------------------------------------------------------------------------
check_swift_parses() {
  bash scripts/check_swift.sh
}

# ---------------------------------------------------------------------------
# C# syntax.  Roslyn parses the sources without resolving a reference, so
# the Win32 and WebView2 types never have to exist — this runs on Linux too.
# ---------------------------------------------------------------------------
check_csharp_parses() {
  bash scripts/check_csharp.sh
}

# ---------------------------------------------------------------------------
# The Windows shell really compiles.  `EnableWindowsTargeting` means this
# works on Linux as well, so a Win32 compile error is caught in seconds
# instead of waiting for the Windows runner.
# ---------------------------------------------------------------------------
check_windows_build() {
  bash scripts/check_windows_build.sh
}

# ---------------------------------------------------------------------------
# Every Swift file on disk must be in the Xcode project's Sources phase,
# otherwise its types are "cannot find type in scope" at build time.
# ---------------------------------------------------------------------------
check_project_sources() {
  python3 shells/macos/tools/check_project_sources.py
  python3 mobile/ios/tools/check_project_sources.py
}

# ---------------------------------------------------------------------------
# Secrets audit — nothing sensitive may be committed
# ---------------------------------------------------------------------------
check_no_secrets() {
  local hits
  hits=$(grep -rInE "(ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})" \
         . --exclude-dir=.git --exclude-dir=.mavis --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.gradle --exclude-dir=build 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    echo "$hits"
    return 1
  fi
  echo "no credential patterns committed"
}

# ===========================================================================
printf '\n\n'
printf '  zode — local verification\n'
printf '  %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
printf '\n'

run "shared contract assets"            check_shared
run "web: every module parses"          check_web_parses
run "web: no bare-specifier imports"    check_web_no_bare_imports
run "web: contract self-check"          check_web_selfcheck
run "library: in sync across platforms" check_library_sync
run "python: all files compile"         check_python_compiles
run "shell: syntax"                     check_shell_syntax
run "security: no committed credentials" check_no_secrets
run "release: workflow + installer"      check_release_tooling
run "swift: every source parses"         check_swift_parses
run "csharp: every source parses"        check_csharp_parses
run "windows: the shell compiles"       check_windows_build
run "xcode: every source is compiled"    check_project_sources

if [[ -f shells/macos/tools/validate_pbxproj.py ]]; then
  run "macOS: Xcode project structure"   run_macos_validator
else
  skip "macOS: Xcode project structure" "shells/macos/tools/validate_pbxproj.py not found"
fi

if [[ -f shells/windows/tools/verify_shell.py ]]; then
  run "Windows: shell contract check"   run_windows_validator
else
  skip "Windows: shell contract check" "shells/windows/tools/verify_shell.py not found"
fi

if [[ -f mobile/ios/tools/validate_pbxproj.py ]]; then
  run "iOS: Xcode project structure"     run_ios_validator
else
  skip "iOS: Xcode project structure" "mobile/ios/tools/validate_pbxproj.py not found"
fi

if [[ -f mobile/android/tools/verify_android.py ]]; then
  run "Android: project + source check"  run_android_validator
else
  skip "Android: project + source check" "mobile/android/tools/verify_android.py not found"
fi

# ---------------------------------------------------------------------------
skip "macOS: Swift compilation" "needs a macOS toolchain — run .github/workflows/ci.yml on the macos runner"
skip "Windows: C# compilation" "needs a Windows SDK — run .github/workflows/ci.yml on the windows runner"
skip "Android: Gradle assemble" "needs the Android SDK — run .github/workflows/ci.yml"
skip "iOS: Swift compilation" "needs a macOS toolchain — run .github/workflows/ci.yml on the macos runner"

hr
printf '\n  passed %d   failed %d   skipped %d\n\n' "$PASS" "$FAIL" "$SKIP"
if (( FAIL > 0 )); then
  printf '  failed checks:\n'
  for n in "${FAILED_NAMES[@]}"; do printf '    - %s\n' "$n"; done
  printf '\n'
  exit 1
fi
printf '  all runnable checks passed\n\n'
