# ai-e2e-test-source.ps1 — publish a local ffmpeg test pattern into
# MediaMTX so the AI frame tap has something to consume without needing
# the Akamai VM to be reachable.
#
# The MediaMTX config has a catch-all `all_others: source: publisher` path,
# so we can publish under any name that isn't one of the pre-defined
# Akamai paths. We use "aitest" to avoid collision with m4td_wide etc.
#
# Usage:
#   .\scripts\ai-e2e-test-source.ps1                # publish, ffmpeg blocks
#   .\scripts\ai-e2e-test-source.ps1 -StreamKey foo # custom key

param(
  [string]$StreamKey = "aitest",
  [int]$Width  = 640,
  [int]$Height = 480,
  [int]$Fps    = 15
)

$url = "rtmp://localhost:1935/live/$StreamKey"

Write-Host "Publishing test pattern to $url" -ForegroundColor Cyan
Write-Host "Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

ffmpeg -re `
  -f lavfi -i "testsrc2=size=${Width}x${Height}:rate=${Fps}" `
  -f lavfi -i "sine=frequency=440:sample_rate=44100" `
  -c:v libx264 -preset ultrafast -tune zerolatency `
  -pix_fmt yuv420p -g $Fps `
  -c:a aac -b:a 64k `
  -f flv $url
