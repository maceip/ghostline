#!/usr/bin/env bash
#
# Compile the Zode Windows shell.
#
#   ./scripts/check_windows_build.sh
#
# The shell is raw Win32 plus Edge WebView2, but it still compiles on Linux:
# the project sets `EnableWindowsTargeting`, so the .NET SDK restores the
# Windows SDK projections and the WebView2 reference assemblies and compiles
# the same sources the Windows runner does.  Only the *run* needs Windows.
#
# That means a Windows compile error is caught in seconds on any machine,
# instead of waiting for the windows runner in CI.
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
    echo "  no .NET SDK found — skipping the Windows compile"
    exit 0
fi

echo "  using $("$DOTNET" --version 2>/dev/null | head -1)"

export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

"$DOTNET" build shells/windows/Zode.Shell/Zode.Shell.csproj \
    -c Release \
    -v minimal \
    --nologo
