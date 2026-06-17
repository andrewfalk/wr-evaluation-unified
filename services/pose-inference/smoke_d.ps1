<#
  PR D integration smoke (Tier 1) -- standalone Python, no server / DB.
  Extends smoke_d1: runs the REAL pipeline (venv / ONNX / rtmlib) and asserts the
  D2 (tracking, sample-detect, target-track) and D3a (quality meta, confidenceBreakdown,
  overall=min invariant) outputs that CI only exercised with synthetic fixtures.

  Steps:
    1) infer_clip   video -> keypoints.json     (+ schema validate)  [D3a quality, D2a trackId]
    2) feature_calc keypoints -> clip_features   (+ schema validate)  [D3a breakdown, D2a tracking]
    3) sample_detect video -> candidates.json                         [D2b multi-person]
    4) feature_calc --target-track <id>          (+ schema validate)  [D2b target track path]
  Checks: quality{blurMetric,dropRatio,sampledFps}, trackId present, tracking block,
          confidenceBreakdown{keypoint,visibility}, overall == min(present components),
          posture_ratio in [0,1], sample-detect candidates, target-track honored.

  Usage:
    powershell -ExecutionPolicy Bypass -File smoke_d.ps1
    powershell -ExecutionPolicy Bypass -File smoke_d.ps1 -Clip my.mp4 -Fps 5 -MaxFrames 40
  Exit code: 0 = pass, 1 = fail. (ASCII-only on purpose: Windows PowerShell 5.1.)
#>
[CmdletBinding()]
param(
  [string]$Clip = "people-detection.mp4",
  [double]$Fps = 5,
  [int]$MaxFrames = 40,
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
$kp   = Join-Path $here "$OutDir\keypoints.json"
$cf   = Join-Path $here "$OutDir\clip_features.json"
$cand = Join-Path $here "$OutDir\sample_detect.json"
$cfTt = Join-Path $here "$OutDir\clip_features_target.json"

$script:fail = $false
function Check($cond, $label) {
  if ($cond) { Write-Host "  [ok]   $label" -ForegroundColor Green }
  else       { Write-Host "  [FAIL] $label" -ForegroundColor Red; $script:fail = $true }
}
function Invoke-Step($label, [string[]]$pyArgs) {
  Write-Host "-> $label" -ForegroundColor Cyan
  & $py @pyArgs
  if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] $label (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}
function Has($obj, $name) { return ($null -ne $obj) -and ($obj.PSObject.Properties.Name -contains $name) }

$maxArgs = @()
if ($MaxFrames -gt 0) { $maxArgs = @("--max-frames", "$MaxFrames") }

# ----- 1) video -> keypoints (+ contract) ----------------------------------
Invoke-Step "infer_clip (video->keypoints)" (@("infer_clip.py", "--input", $clipPath, "--output", $kp, "--fps", "$Fps") + $maxArgs)
Invoke-Step "validate keypoints contract"   @("validate_keypoints.py", "--input", $kp)

# ----- 2) keypoints -> clip_features (+ contract) --------------------------
Invoke-Step "feature_calc (keypoints->clip_features)" @("feature_calc.py", "--keypoints", $kp, "--output", $cf)
Invoke-Step "validate clip_features contract"         @("validate_keypoints.py", "--input", $cf, "--schema", "schema\clip_features.schema.json")

# ----- 3) sample-detect (D2b multi-person) ---------------------------------
Invoke-Step "sample_detect (video->candidates)" @("sample_detect.py", "--input", $clipPath, "--output", $cand)

$kpDoc   = Get-Content $kp   -Raw | ConvertFrom-Json
$cfDoc   = Get-Content $cf   -Raw | ConvertFrom-Json
$candDoc = Get-Content $cand -Raw | ConvertFrom-Json

Write-Host ""
Write-Host "=== D3a quality meta (keypoints) ===" -ForegroundColor Yellow
Check (Has $kpDoc 'quality') "keypoints.quality present"
if (Has $kpDoc 'quality') {
  $q = $kpDoc.quality
  Check (Has $q 'blurMetric')  "  quality.blurMetric present"
  if (Has $q 'blurMetric') { Check ((Has $q.blurMetric 'mean') -and (Has $q.blurMetric 'p10') -and (Has $q.blurMetric 'median')) "  blurMetric has mean/p10/median" }
  Check ((Has $q 'dropRatio') -and ($q.dropRatio -ge 0) -and ($q.dropRatio -le 1)) "  quality.dropRatio in [0,1] ($($q.dropRatio))"
  Check ((Has $q 'sampledFps') -and ($q.sampledFps -gt 0)) "  quality.sampledFps > 0 ($($q.sampledFps))"
  Check (-not (Has $q 'usableFrameRatio')) "  usableFrameRatio omitted (blurThreshold unset = default)"
}

Write-Host ""
Write-Host "=== D2a tracking (keypoints frames) ===" -ForegroundColor Yellow
$trackIds = @()
foreach ($fr in $kpDoc.frames) { foreach ($p in $fr.persons) { if ($null -ne $p.trackId) { $trackIds += $p.trackId } } }
$distinct = @($trackIds | Select-Object -Unique)  # @() forces array (single item would index as a string otherwise)
Check ($trackIds.Count -gt 0) "at least one frame.person has a trackId ($($distinct.Count) distinct: $($distinct -join ','))"

Write-Host ""
Write-Host "=== D2b sample-detect candidates ===" -ForegroundColor Yellow
Check ((Has $candDoc 'persons') -and ($candDoc.persons.Count -ge 1)) "sample-detect produced >=1 candidate ($($candDoc.persons.Count) found)"
foreach ($p in $candDoc.persons) { Write-Host ("  {0}  bbox=[{1}]  score={2}" -f $p.id, ($p.bbox -join ', '), $p.score) }

Write-Host ""
Write-Host "=== D2a tracking block (clip_features) ===" -ForegroundColor Yellow
if (Has $cfDoc 'tracking') {
  $t = $cfDoc.tracking
  Check ((Has $t 'presenceRatio') -and ($t.presenceRatio -ge 0) -and ($t.presenceRatio -le 1)) "  tracking.presenceRatio in [0,1] ($($t.presenceRatio))"
  Check (Has $t 'trackCount') "  tracking.trackCount present ($($t.trackCount))"
  Write-Host "  targetTrackId=$($t.targetTrackId)"
} else {
  Write-Host "  [warn] no tracking block (single-track or no detection)" -ForegroundColor Yellow
}
Check ((Has $cfDoc 'quality')) "clip_features.quality copied from keypoints"

Write-Host ""
Write-Host "=== D3a confidenceBreakdown + overall=min invariant ===" -ForegroundColor Yellow
$rows = @()
foreach ($prop in $cfDoc.features.PSObject.Properties) {
  $key = $prop.Name; $f = $prop.Value
  $metric = if (Has $f 'metric') { $f.metric } else { '-' }
  # posture_ratio range
  if ($metric -eq 'posture_ratio' -and ($f.value -lt 0 -or $f.value -gt 1)) { Check $false "$key posture_ratio in [0,1] (got $($f.value))" }
  # breakdown present + components 0..1 + overall == min(present components, usableFrameRatio excluded)
  if (Has $f 'confidenceBreakdown') {
    $b = $f.confidenceBreakdown
    $comps = @()
    foreach ($c in @('keypoint','visibility','tracking','viewpoint')) { if (Has $b $c) { $comps += [double]$b.$c } }
    $hasKV = (Has $b 'keypoint') -and (Has $b 'visibility')
    $inRange = $true; foreach ($c in $comps) { if ($c -lt 0 -or $c -gt 1) { $inRange = $false } }
    $minC = ($comps | Measure-Object -Minimum).Minimum
    $minOk = ([math]::Abs([double]$f.confidence - $minC) -le 1e-6)
    Check ($hasKV -and $inRange -and $minOk) "${key}: breakdown{keypoint,visibility} 0..1 & confidence==min (conf=$($f.confidence), min=$minC)"
    $bkStr = ($b.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '
  } else {
    Check $false "${key}: confidenceBreakdown present"
    $bkStr = '(none)'
  }
  $rows += [pscustomobject]@{ featureKey = $key; kind = $f.kind; metric = $metric; value = $f.value; conf = $f.confidence; breakdown = $bkStr }
}
if ($cfDoc.features.PSObject.Properties.Count -eq 0) {
  Write-Host "  [WARN] features empty -- person detection may have been 0 (check video/frames)" -ForegroundColor Yellow
}
$rows | Format-Table -AutoSize

# ----- 4) target-track path (D2b worker injects --target-track) -------------
Write-Host "=== D2b --target-track honored ===" -ForegroundColor Yellow
if ($distinct.Count -gt 0) {
  $target = $distinct[0]
  Invoke-Step "feature_calc --target-track $target" @("feature_calc.py", "--keypoints", $kp, "--output", $cfTt, "--target-track", "$target")
  Invoke-Step "validate target clip_features"        @("validate_keypoints.py", "--input", $cfTt, "--schema", "schema\clip_features.schema.json")
  $cfTtDoc = Get-Content $cfTt -Raw | ConvertFrom-Json
  Check ((Has $cfTtDoc 'tracking') -and ($cfTtDoc.tracking.targetTrackId -eq $target)) "target clip_features.tracking.targetTrackId == requested ($target)"
} else {
  Write-Host "  [warn] no trackId available to target -- skipping" -ForegroundColor Yellow
}

Write-Host ""
if ($script:fail) { Write-Host "[FAIL] Tier 1 (PR D) smoke had failures -- see [FAIL] lines above" -ForegroundColor Red; exit 1 }
Write-Host "[PASS] Tier 1 (PR D) smoke passed -- real inference + D2/D3a outputs OK" -ForegroundColor Green
exit 0
