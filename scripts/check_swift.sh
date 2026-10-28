#!/usr/bin/env bash
#
# Parse every Swift source in the repository.
#
#   ./scripts/check_swift.sh
#
# `swiftc -parse` does the syntactic analysis only: it does not resolve the
# imports, so it runs on Linux as well as on macOS and it catches the class of
# error that is easiest to introduce and hardest to see — an unbalanced
# `#if`, a missing brace, a malformed string literal — without needing the
# macOS SDK.
#
# It is NOT a type check.  That needs the real SDK and happens in
# .github/workflows/ci.yml on the macos runner.
#
# If no Swift compiler is installed the script says so and exits 0, so it can
# be wired into a check list without failing a machine that has no toolchain.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SWIFTC="${SWIFTC:-}"
if [[ -z "$SWIFTC" ]]; then
    if command -v swiftc >/dev/null 2>&1; then
        SWIFTC="$(command -v swiftc)"
    elif [[ -x /opt/swift/usr/bin/swiftc ]]; then
        SWIFTC=/opt/swift/usr/bin/swiftc
        export LD_LIBRARY_PATH="/opt/swift/usr/lib/swift/linux:/opt/swift/usr/lib:${LD_LIBRARY_PATH:-}"
    fi
fi

if [[ -z "$SWIFTC" ]]; then
    echo "  no Swift compiler found — skipping the parse check"
    exit 0
fi

echo "  using $("$SWIFTC" --version 2>/dev/null | head -1)"

FAIL=0
COUNT=0
while IFS= read -r -d '' file; do
    COUNT=$((COUNT + 1))
    if ! output="$("$SWIFTC" -parse "$file" 2>&1)"; then
        FAIL=$((FAIL + 1))
        echo "  PARSE FAIL: $file"
        echo "$output" | sed 's/^/      /' | head -12
    fi
done < <(find shells/macos/Zode mobile/ios -name '*.swift' -print0 2>/dev/null)

if [[ "$FAIL" -gt 0 ]]; then
    echo "  $FAIL of $COUNT Swift files failed to parse"
    exit 1
fi

echo "  all $COUNT Swift files parse"
