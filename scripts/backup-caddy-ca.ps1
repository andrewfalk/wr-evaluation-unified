#Requires -Version 5.1
<#
.SYNOPSIS
    Exports the Caddy internal CA (root + intermediate certificates AND PRIVATE KEYS) as a GPG-encrypted archive.

.DESCRIPTION
    Every client PC trusts the root certificate of Caddy's internal CA (see INTRANET_DEPLOYMENT.md section 3).
    If the <project>_caddy_data volume is lost, Caddy creates a NEW CA and the root certificate must be
    re-installed on every client PC. The daily database backup does not cover this volume, so run this script
    once after the first deployment, again about once a year (the intermediate certificate is renewed every
    365 days), and before any server migration or Docker reinstall.

    The archive is encrypted with the same asymmetric GPG PUBLIC key used for the database backups
    (BACKUP_GPG_RECIPIENT), so no passphrase or private key is needed on the server. Keep the matching private
    key offline, separately from the archive. The unencrypted tar only ever exists in memory (/dev/shm of a
    throw-away container); the caddy_data volume is mounted read-only; key contents are never printed.

    Compatible with Windows PowerShell 5.1 and PowerShell 7. Messages are ASCII on purpose (5.1 mis-reads
    non-ASCII text in BOM-less script files).

    With -SourceDir the CA is read from a host folder instead of the volume - the copy the Windows host Caddy
    service uses (install-caddy-host.ps1, C:\ProgramData\wr-caddy\data). That folder is readable only by
    Administrators, SYSTEM and the service, so Docker Desktop cannot bind-mount it: this script (elevated) reads the
    four files and passes them base64-encoded on the container's standard input. The container rebuilds them in
    /dev/shm, checks their SHA-256 against the originals, and creates the same kind of archive (local/...) as the
    volume backup, so the restore procedure is the same. No plain copy is ever written to the host disk.

.PARAMETER Project
    Compose project name. Default: wr-prod. The CA volume is <Project>_caddy_data.

.PARAMETER SourceDir
    Host folder holding pki\authorities\local (e.g. C:\ProgramData\wr-caddy\data). Requires an elevated window.
    Default: back up the <Project>_caddy_data volume instead.

.PARAMETER EnvFile
    Env file used ONLY to read WR_VERSION and BACKUP_GPG_RECIPIENT (nothing else is read). Default: .\.env.production

.PARAMETER Recipient
    GPG recipient (key fingerprint or e-mail). Default: BACKUP_GPG_RECIPIENT from the env file.

.PARAMETER ImageVersion
    Tag of the wr-backup image that provides tar and gpg. Default: WR_VERSION from the env file.

.PARAMETER GnupgVolume
    Docker volume holding the GPG keyring with the public key. Default: <Project>_backup_gnupg

.PARAMETER OutDir
    Output directory for the encrypted archive and its info file. Default: .\caddy-ca-backup

.EXAMPLE
    # Production (run from the package root)
    .\scripts\backup-caddy-ca.ps1

    # Another compose project (e.g. a rehearsal install)
    .\scripts\backup-caddy-ca.ps1 -Project wr-prod-test -EnvFile .\.env.rehearsal

    # The copy used by the Windows host Caddy service (elevated window)
    .\scripts\backup-caddy-ca.ps1 -SourceDir C:\ProgramData\wr-caddy\data
#>
[CmdletBinding()]
param(
    [string]$Project      = 'wr-prod',
    [string]$SourceDir    = '',
    [string]$EnvFile      = '.\.env.production',
    [string]$Recipient    = '',
    [string]$ImageVersion = '',
    [string]$GnupgVolume  = '',
    [string]$OutDir       = '.\caddy-ca-backup'
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$m) { Write-Host ''; Write-Host "-- $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "   OK   $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "   WARN $m" -ForegroundColor Yellow }
function Stop-WithError([string]$m) { Write-Host "   FAIL $m" -ForegroundColor Red; exit 1 }

# Native commands may write harmless warnings to stderr; under EAP=Stop that aborts Windows PowerShell 5.1.
# Run them with EAP=Continue and judge success by $LASTEXITCODE only.
function Invoke-Native {
    param([Parameter(Mandatory)][scriptblock]$Block)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block } finally { $ErrorActionPreference = $prev }
}

function Get-EnvValue([string]$Path, [string]$Key) {
    if (-not (Test-Path $Path)) { return '' }
    $line = Get-Content $Path | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
    if (-not $line) { return '' }
    return ((($line -split '=', 2)[1]).Trim()).Trim('"').Trim("'")
}

# Only characters that are safe inside the container's sh command line (no quoting needed).
function Assert-SafeToken([string]$Name, [string]$Value) {
    if ($Value -notmatch '^[A-Za-z0-9@._+:-]+$') {
        Stop-WithError "$Name contains characters other than letters, digits and @ . _ + : - : '$Value'"
    }
}

function Test-Admin {
    $p = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Sha256Hex([byte[]]$Bytes) {
    $alg = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($alg.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() } finally { $alg.Dispose() }
}

# ---------------------------------------------------------------------------
Write-Step 'Prerequisites'
Invoke-Native { docker info 2>$null } | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Docker is not running.' }
Write-Ok 'Docker daemon is running'

$hostCaDir = ''
if ($SourceDir) {
    if (-not (Test-Admin)) { Stop-WithError '-SourceDir needs an elevated (Administrator) PowerShell: the CA folder is readable only by Administrators, SYSTEM and the service.' }
    # Relative paths follow the current PowerShell location (GetFullPath would use the process directory in 5.1).
    $SourceDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SourceDir)
    $hostCaDir = Join-Path $SourceDir 'pki\authorities\local'
    # The elevated reads below must not follow a link planted into another folder - anywhere on the path, from the
    # drive root down to the CA folder (a junction above -SourceDir would redirect the reads just the same).
    $chain = @()
    $p = $SourceDir
    while ($p) {
        $chain = @($p) + $chain
        $parent = Split-Path -Parent $p
        if (-not $parent -or $parent -eq $p) { break }
        $p = $parent
    }
    foreach ($d in @($chain + @((Join-Path $SourceDir 'pki'), (Join-Path $SourceDir 'pki\authorities'), $hostCaDir))) {
        $item = Get-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue
        if (-not $item -or -not $item.PSIsContainer) { Stop-WithError "Folder not found: $d" }
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { Stop-WithError "$d is a junction or symbolic link. Refusing to read through it." }
    }
    Write-Ok "CA folder: $hostCaDir"
}

$caddyVolume = "${Project}_caddy_data"
if (-not $GnupgVolume) { $GnupgVolume = "${Project}_backup_gnupg" }
if (-not $Recipient)    { $Recipient    = Get-EnvValue $EnvFile 'BACKUP_GPG_RECIPIENT' }
if (-not $ImageVersion) { $ImageVersion = Get-EnvValue $EnvFile 'WR_VERSION' }
if (-not $Recipient)    { Stop-WithError "No GPG recipient. Pass -Recipient or set BACKUP_GPG_RECIPIENT in $EnvFile." }
if (-not $ImageVersion) { Stop-WithError "No image version. Pass -ImageVersion or set WR_VERSION in $EnvFile." }
Assert-SafeToken 'Project' $Project
Assert-SafeToken 'Recipient' $Recipient
Assert-SafeToken 'ImageVersion' $ImageVersion
Assert-SafeToken 'GnupgVolume' $GnupgVolume

if (-not $SourceDir) {
    Invoke-Native { docker volume inspect $caddyVolume 2>$null } | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError "Volume not found: $caddyVolume (wrong -Project, or Caddy was never started)." }
    Write-Ok "CA volume: $caddyVolume"
}

$image = "wr-backup:$ImageVersion"
Invoke-Native { docker image inspect $image 2>$null } | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-WithError "Image not found: $image (load the package images first)." }
Write-Ok "Image: $image (provides tar and gpg)"

Invoke-Native { docker volume inspect $GnupgVolume 2>$null } | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-WithError "GPG keyring volume not found: $GnupgVolume" }
Invoke-Native { docker run --rm -v "${GnupgVolume}:/root/.gnupg" $image gpg --batch --list-keys $Recipient 2>$null } | Out-Null
if ($LASTEXITCODE -ne 0) {
    Stop-WithError "No GPG public key for '$Recipient' in volume $GnupgVolume. Register the backup public key first (docs/BACKUP_RESTORE.md)."
}
Write-Ok "GPG public key for '$Recipient' is present"

# ---------------------------------------------------------------------------
Write-Step 'Inspect the CA (file names and the public root certificate only)'
$caDir = '/data/caddy/pki/authorities/local'
$required = @('root.crt', 'root.key', 'intermediate.crt', 'intermediate.key')
$hostFiles = @{}
if ($SourceDir) {
    foreach ($f in $required) {
        $path = Join-Path $hostCaDir $f
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if (-not $item -or $item.PSIsContainer) { Stop-WithError "CA file missing in ${hostCaDir}: $f" }
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { Stop-WithError "$path is a symbolic link. Refusing to read through it." }
        if ($item.Length -le 0 -or $item.Length -gt 65536) { Stop-WithError "$path has an unexpected size ($($item.Length) bytes)." }
        $hostFiles[$f] = [System.IO.File]::ReadAllBytes($path)
    }
    Write-Ok ('All CA files present: ' + ($required -join ', '))
    $pem = [System.Text.Encoding]::ASCII.GetString($hostFiles['root.crt'])
} else {
    $checkCmd = ($required | ForEach-Object { "test -f $caDir/$_ || echo MISSING:$_" }) -join '; '
    $missing = @(Invoke-Native { docker run --rm --entrypoint sh -v "${caddyVolume}:/data:ro" $image -c $checkCmd 2>$null } | Where-Object { $_ -like 'MISSING:*' })
    if ($missing.Count -gt 0) {
        Stop-WithError ("CA files missing in ${caddyVolume}: " + (($missing | ForEach-Object { $_ -replace '^MISSING:', '' }) -join ', ') + ' (Caddy has not created its CA yet?)')
    }
    Write-Ok ('All CA files present: ' + ($required -join ', '))
    $pem = Invoke-Native { docker run --rm --entrypoint cat -v "${caddyVolume}:/data:ro" $image "$caDir/root.crt" 2>$null }
}
$b64 = (($pem | Out-String) -split "`n" | Where-Object { $_ -and $_ -notmatch '^-----' } | ForEach-Object { $_.Trim() }) -join ''
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [Convert]::FromBase64String($b64))
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$thumb256 = ([BitConverter]::ToString($sha256.ComputeHash($cert.RawData))).Replace('-', '')
Write-Ok "Root: $($cert.Subject)"
Write-Ok "Root SHA-1   (Windows thumbprint): $($cert.Thumbprint)"
Write-Ok "Root SHA-256: $thumb256"
Write-Ok "Root valid until: $($cert.NotAfter.ToString('yyyy-MM-dd'))"
if ($SourceDir) {
    # The host Caddy install records the root it was installed with; a different root here is the wrong folder.
    $hostState = 'C:\ProgramData\wr-caddy\state\install.json'
    if (Test-Path -LiteralPath $hostState) {
        $installed = ([string](([System.IO.File]::ReadAllText($hostState) | ConvertFrom-Json).rootSha256)).ToUpperInvariant()
        if ($installed -and $installed -ne $thumb256) { Stop-WithError "This root ($thumb256) is not the one the host Caddy service was installed with ($installed). Nothing was written." }
        Write-Ok 'Root = the one recorded by the host Caddy install'
    }
}

# ---------------------------------------------------------------------------
Write-Step 'Create the encrypted archive'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }
$outFull = (Resolve-Path $OutDir).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = "caddy-ca-$Project-$stamp.tar.gpg"
Assert-SafeToken 'output file name' $outFile

# The plain tar lives only in /dev/shm (memory) of this throw-away container; only the encrypted file reaches the host.
if (-not $SourceDir) {
    $archiveCmd = 'umask 077 && tar -C /data/caddy/pki/authorities -cf /dev/shm/ca.tar local && ' +
                  'gpg --batch --yes --trust-model always --recipient $GPG_RECIPIENT --output /out/$OUT_FILE --encrypt /dev/shm/ca.tar; ' +
                  'rc=$?; rm -f /dev/shm/ca.tar; exit $rc'
    Invoke-Native {
        docker run --rm --entrypoint sh `
            -e "GPG_RECIPIENT=$Recipient" -e "OUT_FILE=$outFile" `
            -v "${caddyVolume}:/data:ro" -v "${GnupgVolume}:/root/.gnupg" -v "${outFull}:/out" `
            $image -c $archiveCmd
    }
} else {
    # Host folder: name and base64 lines on standard input (ASCII, so Windows PowerShell 5.1 passes them intact).
    # The container rebuilds the files in /dev/shm, checks each SHA-256 against the original (H_* variables, not
    # secret) BEFORE encrypting, and removes its plain copies whatever happens.
    $payload = New-Object System.Collections.Generic.List[string]
    foreach ($f in $required) { $payload.Add($f); $payload.Add([Convert]::ToBase64String($hostFiles[$f])) }
    # No double quotes in this command: Windows PowerShell 5.1 does not escape them in native arguments (the shell
    # would see a broken line). Names and base64 contain no spaces, so nothing needs quoting.
    $importCmd = 'umask 077 && d=/dev/shm/caimport && mkdir -p $d/local && ' +
                 'tr -d ''\r'' | while IFS= read -r name && IFS= read -r data; do ' +
                 'case $name in root.crt|root.key|intermediate.crt|intermediate.key) ;; *) exit 3 ;; esac; ' +
                 'printf ''%s'' $data | base64 -d > $d/local/$name || exit 4; done; ' +
                 'ok=1; for p in root.crt:$H_RC root.key:$H_RK intermediate.crt:$H_IC intermediate.key:$H_IK; do ' +
                 'f=${p%%:*}; h=${p#*:}; test -s $d/local/$f || { ok=0; continue; }; ' +
                 'set -- $(sha256sum $d/local/$f); test $1 = $h || ok=0; done; ' +
                 'if [ $ok = 1 ]; then echo IMPORT_OK && tar -C $d -cf /dev/shm/ca.tar local && ' +
                 'gpg --batch --yes --trust-model always --recipient $GPG_RECIPIENT --output /out/$OUT_FILE --encrypt /dev/shm/ca.tar; ' +
                 'rc=$?; else echo IMPORT_MISMATCH; rc=5; fi; rm -rf $d /dev/shm/ca.tar; exit $rc'
    $importOut = Invoke-Native {
        $payload | docker run -i --rm --entrypoint sh `
            -e "GPG_RECIPIENT=$Recipient" -e "OUT_FILE=$outFile" `
            -e "H_RC=$(Get-Sha256Hex $hostFiles['root.crt'])" -e "H_RK=$(Get-Sha256Hex $hostFiles['root.key'])" `
            -e "H_IC=$(Get-Sha256Hex $hostFiles['intermediate.crt'])" -e "H_IK=$(Get-Sha256Hex $hostFiles['intermediate.key'])" `
            -v "${GnupgVolume}:/root/.gnupg" -v "${outFull}:/out" `
            $image -c $importCmd
    }
    $importCode = $LASTEXITCODE
    # Drop the key material from this process as soon as it is no longer needed.
    foreach ($f in $required) { [Array]::Clear($hostFiles[$f], 0, $hostFiles[$f].Length) }
    $payload.Clear()
    if (@($importOut | Where-Object { "$_" -eq 'IMPORT_OK' }).Count -eq 0) {
        Stop-WithError 'The CA files did not arrive intact in the container (SHA-256 mismatch). No archive was created.'
    }
    Write-Ok 'CA files rebuilt in container memory; SHA-256 of all four = the originals'
    $global:LASTEXITCODE = $importCode
}
$archivePath = Join-Path $outFull $outFile
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $archivePath) -or (Get-Item $archivePath).Length -le 0) {
    if (Test-Path $archivePath) { Remove-Item $archivePath -Force -ErrorAction SilentlyContinue }
    Stop-WithError 'Archive creation failed (no output file was kept).'
}
$size = (Get-Item $archivePath).Length
$fileHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash
Write-Ok "Archive: $archivePath ($size bytes)"

# Sanity check that does not need the private key: the file must be addressed to the expected key.
$packets = Invoke-Native {
    docker run --rm --entrypoint sh -e "OUT_FILE=$outFile" -v "${GnupgVolume}:/root/.gnupg" -v "${outFull}:/out:ro" $image `
        -c 'gpg --batch --list-packets /out/$OUT_FILE 2>&1 | grep -E "pubkey enc|keyid"'
}
if (-not $packets) { Stop-WithError 'The archive does not look like a public-key encrypted GPG file.' }
$packets | ForEach-Object { Write-Ok ("gpg: " + $_.Trim()) }

# ---------------------------------------------------------------------------
$infoPath = "$archivePath.info.txt"
$info = @(
    'Caddy internal CA backup - public information only (no key material in this file)',
    "Created        : $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))",
    "Project        : $Project",
    $(if ($SourceDir) { "Source folder  : $hostCaDir  (host Caddy service copy)" } else { "Source volume  : $caddyVolume  ($caDir)" }),
    "Files archived : $($required -join ', ')",
    "Encrypted for  : $Recipient",
    "Archive        : $outFile",
    "Archive SHA-256: $fileHash",
    "Root subject   : $($cert.Subject)",
    "Root SHA-1     : $($cert.Thumbprint)   (this is the thumbprint Windows shows)",
    "Root SHA-256   : $thumb256",
    "Root valid to  : $($cert.NotAfter.ToString('yyyy-MM-dd'))",
    '',
    'Restore: see docs/PRODUCTION_RELEASE_PLAN.md section 7-1. After restoring, the root fingerprint above must match.'
)
Set-Content -Path $infoPath -Value $info -Encoding ASCII
Write-Ok "Info file: $infoPath"

Write-Host ''
Write-Host 'Done. Next steps:' -ForegroundColor White
Write-Host '  1. Copy the .tar.gpg and the .info.txt to offline media (USB / safe), then delete the working copies.'
Write-Host '  2. Keep the matching GPG PRIVATE key offline and SEPARATE from this archive (it is required to restore).'
Write-Host '  3. Rehearse the restore on a non-production host at least once (PRODUCTION_RELEASE_PLAN.md section 7-1).'
