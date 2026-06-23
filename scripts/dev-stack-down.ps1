# dev-stack-down.ps1 — dev-stack-up.ps1로 띄운 풀스택 종료(dev 전용).
#
# 1) :3001/:3000 LISTEN 중인 node 프로세스 종료
# 2) dev DB(docker compose의 postgres만) 정지 — 운영 컨테이너는 건드리지 않음
#
# 사용: pwsh -File scripts/dev-stack-down.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "[dev-down] :3001/:3000 LISTEN 프로세스 종료…" -ForegroundColor Cyan
foreach ($port in 3001, 3000) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    foreach ($c in $conns) {
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-Host "  - :$port (pid $($c.OwningProcess)) 종료" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "  - :$port LISTEN 없음 (이미 종료)" -ForegroundColor DarkGray
  }
}

Write-Host "[dev-down] dev postgres 정지 (docker compose stop postgres)…" -ForegroundColor Cyan
Push-Location $root
try { docker compose stop postgres } finally { Pop-Location }

Write-Host "[dev-down] 완료." -ForegroundColor Green
