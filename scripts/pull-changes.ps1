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
    if ($changes) {
        Write-Host "Local changes detected:" -ForegroundColor Yellow
        Write-Host $changes
        Write-Host ""
        Write-Host "Pulling will continue, but Git may stop if these changes conflict." -ForegroundColor Yellow
        Write-Host ""
    }

    git pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        Stop-WithMessage "Pull failed. The local and GitHub histories may have diverged; ask Codex before forcing anything."
    }

    Write-Host ""
    Write-Host "Pull completed." -ForegroundColor Green
}
finally {
    Pop-Location
}
