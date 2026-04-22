<#
.SYNOPSIS
  Initialise this project as a git repo and publish it to GitHub.

.DESCRIPTION
  Requires: git and gh (GitHub CLI) on PATH.

  Usage:
    cd "C:\Users\Widemind\OneDrive\Documents\Claude\Projects\World emergency and hotlines"
    powershell -ExecutionPolicy Bypass -File .\setup-github.ps1

  The script will:
    1. Remove any half-broken .git folder left behind by earlier attempts.
    2. git init, configure identity, stage all files, commit.
    3. If you're already logged into gh, create a private repo named
       'world-emergency-hotlines' under your account and push to it.
    4. If you're not logged in, it runs 'gh auth login' first.
#>

$ErrorActionPreference = "Stop"

function Check-Tool($tool, $hint) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Error "$tool not found on PATH. $hint"
        exit 1
    }
}

# ---- Sanity ----
if (-not (Test-Path "hotlines.json")) {
    Write-Error "hotlines.json not found - run this script from the project folder."
    exit 1
}
Check-Tool git "Install from https://git-scm.com/downloads"
Check-Tool gh  "Install from https://cli.github.com/"

# ---- 1. Clear any broken .git ----
if (Test-Path ".git") {
    Write-Host "Removing existing .git folder..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force ".git"
}

# ---- 2. Init + commit ----
Write-Host "`nInitialising git repo..." -ForegroundColor Cyan
git init -b main | Out-Null
git config user.email "craig@interconnected.au"
git config user.name  "Craig"

git add .
# Build commit message as an array and join with newlines - avoids here-string
# and ampersand/hyphen parsing gotchas on Windows PowerShell 5.
$msgLines = @(
    'Initial commit: enriched world emergency and crisis hotlines dataset',
    '',
    'hotlines.json: 250 countries, 1,613 hotline records in schema v2.0',
    '  216 rich-enriched (verified_knowledge) across 22 tier-1 countries',
    '  1,397 migrated (legacy_unverified) pending enrichment',
    'hotlines.xlsx: 3-sheet workbook generated from hotlines.json',
    'information.json: original source dataset (preserved)',
    'sources/vibbrancy_hotlines.json: atlacord/Naga Hotlines.json at commit 61bec14',
    'SCHEMA.md, README.md, COVERAGE.md, VERIFICATION_LOG.md: documentation',
    'scripts/merge_all.py, scripts/build_xlsx.py: regeneration pipeline'
)
$msg = $msgLines -join "`n"
git commit -m $msg | Out-Null
Write-Host "Commit created:" -ForegroundColor Green
git log --oneline -1

# ---- 3. Make sure gh is authenticated ----
Write-Host "`nChecking GitHub CLI auth..." -ForegroundColor Cyan
gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "You're not logged in. Running 'gh auth login'..." -ForegroundColor Yellow
    gh auth login
    if ($LASTEXITCODE -ne 0) {
        Write-Error "gh auth login failed. Abort."
        exit 1
    }
}

# ---- 4. Create the repo and push ----
Write-Host "`nCreating private repo 'world-emergency-hotlines' on GitHub and pushing..." -ForegroundColor Cyan
gh repo create world-emergency-hotlines --private --source=. --remote=origin --push --description "Definitive reference of emergency numbers and crisis support helplines in every country (250 countries, 1,613 hotlines)"

if ($LASTEXITCODE -eq 0) {
    $user = gh api user --jq .login 2>$null
    Write-Host "`n[OK] Done." -ForegroundColor Green
    Write-Host "     Repo: https://github.com/$user/world-emergency-hotlines" -ForegroundColor Green
} else {
    Write-Host "`n[!] gh repo create failed. If the repo already exists under your account, you can push manually:" -ForegroundColor Red
    Write-Host "     git remote add origin https://github.com/YOUR_USERNAME/world-emergency-hotlines.git"
    Write-Host "     git push -u origin main"
}
