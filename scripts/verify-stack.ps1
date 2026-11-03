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
      무작위 비밀값으로 만든다. 통계 워크벤치는 기본으로 켜 두고, 영상 분석 등은 그 파일을 고친 뒤 up 을 다시 실행하면 켜진다.
    - TLS: Caddy 내부 CA 는 기존 볼륨(wr-evaluation-unified_caddy_data)을 재사용한다. 그 CA 루트가 이미 Windows 에
      신뢰 등록돼 있으면 별도 설치 없이 설치본이 접속된다(up 이 지문을 비교해 알려 준다). 새 CA 를 쓰려면 -FreshCa.
    - 서비스는 패키지의 기본 서비스 전부(postgres·backup-monitor·partition·app·caddy)다. backup 프로필(GPG 필요)은 띄우지
      않는다. restart 정책은 no — PC 를 재부팅해도 저절로 8443 을 잡지 않는다.
    - 호스트 Caddy(릴리스 B): 관리자 창에서 install-caddy-host.ps1 -Install → -Cutover(-ProjectName wr-verify)로 이 스택을
      host 모드로 바꾸면 8443/8080 은 Windows 서비스 wr-caddy(caddy.exe)가, Docker Caddy 는 127.0.0.1:18443/18080 이 쓴다.
      이 스크립트는 그 상태를 알아보고(설치 기록·서비스·환경 파일의 WR_CADDY_*_BIND) 그대로 점검·기동한다. 설치·전환·롤백은
      하지 않는다(관리자 작업은 install-caddy-host.ps1 의 몫). 세 가지가 서로 맞지 않으면 무엇이 다른지 보여 주고 멈춘다.

.PARAMETER Action
    up         스택을 켠다(이미지 확인 → 환경 파일 → 포트 점검 → compose up → 헬스 대기 → 감사 계정 비밀번호 동기화).
    down       컨테이너·네트워크를 내린다. 볼륨(DB 등)은 남는다 — 다음 up 에서 이어진다.
    status     컨테이너, 주소별 응답, CA 신뢰 여부를 보여 준다. 스택이 꺼져 있어도 실행된다.
    purge      down + wr-verify_* 볼륨 삭제(DB 초기화). 공유 Caddy CA 볼륨은 external 이라 지워지지 않는다.
    seed-admin 첫 관리자 계정 생성(대화형: 기관·로그인 ID·비밀번호 입력). up 뒤 최초 1회.
    accept     호스트 Caddy 수용 시험(host 모드에서만). 루프백(127.0.0.1)과 이 PC 의 LAN 주소 두 출발지에서 잘못된 로그인을
               보내 ① 감사 로그 IP 가 출발지 그대로 서로 다르게 남는지 ② 로그인 제한(분당 5회)이 출발지별 버킷인지
               ③ 8 KiB 헤더가 통과하는지 확인한다. LAN 주소는 화면에만 출력하고 파일에 쓰지 않는다.

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
    pwsh -File scripts/verify-stack.ps1 accept
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'down', 'status', 'purge', 'seed-admin', 'accept')]
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
$AppPort       = 13001   # 앱 루프백 게시(127.0.0.1:<번호>) — 이 PC의 Tier-3 개발 서버가 3001 을 쓰므로 비켜 둔다
$ShellOverrideKeys = @('WR_APP_PORT', 'WR_CADDY_HTTPS_BIND', 'WR_CADDY_HTTP_BIND', 'WR_DOMAIN')
# 호스트 Caddy(install-caddy-host.ps1)가 남기는 기록과 host 모드의 Docker Caddy 게시 주소 — 읽기만 한다.
$HostCaddyRoot  = 'C:\ProgramData\wr-caddy'
$HostStateFile  = Join-Path $HostCaddyRoot 'state\install.json'
$HostJournal    = Join-Path $HostCaddyRoot 'state\host-mode.json'
$HostCaddyExe   = Join-Path $HostCaddyRoot 'bin\caddy.exe'
$HostHttpsBind  = '127.0.0.1:18443'
$HostHttpBind   = '127.0.0.1:18080'
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
# 통계분석 워크벤치는 기본으로 켠다 — 서버가 꺼 두면(compose 기본값 false) 설치본에 통계분석 버튼이 뜨지 않는다.
STATS_WORKBENCH_ENABLED=true
# 영상 분석은 운영 기본값(꺼짐)을 따른다. 시험이 필요하면 주석을 풀고 up 을 다시 실행한다.
#VIDEO_ANALYSIS_ENABLED=true
# 앱 루프백 게시 포트(127.0.0.1:<번호>). 운영 기본 3001 은 이 PC의 개발 서버와 겹친다(옛 패키지는 이 값을 무시).
WR_APP_PORT=$AppPort
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
    # 이 키가 생기기 전에 만든 환경 파일은 보충한다 — 없으면 새 패키지가 기본 3001 에 게시해 개발 서버와 충돌한다.
    $cur = Get-Content $EnvFile -Raw
    if ($cur -notmatch '(?m)^WR_APP_PORT=') {
        Write-Utf8NoBom $EnvFile ($cur.TrimEnd() + "`nWR_APP_PORT=$AppPort`n")
        Write-Ok "환경 파일에 WR_APP_PORT=$AppPort 보충 (개발 서버 3001 과 충돌 방지)"
    }
}

# 시험 환경 파일의 앱 게시 포트(키가 없거나 비면 compose 기본값 3001).
function Get-AppPort {
    $v = Get-EnvValue 'WR_APP_PORT'
    if ($v) { return [int]$v }
    return 3001
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

# 호스트 포트를 실제로 쥔 컨테이너 목록(이름·compose 프로젝트·서비스·HostIp·HostPort).
# docker ps 의 publish 필터는 쓰지 않는다 — 호스트/컨테이너 포트 중 어느 쪽에 걸리는지 문서가 일관되지 않다
# (이 PC Docker 29.7.2 실측은 호스트 포트, Docker 문서 예시는 컨테이너 포트로 읽힘). 실제 매핑을 읽으면 버전과 무관하다.
function Get-PortOwners {
    $ids = @(docker ps -q 2>$null | Where-Object { $_ })
    if ($ids.Count -eq 0) { return @() }
    $owners = foreach ($c in (docker inspect @ids 2>$null | Out-String | ConvertFrom-Json)) {
        $labels = $c.Config.Labels
        $project = if ($labels -and $labels.PSObject.Properties['com.docker.compose.project']) { $labels.'com.docker.compose.project' } else { '' }
        $service = if ($labels -and $labels.PSObject.Properties['com.docker.compose.service']) { $labels.'com.docker.compose.service' } else { '' }
        if (-not $c.NetworkSettings.Ports) { continue }
        foreach ($prop in $c.NetworkSettings.Ports.PSObject.Properties) {
            foreach ($b in @($prop.Value)) {
                if ($null -eq $b) { continue }
                [pscustomobject]@{ Name = $c.Name.TrimStart('/'); Project = $project; Service = $service; HostIp = $b.HostIp; HostPort = [int]$b.HostPort }
            }
        }
    }
    return @($owners)
}

# 호스트 Caddy 상태(읽기 전용). Host = 이 스택(wr-verify)이 host 모드로 맞게 전환돼 있음. Problems = 세 출처가 어긋난 내용.
#   ① 설치 기록 state\install.json(mode·project) + 전환 기록 host-mode.json(정상 host 모드에서는 'applied'가 정상 —
#      install-caddy-host 는 전환이 끝난 뒤에도 기록을 열어 두고 -Status 도 그 값을 요구한다)
#   ② Windows 서비스 wr-caddy(우리 caddy.exe 인지, 실행 중인지)  ③ 시험 환경 파일의 WR_CADDY_HTTPS_BIND / WR_CADDY_HTTP_BIND
function Get-HostCaddyMode {
    $problems = @()
    $state = $null
    $journal = $null
    if (Test-Path $HostStateFile) { try { $state = Get-Content $HostStateFile -Raw | ConvertFrom-Json } catch { $problems += "$HostStateFile 을 읽지 못했습니다." } }
    if (Test-Path $HostJournal) { try { $journal = Get-Content $HostJournal -Raw | ConvertFrom-Json } catch { $problems += "$HostJournal 을 읽지 못했습니다." } }
    $svc = Get-CimInstance Win32_Service -Filter "Name='wr-caddy'" -ErrorAction SilentlyContinue
    $svcOurs = [bool]($svc -and $svc.PathName -like "$HostCaddyExe *")
    $svcPid = if ($svcOurs -and $svc.State -eq 'Running') { [int]$svc.ProcessId } else { 0 }
    $mode = if ($state) { [string]$state.mode } else { '' }
    $project = if ($state) { [string]$state.project } else { '' }
    $mine = ($project -eq $ProjectName)
    $journalApplied = [bool]($journal -and [string]$journal.status -eq 'applied')
    $envHttps = if (Test-Path $EnvFile) { Get-EnvValue 'WR_CADDY_HTTPS_BIND' } else { $null }
    $envHttp = if (Test-Path $EnvFile) { Get-EnvValue 'WR_CADDY_HTTP_BIND' } else { $null }
    $envHost = ($envHttps -eq $HostHttpsBind -and $envHttp -eq $HostHttpBind)
    $envAnyHost = ($envHttps -eq $HostHttpsBind -or $envHttp -eq $HostHttpBind)
    $isHost = $false
    if ($mine -and $mode -eq 'host') {
        if (-not $envHost) { $problems += "설치 기록은 host 모드인데 환경 파일의 WR_CADDY_HTTPS_BIND / WR_CADDY_HTTP_BIND 가 $HostHttpsBind / $HostHttpBind 이 아닙니다." }
        if (-not $journalApplied) { $problems += "설치 기록은 host 모드인데 $HostJournal 이 'applied' 가 아닙니다." }
        if ($svcPid -eq 0) { $problems += 'host 모드인데 wr-caddy 서비스(우리 caddy.exe)가 실행 중이 아닙니다.' }
        $isHost = ($problems.Count -eq 0)
    } else {
        if ($envAnyHost) { $problems += "환경 파일에 host 모드 값($HostHttpsBind / $HostHttpBind)이 있는데 설치 기록은 mode='$mode', project='$project' 입니다." }
        if ($mine -and $journalApplied) { $problems += "전환이 중간에 끝났습니다($HostJournal 'applied', mode='$mode')." }
    }
    return [pscustomobject]@{ Host = $isHost; Problems = $problems; Mode = $mode; Project = $project; ServicePid = $svcPid; ServiceInstalled = [bool]$svc }
}

function Stop-OnHostCaddyProblems($Hc) {
    if ($Hc.Problems.Count -eq 0) { return }
    $Hc.Problems | ForEach-Object { Write-Fail $_ }
    Stop-WithError '호스트 Caddy 상태가 서로 맞지 않습니다. 관리자 창에서 install-caddy-host.ps1 -Status -ProjectName wr-verify -EnvFile <이 환경 파일> 로 확인하고, 필요하면 -Rollback 하세요.'
}

function Get-Listener([int]$Port) {
    $l = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $l) { return $null }
    $p = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Pid = [int]$l.OwningProcess; Name = $(if ($p) { $p.ProcessName } else { "pid $($l.OwningProcess)" }) }
}

# 이 프로젝트 컨테이너가 쥔 포트는 통과(재실행). 다른 컨테이너·프로세스가 쥐었으면 멈춘다.
function Assert-PortForThisStack([int]$Port, [object[]]$Owners) {
    $here = @($Owners | Where-Object { $_.HostPort -eq $Port })
    $others = @($here | Where-Object { $_.Project -ne $ProjectName })
    if ($others.Count -gt 0) {
        Stop-WithError ":$Port 를 다른 컨테이너가 쓰고 있습니다: $(($others | ForEach-Object Name | Sort-Object -Unique) -join ', ')`n   이 스크립트는 wr-verify 프로젝트 외의 컨테이너를 건드리지 않습니다. 직접 정리한 뒤 다시 실행하세요."
    }
    if ($here.Count -eq 0) {
        $l = Get-Listener $Port
        if ($l) {
            $svc = Get-CimInstance Win32_Service -Filter "Name='wr-caddy'" -ErrorAction SilentlyContinue
            if ($svc -and [int]$svc.ProcessId -eq $l.Pid) {
                $who = if (Test-Path $HostStateFile) { $s = Get-Content $HostStateFile -Raw | ConvertFrom-Json; "프로젝트 '$($s.project)', mode '$($s.mode)'" } else { '설치 기록 없음' }
                Stop-WithError ":$Port 를 호스트 Caddy 서비스 wr-caddy($who)가 쓰고 있습니다. 이 스택은 host 모드가 아닙니다 — 관리자 창에서 install-caddy-host.ps1 -Rollback 으로 되돌리거나, 이 스택을 host 모드로 전환하세요."
            }
            Stop-WithError ":$Port 를 프로세스가 쓰고 있습니다: $($l.Name) (pid $($l.Pid))"
        }
    }
}

function Assert-PortsFree($Hc) {
    $owners = @(Get-PortOwners)
    if ($Hc.Host) {
        # host 모드: 8443/8080 은 wr-caddy 프로세스 하나만, 어떤 컨테이너도 게시하지 않는다. Docker Caddy 는 루프백 대체 포트에.
        foreach ($port in $HttpsPort, $HttpPort) {
            $pub = @($owners | Where-Object { $_.HostPort -eq $port })
            if ($pub.Count -gt 0) { Stop-WithError "host 모드인데 컨테이너가 :$port 를 게시합니다: $(($pub | ForEach-Object Name | Sort-Object -Unique) -join ', ')" }
            $l = Get-Listener $port
            if (-not $l -or $l.Pid -ne $Hc.ServicePid) { Stop-WithError "host 모드인데 :$port 를 wr-caddy 가 아닌 $(if ($l) { "$($l.Name) (pid $($l.Pid))" } else { '아무도' }) 쓰고 있습니다." }
        }
        foreach ($bind in $HostHttpsBind, $HostHttpBind) { Assert-PortForThisStack ([int]($bind -split ':')[-1]) $owners }
    } else {
        foreach ($port in $HttpsPort, $HttpPort) { Assert-PortForThisStack $port $owners }
    }
    Assert-PortForThisStack (Get-AppPort) $owners
}

# 해석된 compose 설정의 caddy 게시: host 모드면 127.0.0.1:18443/18080, docker 모드면 8443/8080.
function Assert-CaddyPublish($Hc) {
    $json = (Invoke-Compose @('config', '--format', 'json')) -join "`n"
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'docker compose config --format json 실패' }
    $caddy = ($json | ConvertFrom-Json).services.caddy
    $ports = @(if ($caddy.PSObject.Properties['ports']) { $caddy.ports })
    $have = @(@($ports | Where-Object { $null -ne $_ } | ForEach-Object {
        $ip = if ($_.PSObject.Properties['host_ip']) { $_.host_ip } else { '' }
        "$ip|$($_.published)|$($_.target)"
    }) | Sort-Object)
    $want = if ($Hc.Host) { @("127.0.0.1|18080|80", "127.0.0.1|18443|443") } else { @("|${HttpPort}|80", "|${HttpsPort}|443") }
    if (($have -join ',') -ne (($want | Sort-Object) -join ',')) { Stop-WithError "caddy 게시가 예상과 다릅니다: $($have -join ', ') (예상: $($want -join ', '))" }
    return $have
}

# 셸 환경변수는 --env-file 보다 우선한다 — 남아 있으면 시험 구성이 환경 파일과 달라진다.
function Assert-NoShellOverride {
    $set = @($ShellOverrideKeys | Where-Object { Test-Path "env:$_" })
    if ($set.Count -gt 0) {
        Stop-WithError "이 셸에 $($set -join ', ') 가 설정돼 있어 환경 파일 값을 덮어씁니다. Remove-Item env:<이름> 로 지우거나 새 창에서 실행하세요."
    }
}

# 해석된 compose 설정에서 app 게시가 127.0.0.1 에만, 환경 파일의 포트로 있는지(게시가 없는 옛 패키지는 통과). 게시 개수를 돌려준다.
function Assert-AppLoopbackOnly {
    $json = (Invoke-Compose @('config', '--format', 'json')) -join "`n"
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'docker compose config --format json 실패' }
    $app = ($json | ConvertFrom-Json).services.app
    $ports = @(if ($app.PSObject.Properties['ports']) { $app.ports | Where-Object { $null -ne $_ } })
    $want = Get-AppPort
    foreach ($p in $ports) {
        $hostIp = if ($p.PSObject.Properties['host_ip']) { $p.host_ip } else { '' }
        if ($hostIp -ne '127.0.0.1') { Stop-WithError "app 이 127.0.0.1 이 아닌 주소('$hostIp')에 게시됩니다(published=$($p.published)). 패키지의 docker-compose.prod.yml 을 확인하세요." }
        if ("$($p.published)" -ne "$want") { Stop-WithError "app 게시 포트($($p.published))가 환경 파일의 WR_APP_PORT($want)와 다릅니다." }
    }
    return $ports.Count
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
# host 모드에서는 8443 이 호스트 Caddy(caddy.exe)라 Docker caddy 재시작은 소용없다 — 안내만 한다.
function Wait-Https([int]$TimeoutSec = 120, [bool]$HostMode = $false) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $restarted = $false
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        $p = Invoke-Probe '/health'
        if ($p.Code -eq 200) { return $true }
        if ($HostMode -and $p.Error -match 'NotTimeValid') {
            Write-Warn '호스트 Caddy(wr-caddy)의 인증서가 유효하지 않습니다. 관리자 창에서 Restart-Service wr-caddy 후 install-caddy-host.ps1 -Status 로 확인하세요.'
            return $false
        }
        if (-not $HostMode -and -not $restarted -and $p.Error -match 'NotTimeValid') {
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
    Assert-NoShellOverride
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
    $appPublished = Assert-AppLoopbackOnly
    if ($appPublished -gt 0) { Write-Ok "app 게시: 127.0.0.1:$(Get-AppPort) 만 (LAN 에서는 닿지 않음)" } else { Write-Ok 'app 게시 없음 (루프백 게시 이전 패키지)' }
    $hc = Get-HostCaddyMode
    Stop-OnHostCaddyProblems $hc
    $caddyPub = Assert-CaddyPublish $hc
    if ($hc.Host) { Write-Ok "Caddy 모드: host — 8443/8080 = 호스트 서비스 wr-caddy, Docker Caddy 게시 $(($caddyPub | ForEach-Object { $p = $_ -split '\|'; "$($p[0]):$($p[1])->$($p[2])" }) -join ', ')" }
    else { Write-Ok "Caddy 모드: docker — Docker Caddy 가 :$HttpsPort / :$HttpPort" }

    Write-Step '4/7 포트 · 호스트 · CA'
    Assert-PortsFree $hc
    if ($hc.Host) { Write-Ok ":$HttpsPort / :$HttpPort = wr-caddy (pid $($hc.ServicePid)), :18443 / :18080 / :$(Get-AppPort) 사용 가능" }
    else { Write-Ok ":$HttpsPort / :$HttpPort / :$(Get-AppPort) 사용 가능" }
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
    [void](Wait-Https 120 $hc.Host)
    $reachable = Show-Endpoints
    if ($FreshCa) { Export-FreshRoot }

    Write-Host ''
    if ($reachable) {
        Write-Host '검증 스택 준비 완료' -ForegroundColor Green
        Write-Host "  접속:        $BaseUrl   (설치본의 기본 주소 — WR_INTRANET_URL 설정 불필요)"
        Write-Host '  첫 관리자:   pwsh -File scripts/verify-stack.ps1 seed-admin   (최초 1회)'
        Write-Host '  상태/종료:   ... status / down / purge -Force'
        if ($hc.Host) { Write-Host '  수용 시험:   pwsh -File scripts/verify-stack.ps1 accept   (호스트 Caddy: 실제 IP·로그인 제한 버킷·헤더 크기)' }
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
    Write-HostModeNotice
}

# host 모드에서 스택을 내리면 wr-caddy 는 계속 8443 을 쥐고 502 를 낸다 — 멈추지 않고 알려만 준다.
function Write-HostModeNotice {
    $hc = Get-HostCaddyMode
    if ($hc.Host -or ($hc.Project -eq $ProjectName -and $hc.Mode -eq 'host')) {
        Write-Warn '이 스택은 호스트 Caddy(host 모드)입니다. wr-caddy 는 계속 8443/8080 을 쥐고, 스택이 꺼진 동안 502 를 냅니다.'
        Write-Host '   Docker Caddy 로 되돌리려면 관리자 창에서: install-caddy-host.ps1 -Rollback -ProjectName wr-verify -EnvFile <이 환경 파일> -ComposeDir <패키지> -ExtraComposeFile <override>'
    }
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
    Write-HostModeNotice
}

function Invoke-Status {
    Assert-Docker
    Write-Step "컨테이너 (프로젝트 $ProjectName)"
    $own = @(Get-OwnContainers)
    if ($own.Count -eq 0) { Write-Host '   실행 중인 컨테이너 없음' } else { docker ps --filter "label=com.docker.compose.project=$ProjectName" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' }
    $vols = @(docker volume ls --format '{{.Name}}' | Where-Object { $_ -like "${ProjectName}_*" })
    Write-Host "   볼륨: $(if ($vols.Count) { $vols -join ', ' } else { '없음' })"
    Write-Host "   환경 파일: $(if (Test-Path $EnvFile) { $EnvFile } else { '없음(아직 up 하지 않음)' })"
    $hc = Get-HostCaddyMode
    if ($hc.Host) { Write-Ok "Caddy 모드: host — 8443/8080 = 호스트 서비스 wr-caddy (pid $($hc.ServicePid)), Docker Caddy 는 $HostHttpsBind / $HostHttpBind" }
    elseif ($hc.Problems.Count -gt 0) { $hc.Problems | ForEach-Object { Write-Warn $_ } }
    else { Write-Host "   Caddy 모드: docker$(if ($hc.ServiceInstalled) { " (wr-caddy 서비스는 있음: 프로젝트 '$($hc.Project)', mode '$($hc.Mode)')" })" }
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

# ── 수용 시험 (호스트 Caddy) ──────────────────────────────────────────────────
# 기본 게이트웨이가 있는 어댑터의 IPv4 — 이 주소로 접속하면 출발지도 이 주소가 된다.
function Get-LanIPv4 {
    $cfg = Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    if (-not $cfg) { return $null }
    return [string]($cfg.IPv4Address | Select-Object -First 1).IPAddress
}

# 잘못된 로그인 1회. 본문은 파일로 넘긴다(인자 속 JSON 따옴표 문제 회피). 출발지 = --resolve 로 정한 주소.
function Send-BadLogin([string]$Source, [string]$Agent, [int]$Port = $HttpsPort) {
    return (curl.exe -sk --max-time 10 --resolve "${Domain}:${Port}:$Source" -A $Agent -H 'Content-Type: application/json' `
        --data-binary "@$script:AcceptBody" "https://${Domain}:${Port}/api/auth/login" -o NUL -w '%{http_code}')
}

function Send-PaddedHeader([int]$KiB, [int]$Port) {
    [System.IO.File]::WriteAllText($script:AcceptHeader, "X-Accept-Pad: $('a' * ($KiB * 1024))`r`n")
    return (curl.exe -sk --max-time 10 --resolve "${Domain}:${Port}:127.0.0.1" -H "@$script:AcceptHeader" "https://${Domain}:${Port}/api/config/public" -o NUL -w '%{http_code}')
}

function Invoke-Accept {
    Assert-Docker
    if (-not (Test-Path $EnvFile)) { Stop-WithError '먼저 up 으로 스택을 켜세요.' }
    Assert-NoShellOverride
    $pkg = Resolve-PackageDir
    Write-OverrideFile
    $script:ComposeBase = Get-ComposeBase $pkg
    $hc = Get-HostCaddyMode
    Stop-OnHostCaddyProblems $hc
    if (-not $hc.Host) { Stop-WithError '이 스택은 host 모드가 아닙니다. 관리자 창에서 install-caddy-host.ps1 -Install … -ProjectName wr-verify 뒤 -Cutover 로 전환한 다음 실행하세요.' }
    if (@(Get-OwnContainers).Count -eq 0) { Stop-WithError '스택이 꺼져 있습니다. 먼저 up 하세요.' }
    $lan = Get-LanIPv4
    if (-not $lan) { Stop-WithError '기본 게이트웨이가 있는 IPv4 어댑터를 찾지 못했습니다(LAN 출발지가 필요합니다).' }
    Write-Ok "출발지: 루프백 127.0.0.1, LAN $lan (이 주소는 화면에만 출력하고 파일에 쓰지 않습니다)"
    $script:AcceptBody = Join-Path $WorkDir 'accept-login.json'
    $script:AcceptHeader = Join-Path $WorkDir 'accept-header.txt'
    Write-Utf8NoBom $script:AcceptBody '{"loginId":"verify-accept-no-such-user","password":"wrong-password"}'
    $tag = 'wr-accept-' + (Get-Date -Format 'yyyyMMddHHmmss')
    $results = [ordered]@{}
    try {
        Write-Step '1/3 감사 로그 IP 가 출발지 그대로, 서로 다르게 남는가'
        $codes = @{ loopback = (Send-BadLogin '127.0.0.1' "$tag-loopback"); lan = (Send-BadLogin $lan "$tag-lan") }
        if ($codes.Values -contains '429') {
            Write-Warn '로그인 제한(분당 5회)의 이전 창이 남아 있습니다 — 61초 기다린 뒤 한 번 다시 보냅니다.'
            Start-Sleep -Seconds 61
            $codes = @{ loopback = (Send-BadLogin '127.0.0.1' "$tag-loopback"); lan = (Send-BadLogin $lan "$tag-lan") }
        }
        $dockerCode = Send-BadLogin '127.0.0.1' "$tag-docker" 18443
        Write-Host "   응답: 루프백 $($codes.loopback), LAN $($codes.lan), Docker 경로(18443) $dockerCode"
        Start-Sleep -Seconds 2
        $rows = @(Invoke-Compose @('exec', '-T', 'postgres', 'psql', '-U', 'wr_user', '-d', 'wr_evaluation', '-At', '-c',
            "SELECT user_agent || '|' || coalesce(host(ip),'') FROM audit_logs WHERE user_agent LIKE '$tag-%'"))
        $ip = @{}
        foreach ($r in $rows) { $parts = "$r" -split '\|', 2; if ($parts.Count -eq 2) { $ip[$parts[0].Substring($tag.Length + 1)] = $parts[1] } }
        Write-Host "   기록: 루프백 → $($ip['loopback']), LAN → $($ip['lan']), Docker 경로 → $($ip['docker']) (참고: Docker Desktop 경유라 가려짐)"
        $results['출발지별 IP'] = ($ip['loopback'] -eq '127.0.0.1' -and $ip['lan'] -eq $lan -and $ip['loopback'] -ne $ip['lan'])

        Write-Step '2/3 로그인 제한(분당 5회)이 출발지별 버킷인가'
        $hit = $false
        for ($i = 1; $i -le 7; $i++) {
            $c = Send-BadLogin '127.0.0.1' "$tag-rl$i"
            if ($c -eq '429') { $hit = $true; Write-Host "   루프백 $i 번째 요청에서 429"; break }
        }
        $lanAfter = Send-BadLogin $lan "$tag-rl-lan"
        Write-Host "   루프백 버킷이 찬 직후 LAN: $lanAfter"
        $results['로그인 제한 버킷 분리'] = ($hit -and $lanAfter -eq '401')

        Write-Step '3/3 헤더 크기 (Caddy 2.11.6 부터 요청 헤더 상한)'
        $results['8 KiB 헤더 통과'] = ((Send-PaddedHeader 8 $HttpsPort) -eq '200')
        foreach ($k in 12, 16, 20, 32) {
            Write-Host ("   참고 {0,2} KiB: 호스트 Caddy(8443) {1} / Docker Caddy(18443) {2}" -f $k, (Send-PaddedHeader $k $HttpsPort), (Send-PaddedHeader $k 18443))
        }
        Write-Host '   (앱 자체도 Node 기본 상한 16 KiB 에서 431 을 낸다 — 호스트 Caddy 의 상한은 그보다 넉넉하다)'
    } finally {
        foreach ($f in $script:AcceptBody, $script:AcceptHeader) { if (Test-Path $f) { Remove-Item $f -Force } }
    }

    Write-Host ''
    $failed = 0
    foreach ($k in $results.Keys) {
        if ($results[$k]) { Write-Ok "PASS $k" } else { Write-Fail "FAIL $k"; $failed++ }
    }
    if ($failed -gt 0) { exit 1 }
    Write-Host '수용 시험 통과' -ForegroundColor Green
}

switch ($Action) {
    'up'         { Invoke-Up }
    'down'       { Invoke-Down }
    'status'     { Invoke-Status }
    'purge'      { Invoke-Purge }
    'seed-admin' { Invoke-SeedAdmin }
    'accept'     { Invoke-Accept }
}
