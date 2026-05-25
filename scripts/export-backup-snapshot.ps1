<#
.SYNOPSIS
    Export wr-evaluation backup files as a single snapshot archive on local disk.

.DESCRIPTION
    Bundles backup_data volume's daily/monthly/yearly + _status + _alerts into
    a single tar.gz on the given local directory, with SHA256 checksum and a
    README for hospital data-export approval workflow.

    Does NOT write to USB directly. The hospital export approval program is
    expected to handle the USB transfer after this script produces the files.

    Aborts on these unsafe-to-export conditions:
      - backup-status.json reports the last run as "failed"
      - week/month mode: zero matching *.dump.gpg files
      - all mode: empty daily directory

    Override these checks with -SkipBackupHealthCheck (NOT recommended for
    routine exports).

.PARAMETER OutputDir
    Local directory to store snapshot files. Default: C:\wr\backup-exports

.PARAMETER Mode
    'all'   = full daily/ + monthly/ + yearly/ + _status/ + _alerts/
              (each directory included only if present in the volume)
    'week'  = last 7 days of daily *.dump.gpg + _status/ + _alerts/ (default)
              (_status / _alerts included only if present)
    'month' = last 31 days of daily *.dump.gpg + _status/ + _alerts/
              (_status / _alerts included only if present)

.PARAMETER Image
    Docker image for tar packing. If omitted, the script reads WR_VERSION
    from .env.production and uses wr-backup:$WR_VERSION. Falls back to the
    newest wr-backup tag available locally.

.PARAMETER ProjectName
    Docker Compose project name. Default: wr-prod (volume = ProjectName_backup_data)

.PARAMETER EnvFile
    Path to .env.production. Default: .\.env.production

.PARAMETER SkipBackupHealthCheck
    Skip the backup-status.json health check. Use only if you know what you
    are doing. The export README will record that the health check was skipped.

.EXAMPLE
    .\scripts\export-backup-snapshot.ps1
.EXAMPLE
    .\scripts\export-backup-snapshot.ps1 -Mode month
.EXAMPLE
    .\scripts\export-backup-snapshot.ps1 -Mode all -OutputDir D:\backup-exports
.EXAMPLE
    .\scripts\export-backup-snapshot.ps1 -Image wr-backup:5.2.0
#>
[CmdletBinding()]
param(
    [string] $OutputDir   = 'C:\wr\backup-exports',
    [ValidateSet('all','week','month')]
    [string] $Mode        = 'week',
    [string] $Image       = '',
    [string] $ProjectName = 'wr-prod',
    [string] $EnvFile     = '.\.env.production',
    [switch] $SkipBackupHealthCheck
)

$ErrorActionPreference = 'Stop'

function Write-Step ([string] $msg) { Write-Host ''; Write-Host ('-- ' + $msg) -ForegroundColor Cyan }
function Write-Ok   ([string] $msg) { Write-Host ('   OK   ' + $msg)           -ForegroundColor Green }
function Write-Warn ([string] $msg) { Write-Host ('   WARN ' + $msg)           -ForegroundColor Yellow }
function Write-Fail ([string] $msg) { Write-Host ('   FAIL ' + $msg)           -ForegroundColor Red }

# =============================================================================
# 0. Preflight checks
# =============================================================================
Write-Step 'Preflight checks'

# Docker daemon (PS 5.1: relax EAP, harmless stderr is wrapped as ErrorRecord)
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$null = & docker info 2>&1
$dockerExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($dockerExit -ne 0) {
    Write-Fail 'Docker is not running.'
    exit 1
}
Write-Ok 'Docker daemon is running'

# Volume
$volumeName = $ProjectName + '_backup_data'
$volExists  = docker volume ls --format '{{.Name}}' | Where-Object { $_ -eq $volumeName }
if (-not $volExists) {
    Write-Fail ("Volume '{0}' not found. Check -ProjectName." -f $volumeName)
    exit 1
}
Write-Ok ("Volume found: {0}" -f $volumeName)

# Resolve docker image
if ([string]::IsNullOrEmpty($Image)) {
    # Try to read WR_VERSION from .env.production
    if (Test-Path -LiteralPath $EnvFile) {
        $verLine = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match '^\s*WR_VERSION\s*=' } | Select-Object -First 1
        if ($verLine) {
            $envVersion = ($verLine -split '=', 2)[1].Trim().Trim('"').Trim("'")
            if ($envVersion) {
                $Image = 'wr-backup:' + $envVersion
                Write-Ok ("Image resolved from {0}: {1}" -f $EnvFile, $Image)
            }
        }
    }
}
if ([string]::IsNullOrEmpty($Image)) {
    # Last resort: pick any local wr-backup tag (no semver-aware comparison -
    # string sort can pick wrong tag when both 5.9 and 5.10 exist).
    # This is only a fallback for missing .env.production; production runs
    # should always pass -Image or use the env file.
    $candidates = docker images --format '{{.Repository}}:{{.Tag}}' |
                  Where-Object { $_ -like 'wr-backup:*' } |
                  Sort-Object -Descending
    if ($candidates) {
        $Image = $candidates[0]
        Write-Warn ("Image not specified and {0} missing - falling back to local image: {1}" -f $EnvFile, $Image)
        Write-Warn '   (string-sorted, not semver-aware - pass -Image explicitly to be precise)'
    } else {
        Write-Fail 'No wr-backup image specified and none found locally.'
        exit 1
    }
}
$imgExists = docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $Image }
if (-not $imgExists) {
    Write-Fail ("Docker image '{0}' not found locally. Use -Image to specify." -f $Image)
    Write-Host '   Available wr-backup images:' -ForegroundColor Gray
    docker images --format '     {{.Repository}}:{{.Tag}}' | Where-Object { $_ -like '*wr-backup*' }
    exit 1
}
Write-Ok ("Image confirmed: {0}" -f $Image)

# Output directory
if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    Write-Ok ("OutputDir created: {0}" -f $OutputDir)
} else {
    Write-Ok ("OutputDir exists: {0}" -f $OutputDir)
}

# =============================================================================
# 0.5 Backup health check (read backup-status.json + count candidate files)
#     This stage prevents shipping a snapshot of a broken/empty backup volume.
# =============================================================================
Write-Step 'Backup health check'

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Invoke-InContainer ([string] $shellCommand) {
    # Runs a one-off command inside the wr-backup image with the backup volume
    # mounted read-only. Returns stdout (trimmed). Throws on non-zero exit code.
    #
    # Important: harmless docker stderr warnings (e.g. "WARNING: No blkio
    # throttle...") MUST NOT mix into stdout, otherwise ConvertFrom-Json or
    # [int]-casts of the caller will fail on a healthy backup volume.
    # Use the call operator with an argument array so `sh -c $shellCommand`
    # is passed as intended. Start-Process -ArgumentList can flatten/quote
    # complex shell commands incorrectly on Windows PowerShell 5.1.
    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $argList = @(
            'run', '--rm',
            '-v', ($volumeName + ':/backups:ro'),
            $Image,
            'sh', '-c', $shellCommand
        )
        & docker @argList 1> $stdoutFile 2> $stderrFile
        $exit = $LASTEXITCODE
        $stdout = ''
        if ((Test-Path -LiteralPath $stdoutFile) -and ((Get-Item -LiteralPath $stdoutFile).Length -gt 0)) {
            $stdout = Get-Content -LiteralPath $stdoutFile -Raw
        }
        $stderr = ''
        if ((Test-Path -LiteralPath $stderrFile) -and ((Get-Item -LiteralPath $stderrFile).Length -gt 0)) {
            $stderr = Get-Content -LiteralPath $stderrFile -Raw
        }
    } finally {
        $ErrorActionPreference = $prev
        Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
    if ($exit -ne 0) {
        $msg = if ($stderr) { $stderr } else { $stdout }
        throw ("Container command failed (exit {0}): {1}" -f $exit, $msg.Trim())
    }
    return $stdout.Trim()
}

# 0.5.a - backup-status.json
$lastStatus       = $null
$healthCheckNote  = ''
try {
    $statusJson = Invoke-InContainer "cat /backups/_status/backup-status.json 2>/dev/null || echo ''"
    if ($statusJson) {
        $parsed = $statusJson | ConvertFrom-Json
        $lastStatus = [string] $parsed.status
        Write-Ok ("Last backup status: {0} (runId={1})" -f $lastStatus, $parsed.runId)
        if ($lastStatus -ne 'success' -and -not $SkipBackupHealthCheck) {
            Write-Fail ("Last backup is '{0}' (reasonClass={1}). Aborting export." -f $lastStatus, $parsed.reasonClass)
            Write-Host '   Fix the backup first, or pass -SkipBackupHealthCheck to override.' -ForegroundColor Gray
            exit 1
        }
        if ($lastStatus -ne 'success' -and $SkipBackupHealthCheck) {
            Write-Warn ("Last backup is '{0}'. Continuing because -SkipBackupHealthCheck was passed." -f $lastStatus)
            $healthCheckNote = '[!] backup-status was "' + $lastStatus + '" at export time; -SkipBackupHealthCheck used.'
        }
    } else {
        if (-not $SkipBackupHealthCheck) {
            Write-Fail 'backup-status.json is missing. Aborting export.'
            Write-Host '   Run a backup first, or pass -SkipBackupHealthCheck to override.' -ForegroundColor Gray
            exit 1
        }
        Write-Warn 'backup-status.json missing. Continuing because -SkipBackupHealthCheck was passed.'
        $healthCheckNote = '[!] backup-status.json missing at export time; -SkipBackupHealthCheck used.'
    }
} catch {
    Write-Fail ('Health check failed: ' + $_.Exception.Message)
    if (-not $SkipBackupHealthCheck) {
        exit 1
    }
    Write-Warn 'Continuing due to -SkipBackupHealthCheck.'
    $healthCheckNote = '[!] Health check threw an error at export time; -SkipBackupHealthCheck used.'
}

# 0.5.b - count candidate files for the chosen mode
$candidateCount = 0
if ($Mode -eq 'all') {
    try {
        $cnt = Invoke-InContainer "find /backups/daily -type f -name '*.dump.gpg' 2>/dev/null | wc -l"
        $candidateCount = [int] $cnt
    } catch { $candidateCount = 0 }
} else {
    $mtimeArg = '-mtime -7'
    if ($Mode -eq 'month') { $mtimeArg = '-mtime -31' }
    try {
        $cnt = Invoke-InContainer ("find /backups/daily -type f -name '*.dump.gpg' " + $mtimeArg + ' 2>/dev/null | wc -l')
        $candidateCount = [int] $cnt
    } catch { $candidateCount = 0 }
}

if ($candidateCount -eq 0) {
    if (-not $SkipBackupHealthCheck) {
        Write-Fail ("No *.dump.gpg files match for mode='{0}'. Aborting export." -f $Mode)
        Write-Host '   Tip: increase the window (-Mode month / all) or verify cron output.' -ForegroundColor Gray
        exit 1
    }
    Write-Warn ("No *.dump.gpg files match for mode='{0}'. Continuing due to -SkipBackupHealthCheck." -f $Mode)
    $healthCheckNote = $healthCheckNote + "`n[!] Zero candidate dump files at export time; -SkipBackupHealthCheck used."
}
Write-Ok ("Candidate dump files in window: {0}" -f $candidateCount)

# =============================================================================
# 1. Snapshot file name and shell script
# =============================================================================
$timestamp    = Get-Date -Format 'yyyyMMdd_HHmmss'
$snapshotName = 'wr-backup-snapshot-' + $Mode + '-' + $timestamp + '.tar.gz'
$snapshotPath = Join-Path -Path $OutputDir -ChildPath $snapshotName
$outDirAbs    = (Resolve-Path -LiteralPath $OutputDir).Path

Write-Step ("Building snapshot (mode={0})" -f $Mode)
Write-Host ('   Target file: ' + $snapshotName)

# Build shell script (temp file -> container) to avoid any PowerShell quoting
# issues around && and special characters.
$shLines = New-Object System.Collections.Generic.List[string]
[void] $shLines.Add('#!/bin/sh')
[void] $shLines.Add('set -e')
[void] $shLines.Add('cd /backups')
if ($Mode -eq 'all') {
    # Pack everything that exists. Use a file list so missing dirs do not abort tar.
    [void] $shLines.Add(': > /tmp/filelist')
    [void] $shLines.Add('for d in daily monthly yearly _status _alerts; do')
    [void] $shLines.Add('  if [ -d "$d" ]; then echo "$d" >> /tmp/filelist; fi')
    [void] $shLines.Add('done')
    [void] $shLines.Add('tar czf /dest/' + $snapshotName + ' -T /tmp/filelist')
} else {
    $mtimeArg = '-mtime -7'
    if ($Mode -eq 'month') { $mtimeArg = '-mtime -31' }
    # Include matching dump files plus _status and _alerts dirs (each only if
    # it exists - tolerates -SkipBackupHealthCheck case where _status might
    # legitimately be missing).
    [void] $shLines.Add("find daily " + $mtimeArg + " -type f -name '*.dump.gpg' > /tmp/filelist")
    [void] $shLines.Add('[ -d "_status" ] && echo "_status" >> /tmp/filelist')
    [void] $shLines.Add('[ -d "_alerts" ] && echo "_alerts" >> /tmp/filelist')
    [void] $shLines.Add('tar czf /dest/' + $snapshotName + ' -T /tmp/filelist')
}
$shContent = ($shLines -join "`n") + "`n"

$tmpScriptName = '.export-snapshot-' + $timestamp + '.sh'
$tmpScriptPath = Join-Path -Path $outDirAbs -ChildPath $tmpScriptName
[System.IO.File]::WriteAllBytes($tmpScriptPath, $utf8NoBom.GetBytes($shContent))

# =============================================================================
# 2. Run tar inside container
# =============================================================================
# PowerShell 5.1: relax EAP around the native docker call so harmless stderr
# warnings (e.g. "WARNING: No blkio throttle...") wrapped as ErrorRecord do
# not abort the script. Exit status is checked via $LASTEXITCODE.
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & docker run --rm `
        -v ($volumeName + ':/backups:ro') `
        -v ($outDirAbs + ':/dest') `
        $Image `
        sh ('/dest/' + $tmpScriptName)
    $tarExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prev
    Remove-Item -LiteralPath $tmpScriptPath -Force -ErrorAction SilentlyContinue
}

if ($tarExit -ne 0) {
    Write-Fail ("tar failed (exit {0})" -f $tarExit)
    exit 1
}
if (-not (Test-Path -LiteralPath $snapshotPath)) {
    Write-Fail ("Snapshot file not created: {0}" -f $snapshotPath)
    exit 1
}

$snapshotSize   = (Get-Item -LiteralPath $snapshotPath).Length
$snapshotSizeMB = [math]::Round($snapshotSize / 1MB, 2)
Write-Ok ("Snapshot created: {0} MB" -f $snapshotSizeMB)

# =============================================================================
# 3. SHA256 checksum
# =============================================================================
Write-Step 'SHA256 checksum'

$hashHex      = (Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256).Hash.ToLower()
$checksumLine = $hashHex + '  ' + $snapshotName
$checksumPath = $snapshotPath + '.sha256'

[System.IO.File]::WriteAllBytes($checksumPath, $utf8NoBom.GetBytes($checksumLine + "`r`n"))
Write-Ok ('Checksum saved: ' + (Split-Path -Path $checksumPath -Leaf))
Write-Host ('   ' + $hashHex) -ForegroundColor Gray

# =============================================================================
# 4. README metadata (ASCII-only for safe parsing on all PowerShell hosts)
# =============================================================================
Write-Step 'README metadata'

$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'

$metaLines = New-Object System.Collections.Generic.List[string]
[void] $metaLines.Add('WR Evaluation Backup Snapshot')
[void] $metaLines.Add('==============================')
[void] $metaLines.Add('Created at        : ' + $now)
[void] $metaLines.Add('Source volume     : ' + $volumeName)
[void] $metaLines.Add('Image used        : ' + $Image)
[void] $metaLines.Add('Mode              : ' + $Mode)
[void] $metaLines.Add('Snapshot file     : ' + $snapshotName)
[void] $metaLines.Add('Snapshot size     : ' + $snapshotSizeMB + ' MB')
[void] $metaLines.Add('SHA256            : ' + $hashHex)
[void] $metaLines.Add('Dump files in tar : ' + $candidateCount)
$lastStatusForReport = if ($lastStatus) { $lastStatus } else { 'unknown' }
[void] $metaLines.Add('Last backup state : ' + $lastStatusForReport)
if ($healthCheckNote) {
    [void] $metaLines.Add('')
    [void] $metaLines.Add('Health check notes')
    [void] $metaLines.Add('------------------')
    foreach ($line in ($healthCheckNote -split "`n")) {
        [void] $metaLines.Add($line)
    }
}
[void] $metaLines.Add('')
[void] $metaLines.Add('Export approval form (enter the following into the approval system)')
[void] $metaLines.Add('====================================================================')
[void] $metaLines.Add('- File name       : ' + $snapshotName)
[void] $metaLines.Add('- Size            : ' + $snapshotSizeMB + ' MB')
[void] $metaLines.Add('- Integrity hash  : SHA256 = ' + $hashHex)
[void] $metaLines.Add('- Content class   : Patient health data (PHI), GPG encrypted')
[void] $metaLines.Add('- Encrypted       : Yes (GPG; private key stored separately)')
[void] $metaLines.Add('- Export purpose  : Offline backup media for disaster recovery')
[void] $metaLines.Add('- Storage place   : (fill in on the approval form)')
[void] $metaLines.Add('')
[void] $metaLines.Add('Restore procedure (on recovery host)')
[void] $metaLines.Add('====================================')
[void] $metaLines.Add('1. Bring the backup USB AND the separate GPG private-key USB')
[void] $metaLines.Add('2. tar xzf ' + $snapshotName)
[void] $metaLines.Add('3. gpg --decrypt each daily/wr-backup-*.dump.gpg')
[void] $metaLines.Add('4. Follow docs/BACKUP_RESTORE.md to load into a temp DB')
[void] $metaLines.Add('')
[void] $metaLines.Add('Verification')
[void] $metaLines.Add('============')
[void] $metaLines.Add('PowerShell: (Get-FileHash <path> -Algorithm SHA256).Hash')
[void] $metaLines.Add('bash:       sha256sum -c ' + $snapshotName + '.sha256')
[void] $metaLines.Add('')
[void] $metaLines.Add('Cautions')
[void] $metaLines.Add('========')
[void] $metaLines.Add('- NEVER export the GPG private key on the same USB')
[void] $metaLines.Add('- PHI data - use an encrypted USB drive')
[void] $metaLines.Add('- Record file name + SHA256 + date in the export log book')

$metaContent = ($metaLines -join "`r`n") + "`r`n"
$metaPath    = Join-Path -Path $OutputDir -ChildPath ($snapshotName + '.README.txt')
[System.IO.File]::WriteAllBytes($metaPath, $utf8NoBom.GetBytes($metaContent))
Write-Ok ('README saved: ' + (Split-Path -Path $metaPath -Leaf))

# =============================================================================
# 5. Final verification
# =============================================================================
Write-Step 'Final verification'

$actualHash = (Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256).Hash.ToLower()
if ($actualHash -eq $hashHex) {
    Write-Ok 'Checksum matches'
} else {
    Write-Fail 'Checksum mismatch - file may be corrupt'
    exit 1
}

# =============================================================================
# Done
# =============================================================================
Write-Host ''
Write-Host '============================================================' -ForegroundColor White
Write-Host '  Backup export snapshot ready (local disk)'                   -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor White
Write-Host ('  File      : ' + $snapshotName)
Write-Host ('  Size      : ' + $snapshotSizeMB + ' MB')
Write-Host ('  Location  : ' + $OutputDir)
Write-Host ('  Checksum  : ' + $snapshotName + '.sha256')
Write-Host ('  README    : ' + $snapshotName + '.README.txt')
Write-Host ('  Dumps in tar: ' + $candidateCount)
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor White
Write-Host '  1. Submit the 3 files above to the hospital export approval system'
Write-Host '     (.tar.gz / .tar.gz.sha256 / .tar.gz.README.txt)'
Write-Host '  2. Fill the form using values from the README'
Write-Host '  3. After approval and USB transfer, re-verify hash'
Write-Host '  4. Keep the GPG private key on a separate medium'
