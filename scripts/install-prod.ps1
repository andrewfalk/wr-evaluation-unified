<#
.SYNOPSIS
    Guided production installation for Windows servers.

.DESCRIPTION
    Checks prerequisites, loads Docker images, validates .env.production,
    and starts all services with the production compose configuration.
    Run from the package root directory.

.PARAMETER EnvFile
    Path to the production env file. Default: .\.env.production

.PARAMETER ProjectName
    Docker Compose project name. Default: wr-prod
    All volumes are prefixed with this name (e.g. wr-prod_postgres_data).

.PARAMETER SkipImageLoad
    Skip docker load step (images already loaded into daemon).

.PARAMETER DryRun
    Print the docker compose command without executing it.

.EXAMPLE
    # Standard first-time installation
    .\scripts\install-prod.ps1

    # Custom project name (e.g. for a second installation on the same host)
    .\scripts\install-prod.ps1 -ProjectName wr-prod-2

    # Dry run — print compose command only
    .\scripts\install-prod.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$EnvFile     = ".\.env.production",
    [string]$ProjectName = "wr-prod",
    [switch]$SkipImageLoad,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$n, [string]$msg) {
    Write-Host ""
    Write-Host "── Step ${n}: $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg)   { Write-Host "   OK  $msg" -ForegroundColor Green  }
function Write-Warn([string]$msg) { Write-Host "   WARN $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "   FAIL $msg" -ForegroundColor Red    }

$Passed  = 0
$Warned  = 0
$Failed  = 0

# ── Step 1: Prerequisites ─────────────────────────────────────────────────────

Write-Step 1 "Prerequisites"

# Docker daemon
docker info *>$null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Docker is not running. Start Docker Desktop (or the docker service) and retry."
    exit 1
}
Write-Ok "Docker daemon is running"
$Passed++

# Docker Compose v2
$composeVersion = docker compose version --short 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Docker Compose v2 not found. Install Docker Engine 24+ which includes Compose v2."
    exit 1
}
$verParts = $composeVersion -replace '^v', '' -split '\.'
if ([int]$verParts[0] -lt 2 -or ([int]$verParts[0] -eq 2 -and [int]$verParts[1] -lt 17)) {
    Write-Warn "Docker Compose $composeVersion detected. v2.17+ recommended for !reset tag support."
    $Warned++
} else {
    Write-Ok "Docker Compose $composeVersion"
    $Passed++
}

# ── Step 2: Load Docker images ────────────────────────────────────────────────

Write-Step 2 "Docker images"

if ($SkipImageLoad) {
    Write-Ok "Skipping image load (-SkipImageLoad)"
} elseif ($DryRun) {
    Write-Ok "DryRun: skipping image load (would run: docker load -i .\images\wr-images.tar)"
    $Passed++
} else {
    $tarPath = ".\images\wr-images.tar"
    if (-not (Test-Path $tarPath)) {
        Write-Fail "images\wr-images.tar not found."
        Write-Host "   This is an offline installer — the image archive must be present." -ForegroundColor Red
        Write-Host "   If images are already loaded into Docker, pass -SkipImageLoad explicitly." -ForegroundColor White
        exit 1
    }
    Write-Host "   Loading images from ${tarPath}..."
    docker load -i $tarPath
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "docker load failed"
        exit 1
    }
    Write-Ok "Images loaded from $tarPath"
    $Passed++
}

# ── Step 3: .env.production validation ───────────────────────────────────────

Write-Step 3 ".env.production validation"

if (-not (Test-Path $EnvFile)) {
    Write-Fail "$EnvFile not found."
    Write-Host "   Copy .env.production.example to .env.production and fill in all values."
    exit 1
}
Write-Ok "$EnvFile found"

# Check for unfilled blank values (lines with KEY= and nothing after =)
$blankKeys = Get-Content $EnvFile |
    Where-Object { $_ -match '^\s*[^#\s][^=]*=\s*$' } |
    ForEach-Object { ($_ -split '=', 2)[0].Trim() }

if ($blankKeys.Count -gt 0) {
    Write-Fail "The following required variables are empty in ${EnvFile}:"
    $blankKeys | ForEach-Object { Write-Host "     - $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "   Fill in all blank values, then re-run this script." -ForegroundColor White
    exit 1
}
Write-Ok "No blank required values"
$Passed++

# Warn about leftover changeme_ values
$changemeKeys = Get-Content $EnvFile |
    Where-Object { $_ -match '^\s*[^#].*=.*changeme' } |
    ForEach-Object { ($_ -split '=', 2)[0].Trim() }

if ($changemeKeys.Count -gt 0) {
    Write-Fail "changeme_ placeholder values found — these MUST be replaced before production:"
    $changemeKeys | ForEach-Object { Write-Host "     - $_" -ForegroundColor Red }
    exit 1
}
Write-Ok "No changeme_ placeholders"
$Passed++

# WR_VERSION must be set
$wrVersion = (Get-Content $EnvFile | Where-Object { $_ -match '^\s*WR_VERSION\s*=' }) |
    ForEach-Object { ($_ -split '=', 2)[1].Trim() } | Select-Object -First 1

if (-not $wrVersion) {
    Write-Fail "WR_VERSION is not set in $EnvFile. Set it to the image tag (e.g. WR_VERSION=5.0.0)."
    exit 1
}
Write-Ok "WR_VERSION=$wrVersion"
$Passed++

# ── Step 4: Compose config validation ────────────────────────────────────────

Write-Step 4 "Compose config validation"

$composeArgs = @(
    "-f", "docker-compose.yml",
    "-f", "docker-compose.prod.yml",
    "--env-file", $EnvFile,
    "-p", $ProjectName,
    "config", "--quiet"
)

docker compose @composeArgs
if ($LASTEXITCODE -ne 0) {
    Write-Fail "docker compose config validation failed. Fix the errors above and retry."
    exit 1
}
Write-Ok "Compose config is valid"
$Passed++

# ── Step 5: Volume isolation check ───────────────────────────────────────────

Write-Step 5 "Volume isolation check"

$existingProdVolumes = docker volume ls --format "{{.Name}}" 2>$null |
    Where-Object { $_ -like "${ProjectName}_*" }

if ($existingProdVolumes.Count -gt 0) {
    Write-Warn "Existing volumes found for project '$ProjectName':"
    $existingProdVolumes | ForEach-Object { Write-Host "     $_" -ForegroundColor Yellow }
    Write-Warn "These volumes will be REUSED — data is preserved. This is expected for upgrades."
    Write-Warn "For a fresh rehearsal environment, pass a different -ProjectName (e.g. -ProjectName wr-prod-test)."
    Write-Warn "Do NOT delete production volumes from this script."
    $Warned++
} else {
    Write-Ok "No existing volumes for project '$ProjectName' — fresh install"
    $Passed++
}

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Pre-flight: $Passed checks passed, $Warned warnings, $Failed failures" -ForegroundColor White

if ($Failed -gt 0) {
    Write-Host "  Aborting due to failures above." -ForegroundColor Red
    exit 1
}

# ── Step 6: Start services ────────────────────────────────────────────────────

Write-Step 6 "Starting services (project: $ProjectName)"

$upArgs = @(
    "-f", "docker-compose.yml",
    "-f", "docker-compose.prod.yml",
    "--env-file", $EnvFile,
    "-p", $ProjectName,
    "up", "-d"
)

$cmdStr = "docker compose " + ($upArgs -join " ")

if ($DryRun) {
    Write-Host ""
    Write-Host "  DRY RUN — would execute:" -ForegroundColor Yellow
    Write-Host "  $cmdStr"                   -ForegroundColor Gray
    Write-Host ""
    exit 0
}

Write-Host "  $cmdStr"
Write-Host ""
docker compose @upArgs

if ($LASTEXITCODE -ne 0) {
    Write-Fail "docker compose up failed (exit $LASTEXITCODE). Check logs above."
    exit 1
}

# ── Post-start ────────────────────────────────────────────────────────────────

$composePrefix = "docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file $EnvFile -p $ProjectName"

Write-Host ""
Write-Host "Services are starting. Check status:" -ForegroundColor White
Write-Host "  $composePrefix ps"
Write-Host "  $composePrefix logs app --tail=100"
Write-Host ""
Write-Host "Volumes created (or reused):" -ForegroundColor White
docker volume ls --format "  {{.Name}}" 2>$null | Where-Object { $_ -match "${ProjectName}_" }

Write-Host ""
Write-Host "Next steps (PRODUCTION_RELEASE_PLAN.md section 4):" -ForegroundColor White
Write-Host "  1. Change AUDIT_DB_PASSWORD:"
Write-Host "     $composePrefix exec postgres psql -U wr_user -d wr_evaluation -c `"ALTER ROLE wr_audit_reader PASSWORD '...';`""
Write-Host "  2. Seed admin account:"
Write-Host "     $composePrefix exec app node dist/cli/seedAdmin.js"
Write-Host "  3. Register GPG public key:"
Write-Host "     Get-Content .\wr-backup-public.asc | $composePrefix --profile backup run --rm -T backup gpg --import"
Write-Host "  4. Activate backup profile:"
Write-Host "     $composePrefix --profile backup up -d"
