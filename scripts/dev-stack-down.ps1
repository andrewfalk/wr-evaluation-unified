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
      # 이 스택이 띄우는 건 항상 node.exe(서버/vite) 뿐 — PID만 보고 무조건 죽이면, 이 포트를 도커
      # 컨테이너(com.docker.backend.exe 등 포워딩 프로세스)가 쥐고 있을 때 Docker Desktop 전체가
      # 죽을 위험이 있다(실제로 이런 충돌을 겪음). node가 아니면 죽이지 않고 경고만 남긴다.
      $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq 'node') {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "  - :$port (pid $($c.OwningProcess), node) 종료" -ForegroundColor Yellow
      } else {
        $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
        Write-Host "  - :$port (pid $($c.OwningProcess), $name) 은 node가 아니라 건너뜀 — 도커 컨테이너일 수 있음, 수동 확인(예: docker ps --filter publish=$port)" -ForegroundColor Red
      }
    }
  } catch {
    Write-Host "  - :$port LISTEN 없음 (이미 종료)" -ForegroundColor DarkGray
  }
}

Write-Host "[dev-down] dev postgres 정지 (docker compose stop postgres)…" -ForegroundColor Cyan
Push-Location $root
try { docker compose stop postgres } finally { Pop-Location }

Write-Host "[dev-down] 완료." -ForegroundColor Green
