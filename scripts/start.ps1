# One-command start for philont: build if needed, then launch.
#
# The launcher serves the web UI (localhost:20267), opens your browser to the
# setup wizard (fill in API key etc.), and supervises the agent process.
#
# (ASCII-only on purpose: PowerShell 5 on a zh-CN console misreads UTF-8.)
#
# Rebuild trigger: dist missing, OR the git HEAD changed since the last build.
# (After a pull the old launcher/dist + web-ui/dist would otherwise still run --
#  the old script only built when dist was missing, so a pull without rebuild ran
#  the stale compiled output.)

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))

# Current git HEAD (empty if git is unavailable -> fall back to "build only if dist missing").
$head = ''
if (Get-Command git -ErrorAction SilentlyContinue) {
    $h = "$(git rev-parse HEAD 2>$null)".Trim()
    if ($LASTEXITCODE -eq 0 -and $h) { $head = $h }
}

$stamp = 'launcher/dist/.build-head'
$needBuild = $false
if (-not (Test-Path 'launcher/dist/index.js') -or -not (Test-Path 'web-ui/dist')) {
    $needBuild = $true
} elseif ($head) {
    $built = if (Test-Path $stamp) { "$(Get-Content $stamp -Raw -ErrorAction SilentlyContinue)".Trim() } else { '' }
    if ($built -ne $head) { $needBuild = $true }
}

if ($needBuild) {
    Write-Host "Building (first run or code updated)..." -ForegroundColor Yellow
    & (Join-Path $PSScriptRoot 'build-all.ps1')
    if ($head) { Set-Content -Path $stamp -Value $head }
}

Write-Host "Starting launcher (serves web UI + supervises agent + opens browser; Ctrl+C to exit)..." -ForegroundColor Green
node launcher/dist/index.js
