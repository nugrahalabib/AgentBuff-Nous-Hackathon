# hack-dev-watchdog.ps1 — keep the demo dev server (port 617) ALWAYS up.
# Runs `pnpm dev`; if it crashes (OOM / Turbopack panic) it auto-restarts in a few
# seconds. Detached from any Claude session, so it survives session resets.
#
# Run it yourself any time:  pwsh scripts/hack-dev-watchdog.ps1
# (leave the window open during the demo). Ctrl+C to stop the whole watchdog.

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot   # hackathon-fit project root

while ($true) {
  Set-Location $root
  $env:NODE_OPTIONS = "--max-old-space-size=8192"
  Write-Host "[watchdog] starting `pnpm dev` on port 617 — $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Cyan
  pnpm dev
  $code = $LASTEXITCODE
  Write-Host "[watchdog] dev server exited (code $code) — restarting in 3s..." -ForegroundColor Yellow
  Start-Sleep -Seconds 3
}
