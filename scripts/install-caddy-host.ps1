#Requires -Version 5.1
<#
.SYNOPSIS
    Installs, checks or removes Caddy as a Windows service on this host (release B, pilot stage).

.DESCRIPTION
    Docker Desktop hides the client IP from the Docker Caddy, so audit logs, sessions and device
    registrations all show the same address. Running Caddy directly on Windows lets it see the real
    client IP and pass it to the app in X-Forwarded-For.

    This version supports the PILOT stage only: the service listens on trial ports (default 9443 /
    9080) next to the Docker Caddy, which keeps serving 8443 / 8080. It never edits .env.production,
    never runs docker compose, and never stops or changes any container. Switching 8443 over is a
    separate, later step. -Uninstall returns the server to its previous state.

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
      -Status     (any user) read-only report. Exit code 0 = OK, 1 = something needs attention.
      -Uninstall  (Administrator) stops and deletes the service, removes the firewall rule and the
                  bin files. The CA copy (data) and the logs are KEPT; the script prints their path.

    Windows PowerShell 5.1 compatible, ASCII only. Supports -WhatIf (checks run, nothing changes).

.PARAMETER Install
.PARAMETER Status
    Default when no action is given.
.PARAMETER Uninstall

.PARAMETER EnvFile
    Production env file (read only: WR_DOMAIN, WR_VERSION). Default: .\.env.production

.PARAMETER ProjectName
    Docker Compose project of the running stack. Default: wr-prod

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
    .\caddy-host\install-caddy-host.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Status')]
param(
    [Parameter(ParameterSetName = 'Install', Mandatory = $true)][switch]$Install,
    [Parameter(ParameterSetName = 'Status')][switch]$Status,
    [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)][switch]$Uninstall,

    [string]$EnvFile     = '.\.env.production',
    [string]$ProjectName = 'wr-prod',
    [int]$HttpsPort      = 9443,
    [int]$HttpPort       = 9080,

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
$FirewallGroup  = 'WR Evaluation Caddy'
$ReservedPorts  = @(8443, 8080)   # switching these over is a later release step, never done here
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
$EnvFile = Resolve-UserPath $EnvFile

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
function Get-ForeignAccess([string]$Path, [System.Security.AccessControl.FileSystemRights]$Rights, [string[]]$AllowedSids) {
    $hits = @()
    foreach ($ace in (Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne 'Allow') { continue }
        if ($AllowedSids -contains $ace.IdentityReference.Value) { continue }
        if (($ace.FileSystemRights -band $Rights) -ne 0) { $hits += "$($ace.IdentityReference.Value) ($($ace.FileSystemRights))" }
    }
    return $hits
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
            foreach ($d in @($Root, $BinDir, $DataDir, $LogDir, $StateDir)) { New-Item -ItemType Directory -Force $d | Out-Null }
            Invoke-Icacls @($Root, '/setowner', "*$SidAdmins", '/T', '/C', '/Q')
            Invoke-Icacls @($Root, '/inheritance:r', '/grant:r', "*${SidAdmins}:(OI)(CI)F", "*${SidSystem}:(OI)(CI)F", "*${SidLocalService}:(OI)(CI)RX", "*${SidUsers}:(OI)(CI)RX")
            # The folder may have been created beforehand by a user who gave themselves rights on it.
            Remove-ForeignAllowAce $Root @($SidAdmins, $SidSystem, $SidLocalService, $SidUsers)
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
    if ($svc.State -ne 'Running') { Write-Fail 'Service is not running.'; $problems++ }
    if ($svc.StartName -notmatch 'LocalService') { Write-Fail 'Service does not run as NT AUTHORITY\LocalService.'; $problems++ }
    if (-not $state) { Write-Fail "$StateFile not found."; exit 1 }
    Write-Ok "Mode=$($state.mode) https=$($state.httpsPort) http=$($state.httpPort) upstream=127.0.0.1:$($state.upstreamPort) caddy=$($state.caddyVersion)"

    Write-Step 'Files and ACLs'
    if (Test-Path -LiteralPath $ExeDest) {
        $exeOk = $false
        try { $exeOk = ((Get-Sha512File $ExeDest) -eq [string]$state.caddyExeSha512) } catch { $exeOk = $false }
        if ($exeOk) { Write-Ok 'caddy.exe matches the installed SHA-512' } else { Write-Fail 'caddy.exe does not match the SHA-512 recorded at install.'; $problems++ }
    } else { Write-Fail "$ExeDest not found."; $problems++ }
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
        if (Test-Path -LiteralPath $SnapshotFile) {
            # Assign first: Windows PowerShell 5.1 ConvertFrom-Json emits a JSON array as ONE pipeline object,
            # so @(... | ConvertFrom-Json) would be a one-element array holding the whole list.
            $parsed = [System.IO.File]::ReadAllText($SnapshotFile) | ConvertFrom-Json
            $before = @($parsed)
            # TCP listeners only: UDP endpoints (mDNS, DNS clients) come and go on their own.
            $key = { param($l) "$($l.Proto) $($l.Port) $($l.Process)" }
            $beforeKeys = @($before | Where-Object { $_.Proto -eq 'TCP' } | ForEach-Object { & $key $_ } | Sort-Object -Unique)
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
    }
    $owners = $null
    try { $owners = @(Get-PortOwners) } catch { Write-Warn "Could not read the app publish from Docker: $($_.Exception.Message)" }
    if ($null -ne $owners) {
        try {
            $appPort = Get-AppPublishedPort -Owners $owners
            if ($appPort -eq [int]$state.upstreamPort) { Write-Ok "Upstream 127.0.0.1:$appPort = the app's actual publish" } else {
                Write-Fail "Caddy proxies to 127.0.0.1:$($state.upstreamPort) but the app now publishes 127.0.0.1:$appPort. Re-install (pilot) to regenerate the configuration."; $problems++
            }
        } catch { Write-Fail $_.Exception.Message; $problems++ }
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
    if ($state -and [string]$state.mode -ne 'pilot') {
        throw "Mode is '$($state.mode)', not 'pilot'. Switch back to the Docker Caddy first; uninstalling now would leave 8443 without a server."
    }
    $svc = Get-ServiceInfo
    if ($svc -and $svc.PathName -notlike "$ExeDest *") {
        throw "Service '$ServiceName' does not point to $ExeDest ($($svc.PathName)). It is not ours; nothing was changed."
    }

    Write-Step 'Uninstall (pilot)'
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
    foreach ($f in @($ExeDest, $ConfigDest, $StateFile, $SnapshotFile, $RootCrtPublic)) {
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
        'Install'   { Invoke-Install }
        'Uninstall' { Invoke-Uninstall }
        default     { Invoke-Status }
    }
} catch {
    Write-Fail $_.Exception.Message
    Write-Host '   Nothing was changed by the failing step.' -ForegroundColor White
    exit 1
}
