# dev-intranet-server.ps1 — 6.0-7 업로드 스모크용 네이티브 인트라넷 서버 기동(dev 전용).
#
# 서버(server/)는 dotenv를 쓰지 않고 process.env만 읽으므로, 루트 .env를 읽어 셸 환경에 주입한 뒤
# 네이티브로 띄운다. 네이티브여야 config.video.python(host venv)으로 실제 추론이 돈다
# (docker app 컨테이너엔 venv가 없음 — 그게 M4 6.0-9 패키징 과제).
#
# 사전조건:
#   - docker compose up -d postgres   (DB; override가 5432를 host에 노출)
#   - services/pose-inference/.venv + rtmlib 모델 캐시(M2에서 설치됨)
#   - 루트 .env 에 secrets / DEPLOYMENT_MODE=intranet / VIDEO_ANALYSIS_ENABLED=true /
#     VIDEO_ANALYSIS_UPLOAD_DIR 존재
#
# 사용: pwsh -File scripts/dev-intranet-server.ps1
#       (서버는 :3001. 웹 클라는 별도 터미널에서 `npm run dev` → :3000, /api 프록시)
#       -SkipSharedBuild: 공유 계약(shared/dist) 재빌드 생략(dev-stack-up이 이미 빌드한 경우).
param([switch]$SkipSharedBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# PATH 방어: dev-stack-up.ps1이 이미 보강했으면 중복 없이 통과하고, 이 스크립트를 단독 기동
# (pwsh -File scripts/dev-intranet-server.ps1)했는데 그 셸의 PATH가 오래돼 Node가 안 잡히는
# 경우에도 npm run build/node dist/index.js가 실패하지 않도록 표준 설치 경로를 보강한다.
$nodeDir = 'C:\Program Files\nodejs'
if ((Test-Path $nodeDir) -and (($env:Path -split ';') -notcontains $nodeDir)) {
  Write-Host "[dev-intranet] PATH에 Node.js 없음 — 보강: $nodeDir" -ForegroundColor Yellow
  $env:Path = "$nodeDir;$env:Path"
}

# 1) 루트 .env 로드 → 현재 프로세스 환경에 주입(주석/빈 줄 무시).
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }
Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq '' -or $line.StartsWith('#')) { return }
  $idx = $line.IndexOf('=')
  if ($idx -lt 1) { return }
  $key = $line.Substring(0, $idx).Trim()
  $val = $line.Substring($idx + 1).Trim()
  Set-Item -Path "env:$key" -Value $val
}

# 2) 네이티브 서버 전용 파생 env(docker가 조립하던 것을 여기서 구성).
$pgPass = if ($env:POSTGRES_PASSWORD) { $env:POSTGRES_PASSWORD } else { 'changeme_for_dev_only' }
if (-not $env:DATABASE_URL)       { $env:DATABASE_URL       = "postgres://wr_user:$pgPass@localhost:5432/wr_evaluation" }
if (-not $env:AUDIT_DATABASE_URL) { $env:AUDIT_DATABASE_URL = "postgres://wr_user:$pgPass@localhost:5432/wr_evaluation" }
if (-not $env:PORT)               { $env:PORT = '3001' }
if (-not $env:NODE_ENV)           { $env:NODE_ENV = 'development' }
# 운영 docker 컨테이너와 동일하게 UTC로 고정. 미설정 시 호스트 로컬(KST)로 돌아
# pg DATE→JS Date의 toISOString() 변환이 하루 밀려 patient 식별(생년월일) 비교가 깨진다.
if (-not $env:TZ)                 { $env:TZ = 'UTC' }
# pose 티어(6.0-14): dev PC(RTX 4060)는 auto 기본 — body 클립이 l/cuda 2단 검증 통과 시 rtmpose-l로
# 분석된다(검증 실패·GPU 없음이면 s로 자동 강등 — CPU-l 경로 없음이라 무해). .env의 값이 우선.
# 기존과 동일 비교가 필요하면 .env에 VIDEO_POSE_TIER=standard. 허용값 standard|auto(그 외 기동 실패).
if (-not $env:VIDEO_POSE_TIER)    { $env:VIDEO_POSE_TIER = 'auto' }
# det 빈도 감소(6.0-15): dev 기본 1초 — det는 초당 1회, 사이 샘플 프레임은 pose 역산 박스 재사용
# (A/B 검증: 스왑 0·target 매핑 동일·손목 wholebody CPU 약 2배, docs/VIDEO_DET_INTERVAL_6015.md).
# 기존과 동일 비교가 필요하면 .env에 VIDEO_DET_INTERVAL_SEC=0. 허용 범위 [0,1.0](그 외 기동 실패).
if (-not $env:VIDEO_DET_INTERVAL_SEC) { $env:VIDEO_DET_INTERVAL_SEC = '1' }

# 2.5) 포트 사전 점검. 과거 이 포트를 도커 app 컨테이너가 선점한 채로 이 스크립트를 띄우면
# node가 EADDRINUSE로 즉시 죽는데(-NoExit라 창은 안 닫힘) 별다른 에러 표시 없이 방치되기 쉬웠다
# (실제로 겪음 — 창은 몇 시간째 열려있는데 서버는 처음부터 안 뜬 상태). 기동 전에 명시 점검한다.
$portNum = [int]$env:PORT
$existing = Get-NetTCPConnection -LocalPort $portNum -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $containerName = $null
  try { $containerName = (docker ps --filter "publish=$portNum" --format '{{.Names}}' 2>$null | Select-Object -First 1) } catch {}
  if ($containerName) {
    # 흔한 케이스: 이전에 남아있던 도커 app 컨테이너가 같은 포트를 씀 — 자동으로 내리고 재확인(포트는 그대로).
    Write-Host "[dev-intranet] :$portNum 을 도커 컨테이너 '$containerName' 이 이미 쓰고 있음 — 중지 후 재확인…" -ForegroundColor Yellow
    docker stop $containerName | Out-Null
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort $portNum -State Listen -ErrorAction SilentlyContinue) {
      throw "컨테이너 '$containerName' 중지 후에도 :$portNum 이 여전히 사용 중 — 수동 확인 필요."
    }
    Write-Host "[dev-intranet] :$portNum 반납 확인." -ForegroundColor Green
  } else {
    $ownerPid = ($existing | Select-Object -First 1).OwningProcess
    $procName = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName
    if (-not $procName) { $procName = 'unknown' }
    throw "포트 :$portNum 이 이미 PID $ownerPid ($procName) 에서 사용 중입니다. 어떤 프로세스가 응답할지 불명확한 채로 " +
      "기동하지 않도록 중단합니다 — 수동으로 확인 후(Stop-Process -Id $ownerPid) 재시도하세요."
  }
}

# 3) 업로드 디렉터리 보장(서버도 tmp/를 mkdir하지만 명시 생성).
if (-not $env:VIDEO_ANALYSIS_UPLOAD_DIR) { throw 'VIDEO_ANALYSIS_UPLOAD_DIR not set in .env' }
New-Item -ItemType Directory -Force -Path $env:VIDEO_ANALYSIS_UPLOAD_DIR | Out-Null

Write-Host "[dev-intranet] DEPLOYMENT_MODE=$($env:DEPLOYMENT_MODE) VIDEO_ANALYSIS_ENABLED=$($env:VIDEO_ANALYSIS_ENABLED)"
Write-Host "[dev-intranet] VIDEO_POSE_TIER=$($env:VIDEO_POSE_TIER) (auto=GPU 검증 시 body를 rtmpose-l로 — 사용 모델은 검토 recipe의 modelVersion으로 확인)"
Write-Host "[dev-intranet] VIDEO_DET_INTERVAL_SEC=$($env:VIDEO_DET_INTERVAL_SEC) (det 빈도 감소 6.0-15 — 0이면 매 프레임 det)"
Write-Host "[dev-intranet] uploadDir=$($env:VIDEO_ANALYSIS_UPLOAD_DIR)"
Write-Host "[dev-intranet] DB=$($env:DATABASE_URL)"
Write-Host "[dev-intranet] building + starting native server on :$($env:PORT) (auto-migrate on boot)…"

# 3.5) 공유 계약(shared → dist) 재빌드. @contracts(shared/dist)는 gitignore라 pull로 안 바뀌고
#      server 빌드·런타임이 이걸 물기 때문에, 계약 변경이 반영되려면 먼저 빌드해야 한다.
#      dev-stack-up 경유 시엔 이미 빌드됐으므로 -SkipSharedBuild로 생략.
if (-not $SkipSharedBuild) {
  Write-Host "[dev-intranet] building shared contracts (shared → dist)…"
  node (Join-Path $root 'scripts/prebuild-shared.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'prebuild-shared 실패 — 공유 계약(shared/dist) 빌드 오류' }
}

# 4) 네이티브 서버 기동: build(tsc) → node dist/index.js.
#    tsx watch는 tsconfig paths로 @wr/contracts를 .d.cts(타입)로 잘못 해석해 런타임 크래시하므로,
#    도커/운영과 동일하게 컴파일 후 실행한다(tsc는 import 스펙을 보존 → node가 패키지 main(.cjs) 해석).
#    부팅 시 마이그레이션 자동 적용(0017/0018 포함).
Set-Location (Join-Path $root 'server')
npm run build
node dist/index.js
