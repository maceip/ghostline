#!/usr/bin/env bash
#
# Parse every C# source in the repository.
#
#   ./scripts/check_csharp.sh
#
# The Windows shell can only be fully compiled on Windows — it is Win32 and
# Edge WebView2.  But a *syntax* check runs anywhere the .NET SDK is
# installed: Roslyn parses the files without resolving a single reference, so
# the Win32 types never have to exist.
#
# That catches an unbalanced brace or a malformed attribute in seconds on any
# machine.  The full compile happens in .github/workflows/ci.yml on the
# Windows runner.
#
# If no .NET SDK is installed the script says so and exits 0.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DOTNET="${DOTNET:-}"
if [[ -z "$DOTNET" ]]; then
    if command -v dotnet >/dev/null 2>&1; then
        DOTNET="$(command -v dotnet)"
    elif [[ -x /opt/dotnet/dotnet ]]; then
        DOTNET=/opt/dotnet/dotnet
    fi
fi

if [[ -z "$DOTNET" ]]; then
    echo "  no .NET SDK found — skipping the C# parse check"
    exit 0
fi

echo "  using $("$DOTNET" --version 2>/dev/null | head -1)"

CHECKER_DIR="tools/csharp-syntax-check"
BUILD_DIR="${TMPDIR:-/tmp}/zode-csharp-syntax-check"

export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

"$DOTNET" build "$CHECKER_DIR/cschk.csproj" -c Release -v quiet --nologo -o "$BUILD_DIR" \
    || { echo "  could not build the syntax checker"; exit 1; }

"$DOTNET" "$BUILD_DIR/zode-csharp-syntax-check.dll" \
    $(find shells/windows -name '*.cs' | sort)
