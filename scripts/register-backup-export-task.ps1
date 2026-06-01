<#
.SYNOPSIS
    Register a Windows scheduled task that runs export-backup-snapshot.ps1
    on a recurring schedule.

.DESCRIPTION
    Registers (or replaces) a Scheduled Task that invokes
    scripts\export-backup-snapshot.ps1 with the chosen -Mode at the chosen time.

    Uses schtasks.exe so it works consistently on PowerShell 5.1 (Windows 7+)
    without depending on the ScheduledTasks PowerShell module version.

    Schedule presets:
      - weekly    : every Monday  (snapshot Mode = week)
      - monthly   : 1st of every month (snapshot Mode = month)
      - quarterly : 1st of Jan/Apr/Jul/Oct (snapshot Mode = all)

    The wrapper .cmd that the task launches redirects stdout/stderr to a log
    file under <OutputDir>\logs\, so failures from unattended runs can be
    diagnosed later.

.PARAMETER Frequency
    'weekly' | 'monthly' | 'quarterly'

.PARAMETER At
    Time of day to run, format HH:mm (24h, 00:00-23:59). Default 09:00.

.PARAMETER TaskName
    Scheduled task name. Default: WR-Backup-Export-<Frequency>.
    Characters invalid on Windows filesystems are stripped before the wrapper
    filename is built.

.PARAMETER PackageRoot
    Path to the wr-evaluation package root where export-backup-snapshot.ps1
    lives. Default: current directory.

.PARAMETER RunAsSystem
    Switch. When present, run the task as NT AUTHORITY\SYSTEM.

    Default (switch absent) is to run as the current user. Docker Desktop on
    Windows often runs only in the current user's session - a SYSTEM-scheduled
    task will fail at the `docker info` step even though the task itself
    appears to register fine.

    Pass -RunAsSystem only on hosts where you have verified Docker is
    reachable from SYSTEM (e.g. dockerd as a Windows service via Docker
    Engine, not Docker Desktop).

    When this switch is absent, schtasks.exe prompts for the run-as account's
    password via /RP * (the password is needed so the task can run while the
    user is logged off).

.PARAMETER Mode
    Override the default snapshot mode. Defaults follow Frequency.

.PARAMETER OutputDir
    Forwarded to export-backup-snapshot.ps1. Also used as the parent of the
    logs/ directory. Default: C:\wr\backup-exports

.PARAMETER ProjectName
    Forwarded to export-backup-snapshot.ps1. Default: wr-prod

.PARAMETER EnvFile
    Forwarded to export-backup-snapshot.ps1. Default: .\.env.production

.EXAMPLE
    .\scripts\register-backup-export-task.ps1 -Frequency weekly

.EXAMPLE
    .\scripts\register-backup-export-task.ps1 -Frequency monthly -At 06:30

.EXAMPLE
    .\scripts\register-backup-export-task.ps1 -Frequency quarterly -RunAsSystem

.NOTES
    Run elevated (Run as Administrator). After registration, ALWAYS test:
        schtasks /Run /TN <TaskName>
    and inspect the log file before relying on the unattended schedule.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('weekly','monthly','quarterly')]
    [string] $Frequency,

    [string] $At          = '09:00',
    [string] $TaskName    = '',
    [string] $PackageRoot = (Get-Location).Path,
    [switch] $RunAsSystem,
    [ValidateSet('','all','week','month')]
    [string] $Mode        = '',
    [string] $OutputDir   = 'C:\wr\backup-exports',
    [string] $ProjectName = 'wr-prod',
    [string] $EnvFile     = '.\.env.production'
)

$ErrorActionPreference = 'Stop'

function Write-Step ([string] $msg) { Write-Host ''; Write-Host ('-- ' + $msg) -ForegroundColor Cyan }
function Write-Ok   ([string] $msg) { Write-Host ('   OK   ' + $msg)           -ForegroundColor Green }
function Write-Warn ([string] $msg) { Write-Host ('   WARN ' + $msg)           -ForegroundColor Yellow }
function Write-Fail ([string] $msg) { Write-Host ('   FAIL ' + $msg)           -ForegroundColor Red }

# =============================================================================
# 0. Admin elevation check
# =============================================================================
Write-Step 'Privilege check'

$wid       = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($wid)
$isAdmin   = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Fail 'This script must be run as Administrator (right-click PowerShell -> Run as Administrator).'
    exit 1
}
Write-Ok ('Running as Administrator: ' + $wid.Name)

# =============================================================================
# 1. Resolve mode & task name defaults
# =============================================================================
if ([string]::IsNullOrEmpty($Mode)) {
    if ($Frequency -eq 'weekly')    { $Mode = 'week'  }
    if ($Frequency -eq 'monthly')   { $Mode = 'month' }
    if ($Frequency -eq 'quarterly') { $Mode = 'all'   }
}
if ([string]::IsNullOrEmpty($TaskName)) {
    $TaskName = 'WR-Backup-Export-' + $Frequency
}

# =============================================================================
# 2. Validate -At  (HH:mm with 00-23 / 00-59 bounds)
# =============================================================================
$timeMatch = [System.Text.RegularExpressions.Regex]::Match($At, '^(\d{2}):(\d{2})$')
if (-not $timeMatch.Success) {
    Write-Fail "-At must be HH:mm (e.g. 09:00). Got: '$At'"
    exit 1
}
$hh = [int] $timeMatch.Groups[1].Value
$mm = [int] $timeMatch.Groups[2].Value
if ($hh -lt 0 -or $hh -gt 23 -or $mm -lt 0 -or $mm -gt 59) {
    Write-Fail "-At must be a valid clock time, 00:00 to 23:59. Got: '$At'"
    exit 1
}
$At = '{0:00}:{1:00}' -f $hh, $mm

# =============================================================================
# 3. Resolve script paths
# =============================================================================
Write-Step 'Resolve script paths'

$pkgRootAbs = (Resolve-Path -LiteralPath $PackageRoot).Path
$exportPs1  = Join-Path -Path $pkgRootAbs -ChildPath 'scripts\export-backup-snapshot.ps1'
if (-not (Test-Path -LiteralPath $exportPs1)) {
    Write-Fail ("export-backup-snapshot.ps1 not found at: {0}" -f $exportPs1)
    exit 1
}
Write-Ok ("Export script: {0}" -f $exportPs1)
Write-Ok ("Working dir  : {0}" -f $pkgRootAbs)

# =============================================================================
# 3.5 Path safety check
# =============================================================================
# The .cmd wrapper embeds these paths verbatim. ASCII-only avoids:
#   * code page mismatch corrupting non-ASCII characters in .cmd files
#   * accidental injection via cmd metacharacters
# The hospital install root C:\wr\... is ASCII by design; this check fails
# fast if the script is invoked from a path that contains Hangul, spaces+
# special chars, or cmd-special characters.
function Test-PathIsCmdSafe ([string] $name, [string] $value) {
    # Reject anything outside printable ASCII (32-126)
    foreach ($ch in $value.ToCharArray()) {
        $code = [int][char]$ch
        if ($code -lt 32 -or $code -gt 126) {
            Write-Fail ("{0} contains non-ASCII character (U+{1:X4}) and is unsafe for .cmd wrapper: '{2}'" -f $name, $code, $value)
            Write-Host '   Move the package to an ASCII-only path (e.g. C:\wr\...).' -ForegroundColor Gray
            exit 1
        }
    }
    # Reject cmd metacharacters that could break the wrapper or inject commands.
    # `"` is allowed only inside our explicit quoting; reject when in raw value.
    $unsafe = '&', '|', '<', '>', '^', '%', '!', '"', '`'
    foreach ($u in $unsafe) {
        if ($value.Contains($u)) {
            Write-Fail ("{0} contains cmd-unsafe character '{1}': '{2}'" -f $name, $u, $value)
            exit 1
        }
    }
}

Test-PathIsCmdSafe 'PackageRoot' $pkgRootAbs
Test-PathIsCmdSafe 'OutputDir'   $OutputDir
Test-PathIsCmdSafe 'ProjectName' $ProjectName
Test-PathIsCmdSafe 'EnvFile'     $EnvFile
Test-PathIsCmdSafe 'TaskName'    $TaskName
Write-Ok 'All paths/names are ASCII and cmd-safe'

# Pre-create OutputDir + logs subdirectory so the wrapper's first scheduled
# run can write its log even on a fresh host. (wrapper's `mkdir` requires
# the parent path to exist, which is not guaranteed for first-time installs.)
$logsDir = Join-Path -Path $OutputDir -ChildPath 'logs'
if (-not (Test-Path -LiteralPath $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    Write-Ok ("Created log dir: {0}" -f $logsDir)
} else {
    Write-Ok ("Log dir exists : {0}" -f $logsDir)
}

# =============================================================================
# 4. Run-as identity advisory
# =============================================================================
if ($RunAsSystem) {
    Write-Warn 'RunAsSystem=$true: SYSTEM often cannot reach Docker Desktop on Windows.'
    Write-Warn '  If unsure, register with -RunAsSystem $false and ALWAYS test via schtasks /Run.'
}

# =============================================================================
# 5. Build .cmd wrapper for schtasks /tr (with stdout/stderr log redirection)
# =============================================================================
# schtasks /tr quoting is fragile with embedded paths + flags. Use a tiny
# .cmd wrapper that does cd + powershell invocation and redirects all output
# to a log file (unattended tasks have no visible console).

# Sanitize TaskName for filesystem use (filename only, not the schtasks /TN value).
$invalid = [System.Collections.Generic.HashSet[char]]::new([System.IO.Path]::GetInvalidFileNameChars())
$safeTaskName = -join ($TaskName.ToCharArray() | ForEach-Object {
    if ($invalid.Contains($_)) { '_' } else { $_ }
})

$wrapperDir = Join-Path -Path $pkgRootAbs -ChildPath 'scripts'
$wrapperCmd = Join-Path -Path $wrapperDir -ChildPath ('run-' + $safeTaskName + '.cmd')

# $logsDir is set earlier (during pre-create); compose the per-task log path here.
$logPath = Join-Path -Path $logsDir   -ChildPath ($safeTaskName + '.log')

# Forward export-script arguments so an operator can re-read the wrapper to
# see exactly what runs.
$exportArgs = '-Mode ' + $Mode `
            + ' -OutputDir "'   + $OutputDir   + '"' `
            + ' -ProjectName "' + $ProjectName + '"' `
            + ' -EnvFile "'     + $EnvFile     + '"'

# NOTE: cmd's `echo X >> file` parses `X` as a command/argument string and is
# fragile when X contains spaces or special chars (e.g. `:`, `(`, `)`, `&`).
# A safer pattern is `>>file echo X` - the redirection token is bound first,
# then everything else is fed to echo verbatim. We also avoid embedding
# parentheses in echoed text since cmd treats `(` `)` specially in compound
# statements.

# Defense in depth: strip any embedded CR/LF from path-like variables before
# they go into the wrapper. Without this, a single stray newline in any of
# pkgRootAbs / logPath / logsDir / exportPs1 / TaskName / exportArgs would
# break the .cmd into pieces and every cmd line would fail.
function Remove-NewlinesFrom ([string] $v) { return ($v -replace "[`r`n]", '') }

$pkgRootAbs  = Remove-NewlinesFrom $pkgRootAbs
$logPath     = Remove-NewlinesFrom $logPath
$logsDir     = Remove-NewlinesFrom $logsDir
$exportPs1   = Remove-NewlinesFrom $exportPs1
$TaskNameCln = Remove-NewlinesFrom $TaskName
$exportArgs  = Remove-NewlinesFrom $exportArgs

# Build wrapper using -f format strings (no `+` concat) so PowerShell can never
# accidentally introduce its own newlines between segments.
$wrapperLines = @(
    '@echo off',
    'setlocal',
    'rem Auto-generated by register-backup-export-task.ps1. Safe to regenerate.',
    ('rem TaskName: {0}' -f $TaskNameCln),
    ('rem Logs    : {0}' -f $logPath),
    ('cd /d "{0}"' -f $pkgRootAbs),
    ('if not exist "{0}" mkdir "{0}"' -f $logsDir),
    ('>>"{0}" echo ============================================================' -f $logPath),
    ('>>"{0}" echo Run start: %DATE% %TIME%' -f $logPath),
    ('>>"{0}" echo TaskName: {1}'           -f $logPath, $TaskNameCln),
    ('>>"{0}" echo Command:  {1}'           -f $logPath, $exportArgs),
    ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" {1} >>"{2}" 2>&1' -f $exportPs1, $exportArgs, $logPath),
    'set RC=%ERRORLEVEL%',
    ('>>"{0}" echo Run end:   %DATE% %TIME%  exit %RC%' -f $logPath),
    ('>>"{0}" echo.' -f $logPath),
    'endlocal & exit /b %RC%'
)

# Re-strip newlines from every assembled line as a final safety net, then join
# strictly with CRLF only.
$wrapperLines = $wrapperLines | ForEach-Object { Remove-NewlinesFrom $_ }
$wrapperContent = ($wrapperLines -join "`r`n") + "`r`n"
$asciiEnc = New-Object System.Text.ASCIIEncoding
[System.IO.File]::WriteAllBytes($wrapperCmd, $asciiEnc.GetBytes($wrapperContent))
Write-Ok ("Wrapper      : {0}" -f $wrapperCmd)
Write-Ok ("Log file     : {0}" -f $logPath)

# /tr value: quoted path to wrapper
$trCommand = '"' + $wrapperCmd + '"'

# =============================================================================
# 6. Build schtasks arguments
# =============================================================================
$schArgs = New-Object System.Collections.Generic.List[string]
[void] $schArgs.Add('/Create')
[void] $schArgs.Add('/F')                # replace if exists
[void] $schArgs.Add('/TN'); [void] $schArgs.Add($TaskName)
[void] $schArgs.Add('/TR'); [void] $schArgs.Add($trCommand)
[void] $schArgs.Add('/ST'); [void] $schArgs.Add($At)
[void] $schArgs.Add('/RL'); [void] $schArgs.Add('HIGHEST')

if ($RunAsSystem) {
    [void] $schArgs.Add('/RU'); [void] $schArgs.Add('SYSTEM')
    Write-Ok 'Run as       : SYSTEM (no password)'
} else {
    $userPrincipal = "$env:USERDOMAIN\$env:USERNAME"
    [void] $schArgs.Add('/RU'); [void] $schArgs.Add($userPrincipal)
    # /RP * forces an interactive password prompt - needed so the task can
    # run while the user is logged off.
    [void] $schArgs.Add('/RP'); [void] $schArgs.Add('*')
    Write-Ok ('Run as       : ' + $userPrincipal + ' (password will be prompted by schtasks)')
}

switch ($Frequency) {
    'weekly' {
        [void] $schArgs.Add('/SC'); [void] $schArgs.Add('WEEKLY')
        [void] $schArgs.Add('/D');  [void] $schArgs.Add('MON')
        Write-Ok ("Trigger      : every Monday at {0}" -f $At)
    }
    'monthly' {
        [void] $schArgs.Add('/SC'); [void] $schArgs.Add('MONTHLY')
        [void] $schArgs.Add('/D');  [void] $schArgs.Add('1')
        Write-Ok ("Trigger      : 1st of every month at {0}" -f $At)
    }
    'quarterly' {
        [void] $schArgs.Add('/SC'); [void] $schArgs.Add('MONTHLY')
        [void] $schArgs.Add('/M');  [void] $schArgs.Add('JAN,APR,JUL,OCT')
        [void] $schArgs.Add('/D');  [void] $schArgs.Add('1')
        Write-Ok ("Trigger      : 1st of Jan/Apr/Jul/Oct at {0}" -f $At)
    }
}

# =============================================================================
# 7. Run schtasks.exe
# =============================================================================
Write-Step ("Register task: {0}" -f $TaskName)

$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& schtasks.exe @schArgs
$schExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP

if ($schExit -ne 0) {
    Write-Fail ("schtasks.exe failed (exit {0})" -f $schExit)
    exit $schExit
}

Write-Ok ("Task registered: {0}" -f $TaskName)

# =============================================================================
# 8. Summary  (test reminder is intentionally prominent)
# =============================================================================
Write-Host ''
Write-Host '============================================================' -ForegroundColor White
Write-Host '  Scheduled task registered'                                    -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor White
Write-Host ('  Task name : ' + $TaskName)
Write-Host ('  Frequency : ' + $Frequency)
Write-Host ('  Mode      : ' + $Mode)
Write-Host ('  Time      : ' + $At)
Write-Host ('  Wrapper   : ' + $wrapperCmd)
Write-Host ('  Log file  : ' + $logPath)
Write-Host ''
Write-Host '!!  TEST IMMEDIATELY  !!' -ForegroundColor Yellow
Write-Host 'Unattended tasks have no console - verify the run before trusting the schedule:' -ForegroundColor Yellow
Write-Host ('  1) schtasks /Run /TN "' + $TaskName + '"')                  -ForegroundColor Yellow
Write-Host ('  2) wait ~30 sec, then inspect the log:')                    -ForegroundColor Yellow
Write-Host ('     Get-Content "' + $logPath + '" -Tail 60')                -ForegroundColor Yellow
Write-Host ('  3) verify a snapshot appears in: ' + $OutputDir)            -ForegroundColor Yellow
Write-Host ''
Write-Host 'Manage the task:' -ForegroundColor White
Write-Host ('  View    : schtasks /Query /TN "' + $TaskName + '" /V /FO LIST')
Write-Host ('  Run now : schtasks /Run /TN "' + $TaskName + '"')
Write-Host ('  Remove  : schtasks /Delete /TN "' + $TaskName + '" /F')
Write-Host  '  GUI     : taskschd.msc'
