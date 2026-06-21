<#
.SYNOPSIS
    포즈 추정 가중치를 온라인 PC에서 1회 다운로드해 manifest에 sha256을 확정한다(6.0-9 PR-B).

.DESCRIPTION
    services/pose-inference/models/manifest.json의 각 모델 sourceUrl(zip)을 받아:
      1) zip 무결성 sha256(sourceArchiveSha256) 계산
      2) 압축 해제 → manifest의 file 이름과 일치하는 .onnx를 models 디렉터리에 배치
      3) 실제 실행 .onnx sha256(onnxSha256) 계산 — recipe analysisBundleVersion에 들어가는 값
      4) manifest.json에 sourceArchiveSha256/onnxSha256 기록 + weightsComplete=true
    이 단계가 끝나면 Docker 빌드(server/Dockerfile)가 models/*.onnx를 이미지에 굽고,
    에어갭 서버에서 docker run --network none으로 추론이 동작한다.

    가중치 .onnx 자체는 커밋 금지(.gitignore) — manifest의 해시만 버전관리한다(§8.11).

.PARAMETER ManifestPath
    manifest.json 경로. 기본 services/pose-inference/models/manifest.json.

.EXAMPLE
    .\scripts\fetch-pose-weights.ps1
#>
[CmdletBinding()]
param(
    [string]$ManifestPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "    OK  $m" -ForegroundColor Green }

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ManifestPath) {
    $ManifestPath = Join-Path $RepoRoot "services\pose-inference\models\manifest.json"
}
if (-not (Test-Path $ManifestPath)) { Write-Error "manifest not found: $ManifestPath"; exit 1 }
$ModelsDir = Split-Path $ManifestPath -Parent

# manifest는 BOM 없는 UTF-8 — .NET API로 명시적 읽기(PS5.1 한글 깨짐 방지).
$raw = [System.IO.File]::ReadAllText($ManifestPath, [System.Text.Encoding]::UTF8)
$manifest = $raw | ConvertFrom-Json

$allComplete = $true
foreach ($m in $manifest.models) {
    Write-Step "$($m.role): $($m.name)"
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wr-pose-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        $zipPath = Join-Path $tmp "weights.zip"
        Write-Host "    downloading $($m.sourceUrl)"
        Invoke-WebRequest -Uri $m.sourceUrl -OutFile $zipPath -UseBasicParsing

        $archSha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
        $m.sourceArchiveSha256 = $archSha
        Write-Ok "sourceArchiveSha256 $archSha"

        Expand-Archive -LiteralPath $zipPath -DestinationPath $tmp -Force
        # @()로 배열 강제(StrictMode: 단일 객체 .Count 오류 방지).
        $onnxAll = @(Get-ChildItem -Path $tmp -Recurse -Filter "*.onnx" -File)
        # manifest의 file 이름과 일치하는 .onnx 우선, 없으면 .onnx가 정확히 1개면 그걸 채택
        # (openmmlab zip은 내부 파일명이 end2end.onnx 등으로 다를 수 있음).
        $onnx = $onnxAll | Where-Object { $_.Name -eq $m.file } | Select-Object -First 1
        if (-not $onnx -and $onnxAll.Count -eq 1) { $onnx = $onnxAll[0] }
        if (-not $onnx) { Write-Error "no matching .onnx ($($m.file)) in archive (found: $($onnxAll.Count))"; exit 1 }

        $dest = Join-Path $ModelsDir $m.file
        Copy-Item $onnx.FullName $dest -Force
        $onnxSha = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
        $m.onnxSha256 = $onnxSha
        Write-Ok "onnxSha256 $onnxSha → models/$($m.file)"
    }
    finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
    if (-not $m.onnxSha256) { $allComplete = $false }
}

$manifest.weightsComplete = [bool]$allComplete

# UTF-8 (BOM 없음)으로 다시 쓴다.
$enc = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($ManifestPath, ($manifest | ConvertTo-Json -Depth 6), $enc)

Write-Host ""
Write-Host "manifest 갱신 완료: weightsComplete=$allComplete" -ForegroundColor Green
Write-Host "models/*.onnx 배치 완료 — 다음: docker build -f server/Dockerfile -t wr-app-server ." -ForegroundColor White
Write-Host "주의: *.onnx 는 커밋 금지(.gitignore). manifest 해시만 버전관리." -ForegroundColor Yellow
