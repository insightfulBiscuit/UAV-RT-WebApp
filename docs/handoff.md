# UAV-RT WebApp — Session Handoff Guide

> **Keep this document up to date.** Whenever a decision changes, a service moves,
> a new tool is added, or a workflow gets simplified, edit the relevant section
> and stamp the "Last updated" line at the top. If you deprecate a section,
> remove it — do not leave stale advice sitting next to accurate advice.
> A rotting handoff is worse than none, because it burns the next session's
> context on questions that already have wrong answers.
>
> Owner: whoever is currently working on the repo.
> Last updated: 2026-09-08 (WHEP auto-reconnect for FH2 publisher rotation; settings-gear modal for thresholds).

---

## One-paragraph state

React + Vite + Express web app for UAV operations at UBCO Kelowna, integrating
DJI FlightHub 2 (M4TD + Dock 3 + M400) over REST + MQTT (via EMQX HiveMQ).
Live video: FH2 Share → operator's Akamai/Linode VM running MediaMTX → local
MediaMTX pull-on-demand → WHEP in the browser. Real DEIMv2/DINOv3 object
detection runs in-process on the operator's GPU. There is **no mock code path
anywhere** — every stage runs against the real thing or refuses to start.
Development is on Windows 10 with an NVIDIA GTX 1080 Ti.

## Infra state (already stood up)

- **Operator's Akamai/Linode VM**: `172.232.174.165`, Ubuntu 24.04
  - Docker + MediaMTX running at `/opt/mediamtx/`
  - Path config lives on the VM (`/mediamtx.yml` inside the container)
  - Publisher creds per path in `~/.mediamtx_pws` on the VM
  - Reader user: `uavrt_all_read` (password baked into local
    `docker/mediamtx/mediamtx.yml` source URLs and `server/config/akamai-streams.json`)
  - SSH: `ssh root@172.232.174.165`
- **EMQX HiveMQ MQTT broker** (URL in `server/.env`) — dock OSD + services flowing
- **FH2 Share** configured to push M4TD Thermal + Dock 3 Indoor to the Akamai VM.
  - **M4TD Wide / Zoom currently NOT flowing** — the VM's `m4td_wide` /
    `m4td_zoom` paths are misconfigured as `source: rtmp://…` (pull) instead of
    `source: publisher` (accept push). Fix on the VM: edit `/opt/mediamtx/mediamtx.yml`
    to set both to `source: publisher` matching `m4td_thermal`, then
    `docker restart uavrt-mediamtx`.

## Local dev machine (Windows) — installed prerequisites

| Tool | Where | Notes |
|---|---|---|
| Node.js 24 LTS | `C:\Program Files\nodejs\` | winget-installed. |
| ffmpeg 9.0.1 | `C:\Users\<u>\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-9.0.1-full_build\bin` | winget-installed, on user PATH. |
| Python 3.12.10 | `C:\Users\<u>\AppData\Local\Programs\Python\Python312\python.exe` | Has torch 2.5.1+cu124, torchvision 0.20.1+cu124, numpy, opencv-python-headless, pyyaml, transformers, faster-coco-eval, scipy, tensorboard, calflops. |
| MediaMTX v1.15.1 | `vendor\mediamtx\mediamtx.exe` | Native Windows binary. `.gitignored`. Installed via `scripts\install-mediamtx.ps1`. |
| NVIDIA driver 582.28 | system | GTX 1080 Ti, 11 GB VRAM. Runs DEIMv2-small at ~50 ms/frame. |
| Docker Desktop 29.4 | installed but **not used** — WSL2 backend has no distro, so we run MediaMTX natively rather than via `docker compose`. |

## File map (critical stuff)

**Backend (Node)**
- `server/src/index.ts` — routes registry
- `server/src/aiFrameTap.ts` — ffmpeg RTMP → BGR24 frame emitter
- `server/src/aiWorker.ts` — spawns Python inference worker, pipes frames.
  On Windows defaults `AI_PYTHON=python`; on macOS/Linux defaults `python3`.
- `server/src/mqttClient.ts` — MQTT hub + OSD cache + tail buffer (2000 msgs)
- `server/src/thermalAnchorService.ts` — R-JPEG anchor capture pipeline
- `server/src/thermalSdkService.ts` — `dji_irp.exe` wrapper. **No mock fallback** —
  throws if the SDK binary is missing. Reads `THERMAL_SDK_BIN` from env.
- `server/src/thermalService.ts` — MQTT point measurement
- `server/src/wsHub.ts` — WebSocket broadcaster (`thermal` channel; AI shares it)
- `server/src/akamaiConfig.ts` — Akamai stream registry + per-tile matcher
- `server/src/livestreamService.ts` — FH2 live-stream/start
- `server/src/thumbService.ts` — ffmpeg thumbnail service for Footage page
- `server/config/akamai-streams.json` — tile → Akamai relay mapping. 5 entries:
  `m400_legacy, m4td_wide, m4td_zoom, m4td_thermal, dock3`. (Dock 3 collapsed
  to a single stream — indoor position — because Akamai only relays one dock
  feed.)

**Python AI worker**
- `ai_worker/inference_worker.py` — main loop (stdin→stdout JSON)
- `ai_worker/detector.py` — `DeimV2Detector` only. **No mock.** Raises on
  missing CUDA / weights / DEIM_ROOT.
- `ai_worker/deimv2_runtime.py` — vendored from delivery, unchanged
- `ai_worker/config.py` — classes + alert thresholds (copied from H30T's
  `product_config.json`)
- `ai_worker/README.md` — install steps for CUDA host

**Frontend**
- `src/components/Livestream/Livestream.tsx` — Live view cockpit. Renders
  primary pane with all overlays. When split view is toggled, renders a
  `SecondaryVideoPane` next to it (own WHEP session, no overlays).
- `src/components/Livestream/AiDetectionsOverlay.tsx` — canvas box overlay
- `src/components/Livestream/ThermalMatrixOverlay.tsx` — palette-inversion
  hot-region overlay (primary pane only)
- `src/components/Alerts/AlertToasts.tsx` + `.css` — global toast popup host
- `src/lib/whepPlayer.ts` — WHEP client
- `src/lib/thermalPalettes.ts` — DJI palette LUTs (0=white_hot, 2=iron_red, 9=black_hot)
- `src/lib/thermalInversionWorker.ts` — Web Worker: RGB → normalized → °C
- `src/lib/api.ts` — all frontend API types + fetchers. `AiWorkerStatus` no
  longer carries a `mode` field.

**Config**
- `docker/mediamtx/mediamtx.yml` — local MediaMTX config (source-on-demand
  pulls from Akamai). Uses v1.15+ field names (`hlsAllowOrigin`,
  `webrtcAllowOrigin` — singular).
- `vite.config.ts` — proxies both `/api` and `/ws` to `http://localhost:4000`.
- `scripts/start-dev.ps1` — one-shot bring-up (three PowerShell windows).
- `scripts/install-mediamtx.ps1` — one-shot MediaMTX binary download.
- `scripts/ai-e2e-test-source.ps1` — ffmpeg testsrc2 publisher for E2E validation.

## Running services (usual startup, Windows)

```powershell
# Foreground path (opens three PS windows so you can Ctrl+C each service):
.\scripts\start-dev.ps1
```

Health checks:

```powershell
Invoke-RestMethod http://localhost:4000/api/health
Invoke-RestMethod http://localhost:9997/v3/paths/list
Invoke-WebRequest  http://localhost:5173/ -UseBasicParsing | Select StatusCode
```

## AI pipeline

- **Real-only.** `AI_MODE` env is not read anywhere. Worker starts with
  `POST /api/ai/worker/start` body `{"modality":"rgb"|"ir"}`.
- Cold-start ~30-40 s (model → GPU). Steady-state P50 latency ~50 ms per frame
  on the 1080 Ti with DEIMv2-small.
- Two independent stages, two buttons:
  - **AI tap** — ffmpeg RTMP → raw BGR24 frame emitter. Counter is frames
    ffmpeg has produced.
  - **AI** — Python DEIMv2 worker. Counter is frames the model has processed.
    Clicking AI auto-starts the tap if it isn't already running.
- Frontend WebSocket subscribes to the `thermal` channel; AI messages are
  distinguished by `type: "ai"`.

## Live view UI

- **Camera tiles** in the right rail: click to view; **shift+click to open in
  a secondary pane** for side-by-side monitoring.
- **Split / Single button** in the header — same effect, auto-picks any other
  streamable tile as secondary.
- Primary pane owns AI overlay + thermal palette-inversion + spot-metering +
  matrix panel. Secondary pane is a pure WHEP video with a caption + close
  button. One AI worker; splitting is for visual monitoring, not for two
  independent inference cockpits.
- Dock 3 exposes one tile (label: "DJI Dock 3 · Camera"). The old outdoor
  placeholder that used to switch dock cameras was removed because Akamai
  only relays one dock feed.

## Alert thresholds

- Defaults live in [ai_worker/config.py](../ai_worker/config.py) as
  `_DEFAULT_ALERT_THRESHOLDS`.
- User overrides live in `server/config/thresholds.json` (gitignored). Written
  from the Live view's **Alert thresholds** panel. Deleted by the panel's
  **Reset defaults** button.
- Effective values = defaults ∪ overrides, serialized as JSON and passed to
  the Python worker via the `AI_THRESHOLDS` env var at spawn time.
- Saving from the UI hits `PUT /api/ai/thresholds`, which writes the file and
  restarts the AI worker so the new values take effect immediately (~1-2 s
  interruption).

## ntfy push notifications

- Configured via `NTFY_URL` in `server/.env` (default topic:
  `https://ntfy.sh/dji_alert`). Optional `NTFY_TOKEN` for reserved topics,
  optional `NTFY_LINK` for the tap-to-open URL (defaults to
  `http://localhost:5173/live`).
- [server/src/ntfyService.ts](../server/src/ntfyService.ts) coalesces alerts
  within a 10 s window per (modality, class, trigger) key so a busy scene
  doesn't spam the phone. If a burst produces 3 fire alerts in 10 s, one push
  arrives with `×3 in 10s` in the body.
- fire / smoke / any trigger with `critical` or `extreme` in the name push
  with `Priority: max`. Everything else with `Priority: default`.
- The Live view's threshold panel has a **Send test push** button that fires
  a canned notification for verifying the topic + phone subscription.

## Thermal SDK

- Path in `.env` is `THERMAL_SDK_BIN`, pointing at
  `deimv2/third_party/dji_thermal_sdk/dji_thermal_sdk_v1.8_20250829/utility/bin/windows/release_x64/dji_irp.exe`.
- **No mock fallback.** `decodeRJpeg()` throws if the binary isn't reachable.
- `/api/thermal/anchor/status` returns `sdkAvailable: true` when the binary
  spawns cleanly.

## The `deimv2/` folder (at repo root)

Everything from the coworker's H30T delivery. 1.5 GB on disk. `.gitignore`
excludes the large binaries so `git status` only tracks ~2 MB of code:

```
deimv2/
  DEIMv2/                     # coworker's Python code (tracked)
    engine/, configs/, tools/, …
    ckpts/vitt_distill.pt     # 38 MB — .gitignored
    weight/*.pth              # COCO pretrained — .gitignored
  new_models/
    *.pth                     # 1.3 GB of trained weights — .gitignored
    model_settings_and_detection_targets.md   # tracked
  third_party/
    dji_thermal_sdk/          # 191 MB SDK zip + extract — .gitignored
  tools/                      # coworker helper scripts (tracked)
  config/product_config.json  # alert threshold source of truth (tracked)
```

Environment (`server/.env`):
- `DEIM_ROOT=C:\Users\<you>\Desktop\UAV-RT-WebApp\deimv2`
- `DEIM_CONFIG_RGB` / `DEIM_CONFIG_IR` — relative paths under `DEIM_ROOT/DEIMv2/`
- `DEIM_WEIGHT_RGB` / `DEIM_WEIGHT_IR` — relative under `DEIM_ROOT/new_models/`
- `THERMAL_SDK_BIN` — absolute path to `dji_irp.exe`

## MQTT status

Currently connects on startup and subscribes to `thing/#`, `sys/#`,
`product/#`, and the specific dock SN. The `/api/health` endpoint sometimes
reports `mqtt.connected: false` even after a successful connection —
that's a stale `mqttHub.status()` reporter bug, not the MQTT client itself.
Real data (OSD, thermal spot readings) flows regardless. If you touch
`mqttClient.ts`, fix the status accessor while you're there.

## Environment vars in `server/.env`

Key ones (don't need to touch unless credentials rotate):

- `FH2_BASE_URL`, `FH2_USER_TOKEN`, `FH2_PROJECT_UUID` — FlightHub 2 auth
- `MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_CLIENT_ID`,
  `MQTT_DOCK_SN` — HiveMQ + dock SN
- `AI_PYTHON=python` — Windows default; leave as-is
- `DEIM_ROOT`, `DEIM_CONFIG_*`, `DEIM_WEIGHT_*` — DEIMv2 paths (see above)
- `THERMAL_SDK_BIN` — DJI Thermal SDK binary

## Named tests

### `ai-integration-e2e` — real DEIMv2 pipeline validation
Runbook: `scratchpad/ai_e2e/README.md`. Now runs against the real detector
(no mock exists). Uses `scripts/ai-e2e-test-source.ps1` to publish an
ffmpeg testsrc2 stream to `rtmp://localhost:1935/live/aitest` and the AI
tap consumes it.

### `akamai-tile-routing-e2e` — multi-tile Akamai routing
Runbook: `scratchpad/akamai_e2e/run.sh`. Verifies per-tile stream selection.

### `temp-matrix-e2e` — R-JPEG anchor pipeline
Runbook: `scratchpad/thermal_sdk_val/`. Now that the SDK binary is wired,
this should work end-to-end. If it doesn't, the failure will be loud
(no mock swallowing the error).

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

fire + smoke alert on **detection** (no temp requirement). Persistence: 3
consecutive frames.

## Open TODOs (rough priority)

1. **Fix M4TD Wide + Zoom on the Akamai VM**: change their `source:` from
   `rtmp://…` to `publisher`, matching `m4td_thermal`. Then confirm FH2
   Share is actually pushing Wide/Zoom from the drone (Pilot app has to
   have them enabled per-camera).
2. **Fix the `mqttHub.status()` stale-report bug** ([server/src/mqttClient.ts](../server/src/mqttClient.ts))
   so `/api/health` matches reality.
3. **Temperature fusion for AI alerts** ([ai_worker/inference_worker.py](../ai_worker/inference_worker.py))
   — `build_temp_lookup` is a stub. Backend attach (from the anchor matrix)
   is cleaner than browser-attach because alerts are computed backend-side.
4. **Rotate MediaMTX credentials** — currently in
   `server/config/akamai-streams.json` in the repo. Move to env-var
   substitution before making the repo public.
5. **Firewall on Akamai VM** — cloud-firewall it to your home IP for SSH,
   with 1935/8888/8889/8189 open for stream traffic.
6. **Anchor interval polish** — panel has 2/5/8/15/30 s options; drone
   photo round-trip is ~4-8 s so 2 s will queue. Consider a "queued: N"
   indicator.
7. **Second AI worker for split view (optional)** — one worker + one tap
   per pane so both cameras get inference simultaneously. Non-trivial:
   Python worker needs stream keying, WS broadcast needs pane routing.

## FH2 Share publisher rotation (upstream pattern to know about)

DJI's FH2 Share cloud pool **rotates publishers every 10-15 seconds**. From
the Akamai VM's MediaMTX log a single stream (`live/m4td_wide`) looks like:

```
publisher A opens → publishes for 12s → EOF
(1-2s gap, no publisher)
publisher B opens (different Chinese ISP IP) → publishes for 14s → EOF
...
```

This is FH2's normal load-balancing behavior, not a drone or config issue.
The aggregate bytes-received number is huge because these short sessions
stitch together, but each individual RTMP session is short-lived.

The 1-3 s hand-off gap kills naïve WHEP viewers: MediaMTX terminates the
peer connection when it loses upstream, and `restartIce()` alone can't
recover because the peer is gone. [src/lib/whepPlayer.ts](../src/lib/whepPlayer.ts)
addresses this with **full session rebuild on prolonged disconnect** — after
3 s of `disconnected` or on `failed`/HTTP error, it tears down the peer
and does a fresh `POST` handshake with a 750 ms backoff. The video element
stays mounted across reconnects, so the overlay chrome doesn't flicker.

If you ever see repeated freezes lasting >5 s, check three things in order:
1. The local MediaMTX log — is the local pull from the VM actually
   reconnecting when the source drops?
2. The VM's MediaMTX log — is FH2 Share reconnecting? If publisher
   IPs stop showing up entirely for >30 s, FH2 stopped pushing.
3. The drone side — Wide/Zoom/Thermal enabled per-camera in Pilot?

## Design decisions worth remembering (so we don't relitigate)

- **No mocks anywhere.** The system either operates against the real thing
  or refuses to start. This applies to AI inference AND the DJI Thermal SDK.
  If someone adds a mock, delete it and read this file to the person who
  added it.
- **Volcengine is gone.** Not coming back. All video is now FH2 Share →
  Akamai MediaMTX → local MediaMTX → WHEP.
- **Palette inversion precision is ±5-10 °C, not ±1-2.** DJI's SDK applies
  spatial DDE (Digital Detail Enhancement) so palette→temp mapping isn't
  stateless. R-JPEG anchors from the SDK are the only path to real
  radiometric precision (±0.1 °C at anchor moments).
- **Alerts wait for anchors.** For an object staying in frame > 10 s, the
  slow (~5-10 s) anchor round-trip is fine — we'll catch it at least once.
- **Thresholds** are copied verbatim from H30T's `product_config.json` for
  behavioral parity with coworker's H30T rig.
- **Both IR and RGB models** — auto-selected based on active tile's lens.
- **Split view is monitoring-only.** Only the primary pane owns AI /
  thermal overlays. Adding a second inference cockpit is on the TODO list
  but hasn't landed.

## How to keep this document useful

- After any refactor that touches routes, env vars, tiles, or file layout:
  edit the affected section here and bump the "Last updated" line at the top.
- When you delete a feature: delete its section. Do not leave "deprecated"
  notes — they confuse the next session.
- When something surprising happens (an environmental issue, a WHEP quirk,
  a config gotcha): write it down in "Design decisions worth remembering"
  so we don't rediscover it.
- If the "One-paragraph state" no longer reflects reality, rewrite it. This
  paragraph is what a fresh session anchors on.

## What to say in the next session

Start with:

> Hey Claude — I want to continue work on my UAV-RT web app. Please read
> `docs/handoff.md` first to catch up on state. Then let's [X].

Where `[X]` is a concrete task.
