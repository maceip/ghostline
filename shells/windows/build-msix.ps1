<#
.SYNOPSIS
    Builds the Zode Windows shell as an MSIX package (packaged build).

.DESCRIPTION
    The packaged build is the ONLY way to get the Windows 11 App Actions
    (contract §4) and the App Content Search integration (contract §10):
    both require package identity.

    Unlike the unpackaged build (build.ps1 — which needs NO certificate) an
    MSIX package MUST be signed with a certificate whose subject matches the
    Publisher attribute of msix/Package.appxmanifest.

    Two ways to provide the certificate:
      * -PfxPath/-PfxPassword  : an existing .pfx (recommended for CI).
      * -CreateDevCertificate  : creates a self-signed certificate in the
                                 current user's certificate store, so that the
                                 package can be installed on the same machine.

    The script publishes the unpackaged output, assembles the package layout
    (appx assets, manifest, appactions.json) and calls MakeAppx.exe from the
    Windows SDK.  SignTool.exe signs it when a certificate is available.

.PARAMETER Configuration
    Release (default) or Debug.

.PARAMETER PfxPath
    Path to the .pfx used for signing.

.PARAMETER PfxPassword
    Password of the .pfx.

.PARAMETER CreateDevCertificate
    Create a self-signed development certificate in the current user store.

.PARAMETER SkipSigning
    Produce an unsigned package (MakeAppx still needs a publisher in the
    manifest; the package can only be installed on a machine that trusts the
    certificate).

.EXAMPLE
    pwsh ./build-msix.ps1 -CreateDevCertificate
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$PfxPath,
    [string]$PfxPassword,
    [switch]$CreateDevCertificate,
    [switch]$SkipSigning
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectFile = Join-Path $scriptRoot 'Zode.Shell\Zode.Shell.csproj'
$msixRoot = Join-Path $scriptRoot 'msix'
$stageRoot = Join-Path $scriptRoot 'artifacts\msix'
$publishDir = Join-Path $scriptRoot 'artifacts\win-x64'
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)

function Write-Step([string]$message) {
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Write-Fail([string]$message) {
    Write-Host "ERROR: $message" -ForegroundColor Red
    throw $message
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Fail "'dotnet' was not found on PATH. Install the .NET 10 SDK and try again."
}

# ---------------------------------------------------------------------------
# 1. The Windows SDK tools (MakeAppx / SignTool)
# ---------------------------------------------------------------------------
function Find-SdkTool([string]$toolName) {
    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "$env:ProgramFiles\Windows Kits\10\bin"
    ) | Where-Object { $_ -and (Test-Path $_) }

    foreach ($root in $roots) {
        $found = Get-ChildItem -Path $root -Filter "$toolName.exe" -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'x64' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }

    return $null
}

$makeAppx = Find-SdkTool 'MakeAppx'
if (-not $makeAppx) {
    Write-Fail @"
MakeAppx.exe was not found.

Install the "Windows SDK" (or the "Windows Application Packaging Tool") from
https://developer.microsoft.com/windows/downloads/windows-sdk/ and re-run this
script.  The unpackaged build (build.ps1) does not need it.
"@
}

$signTool = Find-SdkTool 'signtool'
Write-Step "MakeAppx: $makeAppx"

# ---------------------------------------------------------------------------
# 2. Certificate
# ---------------------------------------------------------------------------
$certificateThumbprint = $null
$pfxForSigning = $null

if ($PfxPath) {
    if (-not (Test-Path $PfxPath)) {
        Write-Fail "the certificate '$PfxPath' does not exist."
    }
    $pfxForSigning = (Resolve-Path $PfxPath).Path
    Write-Step "using the certificate $pfxForSigning"
} elseif ($CreateDevCertificate) {
    $subject = 'CN=Zode Development'
    $existing = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $subject } | Select-Object -First 1
    if ($existing) {
        $certificateThumbprint = $existing.Thumbprint
        Write-Step "reusing the development certificate $certificateThumbprint"
    } else {
        $certificateThumbprint = (New-SelfSignedCertificate -Subject $subject -Type Custom -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(3)).Thumbprint
        Write-Step "created the development certificate $certificateThumbprint"
    }
} elseif (-not $SkipSigning) {
    Write-Fail @"
No certificate was provided.

Use -PfxPath <file.pfx> -PfxPassword <password>, or -CreateDevCertificate to
create a self-signed development certificate in the current user store.
"@
}

# ---------------------------------------------------------------------------
# 3. Publish the app
# ---------------------------------------------------------------------------
Write-Step "publishing $Configuration/win-x64"
& dotnet publish $projectFile --configuration $Configuration --runtime win-x64 --self-contained false --output $publishDir
if ($LASTEXITCODE -ne 0) {
    Write-Fail "dotnet publish failed (exit code $LASTEXITCODE)."
}

# ---------------------------------------------------------------------------
# 4. Assemble the package layout
# ---------------------------------------------------------------------------
if (Test-Path $stageRoot) {
    Remove-Item $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stageRoot | Out-Null

Copy-Item (Join-Path $publishDir '*') -Destination $stageRoot -Recurse -Force
Copy-Item (Join-Path $msixRoot 'Package.appxmanifest') -Destination $stageRoot -Force
Copy-Item (Join-Path $msixRoot 'appactions.json') -Destination $stageRoot -Force

# The appx assets: the app icon is resized with System.Drawing.
$assetsDir = Join-Path $stageRoot 'Assets'
New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null
$sourcePng = Join-Path $repoRoot 'icons\zode.png'

Add-Type -AssemblyName System.Drawing
$assetSizes = @{
    'StoreLogo.png'            = 50
    'Square44x44Logo.png'      = 44
    'Square150x150Logo.png'    = 150
    'Wide310x150Logo.png'      = 310
    'SplashScreen.png'         = 620
}

if (Test-Path $sourcePng) {
    $source = [System.Drawing.Image]::FromFile($sourcePng)
    try {
        foreach ($name in $assetSizes.Keys) {
            $size = $assetSizes[$name]
            $bitmap = New-Object System.Drawing.Bitmap $size, $size
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.DrawImage($source, 0, 0, $size, $size)
                $bitmap.Save((Join-Path $assetsDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
            } finally {
                $graphics.Dispose()
                $bitmap.Dispose()
            }
        }
    } finally {
        $source.Dispose()
    }
} else {
    Write-Fail "the app icon '$sourcePng' is missing; the package needs the appx assets."
}

# ---------------------------------------------------------------------------
# 5. MakeAppx + SignTool
# ---------------------------------------------------------------------------
$packagePath = Join-Path (Split-Path -Parent $stageRoot) 'Zode.NativeShell.msix'

Write-Step "creating $packagePath"
& $makeAppx pack /d $stageRoot /p $packagePath /o
if ($LASTEXITCODE -ne 0) {
    Write-Fail "MakeAppx failed (exit code $LASTEXITCODE)."
}

if (-not $SkipSigning -and $signTool) {
    if ($pfxForSigning) {
        Write-Step "signing with $pfxForSigning"
        & $signTool sign /fd SHA256 /f $pfxForSigning /p $PfxPassword /tr http://timestamp.digicert.com /td SHA256 $packagePath
    } elseif ($certificateThumbprint) {
        Write-Step "signing with the certificate $certificateThumbprint"
        & $signTool sign /fd SHA256 /sha1 $certificateThumbprint /tr http://timestamp.digicert.com /td SHA256 $packagePath
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Fail "SignTool failed (exit code $LASTEXITCODE)."
    }
} else {
    Write-Step "the package was created UNSIGNED — Windows will refuse to install it."
}

Write-Step "done: $packagePath"
Write-Host "Install it with:" -ForegroundColor Cyan
Write-Host "  Add-AppxPackage -Path '$packagePath'" -ForegroundColor Cyan
