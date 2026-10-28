<#
.SYNOPSIS
    Run the Zode Windows shell's self test and fail the build if it does not pass.

.DESCRIPTION
    Zode.Shell.exe is a GUI subsystem application (OutputType=WinExe).  Windows does
    NOT wait for a GUI process launched from a console, and PowerShell therefore
    never populates $LASTEXITCODE for it — it stays $null.  So the obvious

        & $exe --selftest
        if ($LASTEXITCODE -ne 0) { throw "the shell self test failed" }

    throws even when the shell printed "SELFTEST PASSED", because ($null -ne 0) is
    true.  It also does not actually WAIT for the shell, so the step could pass (or
    fail) before the self test had finished at all.

    Start-Process -Wait -PassThru does wait for the process and does surface the
    real exit code, so this helper uses that.  The console output is captured and
    replayed into the CI log as evidence.

.PARAMETER ExePath
    The Zode.Shell.exe to run.

.PARAMETER Argument
    The single argument to pass to it.  Defaults to --selftest.

.EXAMPLE
    ./scripts/run-shell-selftest.ps1 -ExePath "$out/Zode.Shell.exe" -Argument '--selftest'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath,

    [string]$Argument = '--selftest'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "the executable is missing: $ExePath"
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$stdoutPath = Join-Path $tempRoot 'zode-selftest.out'
$stderrPath = Join-Path $tempRoot 'zode-selftest.err'

# Start-Process -Wait -PassThru is the reliable way to read the exit code of a
# GUI subsystem executable: it blocks until the process is gone and exposes
# .ExitCode.  Output is redirected to files so the child never inherits a
# console it cannot write to.
$process = Start-Process -FilePath $ExePath -ArgumentList $Argument `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

$printed = ''
foreach ($path in @($stdoutPath, $stderrPath)) {
    if (Test-Path -LiteralPath $path) {
        $text = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
        if ($text) {
            Write-Host $text
            $printed += $text
        }
    }
}

# The shell prints this when its own checks fail, and returns 1.  Catch it
# explicitly too: the exit code is authoritative, but a shell that reports a
# failure must never be able to pass.
if ($printed -match 'SELFTEST FAILED') {
    throw 'the shell self test reported a failure'
}

if ($process.ExitCode -ne 0) {
    throw "the shell self test failed (exit $($process.ExitCode))"
}

Write-Host 'the shell proved itself'
