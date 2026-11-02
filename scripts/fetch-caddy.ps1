#Requires -Version 5.1
<#
.SYNOPSIS
    Downloads the pinned host Caddy for Windows on an online build PC and verifies it
    against the hashes committed in caddy/ (release B: Caddy as a Windows host service).

.DESCRIPTION
    Reads caddy/CADDY_VERSION and caddy/caddy-windows-amd64.sha512, then:

      1. Downloads caddy_<version>_windows_amd64.zip from the official GitHub release
         (or uses -ZipPath, e.g. a zip carried in on USB).
      2. Stops if the zip's SHA-512 differs from the pinned value.
      3. Download mode only: also downloads the release's caddy_<version>_checksums.txt and
         stops if its entry for the zip differs from the pin (catches a wrong pin as well
         as a wrong download). The Sigstore signature of checksums.txt is NOT checked here
         (needs cosign); the pinned hash is the trust anchor and is reviewed in the PR.
      4. Extracts the zip, stops unless caddy.exe matches the pinned SHA-512 and
         `caddy.exe version` reports the pinned version.
      5. Writes caddy.exe + LICENSE into -OutDir (created if missing). Nothing is written
         unless every check above passed. Only those two files are replaced, each through a
         verified .part copy; other files in -OutDir are never touched or deleted.

    scripts/export-offline-package.ps1 checks caddy.exe against the pin again before it
    packages it into caddy-host/.

    caddy.exe is not Authenticode-signed (the official release is unsigned). The hospital
    security team allow-lists it by the caddy.exe hash in caddy/caddy-windows-amd64.sha512.

.PARAMETER ZipPath
    Use this local zip instead of downloading. Step 3 (checksums.txt cross-check) is skipped.

.PARAMETER OutDir
    Destination folder. Default: <repo>\caddy\windows-amd64 (git-ignored). A relative path is
    resolved against the current PowerShell location.

.EXAMPLE
    .\scripts\fetch-caddy.ps1
    .\scripts\fetch-caddy.ps1 -ZipPath D:\caddy_2.11.7_windows_amd64.zip
#>
[CmdletBinding()]
param(
    [string]$ZipPath = "",
    [string]$OutDir  = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'caddy-pin.ps1')

function Write-Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Stop-WithError([string]$m) {
    Write-Host "    FAIL $m" -ForegroundColor Red
    Write-Host "    Nothing was written to the output folder." -ForegroundColor White
    exit 1
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot "caddy\windows-amd64" }
# Not [IO.Path]::GetFullPath: in Windows PowerShell 5.1 that resolves relative paths against the
# process working directory, which Set-Location does not change, so '.\out' could land elsewhere.
$OutDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)

try { $pin = Read-CaddyPin (Join-Path $RepoRoot "caddy") } catch { Stop-WithError $_.Exception.Message }
Write-Step "Caddy $($pin.Version) for Windows amd64 (pinned in caddy/)"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wr-caddy-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $tmp | Out-Null
$parts = @()
try {
    $releaseBase = "https://github.com/caddyserver/caddy/releases/download/v$($pin.Version)"
    if ($ZipPath) {
        if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { Stop-WithError "zip not found: $ZipPath" }
        $zip = (Resolve-Path -LiteralPath $ZipPath).Path
        Write-Host "    using local zip $zip"
    } else {
        # Windows PowerShell 5.1 on older .NET may not offer TLS 1.2 by default; GitHub requires it.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'   # the 5.1 progress bar slows downloads a lot
        $zip = Join-Path $tmp $pin.ZipName
        Write-Host "    downloading $releaseBase/$($pin.ZipName)"
        Invoke-WebRequest -Uri "$releaseBase/$($pin.ZipName)" -OutFile $zip -UseBasicParsing
    }

    $zipSha = Get-Sha512 $zip
    if ($zipSha -ne $pin.ZipSha512) {
        Stop-WithError "zip SHA-512 does not match the pin.`n      pinned: $($pin.ZipSha512)`n      actual: $zipSha"
    }
    Write-Ok "zip SHA-512 matches the pin"

    if (-not $ZipPath) {
        $sumsName = "caddy_$($pin.Version)_checksums.txt"
        $sums = Join-Path $tmp $sumsName
        Invoke-WebRequest -Uri "$releaseBase/$sumsName" -OutFile $sums -UseBasicParsing
        $official = $null
        foreach ($line in [System.IO.File]::ReadAllLines($sums)) {
            if ($line -match '^([0-9a-fA-F]{128})\s+\*?(\S+)$' -and $Matches[2] -eq $pin.ZipName) {
                $official = $Matches[1].ToLowerInvariant()
            }
        }
        if (-not $official) { Stop-WithError "$sumsName has no entry for $($pin.ZipName)" }
        if ($official -ne $pin.ZipSha512) {
            Stop-WithError "the official $sumsName disagrees with the pin.`n      pinned:   $($pin.ZipSha512)`n      official: $official"
        }
        Write-Ok "pin matches the official $sumsName"
    }

    $extract = Join-Path $tmp "x"
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
    $exe     = Join-Path $extract "caddy.exe"
    $license = Join-Path $extract "LICENSE"
    foreach ($f in @($exe, $license)) {
        if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Stop-WithError "zip does not contain $(Split-Path $f -Leaf)" }
    }
    $exeSha = Get-Sha512 $exe
    if ($exeSha -ne $pin.ExeSha512) {
        Stop-WithError "caddy.exe SHA-512 does not match the pin.`n      pinned: $($pin.ExeSha512)`n      actual: $exeSha"
    }
    Write-Ok "caddy.exe SHA-512 matches the pin"

    # Runs only after the hash check, so this executes exactly the pinned binary.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $reported = (& $exe version 2>$null | Select-Object -First 1) } finally { $ErrorActionPreference = $prevEAP }
    $reportedVersion = if ($reported) { ([string]$reported -split '\s+')[0] } else { '' }
    if ($reportedVersion -ne "v$($pin.Version)") {
        Stop-WithError "caddy.exe version reports '$reported', expected v$($pin.Version)"
    }
    Write-Ok "caddy.exe version = $reportedVersion"

    # Replace only our two files, each through a .part copy in the destination folder that is
    # verified before it is renamed over the old file. The folder itself is never deleted, so a
    # wrong -OutDir (or one ending in a separator) cannot wipe unrelated files.
    if (Test-Path -LiteralPath $OutDir -PathType Leaf) { Stop-WithError "-OutDir is a file, not a folder: $OutDir" }
    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $exePart     = Join-Path $OutDir "caddy.exe.part"
    $licensePart = Join-Path $OutDir "LICENSE.part"
    $parts = @($exePart, $licensePart)
    Copy-Item -LiteralPath $exe -Destination $exePart -Force
    Copy-Item -LiteralPath $license -Destination $licensePart -Force
    if ((Get-Sha512 $exePart) -ne $pin.ExeSha512) { Stop-WithError "copied caddy.exe does not match the pin" }
    Move-Item -LiteralPath $exePart -Destination (Join-Path $OutDir "caddy.exe") -Force
    Move-Item -LiteralPath $licensePart -Destination (Join-Path $OutDir "LICENSE") -Force
    Write-Ok "$OutDir (caddy.exe, LICENSE)"
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($p in $parts) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    }
}
