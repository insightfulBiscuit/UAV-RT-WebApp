# UAV-RT WebApp — Session Handoff Guide

Drop this whole file into the next Claude session as your first message. It
contains everything I need to resume work without re-deriving context.

---

## One-paragraph state

A React + Vite + Express web app for UAV operations at UBCO Kelowna,
integrating DJI FlightHub 2 (M4TD + Dock 3 + M400) over REST + MQTT (via
EMQX HiveMQ). Live video moved from Volcengine RTC (deprecated) to
**FH2 Share → operator's Akamai/Linode VM running MediaMTX → local MediaMTX
pull-on-demand → WHEP in the browser**. A scaffolded AI pipeline is in
place: Node backend spawns a Python inference worker that consumes RTMP
frames from ffmpeg, runs DEIMv2 detection, broadcasts detections/alerts
via WebSocket, and the browser draws bounding boxes + fires toast popups
for alerts.

## Infra state (already stood up — don't recreate)

- **Operator's Akamai/Linode VM**: `172.232.174.165`, Ubuntu 22.04
  - Docker + MediaMTX v1.21 running at `/opt/mediamtx/`
  - 6 paths configured: `live/m400`, `live/m4td_wide|zoom|thermal`, `live/dock3_indoor|outdoor`
  - Publisher creds per path in `~/.mediamtx_pws` on the VM
  - Reader user: `uavrt_all_read` (password in `server/config/akamai-streams.json`)
  - SSH: `ssh root@172.232.174.165` (user's own key)
- **EMQX HiveMQ MQTT broker** (URL in `server/.env`) — dock OSD + services flowing
- **FH2 Share** manually configured to push M4TD Wide/Zoom/Thermal + Dock3
  Indoor/Outdoor to the Akamai VM

## File map (critical stuff)

**Backend (Node)**
- `server/src/index.ts` — routes registry
- `server/src/aiFrameTap.ts` — ffmpeg RTMP → BGR24 frame emitter
- `server/src/aiWorker.ts` — spawns Python inference worker, pipes frames
- `server/src/mqttClient.ts` — MQTT hub + OSD cache + tail buffer (2000 msgs)
- `server/src/thermalAnchorService.ts` — R-JPEG anchor capture pipeline
- `server/src/thermalSdkService.ts` — dji_irp binary wrapper (int16/10 output, mock fallback)
- `server/src/thermalService.ts` — MQTT point measurement
- `server/src/wsHub.ts` — WebSocket broadcaster (`thermal` channel; AI shares it)
- `server/src/akamaiConfig.ts` — Akamai stream registry + per-tile matcher
- `server/src/livestreamService.ts` — FH2 live-stream/start (RTMP path unused; Volcengine removed)
- `server/src/thumbService.ts` — ffmpeg thumbnail service for Footage page
- `server/config/akamai-streams.json` — 6 stream mappings (M400, M4TD ×3 lens, Dock 3 ×2 position)

**Python AI worker**
- `ai_worker/inference_worker.py` — main loop (stdin→stdout JSON)
- `ai_worker/detector.py` — DeimV2Detector (real, CUDA) + MockDetector fallback
- `ai_worker/deimv2_runtime.py` — vendored from H30T delivery
- `ai_worker/config.py` — classes + alert thresholds (copied from H30T's `product_config.json`)
- `ai_worker/README.md` — install steps for CUDA host

**Frontend**
- `src/components/Livestream/Livestream.tsx` — Live view cockpit (single component doing a lot)
- `src/components/Livestream/AiDetectionsOverlay.tsx` — canvas box overlay
- `src/components/Livestream/ThermalMatrixOverlay.tsx` — palette-inversion hot-region overlay
- `src/components/Alerts/AlertToasts.tsx` + `.css` — global toast popup host (mounted in `App.tsx`)
- `src/lib/whepPlayer.ts` — WHEP client (replaced Volcengine SDK)
- `src/lib/thermalPalettes.ts` — DJI palette LUTs (0=white_hot, 2=iron_red, 9=black_hot)
- `src/lib/thermalInversionWorker.ts` — Web Worker: RGB → normalized → °C
- `src/lib/api.ts` — all frontend API types + fetchers

**Docker/config**
- `docker/mediamtx/mediamtx.yml` — local MediaMTX config (source-on-demand pulls from Akamai)

## Running services (usual startup)

```bash
# 1. Local MediaMTX (on the Mac)
/opt/homebrew/opt/mediamtx/bin/mediamtx \
  /Volumes/Dnl_512_SSD/Github/UAV-RT-WebApp/docker/mediamtx/mediamtx.yml \
  > /tmp/mediamtx.log 2>&1 &

# 2. API server
cd /Volumes/Dnl_512_SSD/Github/UAV-RT-WebApp/server
nohup npx tsx watch src/index.ts > /tmp/api.log 2>&1 &

# 3. Vite (from repo ROOT, not server/)
cd /Volumes/Dnl_512_SSD/Github/UAV-RT-WebApp
nohup npx vite > /tmp/vite.log 2>&1 &
```

Health check:
```bash
curl -s http://localhost:4000/api/health
curl -s http://localhost:9997/v3/paths/list  # MediaMTX
```

## Named tests (all scaffolded but not all fully run)

### `temp-matrix-e2e` — R-JPEG anchor pipeline
Verifies: MQTT `camera_photo_take` triggers a thermal photo, R-JPEG lands in
FH2 Media Library, backend decodes via DJI Thermal SDK (currently mocks
because SDK binary isn't in PATH), broadcasts matrix via WebSocket, frontend
palette-inversion overlay uses real DJI LUTs. Precision established at
±5-10°C after DDE trouble (see `docs/thermal-matrix-notes.md` if we wrote it).
Blocked: needs DJI Thermal SDK deployed on server for real R-JPEG decoding.

### `rtmp-e2e` — RTMP + MediaMTX + WHEP loopback
Verifies: local MediaMTX ingest works; browser plays WHEP; ffmpeg frame tap
consumes RTMP. Passed at Phase 1 (loopback). Phase 2+ (FH2→dock→MediaMTX)
superseded by the Akamai path.

### `akamai-tile-routing-e2e` — multi-tile Akamai routing
Verifies: `/api/livestream/akamai/for-tile` picks the right stream per tile
(match by aircraftSn/gatewaySn/cameraIndex/lens/position); frontend auto-picks
per active tile; local MediaMTX pulls-on-demand from Akamai; WHEP handshake
succeeds. Test runner: `scratchpad/akamai_e2e/run.sh`.

### **`ai-integration-e2e` — THIS IS THE ONE TO RUN NEXT**

Full runbook: `scratchpad/ai_e2e/README.md`.

**What it verifies:**
1. `GET /api/ai/worker/status` returns idle
2. RTMP publisher present at `rtmp://172.232.174.165:1935/live/m4td_wide` (FH2 Share OR a local ffmpeg test pattern)
3. Clicking the new **AI** button in the Live view header:
   - Starts the ffmpeg frame tap (`aiFrameTap`)
   - Spawns Python `inference_worker.py` (mode `auto` → mock on Mac since no CUDA)
   - Backend pipes BGR24 frames into Python stdin with JSON header
   - Python emits JSON detections back on stdout
   - Node relays via WebSocket `thermal` channel with `type: "ai"`
4. Frontend draws bounding boxes on the video (color-coded per class)
5. `fire`/`smoke` mock detections trigger red **toast popups** top-right (auto-dismiss 8s)
6. `GET /api/ai/worker/status` shows `running: true`, `framesSent > 0`, matching `framesReceived`, `latencyMsP50 < 30ms` on mock

**Steps (~5 min):**

```bash
# 1. Confirm services up
curl -s http://localhost:4000/api/health
curl -s http://localhost:9997/v3/paths/list | python3 -m json.tool

# 2. Get the M4TD Wide publisher password + start a test stream
ssh root@172.232.174.165 "grep M4TD_WIDE_PUB_PW ~/.mediamtx_pws"
# copy the value, then:
ffmpeg -re -f lavfi -i "testsrc2=size=640x480:rate=15" -c:v libx264 -preset ultrafast \
  -f flv "rtmp://172.232.174.165:1935/live/m4td_wide?user=m4td_wide_pub&pass=<pw>"
# leave running

# 3. Confirm Python + numpy present for mock mode
python3 -c "import numpy; print('OK')"
# if missing: pip install numpy opencv-python-headless

# 4. Open http://localhost:5173/live, click M4TD Wide tile, click "AI" button
# Expected: boxes appear in ~2s, toast pops for fire/smoke mock detections

# 5. Confirm status
curl -s http://localhost:4000/api/ai/worker/status | python3 -m json.tool

# 6. Click AI button again to stop
```

**Known limitations of this test:**
- Uses mock detector (random-ish boxes) because Mac has no CUDA
- Temperature fusion returns `None` in mock — alerts only fire for
  class-triggering classes (fire/smoke), not temperature-conditioned ones
  (person > 75°C etc.)
- Real DEIMv2 pass requires deploying DEIMv2 + `.pth` weights on a
  CUDA host and setting `DEIM_ROOT`, `DEIM_WEIGHT_IR`, `DEIM_WEIGHT_RGB`,
  `AI_MODE=real` in `server/.env`

## Open TODOs (in rough priority)

1. **Deploy DEIMv2 on CUDA host** — the AI pipeline is scaffolded but running mock. Follow `ai_worker/README.md` step-by-step. Likely GCP L4 GPU instance (~$0.60/hr on-demand) or a UBCO GPU box if available.
2. **Deploy DJI Thermal SDK for R-JPEG anchors** — currently `thermalSdkService.ts` returns mock flat matrices. Docker recipe is in the earlier session's setup guide; the SDK's Linux binary + libs live in the H30T delivery folder.
3. **Wire temperature into detection boxes** — `ai_worker/inference_worker.py` has `build_temp_lookup` as a stub. Should either receive OSD min/max via env / stdin metadata OR the browser attaches temperature per detection (already has palette-inversion matrix). Backend attach is cleaner because alerts are computed backend-side.
4. **Firewall on Akamai VM** — currently open, needs Cloud Firewall attached per user's home IP for SSH + open on 1935/8888/8889/8189 for stream traffic.
5. **Anchor interval polish** — panel has 2/5/8/15/30s options; drone photo round-trip is really ~4-8s so 2s will queue. Currently just queues quietly; could show "queued: N" indicator.
6. **Alert toast host** — mounted at `<AlertToasts />` in `App.tsx`. Consider audio ping option later if wanted.
7. **Rotate MediaMTX credentials** — currently in `server/config/akamai-streams.json` in the repo. Move to env-var substitution before making the repo public.

## Environment vars in `server/.env`

Key ones (don't need to touch unless credentials rotate):
- `FH2_BASE_URL`, `FH2_USER_TOKEN`, `FH2_PROJECT_UUID` — FlightHub 2 auth
- `MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_CLIENT_ID`, `MQTT_DOCK_SN` — HiveMQ + dock SN
- `AKAMAI_M400_WHEP_URL` — deprecated (kept for backward-compat)
- `AKAMAI_STREAMS_CONFIG` (optional) — override path for the JSON registry
- `AI_MODE` (default `auto`), `AI_PYTHON` (default `python3`), `DEIM_ROOT`, `DEIM_WEIGHT_IR`, `DEIM_WEIGHT_RGB` — AI worker

## Design decisions worth remembering (so I don't relitigate)

- **Volcengine deleted.** Not coming back. All video is now FH2 Share → Akamai
  MediaMTX → local MediaMTX → WHEP.
- **Palette inversion precision is ±5-10°C, not the ±1-2°C I promised early
  on.** DJI's SDK applies spatial DDE (Digital Detail Enhancement) so
  palette→temp mapping isn't stateless. R-JPEG anchors from the SDK are the
  only path to real radiometric precision (±0.1°C at anchor moments).
- **Alerts wait for anchors.** For an object staying in frame >10s, the
  slow (~5-10s) anchor round-trip is fine — we'll catch it at least once.
  Fast flyover objects fall back to palette inversion (±5°C) for a rough
  "possibly hot" flag.
- **Thresholds** are copied verbatim from H30T's `product_config.json` for
  behavioral parity with coworker's H30T rig.
- **Both IR and RGB models** — auto-selected based on active tile's lens.

## Class list (DEIMv2 head)

```
0 vehicle    1 tree           2 metal_fixture  3 green_grass  4 dry_grass
5 person     6 tent_tarp      7 plastic_waste  8 fire         9 smoke
```

## Alert thresholds (matches H30T's `config/product_config.json`)

| Trigger | Temp | Classes |
|---|---|---|
| triggerC | 55°C | escalation baseline |
| criticalC | 80°C | any |
| combustibleC | 60°C | tree, tent_tarp, plastic_waste, dry_grass |
| personC | 75°C | person |
| unknownHighC | 90°C | any (escalation) |
| unknownExtremeC | 110°C | any (escalation) |
| vehicleExtremeC | 110°C | vehicle |
| cooldownS | 5.1s | per (class, spatial-bin) |

fire + smoke alert on **detection** (no temp requirement).

Persistence: detection must appear in 3+ recent frames.

## What to say in the next session

Start with something like:

> Hey Claude — I want to continue work on my UAV-RT web app. Please read
> `docs/handoff.md` first to catch up on state. Then let's [X].

Where `[X]` is one of:
- `run the ai-integration-e2e test` (most likely first step)
- `deploy DEIMv2 on GCP` (if you've got a GPU host)
- `deploy the DJI Thermal SDK for R-JPEG anchors`
- something specific
