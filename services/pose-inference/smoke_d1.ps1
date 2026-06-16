<#
  PR D1 integration smoke (Tier 1) -- standalone Python inference check.
  Runs the real pipeline (venv / ONNX / rtmlib / model): video -> keypoints -> intrinsic
  clip_features, validates both against the JSON Schema contract, and auto-checks that every
  posture_ratio value is within 0..1. No server / DB required.

  Usage:
    powershell -ExecutionPolicy Bypass -File smoke_d1.ps1
    powershell -ExecutionPolicy Bypass -File smoke_d1.ps1 -Clip my.mp4 -Fps 5 -MaxFrames 40
  Exit code: 0 = pass, 1 = fail (inference / schema / ratio range).
  (ASCII-only on purpose: Windows PowerShell 5.1 mis-parses non-ASCII without a BOM.)
#>
[CmdletBinding()]
param(
  [string]$Clip = "people-detection.mp4",
  [double]$Fps = 5,
  [int]$MaxFrames = 0,
  [string]$OutDir = "out"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$py = Join-Path $here ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  Write-Host "[FAIL] venv python not found: $py" -ForegroundColor Red
  Write-Host "       run first: python -m venv .venv; .venv\Scripts\python -m pip install -r requirements.txt" -ForegroundColor Yellow
  exit 1
}

$clipPath = Join-Path $here "samples\$Clip"
if (-not (Test-Path $clipPath)) {
  Write-Host "[FAIL] fixture video not found: $clipPath" -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path (Join-Path $here $OutDir) | Out-Null
$kp = Join-Path $here "$OutDir\keypoints.json"
$cf = Join-Path $here "$OutDir\clip_features.json"

function Invoke-Step($label, [string[]]$pyArgs) {
  Write-Host "-> $label" -ForegroundColor Cyan
  & $py @pyArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] $label (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
}

$maxArgs = @()
if ($MaxFrames -gt 0) { $maxArgs = @("--max-frames", "$MaxFrames") }

# 1) video -> keypoints (+ contract validation)
Invoke-Step "infer_clip (video->keypoints)" (@("infer_clip.py", "--input", $clipPath, "--output", $kp, "--fps", "$Fps") + $maxArgs)
Invoke-Step "validate keypoints contract"   @("validate_keypoints.py", "--input", $kp)

# 2) keypoints -> intrinsic clip_features (+ contract validation)
Invoke-Step "feature_calc (keypoints->clip_features)" @("feature_calc.py", "--keypoints", $kp, "--output", $cf)
Invoke-Step "validate clip_features contract"         @("validate_keypoints.py", "--input", $cf, "--schema", "schema\clip_features.schema.json")

# 3) summary + posture_ratio 0..1 auto-check
$doc = Get-Content $cf -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "clip_features (configVer=$($doc.featureConfigVersion), frames=$($doc.analyzedFrames), dur=$([int]$doc.clipDurationMs)ms)" -ForegroundColor Green

$fail = $false
$rows = @()
foreach ($prop in $doc.features.PSObject.Properties) {
  $key = $prop.Name
  $f = $prop.Value
  $metric = if ($f.PSObject.Properties.Name -contains 'metric') { $f.metric } else { '-' }
  $unit   = if ($f.PSObject.Properties.Name -contains 'unit')   { $f.unit }   else { '-' }
  $note = ''
  if ($metric -eq 'posture_ratio') {
    if ($f.value -lt 0 -or $f.value -gt 1) { $note = 'RATIO OUT OF [0,1]!'; $fail = $true }
    else { $note = 'ratio ok' }
  }
  $rows += [pscustomobject]@{
    featureKey = $key; kind = $f.kind; metric = $metric
    value = $f.value; unit = $unit; conf = $f.confidence; check = $note
  }
}
$rows | Format-Table -AutoSize

if ($doc.features.PSObject.Properties.Count -eq 0) {
  Write-Host "[WARN] features empty -- person detection may have been 0 (check video / frame count)" -ForegroundColor Yellow
}

Write-Host ""
if ($fail) {
  Write-Host "[FAIL] posture_ratio out of range -- see 'check' column above" -ForegroundColor Red
  exit 1
}
Write-Host "[PASS] Tier 1 smoke passed -- real inference pipeline OK (out\clip_features.json)" -ForegroundColor Green
exit 0
