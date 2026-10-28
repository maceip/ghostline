<#
.SYNOPSIS
    Builds the Zode Windows shell as an .msi installer (and a .zip).

.DESCRIPTION
    Publishes the shell for win-x64, copies the bundled web app next to the
    executable and packages the whole thing as a Windows Installer package
    with WiX v5.

    The web app has to sit NEXT TO the executable: the shell maps it into the
    webview with SetVirtualHostNameToFolderMapping and reads it from
    AppContext.BaseDirectory\web.  A single-file publish would therefore
    break the app, which is why this produces an installer and a zip rather
    than one lone .exe.

    The installer is per-user: no administrator rights, the app lands in the
    user's own AppData and a Start menu shortcut is created.

    WiX v5 is installed as a .NET tool if it is not already on PATH.

.PARAMETER Configuration
    Release (default) or Debug.

.PARAMETER Runtime
    Runtime identifier. Default: win-x64.

.PARAMETER SelfContained
    Publish self-contained, so the installed app needs no .NET runtime.
    Off by default: the .NET 10 Desktop Runtime is small and most developers
    already have it.  Turn it on to ship the app to people who do not.

.PARAMETER WebAppPath
    Folder that contains the built web app (index.html).  When omitted the
    script looks in ../../apps/web and its usual build output folders.

.EXAMPLE
    pwsh ./build-msi.ps1
    pwsh ./build-msi.ps1 -SelfContained
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$Runtime = 'win-x64',
    [switch]$SelfContained,
    [string]$WebAppPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# WiX v5 is the version the installer source is written against: the
# <Files> element that harvests a whole directory is a v5 feature.
$WixVersion = '5.0.2'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectFile = Join-Path $scriptRoot 'Zode.Shell\Zode.Shell.csproj'
$iconFile = Join-Path $scriptRoot 'icons\zode.ico'
$wxsFile = Join-Path $scriptRoot 'msi\Zode.wxs'
$publishRoot = Join-Path $scriptRoot 'artifacts'
$outputRoot = Join-Path $scriptRoot 'artifacts\release'

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
    Write-Fail "'dotnet' was not found on PATH.  Install the .NET 10 SDK and try again."
}
Write-Step "using the .NET SDK $((& dotnet --version).Trim())"

if (-not (Test-Path $wxsFile)) { Write-Fail "the installer source was not found at $wxsFile" }
if (-not (Test-Path $iconFile)) { Write-Fail "the application icon was not found at $iconFile" }

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
        $repoApps
    )

    foreach ($candidate in $candidates) {
        if ((Test-Path $candidate) -and (Test-Path (Join-Path $candidate 'index.html'))) {
            Write-Step "using the web app in $candidate"
            return (Resolve-Path $candidate).Path
        }
    }

    Write-Fail "the web app was not found.  Expected one of: $($candidates -join ', ')"
}

$webRoot = Resolve-WebAppPath -Explicit $WebAppPath

# ---------------------------------------------------------------------------
# 3. Publish
# ---------------------------------------------------------------------------
$publishDir = Join-Path $publishRoot $Runtime
if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force }
New-Item -ItemType Directory -Path $publishDir -Force | Out-Null

Write-Step "publishing $Configuration/$Runtime (self-contained: $SelfContained)"
$publishArgs = @(
    'publish', $projectFile,
    '--configuration', $Configuration,
    '--runtime', $Runtime,
    '--output', $publishDir,
    '-p:Platform=AnyCPU',
    '-p:PublishReadyToRun=false',
    '-p:DebugType=none'
)
if ($SelfContained) {
    $publishArgs += '--self-contained'
} else {
    $publishArgs += '--self-contained', 'false'
}

& dotnet @publishArgs
if ($LASTEXITCODE -ne 0) { Write-Fail "dotnet publish failed (exit code $LASTEXITCODE)." }

Write-Step "copying the web app into the publish output"
$webTarget = Join-Path $publishDir 'web'
New-Item -ItemType Directory -Path $webTarget -Force | Out-Null
Copy-Item -Path (Join-Path $webRoot '*') -Destination $webTarget -Recurse -Force
Copy-Item $iconFile -Destination (Join-Path $publishDir 'zode.ico') -Force

# ---------------------------------------------------------------------------
# 4. WiX
# ---------------------------------------------------------------------------
function Get-WixCommand {
    # The .NET tool lands in %USERPROFILE%\.dotnet\tools, which is not always
    # on PATH in a fresh shell.
    $toolDir = Join-Path $env:USERPROFILE '.dotnet\tools'
    if (-not ($env:PATH -split ';' | Where-Object { $_ -eq $toolDir })) {
        $env:PATH = "$toolDir;$env:PATH"
    }

    if (Get-Command wix -ErrorAction SilentlyContinue) { return 'wix' }

    Write-Step "installing the WiX toolset $WixVersion"
    # The version is pinned: the <Files> element of the installer source is a
    # WiX v5 feature, and a newer major version may change it.
    & dotnet tool uninstall --global wix 2>$null | Out-Null
    # The install prints to stdout.  It must NOT become the return value of
    # this function, or the caller ends up running the install message as if
    # it were the path of the tool.
    & dotnet tool install --global wix --version $WixVersion | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Fail @"
The WiX toolset could not be installed.

Install it by hand and run this script again:

    dotnet tool install --global wix --version $WixVersion

(or download it from https://wixtoolset.org and put wix.exe on PATH).
"@
    }
    if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
        Write-Fail "'wix' is still not on PATH after the install."
    }
    return 'wix'
}

$wix = Get-WixCommand

# ---------------------------------------------------------------------------
# 5. Build the .msi
# ---------------------------------------------------------------------------
if (Test-Path $outputRoot) { Remove-Item $outputRoot -Recurse -Force }
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

$version = '1.0.0'
try {
    $version = ([xml](Get-Content $projectFile)).Project.PropertyGroup.Version
    if (-not $version) { $version = '1.0.0' }
} catch {
    $version = '1.0.0'
}

$msiPath = Join-Path $outputRoot "Zode-$version-windows-$Runtime.msi"

Write-Step "building the installer"
& $wix build $wxsFile `
    '-d' "ZodeAppDir=$publishDir" `
    '-d' "ZodeIcon=$iconFile" `
    '-d' "ZodeVersion=$version" `
    '-o' $msiPath

if ($LASTEXITCODE -ne 0) { Write-Fail "wix build failed (exit code $LASTEXITCODE)." }
if (-not (Test-Path $msiPath)) { Write-Fail "the installer was not produced at $msiPath" }

# ---------------------------------------------------------------------------
# 6. The portable .zip
# ---------------------------------------------------------------------------
# The shell needs its web/ folder next to the executable, so the "just the
# .exe" download is really a zip.  The .msi does the same job automatically.
$zipPath = Join-Path $outputRoot "Zode-$version-windows-$Runtime.zip"
Write-Step "zipping the portable build"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $publishDir '*') -DestinationPath $zipPath

# The bare executable, for people who want to drop it next to a web/ folder.
$exePath = Join-Path $outputRoot 'Zode.Shell.exe'
Copy-Item (Join-Path $publishDir 'Zode.Shell.exe') $exePath -Force

Write-Step "done"
Write-Host "  installer : $msiPath" -ForegroundColor Green
Write-Host "  portable  : $zipPath" -ForegroundColor Green
Write-Host "  executable: $exePath" -ForegroundColor Green
Write-Host "Install with:  msiexec /i `"$msiPath`"" -ForegroundColor Cyan
