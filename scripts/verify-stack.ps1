#Requires -Version 7.0
<#
.SYNOPSIS
    오프라인 패키지 그대로 띄우는 "인트라넷 설치본 검증 스택"(릴리스 리허설용)을 켜고 끈다.

.DESCRIPTION
    인트라넷 설치본(Electron)은 시작할 때 https://wr.hospital.local:8443 을 불러온다. 이 PC에 그 서버가 없으면
    빈 화면이 된다. 이 스크립트는 release\wr-evaluation-unified-<버전>-intranet 패키지의 docker-compose.yml +
    docker-compose.prod.yml 과 패키지에 담긴 Docker 이미지를 운영 설치(install-prod.ps1)와 같은 방식으로 띄운다.
    개발용 Tier-3 스택(dev-stack-up.ps1: 소스 기반 서버 :3001 + Vite :3000)과 달리 "배포물 자체"를 시험한다 —
    패키지의 updates\ 폴더(서명된 latest.yml.sig)도 /updates/ 로 서빙되므로 서명 업데이트 실기기 시험에 쓴다.

    - compose 프로젝트 이름은 wr-verify 로 고정이다(파라미터로 열지 않는다). 운영(wr-prod)·개발(wr-evaluation-unified)
      프로젝트의 컨테이너·볼륨은 건드리지 않는다. DB·업로드·백업 볼륨도 wr-verify_* 로 따로 생긴다.
    - 실제 .env.production 은 읽지 않는다. 시험 전용 환경 파일(release\.verify-stack\wr-verify.env)을 처음 한 번
      무작위 비밀값으로 만든다. 영상 분석·통계 워크벤치 등은 그 파일을 고친 뒤 up 을 다시 실행하면 켜진다.
    - TLS: Caddy 내부 CA 는 기존 볼륨(wr-evaluation-unified_caddy_data)을 재사용한다. 그 CA 루트가 이미 Windows 에
      신뢰 등록돼 있으면 별도 설치 없이 설치본이 접속된다(up 이 지문을 비교해 알려 준다). 새 CA 를 쓰려면 -FreshCa.
    - 서비스는 패키지의 기본 서비스 전부(postgres·backup-monitor·partition·app·caddy)다. backup 프로필(GPG 필요)은 띄우지
      않는다. restart 정책은 no — PC 를 재부팅해도 저절로 8443 을 잡지 않는다.

.PARAMETER Action
    up         스택을 켠다(이미지 확인 → 환경 파일 → 포트 점검 → compose up → 헬스 대기 → 감사 계정 비밀번호 동기화).
    down       컨테이너·네트워크를 내린다. 볼륨(DB 등)은 남는다 — 다음 up 에서 이어진다.
    status     컨테이너, 주소별 응답, CA 신뢰 여부를 보여 준다. 스택이 꺼져 있어도 실행된다.
    purge      down + wr-verify_* 볼륨 삭제(DB 초기화). 공유 Caddy CA 볼륨은 external 이라 지워지지 않는다.
    seed-admin 첫 관리자 계정 생성(대화형: 기관·로그인 ID·비밀번호 입력). up 뒤 최초 1회.

.PARAMETER PackageDir
    패키지 폴더. 생략하면 release\wr-evaluation-unified-<package.json 버전>-intranet.

.PARAMETER LoadImages
    패키지의 images\wr-images.tar 를 docker load 한다(로컬 이미지가 없거나 패키지의 것과 다를 때).

.PARAMETER FreshCa
    기존 Caddy CA 볼륨 대신 이 스택 전용 새 CA 를 쓴다. 루트 인증서를 Windows 에 직접 신뢰 등록해야 한다.

.PARAMETER LaunchShell
    up 이 끝난 뒤 설치된 인트라넷 설치본을 실행한다(WR_INTRANET_URL 을 비운 채 — 기본 주소 8443 로 접속).

.PARAMETER Force
    purge 의 확인 질문을 건너뛴다.

.EXAMPLE
    pwsh -File scripts/verify-stack.ps1 up -LaunchShell
    pwsh -File scripts/verify-stack.ps1 seed-admin
    pwsh -File scripts/verify-stack.ps1 status
    pwsh -File scripts/verify-stack.ps1 down
    pwsh -File scripts/verify-stack.ps1 purge -Force
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'down', 'status', 'purge', 'seed-admin')]
    [string]$Action = 'status',
    [string]$PackageDir = '',
    [switch]$LoadImages,
    [switch]$FreshCa,
    [switch]$LaunchShell,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ── 고정 값 ───────────────────────────────────────────────────────────────────
# 프로젝트 이름은 의도적으로 파라미터가 아니다 — 잘못 넘겨 운영(wr-prod)·개발 프로젝트에 down/purge 가 가지 않게 한다.
$ProjectName   = 'wr-verify'
$Domain        = 'wr.hospital.local'
$HttpsPort     = 8443
$HttpPort      = 8080
$CaVolumeName  = 'wr-evaluation-unified_caddy_data'   # 예전 스택이 만든 Caddy 데이터(내부 CA) 볼륨 — 재사용(external)
$BaseUrl       = "https://${Domain}:${HttpsPort}"

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$WorkDir   = Join-Path $RepoRoot 'release\.verify-stack'     # release\ 는 gitignore 대상
$EnvFile   = Join-Path $WorkDir  'wr-verify.env'
$Override  = Join-Path $WorkDir  'wr-verify.override.yml'
$RootCrt   = Join-Path $WorkDir  'wr-verify-root.crt'

function Write-Step([string]$m) { Write-Host ''; Write-Host "── $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "   OK   $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "   WARN $m" -ForegroundColor Yellow }
function Write-Fail([string]$m) { Write-Host "   FAIL $m" -ForegroundColor Red }
function Stop-WithError([string]$m) { Write-Fail $m; exit 1 }

# ── 패키지·환경 ───────────────────────────────────────────────────────────────
function Resolve-PackageDir {
    if ($PackageDir) { $dir = $PackageDir }
    else {
        $ver = (Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
        $dir = Join-Path $RepoRoot "release\wr-evaluation-unified-$ver-intranet"
    }
    if (-not (Test-Path $dir -PathType Container)) {
        Stop-WithError "패키지 폴더가 없습니다: $dir`n   먼저 npm run electron:build:intranet → scripts\export-offline-package.ps1 로 패키지를 만드세요."
    }
    foreach ($f in 'docker-compose.yml', 'docker-compose.prod.yml', 'release-manifest.json') {
        if (-not (Test-Path (Join-Path $dir $f))) { Stop-WithError "패키지에 $f 가 없습니다: $dir" }
    }
    return (Resolve-Path $dir).Path
}

function New-HexSecret([int]$Bytes = 32) {
    $b = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
    return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# 시험 전용 환경 파일. 있으면 그대로 두고 WR_VERSION 만 패키지 버전에 맞춘다(다른 패키지로 바꿔 시험해도 DB 비밀번호는 유지).
function Initialize-EnvFile([string]$Version) {
    New-Item -ItemType Directory -Force $WorkDir | Out-Null
    if (-not (Test-Path $EnvFile)) {
        $text = @"
# verify-stack.ps1 이 만든 "시험 전용" 환경 파일이다. 실제 .env.production 이 아니며, 비밀값은 이 스택 전용 무작위 값이다.
# 고친 뒤 'verify-stack.ps1 up' 을 다시 실행하면 앱이 새 값으로 재생성된다. DB 비밀번호를 바꾸려면 purge 후 up.
WR_VERSION=$Version
WR_DOMAIN=$Domain
CORS_ORIGINS=$BaseUrl
POSTGRES_PASSWORD=$(New-HexSecret)
AUDIT_DB_PASSWORD=$(New-HexSecret)
ACCESS_TOKEN_SECRET=$(New-HexSecret)
REFRESH_TOKEN_SECRET=$(New-HexSecret)
# docker-compose.prod.yml 이 비어 있으면 거부하는 필수 값 — 이 스택은 backup 서비스를 띄우지 않으므로 자리만 채운다.
BACKUP_GPG_RECIPIENT=verify-stack-unused@invalid.example
# 시험 항목에 따라 필요하면 주석을 풀고 up 을 다시 실행한다.
#VIDEO_ANALYSIS_ENABLED=true
#STATS_WORKBENCH_ENABLED=true
"@
        Write-Utf8NoBom $EnvFile ($text -replace "`r`n", "`n")
        Write-Ok "시험 전용 환경 파일 생성: $EnvFile"
        return
    }
    $cur = Get-Content $EnvFile -Raw
    if ($cur -match '(?m)^WR_VERSION=(.*)$') {
        if ($Matches[1].Trim() -ne $Version) {
            Write-Utf8NoBom $EnvFile ($cur -replace '(?m)^WR_VERSION=.*$', "WR_VERSION=$Version")
            Write-Ok "환경 파일의 WR_VERSION → $Version (패키지에 맞춤)"
        }
    } else {
        Write-Utf8NoBom $EnvFile ($cur.TrimEnd() + "`nWR_VERSION=$Version`n")
    }
}

function Get-EnvValue([string]$Key) {
    $line = Get-Content $EnvFile | Where-Object { $_ -match "^\s*$Key=" } | Select-Object -First 1
    if (-not $line) { return $null }
    return ($line -split '=', 2)[1].Trim()
}

# 시험용 override: 재시작 정책 off + (기본) 기존 Caddy CA 볼륨 재사용.
function Write-OverrideFile {
    $lines = @(
        '# verify-stack.ps1 이 만든 파일 — 직접 고치지 않는다(매 up 마다 다시 쓴다).',
        'services:',
        '  postgres:       { restart: "no" }',
        '  backup-monitor: { restart: "no" }',
        '  partition:      { restart: "no" }',
        '  app:            { restart: "no" }',
        '  caddy:          { restart: "no" }'
    )
    if (-not $FreshCa) {
        $lines += @('volumes:', '  caddy_data:', '    external: true', "    name: $CaVolumeName")
    }
    Write-Utf8NoBom $Override (($lines -join "`n") + "`n")
}

# ── Docker ────────────────────────────────────────────────────────────────────
function Assert-Docker {
    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'Docker 가 실행 중이 아닙니다. Docker Desktop 을 켠 뒤 다시 실행하세요.' }
    docker compose version --short 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'Docker Compose v2 가 필요합니다.' }
}

function Get-ComposeBase([string]$PkgDir) {
    return @(
        'compose', '--project-directory', $PkgDir,
        '-f', (Join-Path $PkgDir 'docker-compose.yml'),
        '-f', (Join-Path $PkgDir 'docker-compose.prod.yml'),
        '-f', $Override,
        '--env-file', $EnvFile,
        '-p', $ProjectName
    )
}

# 모든 compose 호출은 이 함수를 거친다 — 프로젝트 이름이 wr-verify 가 아니면 즉시 중단한다(마지막 안전장치).
function Invoke-Compose([string[]]$ComposeArgs) {
    if ($ProjectName -ne 'wr-verify') { throw "프로젝트 이름이 wr-verify 가 아닙니다: $ProjectName" }
    & docker @script:ComposeBase @ComposeArgs
}

# 패키지 매니페스트에 적힌 이미지 ID 와 로컬 이미지가 같은지 — "시험한 것 = 배포할 것"을 보장한다.
function Assert-Images($Manifest, [string]$PkgDir) {
    $bad = @()
    foreach ($img in $Manifest.images) {
        $ref = "$($img.name):$($img.tag)"
        $id = (docker image inspect $ref --format '{{.Id}}' 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not $id) { $bad += "$ref (로컬에 없음)"; continue }
        if ($id.Trim() -ne $img.imageId) { $bad += "$ref (이미지 ID 가 패키지와 다름)" }
    }
    return $bad
}

function Import-PackageImages([string]$PkgDir) {
    $tar = Join-Path $PkgDir 'images\wr-images.tar'
    if (-not (Test-Path $tar)) { Stop-WithError "이미지 아카이브가 없습니다: $tar" }
    Write-Host "   docker load -i $tar (수 분 걸릴 수 있음)"
    docker load -i $tar | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'docker load 실패' }
}

# ── 포트·호스트·CA ────────────────────────────────────────────────────────────
function Get-OwnContainers {
    return @(docker ps --filter "label=com.docker.compose.project=$ProjectName" --format '{{.Names}}' 2>$null)
}

function Assert-PortsFree {
    $mine = @(Get-OwnContainers)
    foreach ($port in $HttpsPort, $HttpPort) {
        $names = @(docker ps --filter "publish=$port" --format '{{.Names}}' 2>$null) | Where-Object { $_ }
        $others = @($names | Where-Object { $mine -notcontains $_ })
        if ($others.Count -gt 0) {
            Stop-WithError ":$port 를 다른 컨테이너가 쓰고 있습니다: $($others -join ', ')`n   이 스크립트는 wr-verify 프로젝트 외의 컨테이너를 건드리지 않습니다. 직접 정리한 뒤 다시 실행하세요."
        }
        if ($mine.Count -eq 0) {
            $listen = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($listen) {
                $p = Get-Process -Id $listen.OwningProcess -ErrorAction SilentlyContinue
                Stop-WithError ":$port 를 프로세스가 쓰고 있습니다: $(if ($p) { "$($p.ProcessName) (pid $($p.Id))" } else { "pid $($listen.OwningProcess)" })"
            }
        }
    }
}

function Test-HostResolves {
    try {
        $ips = [System.Net.Dns]::GetHostAddresses($Domain) | ForEach-Object { $_.ToString() }
        if ($ips | Where-Object { $_ -in '127.0.0.1', '::1' }) { Write-Ok "$Domain → $($ips -join ', ')"; return }
        Write-Warn "$Domain 이 루프백이 아닙니다($($ips -join ', ')). 이 PC 의 스택에 접속하려면 hosts 에 '127.0.0.1 $Domain' 이 필요합니다."
    } catch {
        Write-Warn "$Domain 을 해석하지 못했습니다. hosts 파일에 '127.0.0.1 $Domain' 을 추가하세요."
    }
}

# 재사용하는 Caddy CA 볼륨의 루트 인증서 지문이 Windows 신뢰 저장소에 있는지.
function Get-CaTrust {
    $pem = docker run --rm --entrypoint cat -v "${CaVolumeName}:/data:ro" caddy:2-alpine /data/caddy/pki/authorities/local/root.crt 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $pem) { return [pscustomobject]@{ Found = $false; Trusted = $false; Thumbprint = $null; Stores = @() } }
    $b64 = (($pem -split "`n") | Where-Object { $_ -and $_ -notmatch '^-----' }) -join ''
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [Convert]::FromBase64String($b64))
    $stores = @()
    foreach ($s in 'CurrentUser', 'LocalMachine') {
        $hit = Get-ChildItem "Cert:\$s\Root" -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
        if ($hit) { $stores += $s }
    }
    return [pscustomobject]@{ Found = $true; Trusted = ($stores.Count -gt 0); Thumbprint = $cert.Thumbprint; Stores = $stores }
}

# ── HTTP 확인 ─────────────────────────────────────────────────────────────────
function Invoke-Probe([string]$Path) {
    try {
        $r = Invoke-WebRequest -Uri "$BaseUrl$Path" -TimeoutSec 8 -SkipHttpErrorCheck
        $c = $r.Content
        if ($c -is [byte[]]) { $c = [System.Text.Encoding]::UTF8.GetString($c) }
        return [pscustomobject]@{ Code = [int]$r.StatusCode; Body = [string]$c; Error = $null }
    } catch {
        $msg = $_.Exception.Message
        if ($_.Exception.InnerException) { $msg += ' / ' + $_.Exception.InnerException.Message }
        return [pscustomobject]@{ Code = 0; Body = ''; Error = $msg }
    }
}

# HTTPS 가 열릴 때까지 기다린다. 재사용한 CA 볼륨의 leaf 인증서(수명 6일)가 만료돼 있으면 Caddy 는 시작할 때 그 파일을 지우고
# 갱신을 시도하다가 방금 지운 키 파일을 읽지 못해 재시도만 반복한다(검증에서 확인: 60초→120초→… 스스로 복구되지 않음).
# 파일이 지워진 뒤 Caddy 를 한 번 다시 시작하면 새로 발급받으므로, NotTimeValid 가 보이면 한 번만 재시작한다.
function Wait-Https([int]$TimeoutSec = 120) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $restarted = $false
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        $p = Invoke-Probe '/health'
        if ($p.Code -eq 200) { return $true }
        if (-not $restarted -and $p.Error -match 'NotTimeValid') {
            Write-Warn '재사용한 Caddy 볼륨의 인증서가 만료돼 있습니다 — Caddy 를 한 번 다시 시작해 새로 발급받습니다.'
            Invoke-Compose @('restart', 'caddy') | Out-Null
            $restarted = $true
        }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Wait-Healthy([string]$Service, [int]$TimeoutSec) {
    $id = (Invoke-Compose @('ps', '-q', $Service) | Select-Object -First 1)
    if (-not $id) { return $false }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        $st = (docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' $id 2>$null)
        if ($st -match '\|healthy$') { return $true }
        if ($st -match '^(exited|dead)') { return $false }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Show-Endpoints {
    $h = Invoke-Probe '/health'
    if ($h.Error) {
        Write-Fail "$BaseUrl/health 접속 실패: $($h.Error)"
        if ($h.Error -match 'certificate|SSL|TLS|trust|인증서') { Write-Warn '인증서 신뢰 문제입니다 — 위 CA 신뢰 항목을 확인하세요.' }
        return $false
    }
    if ($h.Code -eq 200) { Write-Ok "/health → 200" } else { Write-Fail "/health → $($h.Code)"; return $false }
    $c = Invoke-Probe '/api/config/public'
    if ($c.Code -eq 200) { Write-Ok "/api/config/public → 200 $($c.Body.Substring(0, [Math]::Min(120, $c.Body.Length)))…" } else { Write-Warn "/api/config/public → $($c.Code)" }
    $y = Invoke-Probe '/updates/latest.yml'
    if ($y.Code -eq 200 -and $y.Body -match '(?m)^version:\s*(\S+)') { Write-Ok "/updates/latest.yml → 200 (version $($Matches[1]))" } else { Write-Warn "/updates/latest.yml → $($y.Code) (패키지 updates\ 에 피드가 없거나 마운트 문제)" }
    $s = Invoke-Probe '/updates/latest.yml.sig'
    if ($s.Code -eq 200 -and $s.Body.Trim().Length -eq 88) { Write-Ok '/updates/latest.yml.sig → 200 (88자)' } else { Write-Warn "/updates/latest.yml.sig → $($s.Code) (서명 파일이 없으면 7.1.4 셸은 모든 업데이트를 거부)" }
    return $true
}

function Show-CaTrust {
    if ($FreshCa) { Write-Warn '-FreshCa: 이 스택 전용 새 CA 입니다. 루트 인증서를 직접 신뢰 등록해야 합니다(up 끝에 안내).'; return }
    $t = Get-CaTrust
    if (-not $t.Found) { Write-Warn "CA 볼륨($CaVolumeName)을 읽지 못했습니다 — 새 CA 가 만들어지니 -FreshCa 로 실행하고 루트를 신뢰 등록하세요."; return }
    if ($t.Trusted) { Write-Ok "Caddy CA 루트 $($t.Thumbprint.Substring(0, 10))… 는 Windows 에 신뢰 등록돼 있음 ($($t.Stores -join ', '))" }
    else { Write-Warn "Caddy CA 루트 $($t.Thumbprint.Substring(0, 10))… 가 Windows 신뢰 저장소에 없습니다 — 설치본이 인증서 오류로 접속하지 못합니다. -FreshCa 로 새 CA 를 쓰거나 이 루트를 신뢰 등록하세요." }
}

# ── 동작 ──────────────────────────────────────────────────────────────────────
function Invoke-Up {
    Write-Step '1/7 사전 점검'
    Assert-Docker
    Write-Ok 'Docker / Compose'
    $pkg = Resolve-PackageDir
    $manifest = Get-Content (Join-Path $pkg 'release-manifest.json') -Raw | ConvertFrom-Json
    Write-Ok "패키지: $pkg (버전 $($manifest.version), 커밋 $($manifest.gitCommit.Substring(0, 7)))"

    Write-Step '2/7 이미지 (패키지 매니페스트와 대조)'
    if ($LoadImages) { Import-PackageImages $pkg }
    $bad = @(Assert-Images $manifest $pkg)
    if ($bad.Count -gt 0) {
        $bad | ForEach-Object { Write-Fail $_ }
        Stop-WithError "로컬 이미지가 패키지와 다릅니다. -LoadImages 로 패키지의 이미지를 불러오세요."
    }
    Write-Ok "앱·백업 이미지 ID 가 패키지 매니페스트와 일치"

    Write-Step '3/7 환경 파일 · compose 설정'
    Initialize-EnvFile $manifest.version
    Write-OverrideFile
    $script:ComposeBase = Get-ComposeBase $pkg
    Invoke-Compose @('config', '--quiet')
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'docker compose config 검증 실패(위 메시지 확인)' }
    Write-Ok 'compose 설정 유효 (운영 오버레이 + 시험 override)'

    Write-Step '4/7 포트 · 호스트 · CA'
    Assert-PortsFree
    Write-Ok ":$HttpsPort / :$HttpPort 사용 가능"
    Test-HostResolves
    Show-CaTrust

    Write-Step '5/7 기동 (패키지 기본 서비스 전부)'
    # backup-monitor 를 먼저 올린다. 이 컨테이너가 backup_data 볼륨(쓰기 가능)에 /backups/_alerts 마운트 지점을 만들어 둬야
    # app 이 같은 경로를 읽기 전용 /backups 위에 마운트할 수 있다(빈 새 볼륨에서 app 부터 만들면 runc 가 'read-only file system'으로 실패).
    Invoke-Compose @('up', '-d', 'backup-monitor')
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'backup-monitor 기동 실패' }
    Invoke-Compose @('up', '-d')
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'docker compose up 실패' }
    Write-Host '   app 헬스 대기(최대 3분, 첫 기동은 마이그레이션 때문에 더 걸릴 수 있음)…'
    if (-not (Wait-Healthy 'app' 180)) {
        Write-Host '   --- app 로그(마지막 25줄) ---'
        Invoke-Compose @('logs', 'app', '--tail=25')
        Stop-WithError 'app 이 healthy 가 되지 않았습니다.'
    }
    Write-Ok 'app healthy'

    Write-Step '6/7 감사 계정 비밀번호 동기화 (INTRANET_DEPLOYMENT.md 2절 4번)'
    $auditPw = Get-EnvValue 'AUDIT_DB_PASSWORD'
    Invoke-Compose @('exec', '-T', 'postgres', 'psql', '-U', 'wr_user', '-d', 'wr_evaluation', '-v', 'ON_ERROR_STOP=1', '-c', "ALTER ROLE wr_audit_reader PASSWORD '$auditPw'") | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warn 'ALTER ROLE 실패 — 감사 로그 조회(관리자 콘솔)가 오류일 수 있음' } else { Write-Ok 'wr_audit_reader 비밀번호 동기화' }

    Write-Step '7/7 접속 확인'
    [void](Wait-Https 120)
    $reachable = Show-Endpoints
    if ($FreshCa) { Export-FreshRoot }

    Write-Host ''
    if ($reachable) {
        Write-Host '검증 스택 준비 완료' -ForegroundColor Green
        Write-Host "  접속:        $BaseUrl   (설치본의 기본 주소 — WR_INTRANET_URL 설정 불필요)"
        Write-Host '  첫 관리자:   pwsh -File scripts/verify-stack.ps1 seed-admin   (최초 1회)'
        Write-Host '  상태/종료:   ... status / down / purge -Force'
    } else {
        Write-Warn '컨테이너는 떴지만 HTTPS 접속 확인에 실패했습니다. 위 메시지를 확인하세요.'
    }
    if ($LaunchShell) { Start-InstalledShell }
}

function Export-FreshRoot {
    Invoke-Compose @('exec', '-T', 'caddy', 'cat', '/data/caddy/pki/authorities/local/root.crt') | Set-Content -Path $RootCrt -Encoding ascii
    if ($LASTEXITCODE -eq 0 -and (Test-Path $RootCrt)) {
        Write-Warn "새 CA 루트를 내보냈습니다: $RootCrt"
        Write-Host "   신뢰 등록(1회, Windows 확인 창이 뜸):  certutil -user -addstore Root `"$RootCrt`""
    }
}

function Start-InstalledShell {
    $exe = Join-Path $env:LOCALAPPDATA 'Programs\wr-evaluation-unified\직업성 질환 통합 평가 프로그램.exe'
    if (-not (Test-Path $exe)) { Write-Warn "설치본을 찾지 못했습니다: $exe"; return }
    $prev = $env:WR_INTRANET_URL
    $env:WR_INTRANET_URL = $null   # 기본 주소(8443)로 접속하도록 — 개발 서버 주소가 남아 있으면 안 된다
    try { Start-Process -FilePath $exe | Out-Null; Write-Ok '설치본 실행' } finally { $env:WR_INTRANET_URL = $prev }
}

function Invoke-Down {
    Assert-Docker
    if (-not (Test-Path $EnvFile)) { Write-Ok '검증 스택을 띄운 적이 없습니다(환경 파일 없음) — 내릴 것이 없습니다.'; return }
    $pkg = Resolve-PackageDir
    Write-OverrideFile
    $script:ComposeBase = Get-ComposeBase $pkg
    Write-Step "컨테이너·네트워크 내리기 (프로젝트 $ProjectName, 볼륨 유지)"
    Invoke-Compose @('down', '--remove-orphans')
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'docker compose down 실패' }
    Write-Ok '내렸습니다. DB 등 wr-verify_* 볼륨은 남아 있습니다(초기화는 purge).'
}

function Invoke-Purge {
    Assert-Docker
    if (-not (Test-Path $EnvFile)) { Write-Ok '검증 스택을 띄운 적이 없습니다 — 지울 것이 없습니다.'; return }
    if (-not $Force) {
        $ans = Read-Host "wr-verify 프로젝트의 컨테이너와 볼륨(DB·업로드)을 삭제합니다. 계속하려면 YES 입력"
        if ($ans -ne 'YES') { Write-Warn '취소했습니다.'; return }
    }
    $pkg = Resolve-PackageDir
    Write-OverrideFile
    $script:ComposeBase = Get-ComposeBase $pkg
    Write-Step "삭제 (프로젝트 $ProjectName)"
    # external 로 선언한 Caddy CA 볼륨은 compose down -v 가 지우지 않는다 — 아래에서 실제로 남아 있는지 확인한다.
    Invoke-Compose @('down', '-v', '--remove-orphans')
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'docker compose down -v 실패' }
    $left = @(docker volume ls --format '{{.Name}}' | Where-Object { $_ -like "${ProjectName}_*" })
    if ($left.Count -gt 0) { Write-Warn "남은 볼륨: $($left -join ', ')" } else { Write-Ok "wr-verify_* 볼륨 없음" }
    $caKept = @(docker volume ls --format '{{.Name}}' | Where-Object { $_ -eq $CaVolumeName }).Count -gt 0
    if ($caKept) { Write-Ok "공유 Caddy CA 볼륨 보존: $CaVolumeName" } elseif (-not $FreshCa) { Write-Warn "공유 Caddy CA 볼륨이 없습니다: $CaVolumeName" }
}

function Invoke-Status {
    Assert-Docker
    Write-Step "컨테이너 (프로젝트 $ProjectName)"
    $own = @(Get-OwnContainers)
    if ($own.Count -eq 0) { Write-Host '   실행 중인 컨테이너 없음' } else { docker ps --filter "label=com.docker.compose.project=$ProjectName" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' }
    $vols = @(docker volume ls --format '{{.Name}}' | Where-Object { $_ -like "${ProjectName}_*" })
    Write-Host "   볼륨: $(if ($vols.Count) { $vols -join ', ' } else { '없음' })"
    Write-Host "   환경 파일: $(if (Test-Path $EnvFile) { $EnvFile } else { '없음(아직 up 하지 않음)' })"
    Write-Step 'CA 신뢰'
    Show-CaTrust
    Write-Step "주소 응답 ($BaseUrl)"
    if ($own.Count -eq 0) { Write-Host '   (스택이 꺼져 있어 확인하지 않음)'; return }
    [void](Show-Endpoints)
}

function Invoke-SeedAdmin {
    Assert-Docker
    if (-not (Test-Path $EnvFile)) { Stop-WithError '먼저 up 으로 스택을 켜세요.' }
    $pkg = Resolve-PackageDir
    Write-OverrideFile
    $script:ComposeBase = Get-ComposeBase $pkg
    Write-Step '첫 관리자 계정 생성 (기관·로그인 ID·비밀번호를 차례로 입력)'
    Invoke-Compose @('exec', 'app', 'node', 'dist/cli/seedAdmin.js')
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'seedAdmin 실패(이미 있는 로그인 ID 이거나 스택이 꺼져 있을 수 있음)' }
}

switch ($Action) {
    'up'         { Invoke-Up }
    'down'       { Invoke-Down }
    'status'     { Invoke-Status }
    'purge'      { Invoke-Purge }
    'seed-admin' { Invoke-SeedAdmin }
}
