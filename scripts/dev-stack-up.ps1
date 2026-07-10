# dev-stack-up.ps1 — 영상 분석 dev 풀스택 한 번에 기동(dev 전용).
#
# 1) shared/contracts → shared/dist 빌드   (gitignore라 pull로 안 바뀜 — @contracts 갱신)
# 2) docker compose up -d postgres        (dev DB)
# 3) 네이티브 인트라넷 서버 :3001          (별도 창 — host venv 실추론, -SkipSharedBuild)
# 4) 웹 클라이언트 :3000                    (별도 창 — /api → :3001 프록시)
#
# 2)·3)은 각자 새 PowerShell 창에서 떠서 로그를 따로 볼 수 있고, 각 창에서 Ctrl+C로 끌 수 있다.
# 종료는 scripts/dev-stack-down.ps1.
#
# 사용: pwsh -File scripts/dev-stack-up.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# PATH 방어: 이 스크립트를 실행한 셸이 오래 떠 있어 Node 설치 이후로 PATH가 갱신 안 됐어도
# node/npm이 잡히도록 표준 설치 경로를 보강한다(이미 PATH에 있으면 중복 추가 안 함). 아래에서
# 새 창(server/web)을 Start-Process로 띄울 때 이 프로세스의 $env:Path를 그대로 물려받으므로,
# 여기서 한 번만 고치면 두 자식 창 모두에 적용된다.
$nodeDir = 'C:\Program Files\nodejs'
if ((Test-Path $nodeDir) -and (($env:Path -split ';') -notcontains $nodeDir)) {
  Write-Host "[dev-stack] PATH에 Node.js 없음 — 보강: $nodeDir" -ForegroundColor Yellow
  $env:Path = "$nodeDir;$env:Path"
}

# 공유 계약(shared → dist) 먼저 빌드. @contracts(shared/dist)는 gitignore라 pull로 갱신 안 되고
# 서버/웹 둘 다 import하므로 계약 변경 반영엔 선빌드가 필수. 두 창 띄우기 전에 동기 1회 빌드해
# 레이스(두 창이 동시에 shared/dist를 쓰는 것)를 막고, 서버 창엔 -SkipSharedBuild로 중복 빌드 생략.
Write-Host "[dev-stack] 1/4 공유 계약 빌드 (shared → dist)…" -ForegroundColor Cyan
node (Join-Path $root 'scripts/prebuild-shared.mjs')
if ($LASTEXITCODE -ne 0) { throw 'prebuild-shared 실패 — 공유 계약(shared/dist) 빌드 오류' }

Write-Host "[dev-stack] 2/4 postgres (docker compose up -d postgres)…" -ForegroundColor Cyan
docker compose up -d postgres
if ($LASTEXITCODE -ne 0) { throw "docker compose up -d postgres 실패 — Docker Desktop이 켜져 있는지 확인" }

Write-Host "[dev-stack] 3/4 네이티브 서버 :3001 (새 창)…" -ForegroundColor Cyan
$serverScript = Join-Path $PSScriptRoot 'dev-intranet-server.ps1'
Start-Process pwsh -ArgumentList @(
  '-NoExit', '-File', $serverScript, '-SkipSharedBuild'
) -WorkingDirectory $root

Write-Host "[dev-stack] 4/4 웹 클라 :3000 (새 창)…" -ForegroundColor Cyan
# 서버 창(-File)과 달리 이건 inline -Command라 파일 기반 PATH 방어 스니펫을 못 쓴다. 부모 프로세스의
# 고친 $env:Path가 Start-Process 자식에 항상 그대로 상속된다는 보장이 이 환경에서 깨지는 걸 실측
# 했으므로(서버 창은 되는데 이 창만 안 됨 — 원인 미상), 자식이 스스로 한 번 더 PATH를 보강하게 한다.
$webCommand = "if ((`$env:Path -split ';') -notcontains '$nodeDir') { `$env:Path = '$nodeDir;' + `$env:Path }; npm run dev"
Start-Process pwsh -ArgumentList @(
  '-NoExit', '-Command', $webCommand
) -WorkingDirectory $root

Write-Host ""
Write-Host "[dev-stack] 기동 트리거 완료. 새 창 2개(서버/웹)의 로그를 확인하세요." -ForegroundColor Green
Write-Host "  - 서버 헬스체크: http://localhost:3001/api/config/public  (videoAnalysisEnabled:true)" -ForegroundColor Green
Write-Host "  - 웹 접속:       http://localhost:3000" -ForegroundColor Green
Write-Host "  - GPU 티어:      dev 기본 VIDEO_POSE_TIER=auto (6.0-14) — body 클립이 rtmpose-l/cuda로 분석" -ForegroundColor Green
Write-Host "                   (기존 s와 동일 비교가 필요하면 .env에 VIDEO_POSE_TIER=standard)" -ForegroundColor Green
Write-Host "  - det 간격:      dev 기본 VIDEO_DET_INTERVAL_SEC=1 (6.0-15) — det 초당 1회+역산 박스 carry" -ForegroundColor Green
Write-Host "                   (기존과 동일 비교가 필요하면 .env에 VIDEO_DET_INTERVAL_SEC=0)" -ForegroundColor Green
Write-Host "  - 종료:          pwsh -File scripts/dev-stack-down.ps1" -ForegroundColor Green
