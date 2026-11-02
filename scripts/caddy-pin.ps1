#Requires -Version 5.1
# Shared by scripts/fetch-caddy.ps1 (build PC) and scripts/export-offline-package.ps1 (packaging).
# Dot-source it:  . (Join-Path $PSScriptRoot 'caddy-pin.ps1')
#
# The host Caddy binary is pinned in the repository, never committed itself (about 50 MB):
#   caddy/CADDY_VERSION               one line, e.g. 2.11.7
#   caddy/caddy-windows-amd64.sha512  sha512sum format, exactly two entries:
#       <128 hex>  caddy_<version>_windows_amd64.zip   (the official GitHub release asset;
#                                                      the same value as caddy_<version>_checksums.txt)
#       <128 hex>  caddy.exe                           (the binary inside that zip; this is the hash
#                                                      the hospital security team allow-lists)
# Changing the version without both hashes fails here, because the zip entry name carries the version.
# ASCII only: Windows PowerShell 5.1 reads BOM-less files in the system code page.

function Read-CaddyPin {
    param([Parameter(Mandatory)][string]$PinDir)

    $versionFile = Join-Path $PinDir 'CADDY_VERSION'
    $shaFile     = Join-Path $PinDir 'caddy-windows-amd64.sha512'
    foreach ($f in @($versionFile, $shaFile)) {
        if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "Caddy pin file not found: $f" }
    }

    $version = ([System.IO.File]::ReadAllText($versionFile)).Trim()
    if ($version -notmatch '^\d+\.\d+\.\d+$') {
        throw "caddy/CADDY_VERSION must be a plain x.y.z version (got '$version')"
    }
    $zipName = "caddy_${version}_windows_amd64.zip"

    $entries = @{}
    foreach ($raw in [System.IO.File]::ReadAllLines($shaFile)) {
        $line = $raw.Trim()
        if ($line -eq '') { continue }
        if ($line -notmatch '^([0-9a-fA-F]{128})  (\S+)$') {
            throw "caddy/caddy-windows-amd64.sha512: malformed line '$line' (expected '<128 hex>  <file name>')"
        }
        $name = $Matches[2]
        if ($entries.ContainsKey($name)) { throw "caddy/caddy-windows-amd64.sha512: duplicate entry '$name'" }
        $entries[$name] = $Matches[1].ToLowerInvariant()
    }
    foreach ($name in @($zipName, 'caddy.exe')) {
        if (-not $entries.ContainsKey($name)) {
            throw "caddy/caddy-windows-amd64.sha512 has no entry for '$name' (CADDY_VERSION is $version - update both pin files together)"
        }
    }
    if ($entries.Count -ne 2) {
        throw "caddy/caddy-windows-amd64.sha512 must have exactly two entries ($zipName, caddy.exe), found $($entries.Count)"
    }

    return [pscustomobject]@{
        Version   = $version
        ZipName   = $zipName
        ZipSha512 = $entries[$zipName]
        ExeSha512 = $entries['caddy.exe']
    }
}

function Get-Sha512([Parameter(Mandatory)][string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA512).Hash.ToLowerInvariant()
}
