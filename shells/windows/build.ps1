<#
.SYNOPSIS
    Builds the Zode Windows shell (unpackaged).

.DESCRIPTION
    Publishes Zode.Shell for win-x64 and win-arm64, copies the bundled web
    app into the publish output (web/) and the application icon next to the
    executable.

    The UNPACKAGED build needs NO signing certificate and NO admin rights:
    the shell registers its AppUserModelID and a per-user Start Menu shortcut
    on first launch (see Platform/AppIdentity.cs), which is what makes toast
    notifications work without package identity.

    App Actions (contract §4) and App Content Search (contract §10) DO need
    package identity — use build-msix.ps1 for those.

.PARAMETER Configuration
    Release (default) or Debug.

.PARAMETER Runtimes
    Runtime identifiers to publish. Default: win-x64 and win-arm64.

.PARAMETER WebAppPath
    Folder that contains the built web app (index.html).  When omitted the
    script looks in ../../apps/web/{dist,build,public,src} and ../../apps/web.

.EXAMPLE
    pwsh ./build.ps1
    pwsh ./build.ps1 -Runtimes win-x64
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string[]]$Runtimes = @('win-x64', 'win-arm64'),
    [string]$WebAppPath,
    [switch]$SkipWebApp
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectFile = Join-Path $scriptRoot 'Zode.Shell\Zode.Shell.csproj'
$iconFile = Join-Path $scriptRoot 'icons\zode.ico'
$publishRoot = Join-Path $scriptRoot 'artifacts'

function Write-Step([string]$message) {
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Write-Fail([string]$message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    throw $message
}

# ---------------------------------------------------------------------------
# 1. Toolchain
# ---------------------------------------------------------------------------
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Fail @"
'dotnet' was not found on PATH.

Install the .NET 10 SDK (https://dotnet.microsoft.com/download) and make sure
that 'dotnet --version' prints 10.x, then run this script again.
"@
}

$dotnetVersion = (& dotnet --version).Trim()
Write-Step "using the .NET SDK $dotnetVersion"

# ---------------------------------------------------------------------------
# 2. The bundled web app
# ---------------------------------------------------------------------------
function Resolve-WebAppPath {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) {
            Write-Fail "the web app folder '$Explicit' does not exist."
        }
        return (Resolve-Path $Explicit).Path
    }

    $repoRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
    $repoApps = Join-Path $repoRoot 'apps\web'
    $candidates = @(
        (Join-Path $repoRoot 'dist'),
        (Join-Path $repoApps 'dist'),
        (Join-Path $repoApps 'build'),
        (Join-Path $repoApps 'public'),
        (Join-Path $repoApps 'src'),
        $repoApps
    )

    foreach ($candidate in $candidates) {
        if ((Test-Path $candidate) -and (Test-Path (Join-Path $candidate 'index.html'))) {
            Write-Step "using the web app in $candidate"
            return (Resolve-Path $candidate).Path
        }
    }

    Write-Fail @"
The web app was not found.

The shell serves the bundled web app from https://app.zode.local/index.html,
so a build of the web app is required.  Expected one of:
  $((($candidates | ForEach-Object { '  - ' + $_ }) -join "`n"))

Build the web app first (see apps/web), or pass -WebAppPath <folder> with the
folder that contains index.html.

If you only want to try the shell without the web app, run it with the
environment variable ZODE_DEV_URL pointing at your dev server.
"@
}

$webRoot = $null
if (-not $SkipWebApp) {
    $webRoot = Resolve-WebAppPath -Explicit $WebAppPath
} else {
    Write-Step "skipping the web app copy (-SkipWebApp)"
}

# ---------------------------------------------------------------------------
# 3. Publish
# ---------------------------------------------------------------------------
if (Test-Path $publishRoot) {
    Remove-Item $publishRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $publishRoot | Out-Null

foreach ($runtime in $Runtimes) {
    $output = Join-Path $publishRoot $runtime

    Write-Step "publishing $Configuration/$runtime"
    & dotnet publish $projectFile `
        --configuration $Configuration `
        --runtime $runtime `
        --self-contained false `
        --output $output `
        -p:Platform=AnyCPU `
        -p:PublishReadyToRun=false

    if ($LASTEXITCODE -ne 0) {
        Write-Fail "dotnet publish failed for $runtime (exit code $LASTEXITCODE)."
    }

    if ($webRoot) {
        $webTarget = Join-Path $output 'web'
        Write-Step "copying the web app into $webTarget"
        New-Item -ItemType Directory -Path $webTarget -Force | Out-Null
        Copy-Item -Path (Join-Path $webRoot '*') -Destination $webTarget -Recurse -Force
    }

    if (Test-Path $iconFile) {
        Copy-Item $iconFile -Destination (Join-Path $output 'zode.ico') -Force
    }

    Write-Host "    -> $output" -ForegroundColor Green
}

Write-Step "done. The unpackaged build needs no signing certificate."
Write-Host "Run it with:" -ForegroundColor Cyan
Write-Host "  $publishRoot\win-x64\Zode.Shell.exe" -ForegroundColor Cyan
Write-Host "Development against a dev server:" -ForegroundColor Cyan
Write-Host "  `$env:ZODE_DEV_URL = 'http://localhost:5173'; & '$publishRoot\win-x64\Zode.Shell.exe'" -ForegroundColor Cyan
