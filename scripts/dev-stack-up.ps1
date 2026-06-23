# dev-stack-up.ps1 — 영상 분석 dev 풀스택 한 번에 기동(dev 전용).
#
# 1) docker compose up -d postgres        (dev DB)
# 2) 네이티브 인트라넷 서버 :3001          (별도 창 — host venv 실추론)
# 3) 웹 클라이언트 :3000                    (별도 창 — /api → :3001 프록시)
#
# 2)·3)은 각자 새 PowerShell 창에서 떠서 로그를 따로 볼 수 있고, 각 창에서 Ctrl+C로 끌 수 있다.
# 종료는 scripts/dev-stack-down.ps1.
#
# 사용: pwsh -File scripts/dev-stack-up.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "[dev-stack] 1/3 postgres (docker compose up -d postgres)…" -ForegroundColor Cyan
docker compose up -d postgres
if ($LASTEXITCODE -ne 0) { throw "docker compose up -d postgres 실패 — Docker Desktop이 켜져 있는지 확인" }

Write-Host "[dev-stack] 2/3 네이티브 서버 :3001 (새 창)…" -ForegroundColor Cyan
$serverScript = Join-Path $PSScriptRoot 'dev-intranet-server.ps1'
Start-Process pwsh -ArgumentList @(
  '-NoExit', '-File', $serverScript
) -WorkingDirectory $root

Write-Host "[dev-stack] 3/3 웹 클라 :3000 (새 창)…" -ForegroundColor Cyan
Start-Process pwsh -ArgumentList @(
  '-NoExit', '-Command', 'npm run dev'
) -WorkingDirectory $root

Write-Host ""
Write-Host "[dev-stack] 기동 트리거 완료. 새 창 2개(서버/웹)의 로그를 확인하세요." -ForegroundColor Green
Write-Host "  - 서버 헬스체크: http://localhost:3001/api/config/public  (videoAnalysisEnabled:true)" -ForegroundColor Green
Write-Host "  - 웹 접속:       http://localhost:3000" -ForegroundColor Green
Write-Host "  - 종료:          pwsh -File scripts/dev-stack-down.ps1" -ForegroundColor Green
