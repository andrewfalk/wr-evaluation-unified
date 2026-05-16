<#
.SYNOPSIS
    Loads Docker images from the offline package into the local Docker daemon.

.DESCRIPTION
    Run from the package root directory after extracting the offline package.

.PARAMETER ImagesPath
    Path to wr-images.tar. Default: .\images\wr-images.tar

.EXAMPLE
    # From package root
    .\scripts\import-images.ps1

    # Custom path
    .\scripts\import-images.ps1 -ImagesPath D:\transfer\wr-images.tar
#>
param(
    [string]$ImagesPath = ".\images\wr-images.tar"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ImagesPath)) {
    Write-Error "Images archive not found: $ImagesPath`nRun from the package root directory, or specify the correct path."
    exit 1
}

$sizeMB = [math]::Round((Get-Item $ImagesPath).Length / 1MB, 1)
Write-Host "Loading Docker images from: $ImagesPath ($sizeMB MB)"
Write-Host "This may take a minute..."

docker load -i $ImagesPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "docker load failed (exit $LASTEXITCODE)"
    exit 1
}

Write-Host ""
Write-Host "Done. Images loaded successfully." -ForegroundColor Green
Write-Host "Verify with: docker images | Select-String 'wr-'"
