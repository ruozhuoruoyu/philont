# One-command build for philont (pure TypeScript, no Rust needed).
#
# Builds all TS packages + web-ui + launcher in dependency order.
# The server runs via tsx (no build script), so it only gets deps installed.
# The runtime is pure TypeScript — no Rust toolchain needed.
#
# (Kept ASCII-only on purpose: PowerShell 5 on a zh-CN console reads UTF-8 as
#  GBK and would garble Chinese text / break parsing.)

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))

function Build-Pkg([string]$Name, [switch]$NoBuild) {
    Write-Host ""
    Write-Host "==> build $Name" -ForegroundColor Cyan
    Push-Location $Name
    try {
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "${Name}: npm install failed" }
        if (-not $NoBuild) {
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "${Name}: npm run build failed" }
        }
    } finally { Pop-Location }
}

# TS packages, bottom-up (agent-policy is the base; the rest depend on it)
foreach ($p in 'agent-policy', 'agent-tools', 'agent-mcp', 'agent-plugins', 'agent-memory') {
    Build-Pkg $p
}

Write-Host ""
Write-Host "==> install server deps (runs via tsx, no build)" -ForegroundColor Cyan
Build-Pkg 'server' -NoBuild

Build-Pkg 'web-ui'    # vite -> web-ui/dist
Build-Pkg 'launcher'  # tsc  -> launcher/dist

Write-Host ""
Write-Host "Build complete. Start with: .\scripts\start.ps1" -ForegroundColor Green
