Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Root "credentials.ps1")

$cfg = $AkamaiMediaMtx
$remote = $cfg.SshTarget
$remoteDir = $cfg.RemoteDir

function Invoke-RemoteBash {
    param([Parameter(Mandatory)][string]$Script)
    $Script | ssh $remote "tr -d '\r' | bash -s"
    if ($LASTEXITCODE -ne 0) {
        throw "Remote command failed with exit code $LASTEXITCODE."
    }
}

Write-Host "Checking remote Docker and TCP 1935..."
Invoke-RemoteBash @'
set -euo pipefail
echo "== OS =="
. /etc/os-release
echo "$PRETTY_NAME"
echo "== Docker =="
command -v docker >/dev/null 2>&1 && docker --version || true
docker compose version 2>/dev/null || true
echo "== Existing containers =="
docker ps -a 2>/dev/null || true
echo "== TCP 1935 =="
ss -ltnp state listening sport = :1935 || true
listeners="$(ss -ltnp state listening sport = :1935 | tail -n +2 || true)"
if [ -n "$listeners" ]; then
  current="$(docker ps --filter 'name=^/mediamtx-m400$' --format '{{.Names}}' 2>/dev/null || true)"
  if [ "$current" != "mediamtx-m400" ]; then
    echo "TCP 1935 is occupied by something other than mediamtx-m400. Stop and inspect before deployment." >&2
    exit 20
  fi
fi
'@

Write-Host "Installing Docker packages if missing..."
Invoke-RemoteBash @'
set -euo pipefail
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y docker.io docker-compose-v2
fi
systemctl enable --now docker
docker --version
docker compose version
'@

$compose = @"
services:
  mediamtx:
    image: $($cfg.MediaMtxImage)
    container_name: mediamtx-m400
    restart: unless-stopped
    ports:
      - "1935:1935"
    volumes:
      - ./mediamtx.yml:/mediamtx.yml:ro
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
"@

$mediamtx = @"
logLevel: info
logDestinations: [stdout]
readTimeout: 10s
writeTimeout: 10s

authMethod: internal
authInternalUsers:
  - user: $($cfg.PublishUser)
    pass: $($cfg.PublishPass)
    ips: []
    permissions:
      - action: publish
        path: $($cfg.RtmpApp)/$($cfg.RtmpStream)
  - user: $($cfg.ReadUser)
    pass: $($cfg.ReadPass)
    ips: []
    permissions:
      - action: read
        path: $($cfg.RtmpApp)/$($cfg.RtmpStream)

rtmp: true
rtmpAddress: :1935
rtmpEncryption: "no"

rtsp: false
hls: false
webrtc: false
srt: false
api: false
metrics: false
pprof: false
playback: false

pathDefaults:
  source: publisher

paths:
  $($cfg.RtmpApp)/$($cfg.RtmpStream):
    source: publisher
"@

$payload = @{
    compose = $compose
    mediamtx = $mediamtx
} | ConvertTo-Json -Compress
$payload64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))

Write-Host "Writing MediaMTX compose/config and starting fixed image $($cfg.MediaMtxImage)..."
Invoke-RemoteBash @"
set -euo pipefail
install -d -m 700 "$remoteDir"
cd "$remoteDir"
printf '%s' '$payload64' | base64 -d > payload.json
python3 - <<'PY'
import json
from pathlib import Path
p = json.loads(Path("payload.json").read_text())
Path("docker-compose.yml").write_text(p["compose"], encoding="utf-8")
Path("mediamtx.yml").write_text(p["mediamtx"], encoding="utf-8")
PY
rm -f payload.json
chmod 600 mediamtx.yml docker-compose.yml
docker compose pull
docker compose up -d --force-recreate
sleep 2
docker compose ps
ss -ltnp state listening sport = :1935
"@

Write-Host "Deployment complete."
Write-Host "Publish user: $($cfg.PublishUser), read user: $($cfg.ReadUser). Passwords are stored in akamai-mediamtx/credentials.ps1."
