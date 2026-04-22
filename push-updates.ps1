<#
.SYNOPSIS
  Commit the current state of the project and push to GitHub.

.DESCRIPTION
  Run this after Claude has made changes in the project folder.

  Usage:
    cd "C:\Users\Widemind\OneDrive\Documents\Claude\Projects\World emergency and hotlines"
    powershell -ExecutionPolicy Bypass -File .\push-updates.ps1 -Message "Pass 3: tier-2/3 enrichment"
#>

param(
    [string]$Message = "Update dataset"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".git")) {
    Write-Error "No .git folder found. Run setup-github.ps1 first."
    exit 1
}

Write-Host "Staging changes..." -ForegroundColor Cyan
git add .

git diff --cached --stat | Select-Object -First 20
$changeCount = (git diff --cached --name-only | Measure-Object -Line).Lines
Write-Host "$changeCount files changed" -ForegroundColor Green

if ($changeCount -eq 0) {
    Write-Host "Nothing to commit." -ForegroundColor Yellow
    exit 0
}

Write-Host "`nCommitting..." -ForegroundColor Cyan
git commit -m $Message

Write-Host "`nPushing..." -ForegroundColor Cyan
git push

if ($LASTEXITCODE -eq 0) {
    $user = git config --get remote.origin.url -replace '.*github\.com[:/](.+)/.+\.git','$1'
    Write-Host "`n[OK] Pushed." -ForegroundColor Green
} else {
    Write-Host "`n[!] Push failed. Check output above." -ForegroundColor Red
}
