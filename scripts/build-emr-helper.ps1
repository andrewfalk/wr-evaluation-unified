$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'electron\emr-helper\EmrHelper.cs'
$outDir = Join-Path $root 'electron\emr-helper\bin\Release'
$outFile = Join-Path $outDir 'EmrHelper.exe'

if (-not (Test-Path $source)) {
    throw "EmrHelper.cs not found: $source"
}

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    throw "C# compiler not found: $csc"
}

& $csc `
    /nologo `
    /target:exe `
    /platform:x86 `
    /optimize+ `
    /out:$outFile `
    /r:System.dll `
    /r:System.Core.dll `
    $source

if ($LASTEXITCODE -ne 0) {
    throw "Compilation failed"
}

Write-Host "Built EmrHelper.exe (x86) -> $outFile"
