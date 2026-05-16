<#
.SYNOPSIS
    Builds Docker images and assembles an air-gapped offline deployment package.

.DESCRIPTION
    Produces release/wr-evaluation-unified-{VERSION}-intranet/ containing
    everything needed to install on an intranet server without internet access.
    Secrets (.env files, private keys, DB dumps) are explicitly excluded.

.PARAMETER Version
    Package version (semver). If omitted, read from package.json.

.PARAMETER SkipBuild
    Skip Docker image builds and use existing local images.
    The three required images must already exist with the correct tag.

.PARAMETER ExcludeBaseImages
    Exclude postgres:16-alpine and caddy:2-alpine from wr-images.tar.
    By default base images ARE included because the package targets air-gapped
    intranet servers that cannot pull from Docker Hub.
    Use this flag only when the target server has verified internet access to Docker Hub.

.PARAMETER ElectronInstallerPath
    Explicit path to the intranet Electron installer .exe (recommended).
    If omitted, the script searches dist\electron\ for the newest .exe and warns.
    Use this when both intranet and standalone builds exist in dist\electron\ to
    prevent accidentally packaging the wrong build.

.PARAMETER NoZip
    Create the package directory but skip the .zip archive.

.EXAMPLE
    # Standard: includes ALL images (app + base), suitable for air-gapped install
    .\scripts\export-offline-package.ps1

    # Explicit installer path (recommended when both build targets exist)
    .\scripts\export-offline-package.ps1 -ElectronInstallerPath "dist\electron\직업성 질환 통합 평가 프로그램 Setup 5.0.0.exe"

    # Exclude base images (target has Docker Hub access)
    .\scripts\export-offline-package.ps1 -ExcludeBaseImages

    # Explicit version, skip rebuild (CI reuse of previously built images)
    .\scripts\export-offline-package.ps1 -Version "5.0.0" -SkipBuild
#>
[CmdletBinding()]
param(
    [string]$Version               = "",
    [string]$ElectronInstallerPath = "",
    [switch]$SkipBuild             = $false,
    [switch]$ExcludeBaseImages     = $false,
    [switch]$NoZip                 = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg)   { Write-Host "    OK  $msg" -ForegroundColor Green  }
function Write-Warn([string]$msg) { Write-Host "    WARN $msg" -ForegroundColor Yellow }

function Write-Utf8NoBom([string]$path, [string]$content) {
    $enc = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($path, $content, $enc)
}

function Assert-DockerCmd([string]$desc) {
    if (-not $?) { Write-Error "$desc failed (exit code $LASTEXITCODE)"; exit 1 }
}

# ── Version ───────────────────────────────────────────────────────────────────

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not $Version) {
    $pkgJson = Join-Path $RepoRoot "package.json"
    if (Test-Path $pkgJson) {
        $Version = (Get-Content $pkgJson -Raw | ConvertFrom-Json).version
    }
}
if (-not $Version) {
    $gitTag = git -C $RepoRoot describe --tags --exact-match 2>$null
    if ($LASTEXITCODE -eq 0 -and $gitTag) {
        $Version = $gitTag.Trim() -replace '^v', ''
    }
}
if (-not $Version) {
    Write-Error "Cannot determine version. Set 'version' in package.json or pass -Version."
    exit 1
}

# ── Image names ───────────────────────────────────────────────────────────────

$APP_IMAGE     = "wr-app-server:$Version"
$MONITOR_IMAGE = "wr-backup-monitor:$Version"
$BACKUP_IMAGE  = "wr-backup:$Version"

$PackageName = "wr-evaluation-unified-$Version-intranet"
$PackageDir  = Join-Path $RepoRoot "release\$PackageName"

Write-Host ""
Write-Host "  Package : $PackageName" -ForegroundColor White
Write-Host "  Output  : $PackageDir"  -ForegroundColor White

# ── Secret leak guard ─────────────────────────────────────────────────────────

Write-Step "Secret leak guard"
$neverInclude = @(".env", ".env.production", ".env.staging", ".env.local", "*.pem", "*.key", "*.asc")
foreach ($pat in $neverInclude) {
    $hits = Get-ChildItem -Path $RepoRoot -Filter $pat -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\' }
    foreach ($h in $hits) {
        Write-Warn "$($h.Name) found in repo — will NOT be included in package (by design)"
    }
}
Write-Ok "No secrets will be packaged"

# ── Docker image build ────────────────────────────────────────────────────────

if (-not $SkipBuild) {
    Write-Step "Building Docker images (tag: $Version)"

    Write-Host "  [1/3] $APP_IMAGE"
    docker build -t $APP_IMAGE -f (Join-Path $RepoRoot "server\Dockerfile") $RepoRoot
    Assert-DockerCmd "app image build"
    Write-Ok $APP_IMAGE

    Write-Host "  [2/3] $MONITOR_IMAGE"
    docker build -t $MONITOR_IMAGE (Join-Path $RepoRoot "services\backup-monitor")
    Assert-DockerCmd "backup-monitor image build"
    Write-Ok $MONITOR_IMAGE

    Write-Host "  [3/3] $BACKUP_IMAGE"
    docker build -t $BACKUP_IMAGE -f (Join-Path $RepoRoot "backup\Dockerfile") $RepoRoot
    Assert-DockerCmd "backup image build"
    Write-Ok $BACKUP_IMAGE
}
else {
    Write-Step "Skipping builds (-SkipBuild) — verifying local images exist"
    foreach ($img in @($APP_IMAGE, $MONITOR_IMAGE, $BACKUP_IMAGE)) {
        docker image inspect $img *>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Image not found: $img. Build it first or remove -SkipBuild."
            exit 1
        }
        Write-Ok "$img (local)"
    }
}

# ── Create clean package directory ───────────────────────────────────────────

Write-Step "Creating package directory"
if (Test-Path $PackageDir) {
    Remove-Item -Recurse -Force $PackageDir
}
New-Item -ItemType Directory -Force $PackageDir | Out-Null
Write-Ok $PackageDir

# ── Compose files at package root ─────────────────────────────────────────────
#    Docker Compose resolves relative volume paths from the directory that
#    contains the compose file — so compose files must be at the package root.

Write-Step "Copying compose + env template"

foreach ($f in @("docker-compose.yml", "docker-compose.prod.yml", ".env.production.example")) {
    $src = Join-Path $RepoRoot $f
    if (-not (Test-Path $src)) { Write-Error "$f not found at repo root"; exit 1 }
    Copy-Item $src $PackageDir
    Write-Ok $f
}

# caddy/ — referenced as ./caddy/Caddyfile in docker-compose.yml
$caddyDest = Join-Path $PackageDir "caddy"
New-Item -ItemType Directory -Force $caddyDest | Out-Null
$caddySrc = Join-Path $RepoRoot "caddy\Caddyfile"
if (-not (Test-Path $caddySrc)) { Write-Error "caddy/Caddyfile not found"; exit 1 }
Copy-Item $caddySrc $caddyDest
Write-Ok "caddy/Caddyfile"

# ── Scripts ───────────────────────────────────────────────────────────────────

Write-Step "Copying scripts"
$scriptsDest = Join-Path $PackageDir "scripts"
New-Item -ItemType Directory -Force $scriptsDest | Out-Null

# Operational scripts (bind-mounted by compose at runtime)
$opsScripts = @(
    "backup.sh", "restore.sh",
    "audit-partition.sh", "backup-crontab", "partition-crontab"
)
# Installer helper scripts (for use during offline installation)
$helperScripts = @("import-images.ps1", "import-images.sh", "install-prod.ps1")

foreach ($f in ($opsScripts + $helperScripts)) {
    $src = Join-Path $RepoRoot "scripts\$f"
    if (Test-Path $src) {
        Copy-Item $src $scriptsDest
        Write-Ok "scripts/$f"
    } else {
        Write-Warn "scripts/$f not found — skipping"
    }
}

# ── Docs ──────────────────────────────────────────────────────────────────────

Write-Step "Copying docs"
$docsDest = Join-Path $PackageDir "docs"
New-Item -ItemType Directory -Force $docsDest | Out-Null

$docFiles = @(
    "INTRANET_DEPLOYMENT.md",
    "BACKUP_RESTORE.md",
    "OPERATIONS_RUNBOOK.md",
    "PRODUCTION_RELEASE_PLAN.md"
)
foreach ($f in $docFiles) {
    $src = Join-Path $RepoRoot "docs\$f"
    if (Test-Path $src) {
        Copy-Item $src $docsDest
        Write-Ok "docs/$f"
    } else {
        Write-Warn "docs/$f not found — skipping"
    }
}

# ── Electron installer ────────────────────────────────────────────────────────

Write-Step "Electron installer"
$electronDest = Join-Path $PackageDir "electron"
New-Item -ItemType Directory -Force $electronDest | Out-Null

# electron-builder default artifact name: "${productName} Setup ${version}.exe"
# productName = "직업성 질환 통합 평가 프로그램" (no artifactName override in package.json)
#
# Prefer -ElectronInstallerPath when specified; otherwise search dist\electron\ for *.exe.
# WARNING: if both intranet and standalone builds exist, use -ElectronInstallerPath to
#          specify the intranet installer explicitly — do NOT rely on LastWriteTime alone.
$copiedInstallerName = $null
if ($ElectronInstallerPath) {
    if (Test-Path $ElectronInstallerPath) {
        Copy-Item $ElectronInstallerPath $electronDest
        $copiedInstallerName = Split-Path $ElectronInstallerPath -Leaf
        Write-Ok "electron/$copiedInstallerName (from -ElectronInstallerPath)"
    } else {
        Write-Fail "-ElectronInstallerPath not found: $ElectronInstallerPath"
        exit 1
    }
} else {
    $installerSrc = Get-ChildItem (Join-Path $RepoRoot "dist\electron") -Filter "*.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike "*.blockmap" } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($installerSrc) {
        Copy-Item $installerSrc.FullName $electronDest
        $copiedInstallerName = $installerSrc.Name
        Write-Ok "electron/$copiedInstallerName"
        Write-Warn "Auto-selected newest *.exe — verify this is the intranet build. Use -ElectronInstallerPath to be explicit."
    } else {
        $placeholder  = "Electron intranet installer not yet available.`r`n"
        $placeholder += "Build with: npm run electron:build:intranet`r`n"
        $placeholder += "Then re-run: export-offline-package.ps1 -ElectronInstallerPath <path-to-installer.exe>"
        Write-Utf8NoBom (Join-Path $electronDest "PLACEHOLDER.txt") $placeholder
        Write-Warn "Installer not found — PLACEHOLDER.txt added"
    }
}

# ── Docker image tar ──────────────────────────────────────────────────────────

Write-Step "Saving Docker images"
$imagesDest = Join-Path $PackageDir "images"
New-Item -ItemType Directory -Force $imagesDest | Out-Null

$imagesToSave = [System.Collections.Generic.List[string]]::new()
$imagesToSave.Add($APP_IMAGE)
$imagesToSave.Add($MONITOR_IMAGE)
$imagesToSave.Add($BACKUP_IMAGE)

if (-not $ExcludeBaseImages) {
    $imagesToSave.Add("postgres:16-alpine")
    $imagesToSave.Add("caddy:2-alpine")
    Write-Host "  Including base images: postgres:16-alpine, caddy:2-alpine (default for air-gapped)"
} else {
    Write-Warn "Base images excluded (-ExcludeBaseImages). Target server must pull from Docker Hub."
    Write-Warn "Do NOT use this package on fully air-gapped intranet servers."
}

$tarPath = Join-Path $imagesDest "wr-images.tar"
$dockerSaveArgs = @("save", "-o", $tarPath) + $imagesToSave
& docker @dockerSaveArgs
Assert-DockerCmd "docker save"

$tarMB = [math]::Round((Get-Item $tarPath).Length / 1MB, 1)
Write-Ok "images/wr-images.tar ($tarMB MB)"

# ── release-manifest.json ─────────────────────────────────────────────────────

Write-Step "Generating release-manifest.json"

$gitCommit = git -C $RepoRoot rev-parse HEAD 2>$null
$gitBranch = git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null

function Get-ImageId([string]$img) {
    # Returns full sha256:... image ID for tamper-evidence. RepoDigests are only
    # available after pushing to a registry; for locally-built images this is the
    # authoritative identifier.
    $id = docker inspect --format="{{.Id}}" $img 2>$null
    if ($LASTEXITCODE -eq 0 -and $id) { return $id.Trim() }
    return "unknown"
}

$manifest = [ordered]@{
    version              = $Version
    gitCommit            = if ($gitCommit) { $gitCommit.Trim() } else { "unknown" }
    gitBranch            = if ($gitBranch) { $gitBranch.Trim() } else { "unknown" }
    buildTime            = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    builderHost          = $env:COMPUTERNAME
    images               = @(
        [ordered]@{ name = "wr-app-server";     tag = $Version; imageId = (Get-ImageId $APP_IMAGE) }
        [ordered]@{ name = "wr-backup-monitor"; tag = $Version; imageId = (Get-ImageId $MONITOR_IMAGE) }
        [ordered]@{ name = "wr-backup";         tag = $Version; imageId = (Get-ImageId $BACKUP_IMAGE) }
    )
    baseImages           = @("postgres:16-alpine", "caddy:2-alpine")
    baseImagesIncluded   = [bool](-not $ExcludeBaseImages)
    electronInstaller    = [ordered]@{
        included = [bool]$copiedInstallerName
        fileName = if ($copiedInstallerName) { $copiedInstallerName } else { $null }
        note     = if (-not $copiedInstallerName) { "인트라넷 Electron 빌드 미완성 — 별도 빌드 후 -ElectronInstallerPath로 재실행 필요" } else { $null }
    }
    checksum             = "SHA256SUMS"
}

Write-Utf8NoBom (Join-Path $PackageDir "release-manifest.json") ($manifest | ConvertTo-Json -Depth 5)
Write-Ok "release-manifest.json"

# ── SHA256SUMS ────────────────────────────────────────────────────────────────
#   Generated after all content files are written.
#   SHA256SUMS itself is not listed within SHA256SUMS (standard convention).

Write-Step "Generating SHA256SUMS"

$sha256Lines = [System.Collections.Generic.List[string]]::new()
Get-ChildItem -Recurse -File $PackageDir | Sort-Object FullName | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
    # Forward slashes for cross-platform compatibility with sha256sum -c on Linux
    $rel  = $_.FullName.Substring($PackageDir.Length + 1) -replace '\\', '/'
    $sha256Lines.Add("$hash  $rel")
}

Write-Utf8NoBom (Join-Path $PackageDir "SHA256SUMS") ($sha256Lines -join "`n")
Write-Ok "SHA256SUMS ($($sha256Lines.Count) entries)"

# ── Zip ───────────────────────────────────────────────────────────────────────

if (-not $NoZip) {
    Write-Step "Creating zip archive"
    $zipPath = Join-Path $RepoRoot "release\$PackageName.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path $PackageDir -DestinationPath $zipPath
    $zipMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    Write-Ok "$PackageName.zip ($zipMB MB)"
}

# ── Done ──────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Package ready: $PackageName"                                -ForegroundColor Green
Write-Host "  Directory    : $PackageDir"                                 -ForegroundColor Green
if (-not $NoZip) {
    Write-Host "  Archive      : release\$PackageName.zip"                -ForegroundColor Green
}
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Verification (on Linux):"    -ForegroundColor White
Write-Host "  cd $PackageName && sha256sum -c SHA256SUMS" -ForegroundColor Gray
Write-Host ""
Write-Host "Verification (PowerShell):"  -ForegroundColor White
Write-Host "  cd $PackageName"                            -ForegroundColor Gray
Write-Host "  Get-Content SHA256SUMS | ForEach-Object {" -ForegroundColor Gray
Write-Host "    `$h, `$f = `$_ -split '  ', 2"          -ForegroundColor Gray
Write-Host "    if ((Get-FileHash `$f -Algorithm SHA256).Hash.ToLower() -ne `$h) { Write-Warning `"MISMATCH: `$f`" }" -ForegroundColor Gray
Write-Host "  }"                                          -ForegroundColor Gray
Write-Host ""
Write-Host "Next steps:"                 -ForegroundColor White
Write-Host "  1. Transfer the .zip to the target server (USB / intranet file share)" -ForegroundColor White
Write-Host "  2. Follow docs/PRODUCTION_RELEASE_PLAN.md section 3"                   -ForegroundColor White
