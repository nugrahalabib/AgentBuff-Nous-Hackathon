# hack-bringup.ps1 — bring up every demo service in its own window, then verify.
# Usage:  pwsh scripts/hack-bringup.ps1   (from the hackathon-fit root)
# Read-only toward production: only starts the hack DB + hack container + host node
# procs. Never touches prod containers or runs blanket docker commands.

$ErrorActionPreference = "Stop"
$hackRoot = (Resolve-Path "$PSScriptRoot\..").Path
$posRoot  = (Resolve-Path "$hackRoot\..\agentbuff-pos").Path

Write-Host "1) Ensure Docker DB + hack container are up..."
docker start agentbuff-hack-db 2>$null | Out-Null
$cname = (docker ps -a --filter "name=hermes-hack-user-" --format "{{.Names}}" | Select-Object -First 1)
if ($cname) {
  docker start $cname 2>$null | Out-Null
  Write-Host "   hack container: $cname"
} else {
  Write-Host "   WARNING: hack container not found — reprovision via /loby first."
}

function Start-Svc($title, $cwd, $cmd) {
  Write-Host "   launching: $title"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle='$title'; Set-Location '$cwd'; $cmd"
}

Write-Host "2) Launch host services (separate windows)..."
Start-Svc "POS backend 7704"  "$posRoot\server" '$env:PORT=7704; npm run start'
Start-Svc "POS frontend 7703" "$posRoot\src"    'npm run dev'
Start-Svc "Portal 617"        "$hackRoot"       '$env:NODE_OPTIONS="--max-old-space-size=8192"; pnpm dev'

Write-Host "3) Waiting 14s for services to boot..."
Start-Sleep -Seconds 14

Write-Host "4) Verify..."
Push-Location $hackRoot
pnpm tsx --env-file=.env.local scripts/hack-verify-demo.ts
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) {
  Write-Host "`nVerify FAILED — re-check the service windows above before recording." -ForegroundColor Red
} else {
  Write-Host "`nAll green. Open http://localhost:617/app (NEW thread, CONNECTED) and http://localhost:7703 (POS)." -ForegroundColor Green
}
exit $code
