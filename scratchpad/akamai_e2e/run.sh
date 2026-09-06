#!/bin/bash
# akamai-tile-routing-e2e — see README.md

set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_CFG="$REPO/scratchpad/akamai_e2e/akamai-streams.test.json"

cleanup() {
  echo ""
  echo "== Cleanup =="
  pkill -f "ffmpeg .* test_akamai" 2>/dev/null || true
  kill $(lsof -ti :4000 2>/dev/null) 2>/dev/null || true
  echo "  ffmpeg + test API stopped. Restart API with the default config:"
  echo "    cd $REPO/server && npx tsx watch src/index.ts"
}
trap cleanup EXIT

echo "== Verify MediaMTX is up =="
if ! lsof -ti :1935 >/dev/null 2>&1; then
  echo "  MediaMTX not running. Start it with:"
  echo "    /opt/homebrew/opt/mediamtx/bin/mediamtx $REPO/docker/mediamtx/mediamtx.yml"
  exit 1
fi
echo "  OK, listening on 1935"

echo ""
echo "== Start ffmpeg test-pattern publisher =="
ffmpeg -re -f lavfi -i "testsrc2=size=640x480:rate=15,format=yuv420p" \
       -f lavfi -i "sine=frequency=440:sample_rate=48000" \
       -c:v libx264 -preset ultrafast -tune zerolatency -x264-params keyint=30 \
       -c:a aac -b:a 96k -shortest 0 \
       -f flv rtmp://localhost:1935/test_akamai > /tmp/akamai_test_ffmpeg.log 2>&1 &
FFMPEG_PID=$!
echo "  ffmpeg PID $FFMPEG_PID publishing to rtmp://localhost:1935/test_akamai"
sleep 4

echo ""
echo "== Confirm publisher is live via MediaMTX API =="
curl -s http://localhost:9997/v3/paths/list | python3 -c "
import json, sys
d = json.load(sys.stdin)
paths = [p for p in d.get('items', []) if p.get('name') == 'test_akamai']
if not paths:
    print('  ERROR: no test_akamai path in MediaMTX')
    sys.exit(1)
p = paths[0]
print(f\"  path=test_akamai ready={p.get('ready')} tracks={p.get('tracks')}\")"

echo ""
echo "== Restart API with test config =="
kill $(lsof -ti :4000 2>/dev/null) 2>/dev/null; sleep 1
AKAMAI_STREAMS_CONFIG="$TEST_CFG" nohup npx --prefix "$REPO/server" tsx "$REPO/server/src/index.ts" > /tmp/akamai_test_api.log 2>&1 &
API_PID=$!
echo "  API PID $API_PID with AKAMAI_STREAMS_CONFIG=$TEST_CFG"
sleep 6

echo ""
echo "== Registry status =="
curl -s http://localhost:4000/api/livestream/akamai/status | python3 -m json.tool

echo ""
echo "== List — expect 1 stream, ready=true =="
curl -s http://localhost:4000/api/livestream/akamai/list | python3 -m json.tool

echo ""
echo "== for-tile M4TD Wide — expect 200 =="
curl -sS -w "\n  HTTP %{http_code}\n" \
  "http://localhost:4000/api/livestream/akamai/for-tile?aircraftSn=1581F8HGX264P00A1P3U&cameraIndex=99-0-0&lens=wide"

echo ""
echo "== for-tile M4TD Thermal — expect 404 (no match in test config) =="
curl -sS -w "\n  HTTP %{http_code}\n" \
  "http://localhost:4000/api/livestream/akamai/for-tile?aircraftSn=1581F8HGX264P00A1P3U&cameraIndex=99-0-0&lens=ir"

echo ""
echo "== WHEP endpoint accepts SDP =="
# Post a minimal offer; MediaMTX will 400 if the offer's bad, 200 with an SDP answer if the stream is live.
STATUS=$(curl -sS -o /tmp/whep_answer.txt -w "%{http_code}" \
  -X POST -H "Content-Type: application/sdp" \
  --data "v=0\no=- 0 0 IN IP4 127.0.0.1\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=recvonly\n" \
  http://localhost:8889/test_akamai/whep 2>/dev/null)
echo "  HTTP $STATUS  (2xx = WHEP handshake accepted)"
[ "${STATUS:0:1}" = "2" ] && echo "  ✓ WHEP is serving" || echo "  ✗ WHEP failed — see /tmp/whep_answer.txt"

echo ""
echo "== Manual browser check =="
echo "  1. Open http://localhost:5173/live"
echo "  2. Wait for tile list; click M4TD Wide"
echo "  3. Click the Akamai button in the header — should show 'Akamai ON'"
echo "  4. Video pane should switch to the color-bar test pattern"
echo "  5. Click M4TD Thermal — Akamai button auto-disables (safety guard)"
echo ""
echo "Press Enter to tear down, or Ctrl-C to leave running for browser test."
read -r _
