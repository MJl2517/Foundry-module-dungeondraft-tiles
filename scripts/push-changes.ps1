Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

function Stop-WithMessage {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Message
    )

    Write-Host ""
    Write-Host $Message -ForegroundColor Red
    exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Stop-WithMessage "Git was not found in PATH. Open a new PowerShell window or reinstall Git for Windows."
}

Push-Location $repoRoot

try {
    git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage "This folder is not a Git repository: $repoRoot"
    }

    $branch = git branch --show-current
    if (-not $branch) {
        Stop-WithMessage "Could not detect the current Git branch."
    }

    Write-Host "Repository: $repoRoot"
    Write-Host "Branch: $branch"
    Write-Host ""

    $changes = git status --short
    if (-not $changes) {
        Write-Host "No local changes to commit or push." -ForegroundColor Green
        exit 0
    }

    Write-Host "Local changes:" -ForegroundColor Yellow
    Write-Host $changes
    Write-Host ""

    $message = Read-Host "Commit message"
    if (-not $message.Trim()) {
        $message = "Update project files"
    }

    Write-Host ""
    Write-Host "Checking GitHub for new changes..."
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage "Pull failed. The local and GitHub histories may have diverged; ask Codex before forcing anything."
    }

    git add --all
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage "git add failed."
    }

    $staged = git diff --cached --name-only
    if (-not $staged) {
        Write-Host ""
        Write-Host "No staged changes after pull. Nothing to push." -ForegroundColor Green
        exit 0
    }

    git commit -m $message
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage "git commit failed."
    }

    git push
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage "git push failed. Check authentication or GitHub access."
    }

    Write-Host ""
    Write-Host "Changes were pushed to GitHub." -ForegroundColor Green
}
finally {
    Pop-Location
}
