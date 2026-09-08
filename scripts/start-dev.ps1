# start-dev.ps1 — Windows dev bring-up for UAV-RT WebApp
#
# Starts each service in its own PowerShell window:
#   1. MediaMTX (native Windows binary in vendor\mediamtx)
#   2. API server (node/tsx watch, port 4000)
#   3. Vite dev server (port 5173)
#
# Assumes Node, ffmpeg and Python 3.12 are on PATH after install.
# MediaMTX binary is downloaded by scripts\install-mediamtx.ps1.

$repo = Split-Path -Parent $PSScriptRoot

# Refresh PATH from registry so freshly-installed tools are visible.
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path','User')

$mtx = "$repo\vendor\mediamtx\mediamtx.exe"
$mtxYml = "$repo\docker\mediamtx\mediamtx.yml"
if (-not (Test-Path $mtx)) {
  Write-Host "MediaMTX binary missing — run scripts\install-mediamtx.ps1 first." -ForegroundColor Red
  exit 1
}

Write-Host "Starting MediaMTX ($mtx)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "& '$mtx' '$mtxYml'"
)

Start-Sleep -Seconds 1

Write-Host "Starting API server (port 4000)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "Set-Location '$repo\server'; npx tsx watch src/index.ts"
)

Start-Sleep -Seconds 2

Write-Host "Starting Vite dev server (port 5173)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command",
  "Set-Location '$repo'; npx vite"
)

Write-Host ""
Write-Host "All three windows launched." -ForegroundColor Green
Write-Host "  API:      http://localhost:4000/api/health"
Write-Host "  Vite:     http://localhost:5173"
Write-Host "  MediaMTX: http://localhost:9997/v3/paths/list"
Write-Host ""
Write-Host "To stop: close each PowerShell window (Ctrl+C, then close)."
