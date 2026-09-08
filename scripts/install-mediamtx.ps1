# install-mediamtx.ps1 — download the MediaMTX Windows binary into vendor\.

param(
  [string]$Version = 'v1.15.1'
)

$repo = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $repo 'vendor\mediamtx'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$zip = Join-Path $env:TEMP "mediamtx_$Version.zip"
$url = "https://github.com/bluenviron/mediamtx/releases/download/$Version/mediamtx_${Version}_windows_amd64.zip"

Write-Host "Downloading $url" -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath $dest -Force

Write-Host "Extracted to $dest" -ForegroundColor Green
Get-ChildItem $dest | Select-Object Name, Length
