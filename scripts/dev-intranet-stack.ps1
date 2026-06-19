# dev-intranet-stack.ps1 — 영상 분석 Tier-3 라이브 검증 스택 원커맨드 기동/종료(dev 전용).
#
# dev-intranet-server.ps1(네이티브 서버 :3001)을 감싸 docker postgres + 웹(:3000)까지
# 한 번에 띄운다. 웹 UI에서 영상 분석을 "실서버 모드"로 육안 검증할 때 사용.
# (smoke_d.ps1은 Python 추론 Tier-1만 검증 — UI 변경은 본 Tier-3로 확인해야 함.)
#
# 사전조건:
#   - docker 실행 중 / 루트 .env(DEPLOYMENT_MODE=intranet, VIDEO_ANALYSIS_ENABLED=true,
#     VIDEO_ANALYSIS_UPLOAD_DIR, POSTGRES_PASSWORD)
#   - services/pose-inference/.venv + 모델 캐시(smoke_d.ps1 참고)
#
# 사용:
#   pwsh -File scripts/dev-intranet-stack.ps1            # 기동(서버 :3001 + 웹 :3000)
#   pwsh -File scripts/dev-intranet-stack.ps1 -FixtureMode   # 실영상 없이 fixture 클립 허용
#   pwsh -File scripts/dev-intranet-stack.ps1 -Down         # 종료(스택만 — 운영 컨테이너 불침범)
#
# 종료 후에도 docker postgres(dev)만 멈추며, 운영 wr-prod-postgres-1 은 건드리지 않는다.
[CmdletBinding()]
param(
  [switch]$Down,
  [switch]$FixtureMode
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$serverOut = Join-Path $env:TEMP 'wr-server.out.log'
$serverErr = Join-Path $env:TEMP 'wr-server.err.log'
$webOut    = Join-Path $env:TEMP 'wr-web.out.log'
$webErr    = Join-Path $env:TEMP 'wr-web.err.log'

function Stop-PortListener([int]$Port) {
  try {
    $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $pids) {
      $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
      if ($proc) { Write-Host "  stop :$Port -> PID $p ($($proc.ProcessName))"; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    }
  } catch { Write-Host "  :$Port - 리스너 없음" }
}

function Wait-Http([string]$Url, [int]$TimeoutSec = 120) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    try { if ((Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch {}
    Start-Sleep -Seconds 3
  }
  return $false
}

if ($Down) {
  Write-Host "[stack] 종료 중…" -ForegroundColor Cyan
  Stop-PortListener 3001
  Stop-PortListener 3000
  docker compose stop postgres
  Write-Host "[stack] 종료 완료 (운영 wr-prod-postgres-1 은 유지)" -ForegroundColor Green
  return
}

# 1) dev postgres
Write-Host "[stack] 1/3 docker postgres 기동…" -ForegroundColor Cyan
docker compose up -d postgres | Out-Null
$pgReady = $false
for ($i = 0; $i -lt 30; $i++) {
  if (docker exec wr-evaluation-unified-postgres-1 pg_isready -U wr_user -d wr_evaluation 2>$null) { $pgReady = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $pgReady) { Write-Host "[FAIL] postgres 준비 안 됨" -ForegroundColor Red; exit 1 }
Write-Host "  postgres READY" -ForegroundColor Green

# 2) 네이티브 서버 :3001 (dev-intranet-server.ps1 재사용 — env 로직 중복 안 함)
Write-Host "[stack] 2/3 네이티브 서버 빌드+기동 :3001 (수십 초 소요)…" -ForegroundColor Cyan
if ($FixtureMode) { $env:VIDEO_ANALYSIS_FIXTURE_MODE = 'true'; Write-Host "  (fixture 모드: 실영상 없이 fixture 클립 허용)" -ForegroundColor Yellow }
Start-Process pwsh -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/dev-intranet-server.ps1' `
  -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -WindowStyle Hidden | Out-Null
if (-not (Wait-Http 'http://localhost:3001/api/config/public' 180)) {
  Write-Host "[FAIL] 서버 :3001 응답 없음 — 로그:" -ForegroundColor Red
  Get-Content $serverErr -Tail 25 -ErrorAction SilentlyContinue
  exit 1
}
$cfg = (Invoke-WebRequest -Uri 'http://localhost:3001/api/config/public' -UseBasicParsing).Content
Write-Host "  서버 UP — $cfg" -ForegroundColor Green

# 3) 웹 :3000 (/api -> :3001 프록시). npm 은 .cmd 라 cmd /c 로 기동.
Write-Host "[stack] 3/3 웹 dev :3000 기동…" -ForegroundColor Cyan
Start-Process cmd.exe -ArgumentList '/c','npm run dev' `
  -RedirectStandardOutput $webOut -RedirectStandardError $webErr -WindowStyle Hidden | Out-Null
if (-not (Wait-Http 'http://localhost:3000/' 60)) {
  Write-Host "[FAIL] 웹 :3000 응답 없음 — 로그:" -ForegroundColor Red
  Get-Content $webErr -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}
Write-Host "  웹 UP" -ForegroundColor Green

Write-Host ""
Write-Host "[stack] READY ✓" -ForegroundColor Green
Write-Host "  웹 UI:      http://localhost:3000" -ForegroundColor White
Write-Host "  서버 API:   http://localhost:3001" -ForegroundColor White
Write-Host "  로그:       $serverOut / $webOut" -ForegroundColor DarkGray
Write-Host "  종료:       pwsh -File scripts/dev-intranet-stack.ps1 -Down" -ForegroundColor DarkGray
