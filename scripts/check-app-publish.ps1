#Requires -Version 5.1
<#
.SYNOPSIS
    Read-only pre-flight check for the app's loopback-only port publish.
    Run it from the package root before `docker compose ... up -d` (install and update).

.DESCRIPTION
    docker-compose.prod.yml publishes the app on 127.0.0.1:<WR_APP_PORT> (default 3001) so that
    a reverse proxy running on this Windows host can reach it. Other PCs cannot connect to it.
    This script checks, without changing anything:

      1. WR_APP_PORT / WR_CADDY_HTTPS_BIND / WR_CADDY_HTTP_BIND are NOT set in this shell.
         Shell variables override the env file, so compose would publish something other than
         what the env file says.
      2. The resolved compose config publishes the app only on 127.0.0.1, on the port the env
         file asks for (WR_APP_PORT, or 3001 when the key is absent or empty).
      3. That host port is free, or already held by THIS project's app container (normal after
         the first update). Another container or any other process holding it -> stop.
         The owner is found from each running container's real HostIp/HostPort mapping and its
         compose labels. `docker ps --filter publish=<port>` is not used: whether it matches
         the host or the container port is not documented consistently (Docker 29 matched the
         host port in a test; the Docker docs example reads as the container port), and the
         production server runs an older Docker Engine.

    It never stops, removes or restarts anything. Exit code 0 = OK, 1 = fix the reported issue.

.PARAMETER EnvFile
    Path to the production env file. Default: .\.env.production

.PARAMETER ProjectName
    Docker Compose project name. Default: wr-prod

.EXAMPLE
    .\scripts\check-app-publish.ps1
    .\scripts\check-app-publish.ps1 -EnvFile .\.env.rehearsal -ProjectName wr-prod-test
#>
[CmdletBinding()]
param(
    [string]$EnvFile     = ".\.env.production",
    [string]$ProjectName = "wr-prod"
)

$ErrorActionPreference = "Stop"

$DefaultAppPort = 3001
$ShellOverrideKeys = @('WR_APP_PORT', 'WR_CADDY_HTTPS_BIND', 'WR_CADDY_HTTP_BIND')

function Write-Ok([string]$msg)   { Write-Host "   OK   $msg" -ForegroundColor Green }
function Write-Fail([string]$msg) { Write-Host "   FAIL $msg" -ForegroundColor Red }

# Native commands (docker) may write harmless warnings to stderr. In Windows PowerShell 5.1 with
# $ErrorActionPreference=Stop that aborts the script even when the exit code is 0, so every docker
# call runs inside this helper (EAP=Continue) and failures are detected through $LASTEXITCODE.
function Invoke-Native {
    param([Parameter(Mandatory)][scriptblock]$Block)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Block } finally { $ErrorActionPreference = $prev }
}

function Stop-Check([string]$msg) {
    Write-Fail $msg
    Write-Host "   Nothing was changed. Fix the issue above, then run this check again." -ForegroundColor White
    exit 1
}

# Containers that publish a host port: name, compose project/service labels, HostIp, HostPort.
function Get-PortOwners {
    $ids = @(Invoke-Native { docker ps -q 2>$null } | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { Stop-Check "docker ps failed. Is Docker running?" }
    $owners = @()
    if ($ids.Count -eq 0) { return $owners }
    $raw = Invoke-Native { docker inspect $ids 2>$null } | Out-String
    if ($LASTEXITCODE -ne 0) { Stop-Check "docker inspect failed." }
    $parsed = $raw | ConvertFrom-Json
    foreach ($c in $parsed) {
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

Write-Host ""
Write-Host "-- App port pre-check (project: $ProjectName, env file: $EnvFile)" -ForegroundColor Cyan

# 1. Shell variables that would silently override the env file
$overrides = @($ShellOverrideKeys | Where-Object { Test-Path "env:$_" })
if ($overrides.Count -gt 0) {
    Stop-Check ("These variables are set in this shell and would override ${EnvFile}: " + ($overrides -join ', ') +
        ". Remove them (e.g. Remove-Item env:WR_APP_PORT) or open a new PowerShell window.")
}
Write-Ok "No shell overrides ($($ShellOverrideKeys -join ', '))"

# 2. The port the env file asks for
if (-not (Test-Path $EnvFile)) { Stop-Check "$EnvFile not found." }
$expected = $DefaultAppPort
$line = Get-Content $EnvFile | Where-Object { $_ -match '^\s*WR_APP_PORT\s*=' } | Select-Object -Last 1
if ($line) {
    $value = ($line -split '=', 2)[1].Trim()
    if ($value) {
        if ($value -notmatch '^\d{1,5}$' -or [int]$value -lt 1 -or [int]$value -gt 65535) {
            Stop-Check "WR_APP_PORT in $EnvFile must be a port number only (1-65535), got '$value'. The host part is fixed to 127.0.0.1 in docker-compose.prod.yml."
        }
        $expected = [int]$value
    }
}
Write-Ok "Expected app publish: 127.0.0.1:$expected"

# 3. What compose will actually publish
$cfgText = Invoke-Native {
    docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file $EnvFile -p $ProjectName config --format json 2>$null
} | Out-String
if ($LASTEXITCODE -ne 0) { Stop-Check "docker compose config failed (run it without 2>`$null to see the error)." }
$app = ($cfgText | ConvertFrom-Json).services.app
$appPorts = @()
if ($app -and $app.PSObject.Properties['ports']) { $appPorts = @($app.ports | Where-Object { $null -ne $_ }) }
if ($appPorts.Count -eq 0) {
    Stop-Check "The resolved config does not publish the app at all. These compose files are older than this script expects - use the docker-compose*.yml from the same package."
}
foreach ($p in $appPorts) {
    $hostIp = ''
    if ($p.PSObject.Properties['host_ip']) { $hostIp = [string]$p.host_ip }
    if ($hostIp -ne '127.0.0.1') {
        Stop-Check "The app would be published on '$hostIp' (published=$($p.published)), not 127.0.0.1 only. Other PCs could bypass Caddy. Check docker-compose.prod.yml."
    }
    if ([string]$p.published -ne [string]$expected) {
        Stop-Check "The app would be published on port $($p.published), but $EnvFile asks for $expected."
    }
}
Write-Ok "Resolved config publishes the app on 127.0.0.1:$expected only"

# 4. Who holds that host port right now
$owners = @(Get-PortOwners | Where-Object { $_.HostPort -eq [string]$expected })
$foreign = @($owners | Where-Object { -not ($_.Project -eq $ProjectName -and $_.Service -eq 'app') })
if ($foreign.Count -gt 0) {
    $names = ($foreign | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ', '
    Stop-Check "Port $expected is used by another container: $names. Pick a free port with WR_APP_PORT in $EnvFile (this script does not touch other containers)."
}
if ($owners.Count -gt 0) {
    Write-Ok "Port $expected is held by this project's app container (expected after the first update)"
} else {
    $listen = @(Get-NetTCPConnection -State Listen -LocalPort $expected -ErrorAction SilentlyContinue)
    if ($listen.Count -gt 0) {
        $proc = Get-Process -Id $listen[0].OwningProcess -ErrorAction SilentlyContinue
        $who = "pid $($listen[0].OwningProcess)"
        if ($proc) { $who = "$($proc.ProcessName) (pid $($proc.Id))" }
        Stop-Check "Port $expected is already used by $who. Pick a free port with WR_APP_PORT in $EnvFile."
    }
    Write-Ok "Port $expected is free"
}

Write-Host "   App port pre-check passed." -ForegroundColor Green
exit 0
