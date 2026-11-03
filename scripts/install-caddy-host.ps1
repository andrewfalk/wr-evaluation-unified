#Requires -Version 5.1
<#
.SYNOPSIS
    Installs, switches over, checks or removes Caddy as a Windows service on this host (release B).

.DESCRIPTION
    Docker Desktop hides the client IP from the Docker Caddy, so audit logs, sessions and device
    registrations all show the same address. Running Caddy directly on Windows lets it see the real
    client IP and pass it to the app in X-Forwarded-For.

    Modes (recorded in C:\ProgramData\wr-caddy\state\install.json):
      pilot   service on trial ports (default 9443 / 9080); the Docker Caddy keeps 8443 / 8080.
      host    service on 8443 / 8080; the Docker Caddy waits on 127.0.0.1:18443 / 127.0.0.1:18080
              (WR_CADDY_HTTPS_BIND / WR_CADDY_HTTP_BIND in the env file, so a normal `up -d` keeps it there).
      docker  after -Rollback: service stopped and DISABLED; the Docker Caddy serves 8443 / 8080 again.

    -Install never edits the env file and never runs docker compose. -Cutover and -Rollback edit only
    the two WR_CADDY_*_BIND lines of the env file and recreate only the caddy container
    (`up -d --no-deps caddy`); every other key, the app and the database are left alone.

      -Install    (Administrator) checks, then:
                    1. folders under C:\ProgramData\wr-caddy with restricted ACLs (set BEFORE the CA
                       key is copied): bin and state readable by users, data (CA key) and logs not
                    2. copies the internal CA read-only from the Docker volume, but only after the
                       root certificate fingerprint matches -ExpectedRootSha256, the CA backup
                       (-CaBackupInfo) and the volume. An existing CA folder is never overwritten.
                    3. verified caddy.exe + generated Caddyfile.host in bin, `caddy validate`
                    4. service wr-caddy (sc.exe, NT AUTHORITY\LocalService, automatic start,
                       restart on failure) and an inbound firewall rule for caddy.exe on the trial ports
                    5. starts the service and checks HTTPS, the root fingerprint and the listeners
                  If a step fails, what this run created (service, firewall rule, bin files) is
                  removed again. The copied CA is kept.
      -Cutover    (Administrator, mode pilot or docker) switches 8443 / 8080 to the service:
                    checks first (nothing changed): shell variables, the running caddy container was
                    created from the same compose files, 8443 / 8080 held only by that container,
                    18443 / 18080 free, and the resolved compose configuration after the change (app on
                    127.0.0.1, same CA volume, same domain); then `caddy validate` of the new config.
                    Then: stop the service, record host-mode.json, set the two env lines, recreate the
                    caddy container, move the config in place, firewall rule for 8443 / 8080, start
                    (automatic start) and verify. If any step fails it returns to the Docker Caddy by
                    itself (service disabled, env lines restored, caddy container recreated).
      -Rollback   (Administrator, mode host) back to the Docker Caddy: checks the target configuration
                  BEFORE stopping anything, then stops and disables the service, restores only the two
                  env lines recorded in host-mode.json (WR_APP_PORT stays), recreates the caddy container
                  and checks that 8443 answers with the same CA.
      -Reconfigure (Administrator, mode pilot or host) regenerates the configuration when the app's
                  published port changed, validates it and restarts the service.
      -Status     (any user) read-only report. Exit code 0 = OK, 1 = something needs attention.
      -Uninstall  (Administrator, mode pilot or docker) stops and deletes the service, removes the
                  firewall rule and the bin/state files. The CA copy (data) and the logs are KEPT.

    Windows PowerShell 5.1 compatible, ASCII only. Supports -WhatIf (checks run, nothing changes).

.PARAMETER Install
.PARAMETER Status
    Default when no action is given.
.PARAMETER Uninstall
.PARAMETER Cutover
.PARAMETER Rollback
.PARAMETER Reconfigure

.PARAMETER EnvFile
    Production env file. -Install/-Status only read it; -Cutover/-Rollback change the two
    WR_CADDY_*_BIND lines. Default: .\.env.production (-Rollback/-Status: the file -Cutover changed).

.PARAMETER ProjectName
    Docker Compose project of the running stack. Default: wr-prod

.PARAMETER ComposeDir
    Folder with docker-compose.yml and docker-compose.prod.yml (-Cutover/-Rollback). Default: the
    package root. Must be the folder the running caddy container was created from.

.PARAMETER ExtraComposeFile
    Further compose files the stack was started with (e.g. the verify-stack override).

.PARAMETER HttpsPort
    Trial HTTPS port. Default 9443. 8443 / 8080 are refused in this version.

.PARAMETER HttpPort
    Trial HTTP (redirect) port. Default 9080.

.PARAMETER ExpectedRootSha256
    SHA-256 fingerprint of the root certificate installed on the client PCs (check it on a client
    first). Colons and spaces are allowed. Install stops unless every copy of the CA matches it.

.PARAMETER CaBackupInfo
    The .info.txt written by scripts/backup-caddy-ca.ps1. The encrypted archive must sit next to it
    and match its recorded SHA-256, and the recorded root fingerprint must equal -ExpectedRootSha256.

.PARAMETER CaVolume
    Docker volume holding the Caddy data. Default: <ProjectName>_caddy_data

.PARAMETER ImageVersion
    Tag of the wr-backup image used to read the volume. Default: WR_VERSION from the env file.

.EXAMPLE
    .\caddy-host\install-caddy-host.ps1 -Install -ExpectedRootSha256 <client fingerprint> -CaBackupInfo .\caddy-ca-backup\caddy-ca-wr-prod-<stamp>.tar.gpg.info.txt -WhatIf
    .\caddy-host\install-caddy-host.ps1 -Install -ExpectedRootSha256 <client fingerprint> -CaBackupInfo .\caddy-ca-backup\caddy-ca-wr-prod-<stamp>.tar.gpg.info.txt
    .\caddy-host\install-caddy-host.ps1 -Status
    .\caddy-host\install-caddy-host.ps1 -Cutover -EnvFile <env file> -WhatIf
    .\caddy-host\install-caddy-host.ps1 -Cutover -EnvFile <env file>
    .\caddy-host\install-caddy-host.ps1 -Rollback
    .\caddy-host\install-caddy-host.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Status')]
param(
    [Parameter(ParameterSetName = 'Install', Mandatory = $true)][switch]$Install,
    [Parameter(ParameterSetName = 'Status')][switch]$Status,
    [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)][switch]$Uninstall,
    [Parameter(ParameterSetName = 'Cutover', Mandatory = $true)][switch]$Cutover,
    [Parameter(ParameterSetName = 'Rollback', Mandatory = $true)][switch]$Rollback,
    [Parameter(ParameterSetName = 'Reconfigure', Mandatory = $true)][switch]$Reconfigure,

    [string]$EnvFile     = '.\.env.production',
    [string]$ProjectName = 'wr-prod',
    [int]$HttpsPort      = 9443,
    [int]$HttpPort       = 9080,
    [string]$ComposeDir  = '',
    [string[]]$ExtraComposeFile = @(),

    [Parameter(ParameterSetName = 'Install', Mandatory = $true)][string]$ExpectedRootSha256,
    [Parameter(ParameterSetName = 'Install', Mandatory = $true)][string]$CaBackupInfo,
    [Parameter(ParameterSetName = 'Install')][string]$CaVolume = '',
    [Parameter(ParameterSetName = 'Install')][string]$ImageVersion = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Fixed values. The install root is deliberately not a parameter, and it contains no spaces, so the
# service command line needs no embedded quotes (no unquoted-service-path issue, and no difference
# between how Windows PowerShell 5.1 and PowerShell 7 quote native arguments).
$ServiceName    = 'wr-caddy'
$ServiceDisplay = 'WR Evaluation Caddy (host HTTPS proxy)'
$Root           = 'C:\ProgramData\wr-caddy'
$BinDir         = Join-Path $Root 'bin'
$DataDir        = Join-Path $Root 'data'
$LogDir         = Join-Path $Root 'logs'
$StateDir       = Join-Path $Root 'state'
$ExeDest        = Join-Path $BinDir 'caddy.exe'
$ConfigDest     = Join-Path $BinDir 'Caddyfile.host'
$CaDir          = Join-Path $DataDir 'pki\authorities\local'
$CaIncoming     = Join-Path $DataDir 'pki\authorities\local.incoming'
$StateFile      = Join-Path $StateDir 'install.json'
$RootCrtPublic  = Join-Path $StateDir 'root.crt'
$SnapshotFile   = Join-Path $StateDir 'listeners-before.json'
$HostModeFile   = Join-Path $StateDir 'host-mode.json'   # what -Cutover changed in the env file (no secrets)
$ConfigNext     = Join-Path $BinDir 'Caddyfile.host.next'
$ConfigPrev     = Join-Path $BinDir 'Caddyfile.host.prev'
$FirewallGroup  = 'WR Evaluation Caddy'
$ReservedPorts  = @(8443, 8080)   # -Install never takes these; only -Cutover moves the service onto them
$ProdHttpsPort  = 8443
$ProdHttpPort   = 8080
# The env lines -Cutover sets (and -Rollback restores). In host mode the Docker Caddy moves aside to loopback.
# The compose defaults below must equal docker-compose.yml "${WR_CADDY_HTTPS_BIND:-8443}" / "${WR_CADDY_HTTP_BIND:-8080}"
# (a test pins this): a key that was absent before is previewed with the default, never with an empty value -
# Windows PowerShell 5.1 deletes a variable set to '' and Compose would then read the env file's host value again.
$ModeKeys            = @('WR_CADDY_HTTPS_BIND', 'WR_CADDY_HTTP_BIND')
$HostBinds           = @{ WR_CADDY_HTTPS_BIND = '127.0.0.1:18443'; WR_CADDY_HTTP_BIND = '127.0.0.1:18080' }
$ComposeDefaultBinds = @{ WR_CADDY_HTTPS_BIND = '8443'; WR_CADDY_HTTP_BIND = '8080' }
# Processes through which Docker Desktop publishes container ports on the Windows host.
$DockerProcessPattern = '^(com\.docker\..+|vpnkit.*|wslrelay|wslhost|docker.*)$'
$CaFiles        = @('root.crt', 'root.key', 'intermediate.crt', 'intermediate.key')
$VolumeCaDir    = '/data/caddy/pki/authorities/local'

# Well-known SIDs (names differ by Windows language, SIDs do not).
$SidAdmins       = 'S-1-5-32-544'
$SidSystem       = 'S-1-5-18'
$SidLocalService = 'S-1-5-19'
$SidUsers        = 'S-1-5-32-545'
# Allow-lists for the ACL checks: only these may write the install root/bin/state, or read data/logs.
$Writers         = @($SidAdmins, $SidSystem)
$DataReaders     = @($SidAdmins, $SidSystem, $SidLocalService)

if ($Root -match '[\s"]') { throw "Install root must not contain spaces or quotes: $Root" }

# The script's own cmdlet object: the helper functions below call ShouldProcess through it so that
# -WhatIf / -Confirm given to the script apply to every change they make.
$ScriptCmdlet = $PSCmdlet

$ScriptDir   = $PSScriptRoot
$PackageRoot = Split-Path -Parent $ScriptDir
# Relative paths follow the current PowerShell location (GetFullPath would use the process working
# directory in Windows PowerShell 5.1).
function Resolve-UserPath([string]$Path) {
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}
$EnvFileGiven = $PSBoundParameters.ContainsKey('EnvFile')
$EnvFile = Resolve-UserPath $EnvFile
if (-not $ComposeDir) { $ComposeDir = $PackageRoot }
$ComposeDir = (Resolve-UserPath $ComposeDir).TrimEnd('\')
$ExtraComposeFile = @($ExtraComposeFile | Where-Object { $_ } | ForEach-Object { Resolve-UserPath $_ })
$ComposeFiles = @((Join-Path $ComposeDir 'docker-compose.yml'), (Join-Path $ComposeDir 'docker-compose.prod.yml')) + $ExtraComposeFile

# Load the networking modules up front with -WhatIf off: their auto-load creates aliases through
# New-Alias, which would otherwise print "What if" lines (and skip the aliases) under -WhatIf.
$whatIfAtStart = $WhatIfPreference
$WhatIfPreference = $false
Import-Module CimCmdlets, NetTCPIP, NetSecurity -ErrorAction SilentlyContinue
$WhatIfPreference = $whatIfAtStart

# ---------------------------------------------------------------------------
function Write-Step([string]$m) { Write-Host ''; Write-Host "-- $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "   OK   $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "   WARN $m" -ForegroundColor Yellow }
function Write-Fail([string]$m) { Write-Host "   FAIL $m" -ForegroundColor Red }

# Native commands may print harmless warnings on stderr; with EAP=Stop that aborts Windows
# PowerShell 5.1 even on exit code 0. Failures are detected through $LASTEXITCODE instead.
function Invoke-Native {
    param([Parameter(Mandatory)][scriptblock]$Block)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block } finally { $ErrorActionPreference = $prev }
}

function Test-Admin {
    $p = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-EnvValue([string]$Key) {
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { return $null }
    # docker compose: a later line wins over an earlier one.
    $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -Last 1
    if (-not $line) { return $null }
    return ($line -split '=', 2)[1].Trim()
}

function ConvertTo-Fingerprint([string]$Value) {
    $v = ($Value -replace '[\s:\-]', '').ToUpperInvariant()
    if ($v -notmatch '^[0-9A-F]{64}$') { return $null }
    return $v
}

function Get-CertFingerprint([System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Cert.RawData))).Replace('-', '') } finally { $sha.Dispose() }
}

function ConvertFrom-Pem([string]$Pem) {
    $b64 = (($Pem -split "`n") | Where-Object { $_ -and $_ -notmatch '^-----' } | ForEach-Object { $_.Trim() }) -join ''
    if (-not $b64) { return $null }
    return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [Convert]::FromBase64String($b64))
}

function Get-PemFileFingerprint([string]$Path) {
    $cert = ConvertFrom-Pem ([System.IO.File]::ReadAllText($Path))
    if (-not $cert) { return $null }
    return Get-CertFingerprint $cert
}

# .NET hashing instead of Get-FileHash: in Windows PowerShell 5.1 Get-FileHash is a script function
# that honours -WhatIf and then returns nothing, which would break every check under -WhatIf.
function Get-FileHashHex([string]$Path, [string]$Algorithm) {
    $alg = [System.Security.Cryptography.HashAlgorithm]::Create($Algorithm)
    $stream = [System.IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($alg.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $alg.Dispose() }
}

function Get-Sha512File([string]$Path) { return Get-FileHashHex $Path 'SHA512' }

# Real host-side publishes of running containers (HostIp/HostPort + compose labels), as in
# scripts/check-app-publish.ps1. `docker ps --filter publish=` is not used (its meaning differs
# between engine versions).
function Get-PortOwners {
    $ids = @(Invoke-Native { docker ps -q 2>$null } | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { throw 'docker ps failed. Is Docker running?' }
    $owners = @()
    if ($ids.Count -eq 0) { return $owners }
    $raw = Invoke-Native { docker inspect $ids 2>$null } | Out-String
    if ($LASTEXITCODE -ne 0) { throw 'docker inspect failed.' }
    foreach ($c in ($raw | ConvertFrom-Json)) {
        $project = ''
        $service = ''
        $labels = $c.Config.Labels
        if ($labels) {
            $p = $labels.PSObject.Properties['com.docker.compose.project']
            if ($p) { $project = [string]$p.Value }
            $s = $labels.PSObject.Properties['com.docker.compose.service']
            if ($s) { $service = [string]$s.Value }
        }
        $ports = $c.NetworkSettings.Ports
        if (-not $ports) { continue }
        foreach ($prop in $ports.PSObject.Properties) {
            foreach ($b in @($prop.Value)) {
                if ($null -eq $b) { continue }
                $owners += [pscustomobject]@{
                    Name     = ([string]$c.Name).TrimStart('/')
                    Project  = $project
                    Service  = $service
                    HostIp   = [string]$b.HostIp
                    HostPort = [string]$b.HostPort
                }
            }
        }
    }
    return $owners
}

# The app port Caddy must proxy to = what the running app container actually publishes.
# Throws when the publish breaks the rules (none, non-loopback, several ports). -Owners lets -Status read
# Docker separately, so "Docker unreadable" (warning) is not confused with a rule violation (problem).
function Get-AppPublishedPort {
    param([object[]]$Owners = $null)
    if ($null -eq $Owners) { $Owners = @(Get-PortOwners) }
    $app = @($Owners | Where-Object { $_.Project -eq $ProjectName -and $_.Service -eq 'app' })
    if ($app.Count -eq 0) {
        throw "No running '$ProjectName' app container publishes a port. Deploy the release that publishes the app on 127.0.0.1:<WR_APP_PORT> first (check-app-publish.ps1)."
    }
    $bad = @($app | Where-Object { $_.HostIp -ne '127.0.0.1' })
    if ($bad.Count -gt 0) {
        throw ("The app is published on a non-loopback address (" + (($bad | ForEach-Object { "$($_.HostIp):$($_.HostPort)" }) -join ', ') + "). Fix the compose files before going on.")
    }
    $portsFound = @($app | ForEach-Object { $_.HostPort } | Sort-Object -Unique)
    if ($portsFound.Count -ne 1) { throw ("The app publishes more than one port: " + ($portsFound -join ', ')) }
    return [int]$portsFound[0]
}

function Get-Listeners {
    $list = @()
    foreach ($t in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
        $list += [pscustomobject]@{ Proto = 'TCP'; Address = [string]$t.LocalAddress; Port = [int]$t.LocalPort; Pid = [int]$t.OwningProcess; Process = (Get-Process -Id $t.OwningProcess -ErrorAction SilentlyContinue).ProcessName }
    }
    foreach ($u in @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue)) {
        $list += [pscustomobject]@{ Proto = 'UDP'; Address = [string]$u.LocalAddress; Port = [int]$u.LocalPort; Pid = [int]$u.OwningProcess; Process = (Get-Process -Id $u.OwningProcess -ErrorAction SilentlyContinue).ProcessName }
    }
    return $list
}

function Test-PortInUse([int]$Port) {
    return [bool](@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0 -or
                  @(Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0)
}

function Get-ServiceInfo {
    return Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
}

# TLS probe through the service: SNI = domain, HTTP/1.1 GET, chain checked against the CA root.
function Invoke-TlsProbe([int]$Port, [string]$Domain, [string]$Path, [string]$RootPemPath, [int]$TimeoutMs = 10000) {
    $result = [ordered]@{ Ok = $false; Status = 0; LeafNotAfter = $null; ChainRoot = $null; Error = $null }
    $script:probeLeafRaw = $null
    $script:probeSentRaw = New-Object System.Collections.ArrayList
    $script:probePolicyErrors = [System.Net.Security.SslPolicyErrors]::None
    $client = New-Object System.Net.Sockets.TcpClient
    # Every step is bounded: a stuck upstream (Caddy has no response-header timeout by default) must make the
    # probe fail, not hang the install before it can roll back.
    $client.ReceiveTimeout = $TimeoutMs
    $client.SendTimeout = $TimeoutMs
    try {
        $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne($TimeoutMs)) { throw "connect to 127.0.0.1:$Port timed out" }
        $client.EndConnect($connect)
        # Copy the raw bytes inside the callback: .NET Framework (Windows PowerShell 5.1) frees the certificate
        # and chain handles once the callback returns, and X509Chain.Build on them then throws.
        # The callback accepts everything (the CA is not in the trust store here); the checks are done below.
        $callback = [System.Net.Security.RemoteCertificateValidationCallback] {
            param($s, $cert, $sentChain, $errors)
            $script:probePolicyErrors = $errors
            $script:probeLeafRaw = $cert.GetRawCertData()
            if ($sentChain) { foreach ($el in $sentChain.ChainElements) { [void]$script:probeSentRaw.Add($el.Certificate.RawData) } }
            return $true
        }
        $ssl = New-Object System.Net.Security.SslStream ($client.GetStream(), $false, $callback)
        $ssl.ReadTimeout = $TimeoutMs
        $ssl.WriteTimeout = $TimeoutMs
        # Explicit TLS 1.2: Windows PowerShell 5.1 (.NET Framework) may otherwise offer only TLS 1.0.
        $ssl.AuthenticateAsClient($Domain, $null, [System.Security.Authentication.SslProtocols]::Tls12, $false)
        if ($script:probePolicyErrors -band [System.Net.Security.SslPolicyErrors]::RemoteCertificateNameMismatch) {
            throw "the server certificate is not issued for $Domain"
        }
        $leaf = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (,$script:probeLeafRaw)
        $result.LeafNotAfter = $leaf.NotAfter
        $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
        # Intermediates the server sent; the root still has to match the expected fingerprint below.
        foreach ($raw in $script:probeSentRaw) {
            [void]$chain.ChainPolicy.ExtraStore.Add((New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (,[byte[]]$raw)))
        }
        if ($RootPemPath -and (Test-Path -LiteralPath $RootPemPath)) {
            $rootCert = ConvertFrom-Pem ([System.IO.File]::ReadAllText($RootPemPath))
            if ($rootCert) { [void]$chain.ChainPolicy.ExtraStore.Add($rootCert) }
        }
        # AllowUnknownCertificateAuthority waives only "root not trusted"; time validity, signatures and a
        # complete chain are still required.
        $built = $chain.Build($leaf)
        if ($chain.ChainElements.Count -gt 0) {
            $result.ChainRoot = Get-CertFingerprint $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
        }
        if (-not $built) {
            $why = @($chain.ChainStatus | ForEach-Object { [string]$_.Status } | Sort-Object -Unique) -join ', '
            throw "certificate chain is not valid ($why)"
        }
        $req = [System.Text.Encoding]::ASCII.GetBytes("GET $Path HTTP/1.1`r`nHost: ${Domain}:$Port`r`nConnection: close`r`n`r`n")
        $ssl.Write($req, 0, $req.Length)
        $ssl.Flush()
        $reader = New-Object System.IO.StreamReader ($ssl, [System.Text.Encoding]::ASCII)
        $statusLine = $reader.ReadLine()
        if ($statusLine -match '^HTTP/\d(\.\d)? (\d{3})') { $result.Status = [int]$Matches[2] }
        $result.Ok = $true
    } catch {
        $result.Error = $_.Exception.Message
    } finally {
        $client.Close()
    }
    return [pscustomobject]$result
}

function Get-StateJson {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { return $null }
    return ([System.IO.File]::ReadAllText($StateFile) | ConvertFrom-Json)
}

function Write-TextFile([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

function Invoke-Icacls([string[]]$IcaclsArgs) {
    $out = Invoke-Native { & icacls.exe @IcaclsArgs 2>&1 }
    if ($LASTEXITCODE -ne 0) { throw ("icacls " + ($IcaclsArgs -join ' ') + " failed: " + ($out | Out-String).Trim()) }
}

# Any allow ACE (explicit or inherited) that gives the listed rights on $Path to a SID outside $AllowedSids.
# Allow-list, not a list of broad groups: a single user's SID can also be planted (ProgramData lets users
# create folders, and the creator owns them).
# -Acl: check a security descriptor already in hand (e.g. read through an open file handle) instead of $Path.
function Get-ForeignAccess([string]$Path, [System.Security.AccessControl.FileSystemRights]$Rights, [string[]]$AllowedSids, $Acl = $null) {
    $hits = @()
    if ($null -eq $Acl) { $Acl = Get-Acl -LiteralPath $Path }
    foreach ($ace in $Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne 'Allow') { continue }
        if ($AllowedSids -contains $ace.IdentityReference.Value) { continue }
        if (($ace.FileSystemRights -band $Rights) -ne 0) { $hits += "$($ace.IdentityReference.Value) ($($ace.FileSystemRights))" }
    }
    return $hits
}

# Junctions / symbolic links at or under $Top. Does not descend into them (5.1 Get-ChildItem -Recurse would).
# Elevated icacls /T and file writes must never follow a link a user planted into another folder.
function Get-ReparsePoints([string]$Top) {
    $hits = @()
    $topItem = Get-Item -LiteralPath $Top -Force -ErrorAction SilentlyContinue
    if (-not $topItem) { return $hits }
    if ($topItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return @($Top) }
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($Top)
    while ($queue.Count -gt 0) {
        foreach ($i in @(Get-ChildItem -LiteralPath $queue.Dequeue() -Force -ErrorAction SilentlyContinue)) {
            if ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $hits += $i.FullName; continue }
            if ($i.PSIsContainer) { $queue.Enqueue($i.FullName) }
        }
    }
    return $hits
}

# An existing install root is accepted only in the locked state this script leaves it in: a real folder,
# owned by Administrators/SYSTEM, writable by nobody else. ProgramData lets any user create (and own) a
# folder there, e.g. a junction to a folder they can swap later. Returns the reason, or $null.
# -MustExist: the caller saw the folder before. Its disappearance is then a problem, not "nothing there" -
# a user-owned folder deleted between two checks could come back as a junction right after.
function Get-ExistingRootProblem([switch]$MustExist) {
    if (-not (Test-Path -LiteralPath $Root)) {
        if ($MustExist) { return "$Root disappeared after it was seen" }
        return $null
    }
    $item = Get-Item -LiteralPath $Root -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return "$Root is a junction or symbolic link" }
    if (-not $item.PSIsContainer) { return "$Root is not a folder" }
    $owner = (Get-Acl -LiteralPath $Root).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($Writers -notcontains $owner) { return "$Root is owned by $owner, not by Administrators or SYSTEM" }
    $foreign = @(Get-ForeignAccess $Root $WriteRights $Writers)
    if ($foreign.Count -gt 0) { return "others can write ${Root}: $($foreign -join ', ')" }
    return $null
}

# icacls /grant:r replaces only the SIDs it names; remove every other explicit allow entry on $Path.
function Remove-ForeignAllowAce([string]$Path, [string[]]$KeepSids) {
    foreach ($rule in (Get-Acl -LiteralPath $Path).GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
        $sid = $rule.IdentityReference.Value
        if ($rule.AccessControlType -eq 'Allow' -and $KeepSids -notcontains $sid) { Invoke-Icacls @($Path, '/remove:g', "*$sid") }
    }
}

$WriteRights = [System.Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
$ReadRights  = [System.Security.AccessControl.FileSystemRights]'ReadData'

# ===========================================================================
# Switch-over helpers (-Cutover / -Rollback / -Reconfigure)

# Property of a parsed JSON object, or $null when absent (StrictMode throws on a missing property).
function Get-JsonProp($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Update-JsonFile([string]$Path, [hashtable]$Changes) {
    $o = [ordered]@{}
    $parsed = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
    foreach ($p in $parsed.PSObject.Properties) { $o[$p.Name] = $p.Value }
    foreach ($k in $Changes.Keys) { $o[$k] = $Changes[$k] }
    Write-TextFile $Path ($o | ConvertTo-Json -Depth 5)
}

function Get-HostModeJson {
    if (-not (Test-Path -LiteralPath $HostModeFile -PathType Leaf)) { return $null }
    return ([System.IO.File]::ReadAllText($HostModeFile) | ConvertFrom-Json)
}

# --- env file, key by key ----------------------------------------------------
# Keeps comments, order, BOM and every line's own line ending (a file may mix CRLF and LF); only the lines of the
# changed keys differ afterwards, byte for byte.
function Read-EnvDocument([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $offset = 0
    if ($bom) { $offset = 3 }
    $text = (New-Object System.Text.UTF8Encoding $false, $true).GetString($bytes, $offset, $bytes.Length - $offset)
    $lines = New-Object System.Collections.Generic.List[string]
    $endings = New-Object System.Collections.Generic.List[string]
    foreach ($m in [regex]::Matches($text, "([^\r\n]*)(\r\n|\n|\r|$)")) {
        if ($m.Length -eq 0) { continue }   # the empty match at the very end
        $lines.Add($m.Groups[1].Value)
        $endings.Add($m.Groups[2].Value)
    }
    # Line ending for appended lines: that of the last line that has one (LF in an empty or one-line file without one).
    $newLine = "`n"
    for ($i = $endings.Count - 1; $i -ge 0; $i--) { if ($endings[$i]) { $newLine = $endings[$i]; break } }
    return [pscustomobject]@{ Path = $Path; Bom = $bom; NewLine = $newLine; Lines = $lines; Endings = $endings }
}

function Test-EnvKeyLine([string]$Line, [string]$Key) { return ($Line -match "^\s*(export\s+)?$Key\s*=") }

# Value as docker compose reads it: surrounding quotes removed, " # comment" dropped from unquoted values.
function ConvertFrom-EnvLine([string]$Line) {
    $v = ($Line -split '=', 2)[1].Trim()
    if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) { return $v.Substring(1, $v.Length - 2) }
    $hash = $v.IndexOf(' #')
    if ($hash -ge 0) { $v = $v.Substring(0, $hash).TrimEnd() }
    return $v
}

# Current WR_CADDY_*_BIND lines. A key on several lines is refused: which one wins is easy to get wrong by hand.
function Get-ModeKeyState($Doc) {
    $result = @{}
    foreach ($k in $ModeKeys) {
        $hits = @($Doc.Lines | Where-Object { Test-EnvKeyLine $_ $k })
        if ($hits.Count -gt 1) { throw "$k appears on $($hits.Count) lines of $($Doc.Path). Keep one line (or none) and run again. Nothing was changed." }
        if ($hits.Count -eq 1) { $result[$k] = [pscustomobject]@{ Exists = $true; Line = [string]$hits[0]; Value = (ConvertFrom-EnvLine $hits[0]) } }
        else { $result[$k] = [pscustomobject]@{ Exists = $false; Line = $null; Value = $null } }
    }
    return $result
}

# $Changes: key -> the full line to write, or $null to delete that key's line. The temporary file is created
# WITH the env file's ACL and opened exclusively, and the secrets are written through that same handle: it never
# inherits the folder's ACL (users may be able to read the folder), and nobody can hold a handle opened before
# it was locked (Windows does not revoke open handles when an ACL changes). File.Replace then swaps it in; the
# original file, with its ACL, becomes the backup. Returns the backup path.
function Write-EnvKeys([string]$Path, [System.Collections.Specialized.OrderedDictionary]$Changes, [string]$BackupTag) {
    $doc = Read-EnvDocument $Path
    $sb = New-Object System.Text.StringBuilder
    $handled = @{}
    for ($i = 0; $i -lt $doc.Lines.Count; $i++) {
        $l = $doc.Lines[$i]
        $key = $null
        foreach ($k in @($Changes.Keys)) { if (Test-EnvKeyLine $l $k) { $key = $k; break } }
        if ($null -eq $key) { [void]$sb.Append($l).Append($doc.Endings[$i]); continue }
        if ($handled.ContainsKey($key)) { throw "$key appears on more than one line of $Path. Nothing was changed." }
        $handled[$key] = $true
        if ($null -ne $Changes[$key]) { [void]$sb.Append([string]$Changes[$key]).Append($doc.Endings[$i]) }   # replaced in place, same ending
    }
    foreach ($k in @($Changes.Keys)) {
        if ($handled.ContainsKey($k) -or $null -eq $Changes[$k]) { continue }
        # Appended at the end, each with its own line ending (after giving a last line without one an ending).
        if ($sb.Length -gt 0 -and -not ($sb.ToString().EndsWith("`n") -or $sb.ToString().EndsWith("`r"))) { [void]$sb.Append($doc.NewLine) }
        [void]$sb.Append([string]$Changes[$k]).Append($doc.NewLine)
    }
    $body = (New-Object System.Text.UTF8Encoding $false).GetBytes($sb.ToString())
    if ($doc.Bom) { $body = [byte[]](0xEF, 0xBB, 0xBF) + $body }

    $origAcl = Get-Acl -LiteralPath $Path
    $readers = @(foreach ($r in $origAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($r.AccessControlType -eq 'Allow' -and ($r.FileSystemRights -band $ReadRights) -ne 0) { $r.IdentityReference.Value }
    })
    $sec = New-Object System.Security.AccessControl.FileSecurity
    $sec.SetSecurityDescriptorSddlForm($origAcl.GetSecurityDescriptorSddlForm('Access'), 'Access')
    $sec.SetAccessRuleProtection($true, $true)   # same entries as the env file, inherited ones made explicit
    # FileSystemRights, not FileAccess: ReadPermissions is needed to read the ACL back through this handle.
    $rights = [System.Security.AccessControl.FileSystemRights]'Write, ReadPermissions'
    $tmp = Join-Path (Split-Path -Parent $Path) ('.' + (Split-Path -Leaf $Path) + '.tmp-' + [Guid]::NewGuid().ToString('N'))
    $backup = "$Path.before-$BackupTag-" + (Get-Date).ToString('yyyyMMdd-HHmmss')
    $fs = $null
    try {
        if ($PSVersionTable.PSEdition -eq 'Core') {
            $fs = [System.IO.FileSystemAclExtensions]::Create((New-Object System.IO.FileInfo $tmp), [System.IO.FileMode]::CreateNew, $rights,
                [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $sec)
            $tmpAcl = [System.IO.FileSystemAclExtensions]::GetAccessControl($fs)
        } else {
            $fs = New-Object System.IO.FileStream ($tmp, [System.IO.FileMode]::CreateNew, $rights, [System.IO.FileShare]::None, 4096,
                [System.IO.FileOptions]::None, $sec)
            $tmpAcl = $fs.GetAccessControl()
        }
        $foreign = @(Get-ForeignAccess $tmp $ReadRights $readers -Acl $tmpAcl)
        if ($foreign.Count -gt 0) { throw "The temporary env file would be readable by $($foreign -join ', '). Nothing was changed." }
        $fs.Write($body, 0, $body.Length)
        $fs.Flush($true)
        $fs.Dispose()
        $fs = $null
        [System.IO.File]::Replace($tmp, $Path, $backup)
    } finally {
        if ($fs) { $fs.Dispose() }
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
    return $backup
}

# Restores the WR_CADDY_*_BIND lines recorded by -Cutover (action 'revert' only; WR_APP_PORT is 'retain').
# Never copies a backup back as a whole: WR_VERSION, passwords and other keys may have changed since.
function Undo-EnvModeKeys {
    $hm = Get-HostModeJson
    if (-not $hm) { throw "$HostModeFile not found." }
    $changes = New-Object System.Collections.Specialized.OrderedDictionary
    foreach ($e in @($hm.entries)) {
        if ([string]$e.action -ne 'revert') { continue }
        if ($e.existedBefore) { $changes[[string]$e.key] = [string]$e.previousLine } else { $changes[[string]$e.key] = $null }
    }
    # The journal stays 'applied': it is closed only after the Docker Caddy answers and the mode says docker, so a
    # rollback that fails after this step can simply be run again.
    return (Write-EnvKeys $EnvFile $changes 'rollback')
}

# Closes the journal; called last, after the mode was set to docker.
function Close-HostModeJournal([string]$Status) {
    if (Test-Path -LiteralPath $HostModeFile) { Update-JsonFile $HostModeFile @{ status = $Status; closedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK') } }
}

# --- docker compose -------------------------------------------------------------
# Shell variables win over --env-file. Any variable the env file or the compose files use must not be set in
# this window, or the configuration checked here and the one `up` uses could differ from the env file.
function Get-ComposeVariableNames {
    $names = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($f in $ComposeFiles) {
        if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
        foreach ($m in [regex]::Matches([System.IO.File]::ReadAllText($f), '\$\{([A-Za-z_][A-Za-z0-9_]*)')) { [void]$names.Add($m.Groups[1].Value) }
    }
    if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
        foreach ($l in [System.IO.File]::ReadAllLines($EnvFile)) { if ($l -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=') { [void]$names.Add($Matches[1]) } }
    }
    foreach ($k in @($ModeKeys + @('WR_APP_PORT', 'WR_DOMAIN'))) { [void]$names.Add($k) }
    return , $names
}

function Get-ShellOverrides {
    $names = Get-ComposeVariableNames
    return @(Get-ChildItem Env: | Where-Object { $names.Contains($_.Name) } | ForEach-Object { $_.Name } | Sort-Object)
}

function Assert-NoShellOverride {
    $hits = @(Get-ShellOverrides)
    if ($hits.Count -gt 0) {
        throw ("These variables are set in this PowerShell window and would override $EnvFile for docker compose: " + ($hits -join ', ') +
            ". Open a new PowerShell window (or Remove-Item Env:<name>) and run again. Nothing was changed.")
    }
}

function Assert-ComposeFiles {
    foreach ($f in $ComposeFiles) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "Compose file not found: $f (pass -ComposeDir / -ExtraComposeFile)." } }
}

function Get-ComposeArgs {
    $a = @('compose', '-p', $ProjectName, '--project-directory', $ComposeDir, '--env-file', $EnvFile)
    foreach ($f in $ComposeFiles) { $a += @('-f', $f) }
    return $a
}

# Resolved configuration. $Overrides go into this process's environment for this call only, so the result of a
# planned env change can be checked before the file is touched. Values must be non-empty (see $ComposeDefaultBinds).
# Removal uses [NullString]::Value: PowerShell 7 turns $null into '' for .NET string parameters, which would leave
# an EMPTY variable behind. Set-Item/Remove-Item Env: are not used because they obey -WhatIf.
function Get-ComposeConfig([hashtable]$Overrides = @{}) {
    foreach ($k in @($Overrides.Keys)) { if ([string]::IsNullOrEmpty([string]$Overrides[$k])) { throw "Internal error: empty override for $k" } }
    try {
        foreach ($k in @($Overrides.Keys)) { [Environment]::SetEnvironmentVariable($k, [string]$Overrides[$k], 'Process') }
        $a = @(Get-ComposeArgs) + @('config', '--format', 'json')
        $out = @(Invoke-Native { & docker @a 2>&1 })
        $code = $LASTEXITCODE
    } finally {
        foreach ($k in @($Overrides.Keys)) { [Environment]::SetEnvironmentVariable($k, [NullString]::Value, 'Process') }
    }
    $errText = ($out | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join ' '
    if ($code -ne 0) { throw "docker compose config failed: $errText" }
    $json = ($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ }) -join "`n"
    $parsed = $json | ConvertFrom-Json
    return $parsed
}

# The only container change this script makes: recreate the caddy container (the app and the database stay).
function Invoke-ComposeUpCaddy {
    $a = @(Get-ComposeArgs) + @('up', '-d', '--no-deps', 'caddy')
    $out = Invoke-Native { & docker @a 2>&1 }
    if ($LASTEXITCODE -ne 0) { throw ("docker compose up -d --no-deps caddy failed: " + ($out | Out-String).Trim()) }
}

function ConvertFrom-Bind([string]$Bind) {
    $i = $Bind.LastIndexOf(':')
    if ($i -lt 0) { return [pscustomobject]@{ Ip = ''; Port = [int]$Bind } }
    return [pscustomobject]@{ Ip = $Bind.Substring(0, $i).Trim('[', ']'); Port = [int]$Bind.Substring($i + 1) }
}

# Checks a resolved configuration: the app stays on 127.0.0.1:<its port>, caddy publishes exactly $Binds, keeps
# the CA volume the service was installed from (another volume = a NEW CA, every PC would need a new root) and
# the domain the service was installed for.
function Assert-TargetConfig($Config, [hashtable]$Binds, [int]$AppPort, [string]$Domain, $State) {
    $services = Get-JsonProp $Config 'services'
    $appPorts = @(Get-JsonProp (Get-JsonProp $services 'app') 'ports')
    if ($appPorts.Count -eq 0) { throw 'compose: the app would publish no port.' }
    foreach ($p in $appPorts) {
        if ([string](Get-JsonProp $p 'host_ip') -ne '127.0.0.1') { throw "compose: the app would be published on '$(Get-JsonProp $p 'host_ip')', not 127.0.0.1." }
        if ([int](Get-JsonProp $p 'published') -ne $AppPort) { throw "compose: the app would be published on port $(Get-JsonProp $p 'published'), but it runs on $AppPort." }
    }
    $caddy = Get-JsonProp $services 'caddy'
    if ($null -eq $caddy) { throw 'compose: no caddy service.' }
    $want = @(@(foreach ($k in $ModeKeys) {
        $b = ConvertFrom-Bind $Binds[$k]
        $target = 80
        if ($k -eq 'WR_CADDY_HTTPS_BIND') { $target = 443 }
        "$($b.Ip)|$($b.Port)|$target"
    }) | Sort-Object)
    $have = @(@(foreach ($p in @(Get-JsonProp $caddy 'ports')) {
        "$([string](Get-JsonProp $p 'host_ip'))|$([string](Get-JsonProp $p 'published'))|$([string](Get-JsonProp $p 'target'))"
    }) | Sort-Object)
    if (($have -join ',') -ne ($want -join ',')) { throw "compose: caddy would publish $($have -join ', '), expected $($want -join ', ')." }
    $dataMount = @(@(Get-JsonProp $caddy 'volumes') | Where-Object { [string](Get-JsonProp $_ 'target') -eq '/data' })
    if ($dataMount.Count -ne 1 -or [string](Get-JsonProp $dataMount[0] 'type') -ne 'volume') { throw 'compose: caddy has no named volume on /data.' }
    $volName = [string](Get-JsonProp (Get-JsonProp (Get-JsonProp $Config 'volumes') ([string](Get-JsonProp $dataMount[0] 'source'))) 'name')
    if ($volName -ne [string]$State.caVolume) {
        throw "compose: caddy /data would be volume '$volName', but the CA was installed from '$($State.caVolume)'. Another volume means a NEW CA (every PC would need a new root). Nothing was changed."
    }
    $d = [string](Get-JsonProp (Get-JsonProp $caddy 'environment') 'WR_DOMAIN')
    if ($d -ne $Domain -or $d -ne [string]$State.domain) { throw "compose: caddy WR_DOMAIN would be '$d' (env file: '$Domain', installed for '$($State.domain)'). Nothing was changed." }
}

function Get-DockerCaddyContainer {
    $ids = @(Invoke-Native { docker ps -a -q --filter "label=com.docker.compose.project=$ProjectName" --filter 'label=com.docker.compose.service=caddy' 2>$null } | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { throw 'docker ps failed. Is Docker running?' }
    if ($ids.Count -eq 0) { return $null }
    if ($ids.Count -gt 1) { throw "More than one '$ProjectName' caddy container exists." }
    $raw = Invoke-Native { docker inspect $ids[0] 2>$null } | Out-String
    if ($LASTEXITCODE -ne 0) { throw 'docker inspect failed.' }
    $parsed = $raw | ConvertFrom-Json
    return @($parsed)[0]
}

# `up` from other files or another folder would rebuild the caddy container from a different definition (e.g. an
# older package without WR_CADDY_*_BIND). Require what the running container was created with.
function Assert-ComposeMatchesContainer($Container) {
    $labels = $Container.Config.Labels
    $norm = { param($p) ([string]$p).TrimEnd('\', '/').Replace('/', '\').ToLowerInvariant() }
    $wd = [string](Get-JsonProp $labels 'com.docker.compose.project.working_dir')
    if ((& $norm $wd) -ne (& $norm $ComposeDir)) {
        throw "The running caddy container was created from $wd, not $ComposeDir. Run this script from that package or pass -ComposeDir (and the same -ExtraComposeFile). Nothing was changed."
    }
    $files = [string](Get-JsonProp $labels 'com.docker.compose.project.config_files')
    # Same files in the same ORDER: a later file overrides an earlier one.
    $have = @($files -split ',' | Where-Object { $_ } | ForEach-Object {
        $f = $_
        if (-not [System.IO.Path]::IsPathRooted($f)) { $f = Join-Path $wd $f }
        & $norm $f
    })
    $want = @($ComposeFiles | ForEach-Object { & $norm $_ })
    if (($have -join '|') -ne ($want -join '|')) {
        throw "The running caddy container was created with the compose files [$files] (in this order); this run would use [$($ComposeFiles -join ',')]. Pass the same files in the same order (-ExtraComposeFile). Nothing was changed."
    }
    $envLabel = [string](Get-JsonProp $labels 'com.docker.compose.project.environment_file')
    if ($envLabel -and (& $norm $envLabel) -ne (& $norm $EnvFile)) {
        throw "The running caddy container was created with the env file $envLabel, not $EnvFile. Pass -EnvFile '$envLabel'. Nothing was changed."
    }
}

function Get-TcpListeners([int]$Port) {
    return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{ Address = [string]$_.LocalAddress; Pid = [int]$_.OwningProcess; Process = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName }
    })
}

# The project's Docker Caddy publishes exactly the ports of $Binds, on the addresses they name ('' = all).
function Test-CaddyPublish([object[]]$Owners, [hashtable]$Binds) {
    $mine = @($Owners | Where-Object { $_.Project -eq $ProjectName -and $_.Service -eq 'caddy' })
    if ($mine.Count -eq 0) { return $false }
    $wantPorts = @(@(foreach ($k in $ModeKeys) { (ConvertFrom-Bind $Binds[$k]).Port }) | Sort-Object)
    $havePorts = @(@($mine | ForEach-Object { [int]$_.HostPort }) | Sort-Object -Unique)
    if (($havePorts -join ',') -ne ($wantPorts -join ',')) { return $false }
    foreach ($k in $ModeKeys) {
        $b = ConvertFrom-Bind $Binds[$k]
        foreach ($o in @($mine | Where-Object { [int]$_.HostPort -eq $b.Port })) {
            if ($b.Ip) { if ($o.HostIp -ne $b.Ip) { return $false } }
            elseif (@('', '0.0.0.0', '::') -notcontains $o.HostIp) { return $false }
        }
    }
    return $true
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds = 60) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ($true) {
        if (& $Condition) { return $true }
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 500
    }
}

function Test-ProdPortsFree { return (@(Get-TcpListeners $ProdHttpsPort).Count -eq 0 -and @(Get-TcpListeners $ProdHttpPort).Count -eq 0) }

# Nothing but Docker listens on 8443 / 8080 (wr-caddy has let go of them).
function Test-NoHostListener {
    return (@(@(Get-TcpListeners $ProdHttpsPort) + @(Get-TcpListeners $ProdHttpPort) | Where-Object { $_.Process -notmatch $DockerProcessPattern }).Count -eq 0)
}

# The Docker Caddy answers on 8443 again: listeners are Docker's, the chain root is the installed CA.
function Wait-DockerHttps([string]$Domain, [string]$Fp) {
    $script:lastDockerProbe = $null
    $ok = Wait-Until {
        $l = @(Get-TcpListeners $ProdHttpsPort)
        if ($l.Count -eq 0 -or @($l | Where-Object { $_.Process -notmatch $DockerProcessPattern }).Count -gt 0) { return $false }
        $script:lastDockerProbe = Invoke-TlsProbe $ProdHttpsPort $Domain '/api/config/public' $RootCrtPublic
        return ($script:lastDockerProbe.Ok -and $script:lastDockerProbe.ChainRoot -eq $Fp -and $script:lastDockerProbe.Status -ge 200 -and $script:lastDockerProbe.Status -lt 500)
    } 60
    if (-not $ok) {
        $why = 'no Docker listener on 8443'
        if ($script:lastDockerProbe) { $why = "probe: ok=$($script:lastDockerProbe.Ok) status=$($script:lastDockerProbe.Status) root=$($script:lastDockerProbe.ChainRoot) $($script:lastDockerProbe.Error)" }
        throw "The Docker Caddy does not answer correctly on :8443 within 60 s ($why)."
    }
}

# wr-caddy answers on $Https with the installed CA and listens on exactly $Https/$Http (no UDP, nothing on 2019).
function Assert-HostServing([string]$Domain, [string]$Fp, [int]$AppPort, [int]$Https, [int]$Http) {
    $probe = $null
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Seconds 1
        $probe = Invoke-TlsProbe $Https $Domain '/api/config/public' $RootCrtPublic
    } while (-not $probe.Ok -and (Get-Date) -lt $deadline)
    if (-not $probe.Ok) { throw "HTTPS check failed on 127.0.0.1:$Https ($($probe.Error)). See $LogDir\caddy.log." }
    if ($probe.ChainRoot -ne $Fp) { throw "The service presents a chain whose root is $($probe.ChainRoot), not the installed CA." }
    if ($probe.Status -lt 200 -or $probe.Status -ge 500) { throw "HTTPS answered with status $($probe.Status) (the app behind 127.0.0.1:$AppPort?)." }
    Write-Ok "HTTPS on :$Https answers $($probe.Status), chain root = installed CA, certificate valid until $($probe.LeafNotAfter)"
    $svc = Get-ServiceInfo
    $all = @(Get-Listeners)
    $mine = @($all | Where-Object { $_.Pid -eq [int]$svc.ProcessId })
    $tcp = @($mine | Where-Object { $_.Proto -eq 'TCP' } | ForEach-Object { $_.Port } | Sort-Object -Unique)
    if (($tcp -join ',') -ne ((@($Https, $Http) | Sort-Object) -join ',')) { throw "caddy.exe listens on TCP $($tcp -join ', '), expected only $Https and $Http." }
    if (@($mine | Where-Object { $_.Proto -eq 'UDP' }).Count -gt 0) { throw 'caddy.exe opened UDP ports.' }
    if (@($all | Where-Object { $_.Proto -eq 'TCP' -and $_.Port -eq 2019 }).Count -gt 0) { throw 'Something listens on TCP 2019 (Caddy admin API must be off).' }
    $others = @($all | Where-Object { $_.Proto -eq 'TCP' -and @($Https, $Http) -contains $_.Port -and $_.Pid -ne [int]$svc.ProcessId })
    if ($others.Count -gt 0) { throw "Other processes also listen on ${Https}/${Http}: $(($others | ForEach-Object { $_.Process }) -join ', ')" }
    Write-Ok "Listeners: caddy.exe alone on TCP $($tcp -join ', '); no UDP; nothing on 2019"
}

function Set-ServiceStart([string]$Mode) {
    $out = Invoke-Native { & sc.exe config $ServiceName 'start=' $Mode 2>&1 }
    if ($LASTEXITCODE -ne 0) { throw ("sc.exe config start= $Mode failed: " + ($out | Out-String).Trim()) }
}

function Stop-HostService {
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
    if (-not (Wait-Until { (Get-ServiceInfo).State -eq 'Stopped' } 30)) { throw "Service '$ServiceName' did not stop within 30 s." }
}

function Get-TemplatePath {
    $p = Join-Path $ScriptDir 'Caddyfile.host.template'   # package layout (caddy-host\)
    if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
    return (Join-Path $PackageRoot 'caddy\Caddyfile.host.template')
}

function New-HostCaddyConfig([int]$Https, [int]$Http, [int]$AppPort, [string]$Domain) {
    $template = [System.IO.File]::ReadAllText((Get-TemplatePath))
    $config = $template.Replace('__DATA_DIR__', ($DataDir -replace '\\', '/')).Replace('__LOG_DIR__', ($LogDir -replace '\\', '/')).
        Replace('__DOMAIN__', $Domain).Replace('__HTTPS_PORT__', [string]$Https).Replace('__HTTP_PORT__', [string]$Http).
        Replace('__APP_PORT__', [string]$AppPort)
    if ($config -match '__[A-Z_]+__') { throw "Template placeholder left unreplaced: $($Matches[0])" }
    return $config
}

# Writes a configuration next to the live one and validates it with the installed CA (root must be unchanged).
function Write-ValidatedConfig([string]$Path, [string]$Config, [string]$Fp) {
    Write-TextFile $Path $Config
    # caddy.exe is about to run elevated: nobody else may be able to swap it or this config.
    foreach ($f in @($ExeDest, $Path)) {
        $foreign = @(Get-ForeignAccess $f $WriteRights $Writers)
        if ($foreign.Count -gt 0) { throw "ACL check failed, others can write ${f}: $($foreign -join ', ')" }
    }
    $out = Invoke-Native { & $ExeDest validate --config $Path --adapter caddyfile 2>&1 }
    if ($LASTEXITCODE -ne 0) { throw ("caddy validate failed:`n" + ($out | Out-String)) }
    if ((Get-PemFileFingerprint (Join-Path $CaDir 'root.crt')) -ne $Fp) { throw 'The CA root changed during validation. Stop and inspect.' }
}

# Common checks before -Cutover / -Rollback / -Reconfigure change anything.
function Get-TrustedInstall([string[]]$Modes) {
    $state = Get-StateJson
    if (-not $state) { throw "$StateFile not found. Install the pilot first (-Install)." }
    $mode = [string]$state.mode
    if ($Modes -notcontains $mode) { throw "Mode is '$mode'; this action needs mode $($Modes -join ' or '). Nothing was changed." }
    if ([string]$state.project -ne $ProjectName) { throw "The service was installed for compose project '$($state.project)', not '$ProjectName'. Pass -ProjectName $($state.project)." }
    $svc = Get-ServiceInfo
    if (-not $svc) { throw "Service '$ServiceName' is not installed." }
    if ($svc.PathName -notlike "$ExeDest *") { throw "Service '$ServiceName' does not point to $ExeDest ($($svc.PathName)). It is not ours; nothing was changed." }
    if ($svc.StartName -notmatch 'LocalService') { throw "Service '$ServiceName' runs as $($svc.StartName), not NT AUTHORITY\LocalService. Nothing was changed." }
    $rootProblem = Get-ExistingRootProblem -MustExist
    if ($rootProblem) { throw "Install folder not trusted: $rootProblem. Nothing was changed." }
    $links = @(foreach ($d in @($BinDir, $StateDir)) { Get-ReparsePoints $d })
    if ($links.Count -gt 0) { throw "Junctions or symbolic links in the install folder: $($links -join ', '). Nothing was changed." }
    foreach ($d in @($Root, $BinDir, $StateDir, $ExeDest)) {
        $foreign = @(Get-ForeignAccess $d $WriteRights $Writers)
        if ($foreign.Count -gt 0) { throw "Others can write ${d}: $($foreign -join ', '). Nothing was changed." }
    }
    if ((Get-Sha512File $ExeDest) -ne [string]$state.caddyExeSha512) { throw 'caddy.exe does not match the SHA-512 recorded at install. Nothing was changed.' }
    if ((Get-PemFileFingerprint $RootCrtPublic) -ne [string]$state.rootSha256) { throw "$RootCrtPublic is not the installed CA root. Nothing was changed." }
    $dataFp = $null
    try { $dataFp = Get-PemFileFingerprint (Join-Path $CaDir 'root.crt') } catch {
        if (-not $WhatIfPreference) { throw }
        Write-Warn 'CA copy not readable by this account (expected when not elevated); checked in the real run.'
    }
    if ($dataFp -and $dataFp -ne [string]$state.rootSha256) { throw "The CA copy in $CaDir is not the installed root. Nothing was changed." }
    Write-Ok "Installed service is ours and intact (mode $mode, caddy.exe and CA root as recorded)"
    return [pscustomobject]@{ State = $state; Service = $svc }
}

# Back to the Docker Caddy after a failed -Cutover. Each step runs even if an earlier one failed; whatever could
# not be done is printed as manual steps in order.
function Restore-DockerMode($State, [string]$Domain, [bool]$EnvEdited) {
    $left = @()
    try {
        Stop-Service -Name $ServiceName -Force -ErrorAction Stop
        Set-ServiceStart 'disabled'
        Write-Ok "Service '$ServiceName' stopped and disabled"
    } catch { $left += "Stop and disable the service: Stop-Service $ServiceName -Force; sc.exe config $ServiceName start= disabled   ($($_.Exception.Message))" }
    if ($EnvEdited) {
        try {
            $b = Undo-EnvModeKeys
            Write-Ok "Env file: WR_CADDY_HTTPS_BIND / WR_CADDY_HTTP_BIND restored (file before this step: $b)"
        } catch { $left += "In $EnvFile restore only WR_CADDY_HTTPS_BIND / WR_CADDY_HTTP_BIND as recorded in $HostModeFile (previousLine; delete the line if existedBefore is false)   ($($_.Exception.Message))" }
    }
    try {
        Invoke-ComposeUpCaddy
        Wait-DockerHttps $Domain ([string]$State.rootSha256)
        Write-Ok 'Docker Caddy answers on 8443 again (same CA)'
    } catch { $left += "Recreate the Docker Caddy: docker $((Get-ComposeArgs) -join ' ') up -d --no-deps caddy ; then check https://${Domain}:8443   ($($_.Exception.Message))" }
    try {
        Remove-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue
        Write-Ok "Firewall rules of group '$FirewallGroup' removed"
    } catch { $left += "Remove-NetFirewallRule -Group '$FirewallGroup'   ($($_.Exception.Message))" }
    if ($left.Count -eq 0) {
        try {
            Update-JsonFile $StateFile @{ mode = 'docker'; dockerSince = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK') }
            # Only now close the journal, so -Cutover can run again ('aborted' when the env file was never changed).
            if ($EnvEdited) { Close-HostModeJournal 'reverted' } else { Close-HostModeJournal 'aborted' }
        } catch { $left += "Set mode to docker in $StateFile and status 'reverted' in $HostModeFile   ($($_.Exception.Message))" }
    }
    if ($left.Count -gt 0) {
        Write-Fail "Could not finish returning to the Docker Caddy. Run -Rollback (it finishes an interrupted switch-over recorded in $HostModeFile), or do these by hand, in this order:"
        $i = 1
        foreach ($s in $left) { Write-Host "   $i. $s" -ForegroundColor Yellow; $i++ }
        return $false
    }
    return $true
}

# ===========================================================================
function Invoke-Install {
    $whatIf = [bool]$WhatIfPreference
    if (-not $whatIf -and -not (Test-Admin)) { throw 'Run this from an elevated (Administrator) PowerShell. -WhatIf works without it.' }

    Write-Step 'Pre-checks'
    foreach ($p in @($HttpsPort, $HttpPort)) {
        if ($p -lt 1 -or $p -gt 65535) { throw "Port out of range: $p" }
        if ($ReservedPorts -contains $p) { throw "Port $p is the production port. This version installs on trial ports only (e.g. 9443 / 9080); the switch-over is a separate step." }
    }
    if ($HttpsPort -eq $HttpPort) { throw 'HttpsPort and HttpPort must differ.' }

    $fp = ConvertTo-Fingerprint $ExpectedRootSha256
    if (-not $fp) { throw '-ExpectedRootSha256 must be a SHA-256 fingerprint (64 hex digits; colons/spaces allowed).' }

    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "Env file not found: $EnvFile" }
    $domain = Get-EnvValue 'WR_DOMAIN'
    if (-not $domain -or $domain -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$') { throw "WR_DOMAIN in $EnvFile is missing or not a plain host name: '$domain'" }
    Write-Ok "Domain: $domain"
    if (-not $ImageVersion) { $script:ImageVersion = Get-EnvValue 'WR_VERSION' }
    if (-not $script:ImageVersion -or $script:ImageVersion -notmatch '^[A-Za-z0-9._-]+$') { throw "No usable image version. Pass -ImageVersion or set WR_VERSION in $EnvFile." }
    if (-not $CaVolume) { $script:CaVolume = "${ProjectName}_caddy_data" }
    if ($script:CaVolume -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') { throw "Invalid volume name: $($script:CaVolume)" }

    # caddy.exe and template: package layout (caddy-host\) or repository layout (scripts\ + caddy\).
    $packageExe = Join-Path $ScriptDir 'caddy.exe'
    if (Test-Path -LiteralPath $packageExe -PathType Leaf) {
        $srcExe = $packageExe
        $srcTemplate = Join-Path $ScriptDir 'Caddyfile.host.template'
        $manifestPath = Join-Path $PackageRoot 'release-manifest.json'
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "release-manifest.json not found next to the package: $manifestPath" }
        $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
        if (-not $manifest.PSObject.Properties['caddyHost'] -or -not $manifest.caddyHost.included) { throw 'release-manifest.json says this package has no host Caddy.' }
        $expectedExeSha = ([string]$manifest.caddyHost.exeSha512).ToLowerInvariant()
        $caddyVersion = [string]$manifest.caddyHost.version
    } else {
        $srcExe = Join-Path $PackageRoot 'caddy\windows-amd64\caddy.exe'
        $srcTemplate = Join-Path $PackageRoot 'caddy\Caddyfile.host.template'
        . (Join-Path $ScriptDir 'caddy-pin.ps1')
        $pin = Read-CaddyPin (Join-Path $PackageRoot 'caddy')
        $expectedExeSha = $pin.ExeSha512
        $caddyVersion = $pin.Version
    }
    foreach ($f in @($srcExe, $srcTemplate)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "Not found: $f" } }
    if ((Get-Sha512File $srcExe) -ne $expectedExeSha) { throw "caddy.exe SHA-512 does not match the expected value ($srcExe)." }
    Write-Ok "caddy.exe $caddyVersion matches its pinned SHA-512"

    $existing = Get-ServiceInfo
    if ($existing) { throw "A service named '$ServiceName' already exists ($($existing.PathName)). Nothing was changed. Use -Uninstall first if it is a previous pilot install." }
    $oldRules = @(Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue)
    if ($oldRules.Count -gt 0) { throw "Firewall rules of group '$FirewallGroup' already exist. Run -Uninstall first." }
    Write-Ok "No existing '$ServiceName' service or firewall rules"
    # Remember what the pre-check saw: the create step must not look again (a path appearing in between
    # must make it fail, not be adopted).
    $rootExisted = Test-Path -LiteralPath $Root
    $rootProblem = Get-ExistingRootProblem -MustExist:$rootExisted
    if ($rootProblem) {
        throw "Existing install folder not trusted: $rootProblem. Nothing was changed. Inspect it, delete it as an Administrator (keep a copy of data\ if it holds the CA) and run again."
    }
    if ($rootExisted) { Write-Ok "Existing $Root is locked down (owner and write access)" }

    Invoke-Native { docker info 2>$null } | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Docker is not running.' }
    $appPort = Get-AppPublishedPort
    Write-Ok "App container publishes 127.0.0.1:$appPort (Caddy upstream)"
    foreach ($p in @($HttpsPort, $HttpPort)) {
        if ($p -eq $appPort) { throw "Port $p is the app port." }
        if (Test-PortInUse $p) { throw "Port $p is already in use (TCP or UDP). Pick other trial ports with -HttpsPort / -HttpPort." }
    }
    Write-Ok "Trial ports $HttpsPort / $HttpPort are free (TCP and UDP)"

    Write-Step 'CA guard (backup, volume and client fingerprints must all match)'
    $infoPath = Resolve-UserPath $CaBackupInfo
    if (-not (Test-Path -LiteralPath $infoPath -PathType Leaf)) { throw "CA backup info file not found: $infoPath" }
    $info = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($infoPath)) {
        if ($line -match '^\s*(Archive|Archive SHA-256|Root SHA-256)\s*:\s*(\S+)') { $info[$Matches[1]] = $Matches[2] }
    }
    foreach ($k in @('Archive', 'Archive SHA-256', 'Root SHA-256')) { if (-not $info.ContainsKey($k)) { throw "CA backup info file has no '$k' line: $infoPath" } }
    $archive = Join-Path (Split-Path -Parent $infoPath) $info['Archive']
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "The encrypted CA backup is not next to its info file: $archive" }
    if ((Get-FileHashHex $archive 'SHA256') -ne $info['Archive SHA-256'].ToLowerInvariant()) { throw "CA backup archive SHA-256 does not match its info file: $archive" }
    if ((ConvertTo-Fingerprint $info['Root SHA-256']) -ne $fp) { throw 'The CA backup is of a different root than -ExpectedRootSha256.' }
    Write-Ok "CA backup present and intact: $archive"

    $image = "wr-backup:$($script:ImageVersion)"
    Invoke-Native { docker image inspect $image 2>$null } | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Image not found: $image (it is used to read the volume; pass -ImageVersion)." }
    Invoke-Native { docker volume inspect $script:CaVolume 2>$null } | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Volume not found: $($script:CaVolume) (pass -CaVolume)." }
    $volPem = Invoke-Native { docker run --rm --entrypoint cat -v "$($script:CaVolume):/data:ro" $image "$VolumeCaDir/root.crt" 2>$null } | Out-String
    if ($LASTEXITCODE -ne 0) { throw "Could not read root.crt from $($script:CaVolume)." }
    $volCert = ConvertFrom-Pem $volPem
    if (-not $volCert -or (Get-CertFingerprint $volCert) -ne $fp) { throw "The root certificate in $($script:CaVolume) does not match -ExpectedRootSha256. Nothing was changed." }
    Write-Ok "Volume $($script:CaVolume) root = expected ($fp)"

    if (Test-Path -LiteralPath $CaDir) {
        $have = Get-PemFileFingerprint (Join-Path $CaDir 'root.crt')
        if ($have -ne $fp) { throw "$CaDir already holds a DIFFERENT CA. It is never overwritten; inspect it manually." }
        Write-Ok "Existing CA copy in $CaDir matches (kept as is)"
    }

    # Snapshot of other programs' listeners, for -Status to compare later.
    $snapshot = @(Get-Listeners)

    $created = [ordered]@{ Service = $false; Firewall = $false; Exe = $false; Config = $false }
    try {
        Write-Step "Folders and ACLs ($Root)"
        if ($ScriptCmdlet.ShouldProcess($Root, 'Create folders and set ACLs (users: read bin/state only; no access to data/logs)')) {
            # 1. Lock the root itself (not recursively) before anything touches its contents.
            #    Absent at the pre-check: create it WITHOUT -Force, so anything that appeared at the path since
            #    (e.g. a junction) makes this fail before any icacls runs. Present: it was locked down, re-check.
            if (-not $rootExisted) {
                New-Item -ItemType Directory $Root -ErrorAction Stop | Out-Null
            } else {
                $rootProblem = Get-ExistingRootProblem -MustExist
                if ($rootProblem) { throw "Install folder changed since the pre-check: $rootProblem. Nothing was changed in it." }
            }
            Invoke-Icacls @($Root, '/setowner', "*$SidAdmins", '/C', '/Q')
            Invoke-Icacls @($Root, '/inheritance:r', '/grant:r', "*${SidAdmins}:(OI)(CI)F", "*${SidSystem}:(OI)(CI)F", "*${SidLocalService}:(OI)(CI)RX", "*${SidUsers}:(OI)(CI)RX")
            Remove-ForeignAllowAce $Root @($SidAdmins, $SidSystem, $SidLocalService, $SidUsers)
            # 2. Until the lock, a new root inherited "users may add folders" from ProgramData: it must still be empty.
            if (-not $rootExisted -and @(Get-ChildItem -LiteralPath $Root -Force).Count -gt 0) {
                throw "Something was created inside $Root while it was being set up. Inspect it, delete it as an Administrator and run again."
            }
            # 3. No junction/symlink anywhere below before the recursive (/T) changes and the elevated writes.
            $links = @(Get-ReparsePoints $Root)
            if ($links.Count -gt 0) { throw "Junctions or symbolic links under ${Root}: $($links -join ', '). Refusing to continue." }
            foreach ($d in @($BinDir, $DataDir, $LogDir, $StateDir)) { New-Item -ItemType Directory -Force $d | Out-Null }
            Invoke-Icacls @($Root, '/setowner', "*$SidAdmins", '/T', '/C', '/Q')
            foreach ($d in @($BinDir, $StateDir)) { Invoke-Icacls @($d, '/reset', '/T', '/C', '/Q') }
            # Restrict the folder itself FIRST, then let its contents inherit from it. Resetting the folder first
            # would make it inherit Users:RX from the root for a moment - with a CA key already in data on a
            # re-install, users could open root.key in that window.
            foreach ($d in @($DataDir, $LogDir)) {
                Invoke-Icacls @($d, '/inheritance:r', '/grant:r', "*${SidAdmins}:(OI)(CI)F", "*${SidSystem}:(OI)(CI)F", "*${SidLocalService}:(OI)(CI)M")
                # /grant:r only replaces those three; drop any other explicit allow entry (the old /reset did that too).
                Remove-ForeignAllowAce $d @($SidAdmins, $SidSystem, $SidLocalService)
                foreach ($child in @(Get-ChildItem -LiteralPath $d -Force)) { Invoke-Icacls @($child.FullName, '/reset', '/T', '/C', '/Q') }
            }
            foreach ($d in @($DataDir, $LogDir)) {
                $foreign = @(Get-ForeignAccess $d $ReadRights $DataReaders)
                if ($foreign.Count -gt 0) { throw "ACL check failed, others can read ${d}: $($foreign -join ', ')" }
            }
            foreach ($d in @($Root, $BinDir, $StateDir)) {
                $foreign = @(Get-ForeignAccess $d $WriteRights $Writers)
                if ($foreign.Count -gt 0) { throw "ACL check failed, others can write ${d}: $($foreign -join ', ')" }
            }
            Write-Ok 'ACLs set and verified'
        }

        Write-Step 'Copy the internal CA (read-only from the volume)'
        if (-not (Test-Path -LiteralPath $CaDir)) {
            if ($ScriptCmdlet.ShouldProcess($CaDir, "Copy $VolumeCaDir from $($script:CaVolume) (read-only mount)")) {
                if (Test-Path -LiteralPath $CaIncoming) { Remove-Item -LiteralPath $CaIncoming -Recurse -Force }
                New-Item -ItemType Directory -Force (Split-Path -Parent $CaIncoming) | Out-Null
                $cid = (Invoke-Native { docker create -v "$($script:CaVolume):/data:ro" $image 2>$null } | Out-String).Trim()
                if ($LASTEXITCODE -ne 0 -or -not $cid) { throw 'docker create (CA reader) failed.' }
                try {
                    Invoke-Native { docker cp "${cid}:$VolumeCaDir" $CaIncoming 2>&1 } | Out-Null
                    if ($LASTEXITCODE -ne 0) { throw 'docker cp of the CA folder failed.' }
                } finally {
                    Invoke-Native { docker rm $cid 2>$null } | Out-Null
                }
                Invoke-Icacls @($CaIncoming, '/setowner', "*$SidAdmins", '/T', '/C', '/Q')
                Invoke-Icacls @($CaIncoming, '/reset', '/T', '/C', '/Q')
                foreach ($f in $CaFiles) {
                    if (-not (Test-Path -LiteralPath (Join-Path $CaIncoming $f) -PathType Leaf)) {
                        Remove-Item -LiteralPath $CaIncoming -Recurse -Force
                        throw "The copied CA is missing $f."
                    }
                }
                if ((Get-PemFileFingerprint (Join-Path $CaIncoming 'root.crt')) -ne $fp) {
                    Remove-Item -LiteralPath $CaIncoming -Recurse -Force
                    throw 'The copied root certificate does not match -ExpectedRootSha256. The copy was removed.'
                }
                Rename-Item -LiteralPath $CaIncoming -NewName 'local'
                Write-Ok "CA copied to $CaDir (root fingerprint verified)"
            }
        }
        if ((Test-Path -LiteralPath $CaDir) -and $ScriptCmdlet.ShouldProcess($RootCrtPublic, 'Copy the public root certificate (for -Status)')) {
            foreach ($f in $CaFiles) {
                $foreign = @(Get-ForeignAccess (Join-Path $CaDir $f) $ReadRights $DataReaders)
                if ($foreign.Count -gt 0) { throw "ACL check failed, others can read $f in ${CaDir}: $($foreign -join ', ')" }
            }
            Write-Ok 'CA files are not readable by users'
            Copy-Item -LiteralPath (Join-Path $CaDir 'root.crt') -Destination $RootCrtPublic -Force   # public certificate only
        }

        Write-Step 'Binary and configuration'
        if ($ScriptCmdlet.ShouldProcess($ExeDest, 'Copy verified caddy.exe')) {
            Copy-Item -LiteralPath $srcExe -Destination $ExeDest -Force
            $created.Exe = $true
            if ((Get-Sha512File $ExeDest) -ne $expectedExeSha) { throw 'Copied caddy.exe does not match its pinned SHA-512.' }
            Write-Ok "$ExeDest"
        }
        $template = [System.IO.File]::ReadAllText($srcTemplate)
        $config = $template.Replace('__DATA_DIR__', ($DataDir -replace '\\', '/')).Replace('__LOG_DIR__', ($LogDir -replace '\\', '/')).
            Replace('__DOMAIN__', $domain).Replace('__HTTPS_PORT__', [string]$HttpsPort).Replace('__HTTP_PORT__', [string]$HttpPort).
            Replace('__APP_PORT__', [string]$appPort)
        if ($config -match '__[A-Z_]+__') { throw "Template placeholder left unreplaced: $($Matches[0])" }
        if ($ScriptCmdlet.ShouldProcess($ConfigDest, "Write Caddyfile.host (https :$HttpsPort, http :$HttpPort, upstream 127.0.0.1:$appPort) and validate")) {
            Write-TextFile $ConfigDest $config
            $created.Config = $true
            # caddy.exe is about to run elevated: nobody else may be able to swap it or its config.
            foreach ($f in @($ExeDest, $ConfigDest)) {
                $foreign = @(Get-ForeignAccess $f $WriteRights $Writers)
                if ($foreign.Count -gt 0) { throw "ACL check failed, others can write ${f}: $($foreign -join ', ')" }
            }
            # Validate only after the CA is in place, so validation loads it instead of creating a new one.
            $out = Invoke-Native { & $ExeDest validate --config $ConfigDest --adapter caddyfile 2>&1 }
            if ($LASTEXITCODE -ne 0) { throw ("caddy validate failed:`n" + ($out | Out-String)) }
            if ((Get-PemFileFingerprint (Join-Path $CaDir 'root.crt')) -ne $fp) { throw 'The CA root changed during validation. Stop and inspect.' }
            Write-Ok 'caddy validate passed (CA root unchanged)'
        }

        Write-Step "Service '$ServiceName' and firewall rule"
        $binPath = "$ExeDest run --config $ConfigDest --adapter caddyfile"
        if ($ScriptCmdlet.ShouldProcess($ServiceName, "sc.exe create (LocalService, automatic, restart on failure): $binPath")) {
            $out = Invoke-Native { & sc.exe create $ServiceName 'binPath=' $binPath 'start=' 'auto' 'obj=' 'NT AUTHORITY\LocalService' 'DisplayName=' $ServiceDisplay 2>&1 }
            if ($LASTEXITCODE -ne 0) { throw ("sc.exe create failed: " + ($out | Out-String).Trim()) }
            $created.Service = $true
            $out = Invoke-Native { & sc.exe description $ServiceName 'Reverse proxy for wr-evaluation-unified that sees the real client IP (C:\ProgramData\wr-caddy).' 2>&1 }
            if ($LASTEXITCODE -ne 0) { throw ("sc.exe description failed: " + ($out | Out-String).Trim()) }
            $out = Invoke-Native { & sc.exe failure $ServiceName 'reset=' '86400' 'actions=' 'restart/5000/restart/5000/restart/60000' 2>&1 }
            if ($LASTEXITCODE -ne 0) { throw ("sc.exe failure failed: " + ($out | Out-String).Trim()) }
            # Caddy writes autosave.json / instance.uuid to its config/data dirs; keep them under data,
            # not in the LocalService profile.
            $svcKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
            New-ItemProperty -Path $svcKey -Name 'Environment' -PropertyType MultiString -Force -Value @(
                "XDG_DATA_HOME=$(Join-Path $DataDir 'xdg-data')",
                "XDG_CONFIG_HOME=$(Join-Path $DataDir 'xdg-config')"
            ) | Out-Null
            $svc = Get-ServiceInfo
            if (-not $svc -or $svc.StartName -notmatch 'LocalService') { throw "Service account is '$($svc.StartName)', expected NT AUTHORITY\LocalService." }
            if ($svc.PathName -ne $binPath) { throw "Service command line differs from the intended one: $($svc.PathName)" }
            Write-Ok "Service created: $($svc.StartName), start=$($svc.StartMode)"
        }
        if ($ScriptCmdlet.ShouldProcess("TCP $HttpsPort,$HttpPort", "Inbound firewall rule for $ExeDest (group '$FirewallGroup')")) {
            New-NetFirewallRule -DisplayName "WR Caddy host (TCP $HttpsPort, $HttpPort)" -Group $FirewallGroup -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort @($HttpsPort, $HttpPort) -Program $ExeDest -Profile Any | Out-Null
            $created.Firewall = $true
            Write-Ok "Firewall rule added (group '$FirewallGroup')"
        }

        Write-Step 'Start and verify'
        if ($ScriptCmdlet.ShouldProcess($ServiceName, 'Start service and verify HTTPS, CA root and listeners')) {
            Start-Service -Name $ServiceName
            $deadline = (Get-Date).AddSeconds(20)
            $probe = $null
            do {
                Start-Sleep -Seconds 1
                $probe = Invoke-TlsProbe $HttpsPort $domain '/api/config/public' $RootCrtPublic
            } while (-not $probe.Ok -and (Get-Date) -lt $deadline)
            if (-not $probe.Ok) { throw "HTTPS check failed on 127.0.0.1:$HttpsPort ($($probe.Error)). See $LogDir\caddy.log." }
            if ($probe.ChainRoot -ne $fp) { throw "The service presents a chain whose root is $($probe.ChainRoot), not the expected CA." }
            if ($probe.Status -lt 200 -or $probe.Status -ge 500) { throw "HTTPS answered with status $($probe.Status) (the app behind 127.0.0.1:$appPort?)." }
            Write-Ok "HTTPS on :$HttpsPort answers $($probe.Status), chain root = expected CA, certificate valid until $($probe.LeafNotAfter)"

            $svc = Get-ServiceInfo
            $mine = @(Get-Listeners | Where-Object { $_.Pid -eq [int]$svc.ProcessId })
            $tcp = @($mine | Where-Object { $_.Proto -eq 'TCP' } | ForEach-Object { $_.Port } | Sort-Object -Unique)
            $udp = @($mine | Where-Object { $_.Proto -eq 'UDP' })
            if (($tcp -join ',') -ne ((@($HttpsPort, $HttpPort) | Sort-Object) -join ',')) { throw "caddy.exe listens on TCP $($tcp -join ', '), expected only $HttpsPort and $HttpPort." }
            if ($udp.Count -gt 0) { throw "caddy.exe opened UDP ports: $(($udp | ForEach-Object { $_.Port }) -join ', ')" }
            if (@(Get-NetTCPConnection -State Listen -LocalPort 2019 -ErrorAction SilentlyContinue).Count -gt 0) { throw 'Something listens on TCP 2019 (Caddy admin API must be off).' }
            Write-Ok "Listeners: TCP $($tcp -join ', ') only; no UDP; nothing on 2019"

            $state = [ordered]@{
                mode           = 'pilot'
                httpsPort      = $HttpsPort
                httpPort       = $HttpPort
                upstreamPort   = $appPort
                domain         = $domain
                project        = $ProjectName
                caVolume       = $script:CaVolume
                rootSha256     = $fp
                caddyVersion   = $caddyVersion
                caddyExeSha512 = $expectedExeSha
                installedAt    = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
            }
            Write-TextFile $StateFile ($state | ConvertTo-Json)
            Write-TextFile $SnapshotFile (ConvertTo-Json -InputObject @($snapshot | Where-Object { $_.Pid -ne [int]$svc.ProcessId }) -Depth 3)
            Write-Ok "State written: $StateFile"
        }
    } catch {
        Write-Fail $_.Exception.Message
        if (-not $whatIf) {
            Write-Host '   Undoing what this run created (the copied CA in data is kept) ...' -ForegroundColor White
            if ($created.Service) {
                Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
                Invoke-Native { & sc.exe delete $ServiceName 2>&1 } | Out-Null
            }
            if ($created.Firewall) { Remove-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue }
            if ($created.Config -and (Test-Path -LiteralPath $ConfigDest)) { Remove-Item -LiteralPath $ConfigDest -Force -ErrorAction SilentlyContinue }
            if ($created.Exe -and (Test-Path -LiteralPath $ExeDest)) { Remove-Item -LiteralPath $ExeDest -Force -ErrorAction SilentlyContinue }
        }
        exit 1
    }

    Write-Host ''
    if ($whatIf) {
        Write-Host '   -WhatIf: checks passed, nothing was changed.' -ForegroundColor Green
    } else {
        Write-Host "   Pilot install done. Docker Caddy still serves 8443/8080; this service answers on $HttpsPort/$HttpPort." -ForegroundColor Green
        Write-Host "   From another PC: curl.exe -k --resolve ${domain}:${HttpsPort}:<server IP> https://${domain}:${HttpsPort}/api/config/public" -ForegroundColor White
    }
    exit 0
}

# ===========================================================================
function Invoke-Cutover {
    $whatIf = [bool]$WhatIfPreference
    if (-not $whatIf -and -not (Test-Admin)) { throw 'Run this from an elevated (Administrator) PowerShell. -WhatIf works without it.' }

    Write-Step 'Pre-checks'
    $inst = Get-TrustedInstall @('pilot', 'docker')
    $state = $inst.State
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "Env file not found: $EnvFile" }
    Assert-ComposeFiles
    Assert-NoShellOverride
    Write-Ok 'No shell variables override the env file'
    $domain = Get-EnvValue 'WR_DOMAIN'
    if ($domain -ne [string]$state.domain) { throw "WR_DOMAIN in $EnvFile is '$domain', but the service was installed for '$($state.domain)'. Nothing was changed." }
    $hm = Get-HostModeJson
    if ($hm -and [string]$hm.status -eq 'applied') {
        throw "An earlier switch-over was interrupted ($HostModeFile is 'applied' while the mode is '$($state.mode)'). Run -Rollback first; it puts the Docker Caddy back. Nothing was changed."
    }
    $current = Get-ModeKeyState (Read-EnvDocument $EnvFile)
    foreach ($k in $ModeKeys) {
        if ($current[$k].Exists -and $current[$k].Value -eq $HostBinds[$k]) {
            throw "$EnvFile already has $k=$($HostBinds[$k]) (host mode) while the recorded mode is '$($state.mode)' and no switch-over is recorded. Restore only that line from the newest $EnvFile.before-cutover-* file, then run again. Nothing was changed."
        }
    }
    # What a later rollback returns to: the current lines, or the compose default where a key is absent.
    $restoreBinds = @{}
    foreach ($k in $ModeKeys) {
        if ($current[$k].Exists) { $restoreBinds[$k] = [string]$current[$k].Value } else { $restoreBinds[$k] = $ComposeDefaultBinds[$k] }
        if ([string]::IsNullOrEmpty($restoreBinds[$k])) { throw "$k has an empty value in $EnvFile. Delete the line or give it a value, then run again. Nothing was changed." }
    }
    Write-Ok "Env file: $EnvFile (now WR_CADDY_HTTPS_BIND=$($restoreBinds['WR_CADDY_HTTPS_BIND']), WR_CADDY_HTTP_BIND=$($restoreBinds['WR_CADDY_HTTP_BIND']))"

    Invoke-Native { docker info 2>$null } | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Docker is not running.' }
    $container = Get-DockerCaddyContainer
    if (-not $container) { throw "No '$ProjectName' caddy container exists. Start the stack first. Nothing was changed." }
    Assert-ComposeMatchesContainer $container
    Write-Ok "Compose files and env file match the running caddy container ($ComposeDir)"
    $owners = @(Get-PortOwners)
    if (-not (Test-CaddyPublish $owners $restoreBinds)) {
        throw "The '$ProjectName' Docker Caddy does not publish what the env file says ($($restoreBinds['WR_CADDY_HTTPS_BIND']), $($restoreBinds['WR_CADDY_HTTP_BIND'])). Run the normal 'up -d' first. Nothing was changed."
    }
    foreach ($p in @($ProdHttpsPort, $ProdHttpPort)) {
        $pub = @($owners | Where-Object { [int]$_.HostPort -eq $p })
        if (@($pub | Where-Object { -not ($_.Project -eq $ProjectName -and $_.Service -eq 'caddy') }).Count -gt 0 -or $pub.Count -eq 0) {
            throw "Port $p is not published by the '$ProjectName' Docker Caddy alone. Nothing was changed."
        }
        $other = @(Get-TcpListeners $p | Where-Object { $_.Process -notmatch $DockerProcessPattern })
        if ($other.Count -gt 0) { throw "Port $p is also held by $(($other | ForEach-Object { "$($_.Process) (pid $($_.Pid))" }) -join ', '). Nothing was changed." }
    }
    Write-Ok "8443 / 8080 are served by the '$ProjectName' Docker Caddy only"
    foreach ($k in $ModeKeys) {
        $p = (ConvertFrom-Bind $HostBinds[$k]).Port
        if ((Test-PortInUse $p) -or @($owners | Where-Object { [int]$_.HostPort -eq $p }).Count -gt 0) { throw "Port $p (where the Docker Caddy moves to) is already in use. Nothing was changed." }
    }
    Write-Ok '18443 / 18080 are free'
    $appPort = Get-AppPublishedPort -Owners $owners
    Write-Ok "App publishes 127.0.0.1:$appPort"

    Write-Step 'Compose configuration now and after the change (checked before anything changes)'
    Assert-TargetConfig (Get-ComposeConfig) $restoreBinds $appPort $domain $state
    Write-Ok "Now: caddy on $($restoreBinds['WR_CADDY_HTTPS_BIND']) / $($restoreBinds['WR_CADDY_HTTP_BIND'])"
    Assert-TargetConfig (Get-ComposeConfig $HostBinds) $HostBinds $appPort $domain $state
    Write-Ok "After: caddy on $($HostBinds['WR_CADDY_HTTPS_BIND']) / $($HostBinds['WR_CADDY_HTTP_BIND']), app on 127.0.0.1:$appPort, CA volume $($state.caVolume), domain $domain"

    Write-Step 'New configuration for caddy.exe (8443 / 8080)'
    $config = New-HostCaddyConfig $ProdHttpsPort $ProdHttpPort $appPort $domain
    if ($whatIf) {
        Write-Host ''
        Write-Host '   -WhatIf: checks passed, nothing was changed (caddy validate runs in the real run, before any change).' -ForegroundColor Green
        exit 0
    }
    Write-ValidatedConfig $ConfigNext $config ([string]$state.rootSha256)
    Write-Ok "caddy validate passed: $ConfigNext"
    if (-not $ScriptCmdlet.ShouldProcess('8443 / 8080', 'Switch over from the Docker Caddy to the wr-caddy service')) { exit 0 }

    Write-Step 'Switch-over'
    $envEdited = $false
    try {
        $entries = @()
        foreach ($k in $ModeKeys) {
            $entries += [ordered]@{ key = $k; action = 'revert'; existedBefore = [bool]$current[$k].Exists; previousLine = $current[$k].Line; previousValue = $current[$k].Value; newValue = $HostBinds[$k] }
        }
        $appLine = Get-EnvValue 'WR_APP_PORT'
        $entries += [ordered]@{ key = 'WR_APP_PORT'; action = 'retain'; existedBefore = [bool]$appLine; previousLine = $null; previousValue = $appLine; newValue = $appLine }
        $hostMode = [ordered]@{
            status       = 'applied'
            appliedAt    = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
            envFile      = $EnvFile
            composeDir   = $ComposeDir
            composeFiles = $ComposeFiles
            project      = $ProjectName
            entries      = $entries
        }
        # The journal is written BEFORE anything changes. While it says 'applied' and the mode is not yet host, the
        # switch-over counts as interrupted (e.g. the window was closed): -Uninstall refuses, -Rollback finishes it.
        Write-TextFile $HostModeFile ($hostMode | ConvertTo-Json -Depth 5)
        Stop-HostService
        Write-Ok "Service '$ServiceName' stopped (trial ports closed)"
        $changes =New-Object System.Collections.Specialized.OrderedDictionary
        foreach ($k in $ModeKeys) { $changes[$k] = "$k=$($HostBinds[$k])" }
        $backup = Write-EnvKeys $EnvFile $changes 'cutover'
        $envEdited = $true
        Write-Ok "Env file: WR_CADDY_HTTPS_BIND / WR_CADDY_HTTP_BIND set (previous file kept as $backup)"
        Invoke-ComposeUpCaddy
        if (-not (Wait-Until { Test-ProdPortsFree } 60)) { throw '8443 / 8080 were not released within 60 s.' }
        if (-not (Wait-Until { Test-CaddyPublish @(Get-PortOwners) $HostBinds } 60)) { throw 'The Docker Caddy did not come up on 127.0.0.1:18443 / 18080 within 60 s.' }
        Write-Ok 'Docker Caddy recreated on 127.0.0.1:18443 / 127.0.0.1:18080; 8443 / 8080 are free'
        $appNow = Get-AppPublishedPort
        if ($appNow -ne $appPort) {
            $appPort = $appNow
            Write-ValidatedConfig $ConfigNext (New-HostCaddyConfig $ProdHttpsPort $ProdHttpPort $appPort $domain) ([string]$state.rootSha256)
            Write-Warn "The app port changed to $appPort meanwhile; configuration regenerated and validated"
        }
        Move-Item -LiteralPath $ConfigNext -Destination $ConfigDest -Force
        Remove-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName "WR Caddy host (TCP $ProdHttpsPort, $ProdHttpPort)" -Group $FirewallGroup -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort @($ProdHttpsPort, $ProdHttpPort) -Program $ExeDest -Profile Any | Out-Null
        Write-Ok "Firewall rule for caddy.exe on TCP $ProdHttpsPort, $ProdHttpPort (group '$FirewallGroup')"
        Set-ServiceStart 'auto'
        Start-Service -Name $ServiceName
        Assert-HostServing $domain ([string]$state.rootSha256) $appPort $ProdHttpsPort $ProdHttpPort
        Update-JsonFile $StateFile @{ mode = 'host'; httpsPort = $ProdHttpsPort; httpPort = $ProdHttpPort; upstreamPort = $appPort; hostSince = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK') }
        Write-Ok 'Mode = host'
    } catch {
        Write-Fail $_.Exception.Message
        Write-Host '   Returning to the Docker Caddy ...' -ForegroundColor White
        if (Restore-DockerMode $state $domain $envEdited) {
            Write-Host '   Back on the Docker Caddy (mode docker, service disabled). Fix the cause and run -Cutover again.' -ForegroundColor Yellow
        }
        exit 1
    }
    Write-Host ''
    Write-Host '   Switch-over done: wr-caddy serves 8443 / 8080; the Docker Caddy waits on 127.0.0.1:18443 / 18080.' -ForegroundColor Green
    Write-Host '   Back to the Docker Caddy at any time: -Rollback' -ForegroundColor White
    exit 0
}

# ===========================================================================
function Invoke-Rollback {
    $whatIf = [bool]$WhatIfPreference
    if (-not $whatIf -and -not (Test-Admin)) { throw 'Run this from an elevated (Administrator) PowerShell. -WhatIf works without it.' }

    Write-Step 'Pre-checks'
    # Mode host, or an interrupted switch-over: the journal says 'applied' but the mode was never set to host
    # (the window was closed mid-way, or the automatic return could not finish).
    $inst = Get-TrustedInstall @('host', 'pilot', 'docker')
    $state = $inst.State
    $svc = $inst.Service
    $hm = Get-HostModeJson
    $interrupted = ([string]$state.mode -ne 'host')
    if (-not $hm -or [string]$hm.status -ne 'applied') {
        if ($interrupted) { throw "Mode is '$($state.mode)' and no switch-over is recorded in $HostModeFile; there is nothing to roll back. Nothing was changed." }
        throw "$HostModeFile is missing or not 'applied'; the env lines to restore are unknown. Nothing was changed."
    }
    if ($interrupted) { Write-Warn "Finishing an interrupted switch-over (mode '$($state.mode)', $HostModeFile 'applied')." }
    if (-not $EnvFileGiven -and (Get-JsonProp $hm 'envFile')) { $script:EnvFile = [string]$hm.envFile }
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "Env file not found: $EnvFile" }
    Assert-ComposeFiles
    Assert-NoShellOverride
    Write-Ok 'No shell variables override the env file'
    $domain = Get-EnvValue 'WR_DOMAIN'
    if ($domain -ne [string]$state.domain) { throw "WR_DOMAIN in $EnvFile is '$domain', but the service was installed for '$($state.domain)'. Nothing was changed." }
    $current = Get-ModeKeyState (Read-EnvDocument $EnvFile)
    $targetBinds = @{}
    foreach ($e in @($hm.entries | Where-Object { [string]$_.action -eq 'revert' })) {
        $k = [string]$e.key
        $atNew = ($current[$k].Exists -and $current[$k].Value -eq [string]$e.newValue)
        # Already as before: an interrupted switch-over that stopped before the env file was changed, or an earlier
        # rollback that restored the env file and then failed (the journal stays open until the very end).
        $atPrevious = ($current[$k].Exists -eq [bool]$e.existedBefore -and (-not $current[$k].Exists -or $current[$k].Value -eq [string]$e.previousValue))
        if (-not $atNew -and -not $atPrevious) {
            throw "$k in $EnvFile is '$($current[$k].Value)', not '$($e.newValue)' as the switch-over set it. It was changed by hand; fix it (see $HostModeFile) and run again. Nothing was changed."
        }
        if ($e.existedBefore) { $targetBinds[$k] = [string]$e.previousValue } else { $targetBinds[$k] = $ComposeDefaultBinds[$k] }
    }
    foreach ($k in $ModeKeys) {
        if (-not $targetBinds.ContainsKey($k) -or [string]::IsNullOrEmpty($targetBinds[$k])) { throw "$HostModeFile has no usable entry for $k. Nothing was changed." }
    }
    Write-Ok "Env file: $EnvFile (restores WR_CADDY_HTTPS_BIND=$($targetBinds['WR_CADDY_HTTPS_BIND']), WR_CADDY_HTTP_BIND=$($targetBinds['WR_CADDY_HTTP_BIND']); WR_APP_PORT and all other keys stay)"

    Invoke-Native { docker info 2>$null } | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Docker is not running.' }
    $container = Get-DockerCaddyContainer
    if ($container) {
        Assert-ComposeMatchesContainer $container
        Write-Ok "Compose files and env file match the running caddy container ($ComposeDir)"
    } else {
        Write-Warn "No '$ProjectName' caddy container exists; it will be created from $ComposeDir."
    }
    $svcPid = 0
    if ($svc.State -eq 'Running') { $svcPid = [int]$svc.ProcessId }
    # Docker may still (or again) hold them after an interrupted switch-over; anything else is a third program.
    foreach ($p in @($ProdHttpsPort, $ProdHttpPort)) {
        $others = @(Get-TcpListeners $p | Where-Object { $_.Pid -ne $svcPid -and $_.Process -notmatch $DockerProcessPattern })
        if ($others.Count -gt 0) { throw "Port $p is held by $(($others | ForEach-Object { "$($_.Process) (pid $($_.Pid))" }) -join ', '), not by wr-caddy or Docker. Nothing was changed." }
    }
    Write-Ok '8443 / 8080 are held by wr-caddy or Docker only (or free)'
    $appPort = Get-AppPublishedPort

    Write-Step 'Compose configuration after the rollback (checked before the service stops)'
    Assert-TargetConfig (Get-ComposeConfig $targetBinds) $targetBinds $appPort $domain $state
    Write-Ok "After: caddy on $($targetBinds['WR_CADDY_HTTPS_BIND']) / $($targetBinds['WR_CADDY_HTTP_BIND']), app on 127.0.0.1:$appPort, CA volume $($state.caVolume), domain $domain"
    if ($whatIf) {
        Write-Host ''
        Write-Host '   -WhatIf: checks passed, nothing was changed.' -ForegroundColor Green
        exit 0
    }
    if (-not $ScriptCmdlet.ShouldProcess('8443 / 8080', 'Roll back to the Docker Caddy (service stopped and disabled)')) { exit 0 }

    Write-Step 'Rollback'
    $done = [ordered]@{ ServiceStopped = $false; EnvRestored = $false; DockerServing = $false }
    try {
        Stop-HostService
        Set-ServiceStart 'disabled'
        $done.ServiceStopped = $true
        Write-Ok "Service '$ServiceName' stopped and disabled"
        if (-not (Wait-Until { Test-NoHostListener } 30)) { throw 'Something other than Docker still listens on 8443 / 8080 after stopping wr-caddy.' }
        $backup = Undo-EnvModeKeys
        $done.EnvRestored = $true
        Write-Ok "Env file: WR_CADDY_HTTPS_BIND / WR_CADDY_HTTP_BIND restored (file before this step: $backup)"
        Invoke-ComposeUpCaddy
        Wait-DockerHttps $domain ([string]$state.rootSha256)
        $done.DockerServing = $true
        Write-Ok 'Docker Caddy answers on 8443 (same CA)'
        Remove-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue
        Write-Ok "Firewall rules of group '$FirewallGroup' removed"
        Update-JsonFile $StateFile @{ mode = 'docker'; dockerSince = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK') }
        Close-HostModeJournal 'reverted'
        Write-Ok 'Mode = docker'
    } catch {
        Write-Fail $_.Exception.Message
        Write-Host '   Rollback stopped (running -Rollback again continues from here). Where it stands and what is left:' -ForegroundColor Yellow
        $up = "docker $((Get-ComposeArgs) -join ' ') up -d --no-deps caddy"
        if (-not $done.ServiceStopped) {
            Write-Host '   - wr-caddy may still serve 8443; nothing else was changed. Check with -Status.' -ForegroundColor Yellow
        } elseif (-not $done.EnvRestored) {
            Write-Host '   - wr-caddy is stopped and disabled, so 8443 is NOT served now. Quickest way back:' -ForegroundColor Yellow
            Write-Host "     sc.exe config $ServiceName start= auto ; Start-Service $ServiceName" -ForegroundColor Yellow
            Write-Host "     Or restore the two lines in $EnvFile as recorded in $HostModeFile, then: $up" -ForegroundColor Yellow
        } elseif (-not $done.DockerServing) {
            Write-Host "   - Env lines restored. Bring the Docker Caddy back on 8443: $up" -ForegroundColor Yellow
        } else {
            Write-Host "   - The Docker Caddy serves 8443. Remove the firewall group '$FirewallGroup' and set mode docker in $StateFile." -ForegroundColor Yellow
        }
        exit 1
    }
    Write-Host ''
    Write-Host '   Rollback done: the Docker Caddy serves 8443 / 8080; wr-caddy is stopped and disabled (mode docker).' -ForegroundColor Green
    Write-Host '   Switch over again with -Cutover, or remove the service with -Uninstall.' -ForegroundColor White
    exit 0
}

# ===========================================================================
function Invoke-Reconfigure {
    $whatIf = [bool]$WhatIfPreference
    if (-not $whatIf -and -not (Test-Admin)) { throw 'Run this from an elevated (Administrator) PowerShell. -WhatIf works without it.' }

    Write-Step 'Pre-checks'
    $inst = Get-TrustedInstall @('pilot', 'host')
    $state = $inst.State
    # Mode pilot with an open journal = interrupted switch-over: wr-caddy may be the one serving 8443 while
    # install.json still lists the trial ports. Regenerating from those would leave 8443 without a server.
    $journal = Get-HostModeJson
    if ([string]$state.mode -ne 'host' -and $journal -and [string]$journal.status -eq 'applied') {
        throw "A switch-over recorded in $HostModeFile did not finish. Run -Rollback first. Nothing was changed."
    }
    Invoke-Native { docker info 2>$null } | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Docker is not running.' }
    $appPort = Get-AppPublishedPort
    $live = ''
    if (Test-Path -LiteralPath $ConfigDest -PathType Leaf) { $live = [System.IO.File]::ReadAllText($ConfigDest) }
    if ($appPort -eq [int]$state.upstreamPort -and $live.Contains("reverse_proxy 127.0.0.1:$appPort")) {
        Write-Ok "Upstream is already 127.0.0.1:$appPort. Nothing to change."
        exit 0
    }
    Write-Ok "App publishes 127.0.0.1:$appPort (configured: 127.0.0.1:$($state.upstreamPort))"
    $config = New-HostCaddyConfig ([int]$state.httpsPort) ([int]$state.httpPort) $appPort ([string]$state.domain)
    if ($whatIf) {
        Write-Host ''
        Write-Host '   -WhatIf: checks passed, nothing was changed.' -ForegroundColor Green
        exit 0
    }
    Write-ValidatedConfig $ConfigNext $config ([string]$state.rootSha256)
    Write-Ok "caddy validate passed: $ConfigNext"
    if (-not $ScriptCmdlet.ShouldProcess($ServiceName, "Restart with upstream 127.0.0.1:$appPort")) { exit 0 }

    Write-Step 'Apply'
    Copy-Item -LiteralPath $ConfigDest -Destination $ConfigPrev -Force
    Move-Item -LiteralPath $ConfigNext -Destination $ConfigDest -Force
    try {
        Restart-Service -Name $ServiceName -Force
        Assert-HostServing ([string]$state.domain) ([string]$state.rootSha256) $appPort ([int]$state.httpsPort) ([int]$state.httpPort)
        Update-JsonFile $StateFile @{ upstreamPort = $appPort }
        Remove-Item -LiteralPath $ConfigPrev -Force
    } catch {
        Write-Fail $_.Exception.Message
        Move-Item -LiteralPath $ConfigPrev -Destination $ConfigDest -Force
        Restart-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        Write-Host '   The previous configuration was put back and the service restarted.' -ForegroundColor Yellow
        exit 1
    }
    Write-Host ''
    Write-Host "   Reconfigured: upstream 127.0.0.1:$appPort." -ForegroundColor Green
    exit 0
}

# ===========================================================================
function Invoke-Status {
    $problems = 0
    Write-Step "Service '$ServiceName'"
    $svc = Get-ServiceInfo
    $state = Get-StateJson
    if (-not $svc) {
        Write-Warn 'Service is not installed.'
        if ($state) { Write-Warn "But $StateFile exists (left over from an interrupted install/uninstall?)." }
        exit 1
    }
    Write-Ok "State=$($svc.State) StartMode=$($svc.StartMode) Account=$($svc.StartName)"
    Write-Ok "Command: $($svc.PathName)"
    if ($svc.StartName -notmatch 'LocalService') { Write-Fail 'Service does not run as NT AUTHORITY\LocalService.'; $problems++ }
    if (-not $state) { Write-Fail "$StateFile not found."; exit 1 }
    $mode = [string]$state.mode
    Write-Ok "Mode=$mode https=$($state.httpsPort) http=$($state.httpPort) upstream=127.0.0.1:$($state.upstreamPort) caddy=$($state.caddyVersion)"
    if (@('pilot', 'host', 'docker') -notcontains $mode) { Write-Fail "Unknown mode '$mode'."; $problems++ }
    if ($mode -eq 'docker') {
        # Disabled, not just stopped: with automatic start it would take 8443 from the Docker Caddy at the next reboot.
        if ($svc.StartMode -ne 'Disabled') { Write-Fail "Mode is docker but the start mode is $($svc.StartMode): after a reboot it would compete with the Docker Caddy for 8443. Set the service's start type to Disabled."; $problems++ }
        if ($svc.State -ne 'Stopped') { Write-Fail 'Mode is docker but the service is not stopped.'; $problems++ }
    } else {
        if ($svc.State -ne 'Running') { Write-Fail 'Service is not running.'; $problems++ }
        if ($svc.StartMode -ne 'Auto') { Write-Fail "Start mode is $($svc.StartMode), expected Auto."; $problems++ }
    }

    Write-Step 'Files and ACLs'
    if (Test-Path -LiteralPath $ExeDest) {
        $exeOk = $false
        try { $exeOk = ((Get-Sha512File $ExeDest) -eq [string]$state.caddyExeSha512) } catch { $exeOk = $false }
        if ($exeOk) { Write-Ok 'caddy.exe matches the installed SHA-512' } else { Write-Fail 'caddy.exe does not match the SHA-512 recorded at install.'; $problems++ }
    } else { Write-Fail "$ExeDest not found."; $problems++ }
    $rootProblem = Get-ExistingRootProblem
    if ($rootProblem) { Write-Fail "Install folder not trusted: $rootProblem"; $problems++ }
    $links = @(Get-ReparsePoints $Root)   # data/logs are skipped silently when not elevated
    if ($links.Count -gt 0) { Write-Fail "Junctions or symbolic links under ${Root}: $($links -join ', ')"; $problems++ } else { Write-Ok "No junctions or symbolic links under $Root" }
    foreach ($d in @($Root, $BinDir, $StateDir, $ExeDest, $ConfigDest)) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        $foreign = @(Get-ForeignAccess $d $WriteRights $Writers)
        if ($foreign.Count -gt 0) { Write-Fail "Others can write ${d}: $($foreign -join ', ')"; $problems++ } else { Write-Ok "Only Administrators and SYSTEM can write: $d" }
    }
    foreach ($d in @($DataDir, $LogDir)) {
        try {
            $foreign = @(Get-ForeignAccess $d $ReadRights $DataReaders)
            if ($foreign.Count -gt 0) { Write-Fail "Others can read ${d}: $($foreign -join ', ')"; $problems++ } else { Write-Ok "Only Administrators, SYSTEM and the service can read: $d" }
        } catch {
            Write-Ok "No access for this account: $d (expected when not elevated)"
        }
    }

    Write-Step 'Listeners'
    if ($svc.State -eq 'Running') {
        $all = @(Get-Listeners)
        $mine = @($all | Where-Object { $_.Pid -eq [int]$svc.ProcessId })
        $tcp = @($mine | Where-Object { $_.Proto -eq 'TCP' } | ForEach-Object { $_.Port } | Sort-Object -Unique)
        $udp = @($mine | Where-Object { $_.Proto -eq 'UDP' })
        $want = (@([int]$state.httpsPort, [int]$state.httpPort) | Sort-Object) -join ','
        if (($tcp -join ',') -eq $want) { Write-Ok "caddy.exe listens on TCP $($tcp -join ', ') only" } else { Write-Fail "caddy.exe listens on TCP $($tcp -join ', '), expected $want"; $problems++ }
        if ($udp.Count -eq 0) { Write-Ok 'No UDP listener' } else { Write-Fail "UDP listeners: $(($udp | ForEach-Object { $_.Port }) -join ', ')"; $problems++ }
        if (@($all | Where-Object { $_.Proto -eq 'TCP' -and $_.Port -eq 2019 }).Count -eq 0) { Write-Ok 'Nothing on TCP 2019 (admin API off)' } else { Write-Fail 'Something listens on TCP 2019.'; $problems++ }
        if ($mode -eq 'host') {
            $others = @($all | Where-Object { $_.Proto -eq 'TCP' -and @($ProdHttpsPort, $ProdHttpPort) -contains $_.Port -and $_.Pid -ne [int]$svc.ProcessId })
            if ($others.Count -eq 0) { Write-Ok 'Nobody else listens on 8443 / 8080' } else { Write-Fail "Also listening on 8443 / 8080: $(($others | ForEach-Object { $_.Process }) -join ', ')"; $problems++ }
        }
        if (Test-Path -LiteralPath $SnapshotFile) {
            # Assign first: Windows PowerShell 5.1 ConvertFrom-Json emits a JSON array as ONE pipeline object,
            # so @(... | ConvertFrom-Json) would be a one-element array holding the whole list.
            $parsed = [System.IO.File]::ReadAllText($SnapshotFile) | ConvertFrom-Json
            $before = @($parsed)
            # TCP listeners only: UDP endpoints (mDNS, DNS clients) come and go on their own.
            $key = { param($l) "$($l.Proto) $($l.Port) $($l.Process)" }
            # In host mode Docker's 8443 / 8080 listeners are gone on purpose (they moved to 18443 / 18080).
            $movedPorts = @()
            if ($mode -eq 'host') { $movedPorts = @($ProdHttpsPort, $ProdHttpPort) }
            $beforeKeys = @($before | Where-Object { $_.Proto -eq 'TCP' -and $movedPorts -notcontains [int]$_.Port } | ForEach-Object { & $key $_ } | Sort-Object -Unique)
            $nowKeys = @($all | Where-Object { $_.Proto -eq 'TCP' -and $_.Pid -ne [int]$svc.ProcessId } | ForEach-Object { & $key $_ } | Sort-Object -Unique)
            $gone = @($beforeKeys | Where-Object { $nowKeys -notcontains $_ })
            if ($gone.Count -gt 0) { Write-Warn ("Listeners present at install time but not now (other programs): " + ($gone -join '; ')) } else { Write-Ok 'All listeners recorded at install time are still there' }
        }
    }

    Write-Step 'HTTPS and upstream'
    if ($svc.State -eq 'Running') {
        $probe = Invoke-TlsProbe ([int]$state.httpsPort) ([string]$state.domain) '/api/config/public' $RootCrtPublic
        if (-not $probe.Ok) {
            Write-Fail "HTTPS check failed on 127.0.0.1:$($state.httpsPort): $($probe.Error)"; $problems++
        } else {
            if ($probe.ChainRoot -eq [string]$state.rootSha256) { Write-Ok 'Certificate chain root = installed CA' } else { Write-Fail "Chain root $($probe.ChainRoot) differs from the installed CA"; $problems++ }
            $left = $probe.LeafNotAfter - (Get-Date)
            if ($left.TotalHours -lt 24) { Write-Fail "Server certificate expires $($probe.LeafNotAfter) (check the server clock and caddy.log)"; $problems++ } else { Write-Ok "Server certificate valid until $($probe.LeafNotAfter)" }
            if ($probe.Status -ge 200 -and $probe.Status -lt 500) { Write-Ok "App answers through Caddy ($($probe.Status))" } else {
                Write-Fail "Status $($probe.Status) through Caddy. 502 = the app is not reachable on 127.0.0.1:$($state.upstreamPort)."; $problems++
            }
        }
    } elseif ($mode -eq 'docker') {
        $dl = @(Get-Listeners | Where-Object { $_.Proto -eq 'TCP' -and $_.Port -eq $ProdHttpsPort })
        if ($dl.Count -eq 0 -or @($dl | Where-Object { $_.Process -notmatch $DockerProcessPattern }).Count -gt 0) {
            Write-Fail "8443 is not held by Docker alone: $(($dl | ForEach-Object { $_.Process }) -join ', ')"; $problems++
        } else {
            $probe = Invoke-TlsProbe $ProdHttpsPort ([string]$state.domain) '/api/config/public' $RootCrtPublic
            if ($probe.Ok -and $probe.ChainRoot -eq [string]$state.rootSha256 -and $probe.Status -ge 200 -and $probe.Status -lt 500) { Write-Ok "Docker Caddy answers on 8443 ($($probe.Status)) with the installed CA" } else {
                Write-Fail "8443 check: ok=$($probe.Ok) status=$($probe.Status) root=$($probe.ChainRoot) $($probe.Error)"; $problems++
            }
        }
    }
    $owners = $null
    try { $owners = @(Get-PortOwners) } catch { Write-Warn "Could not read the app publish from Docker: $($_.Exception.Message)" }
    if ($null -ne $owners) {
        try {
            # The publish rules (loopback only, one port) apply in every mode; only the upstream comparison needs the service.
            $appPort = Get-AppPublishedPort -Owners $owners
            if ($mode -eq 'docker') { Write-Ok "App published on 127.0.0.1:$appPort only (upstream not compared: service disabled)" }
            elseif ($appPort -eq [int]$state.upstreamPort) { Write-Ok "Upstream 127.0.0.1:$appPort = the app's actual publish" } else {
                Write-Fail "Caddy proxies to 127.0.0.1:$($state.upstreamPort) but the app now publishes 127.0.0.1:$appPort. Run -Reconfigure to regenerate the configuration."; $problems++
            }
        } catch { Write-Fail $_.Exception.Message; $problems++ }
    }

    Write-Step 'Docker Caddy and env file'
    $shellVars = @(Get-ShellOverrides)
    if ($shellVars.Count -gt 0) { Write-Warn "Set in this PowerShell window (would override the env file for docker compose): $($shellVars -join ', ')" }
    if ($null -ne $owners) {
        $dock = @($owners | Where-Object { $_.Project -eq [string]$state.project -and $_.Service -eq 'caddy' })
        $dockPorts = @(@($dock | ForEach-Object { [int]$_.HostPort }) | Sort-Object -Unique)
        if ($mode -eq 'host') {
            if ($dock.Count -gt 0 -and @($dock | Where-Object { $_.HostIp -ne '127.0.0.1' }).Count -eq 0) { Write-Ok "Docker Caddy publishes on loopback only (127.0.0.1:$($dockPorts -join ', '))" } else {
                Write-Fail "In host mode the Docker Caddy must publish on 127.0.0.1 only; it publishes: $(($dock | ForEach-Object { "$($_.HostIp):$($_.HostPort)" }) -join ', ')"; $problems++
            }
        } elseif (($dockPorts -contains $ProdHttpsPort) -and ($dockPorts -contains $ProdHttpPort)) {
            Write-Ok 'Docker Caddy publishes 8443 / 8080'
        } else {
            Write-Fail "The Docker Caddy does not publish 8443 / 8080 (it publishes: $($dockPorts -join ', '))."; $problems++
        }
    }
    $hm = Get-HostModeJson
    if ($mode -ne 'host' -and $hm -and [string]$hm.status -eq 'applied') {
        Write-Fail "A switch-over recorded in $HostModeFile did not finish (mode '$mode'). Run -Rollback to put the Docker Caddy back."; $problems++
    }
    $envPath = $EnvFile
    if (-not $EnvFileGiven -and $hm -and (Get-JsonProp $hm 'envFile')) { $envPath = [string]$hm.envFile }
    $envKeys = $null
    try {
        if (Test-Path -LiteralPath $envPath -PathType Leaf) { $envKeys = Get-ModeKeyState (Read-EnvDocument $envPath) }
    } catch { Write-Fail "Env file ${envPath}: $($_.Exception.Message)"; $problems++ }
    if ($null -eq $envKeys) {
        Write-Warn "Env file not read ($envPath); pass -EnvFile to check WR_CADDY_HTTPS_BIND / WR_CADDY_HTTP_BIND."
    } elseif ($mode -eq 'host') {
        if (-not $hm -or [string]$hm.status -ne 'applied') { Write-Fail "Mode is host but $HostModeFile is missing or not 'applied'."; $problems++ }
        $bad = @($ModeKeys | Where-Object { -not $envKeys[$_].Exists -or $envKeys[$_].Value -ne $HostBinds[$_] })
        if ($bad.Count -eq 0) { Write-Ok "Env file keeps the Docker Caddy on loopback ($envPath)" } else {
            Write-Fail "Env file ${envPath}: $($bad -join ', ') not at the host-mode value; the next 'up -d' would move the Docker Caddy back onto 8443 / 8080."; $problems++
        }
    } else {
        $bad = @($ModeKeys | Where-Object { $envKeys[$_].Exists -and $envKeys[$_].Value -eq $HostBinds[$_] })
        if ($bad.Count -eq 0) { Write-Ok "Env file has no host-mode values ($envPath)" } else {
            Write-Fail "Env file ${envPath}: $($bad -join ', ') at the host-mode value; the next 'up -d' would move the Docker Caddy off 8443 / 8080."; $problems++
        }
    }

    Write-Host ''
    if ($problems -eq 0) { Write-Host '   Status: OK' -ForegroundColor Green; exit 0 }
    Write-Host "   Status: $problems problem(s)" -ForegroundColor Red
    exit 1
}

# ===========================================================================
function Invoke-Uninstall {
    $whatIf = [bool]$WhatIfPreference
    if (-not $whatIf -and -not (Test-Admin)) { throw 'Run this from an elevated (Administrator) PowerShell. -WhatIf works without it.' }
    $state = Get-StateJson
    if ($state -and @('pilot', 'docker') -notcontains [string]$state.mode) {
        throw "Mode is '$($state.mode)'. Run -Rollback first; uninstalling now would leave 8443 without a server. Nothing was changed."
    }
    # An interrupted switch-over leaves the mode at pilot/docker while wr-caddy may already serve 8443 and the env
    # file may already hold the host-mode lines: removing the service and the journal would strand both.
    $journal = Get-HostModeJson
    if ($journal -and [string]$journal.status -eq 'applied') {
        throw "A switch-over is recorded in $HostModeFile but did not finish. Run -Rollback first. Nothing was changed."
    }
    $svc = Get-ServiceInfo
    if ($svc -and $svc.PathName -notlike "$ExeDest *") {
        throw "Service '$ServiceName' does not point to $ExeDest ($($svc.PathName)). It is not ours; nothing was changed."
    }
    # Deletes below must not follow a planted link out of the install folder.
    $rootProblem = Get-ExistingRootProblem
    if ($rootProblem) { throw "Install folder not trusted: $rootProblem. Nothing was changed; inspect it as an Administrator." }
    $links = @(foreach ($d in @($BinDir, $StateDir)) { Get-ReparsePoints $d })
    if ($links.Count -gt 0) { throw "Junctions or symbolic links in the install folder: $($links -join ', '). Nothing was changed." }

    Write-Step "Uninstall (mode $(if ($state) { $state.mode } else { 'unknown' }))"
    if ($svc -and $ScriptCmdlet.ShouldProcess($ServiceName, 'Stop and delete service')) {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        $out = Invoke-Native { & sc.exe delete $ServiceName 2>&1 }
        if ($LASTEXITCODE -ne 0) { throw ("sc.exe delete failed: " + ($out | Out-String).Trim()) }
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-ServiceInfo) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
        if (Get-ServiceInfo) { throw 'The service is marked for deletion but still present (close services.msc and re-run).' }
        Write-Ok 'Service removed'
    }
    if (@(Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue).Count -gt 0 -and
        $ScriptCmdlet.ShouldProcess($FirewallGroup, 'Remove firewall rules')) {
        Remove-NetFirewallRule -Group $FirewallGroup
        Write-Ok 'Firewall rules removed'
    }
    foreach ($f in @($ExeDest, $ConfigDest, $ConfigNext, $ConfigPrev, $StateFile, $SnapshotFile, $HostModeFile, $RootCrtPublic)) {
        if ((Test-Path -LiteralPath $f) -and $ScriptCmdlet.ShouldProcess($f, 'Delete file')) {
            Remove-Item -LiteralPath $f -Force
            Write-Ok "Deleted $f"
        }
    }
    Write-Host ''
    Write-Host "   KEPT (never deleted automatically): $DataDir (CA key copy) and $LogDir." -ForegroundColor Yellow
    Write-Host '   The original CA stays in the Docker volume. If you no longer need the copy, delete the folder as an Administrator.' -ForegroundColor White
    exit 0
}

# ===========================================================================
try {
    switch ($PSCmdlet.ParameterSetName) {
        'Install'     { Invoke-Install }
        'Uninstall'   { Invoke-Uninstall }
        'Cutover'     { Invoke-Cutover }
        'Rollback'    { Invoke-Rollback }
        'Reconfigure' { Invoke-Reconfigure }
        default       { Invoke-Status }
    }
} catch {
    Write-Fail $_.Exception.Message
    Write-Host '   Nothing was changed by the failing step.' -ForegroundColor White
    exit 1
}
