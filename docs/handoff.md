# UAV-RT WebApp — Session Handoff Guide

> **Keep this document up to date.** Whenever a decision changes, a service moves,
> a new tool is added, or a workflow gets simplified, edit the relevant section
> and stamp the "Last updated" line at the top. If you deprecate a section,
> remove it — do not leave stale advice sitting next to accurate advice.
> A rotting handoff is worse than none, because it burns the next session's
> context on questions that already have wrong answers.
>
> Owner: whoever is currently working on the repo.
> Last updated: 2026-09-22 (comprehensive system-wide logging: `server/src/logger.ts` persists every HTTP request, MQTT lifecycle event, AI worker lifecycle event, ntfy send, alert ingest/clear, thermal anchor capture, threshold change, and uncaught exception to daily-rotated JSONL, replacing scattered `console.*` calls across the server; new `/api/logs` + `/api/logs/files` routes; see "System log" section).

---

## One-paragraph state

React + Vite + Express web app for UAV operations at UBCO Kelowna, integrating
DJI FlightHub 2 (M4TD + Dock 3 + M400) over REST + MQTT (via EMQX HiveMQ).
Live video: FH2 Share → operator's Akamai/Linode VM running MediaMTX → local
MediaMTX pull-on-demand → WHEP in the browser. Real DEIMv2/DINOv3 object
detection runs in-process on the operator's GPU. Every AI alert is persisted
to a JSONL log with a captured JPEG + 5 s MP4 clip, surfaced on the Overview
page as a multi-select list you can bulk-clear or forward via ntfy. The
Overview also polls a `/api/status/summary` blob every 7 s for real dock +
aircraft telemetry, MQTT liveness, Akamai stream readiness, AI-worker and
Thermal-SDK state, and FH2 flight-task counts. There is **no mock code path
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
  On every alert batch: forwards alerts to ntfy (via `ntfyService`) AND
  persists them via `alertStore` (which fires off a photo + 5 s clip capture
  via `alertMediaService`), then broadcasts `type: "alertPersisted"` on the
  `thermal` WS channel with media URLs attached.
- `server/src/alertStore.ts` — persistent alert log. JSONL at
  `server/data/alerts.log`, in-memory ring of last 500, single shared "ack
  timestamp" at `server/data/alerts.ack.json`. Handles list/clear/ackAll/
  todayCount + a `seedForTest` helper.
- `server/src/alertMediaService.ts` — spawns two ffmpegs per alert batch
  against the AI tap's current RTMP: one JPEG frame + one 5-second `-c copy`
  MP4. Files land in `server/data/alert-media/<mediaId>.{jpg,mp4}`. Fire and
  forget; 15 s kill timeout per spawn.
- `server/src/logger.ts` — system-wide structured logger. Every server
  module logs through here (not raw `console.*`) so there is one persisted,
  queryable record of everything the system did. See "System log" below.
- `server/src/statusSummary.ts` — one-blob aggregator that feeds the Overview
  page. Reads `mqttHub.mergedOsdHost(sn)` for dock + aircraft state, plus
  `akamaiRegistry`, `aiWorker`, `aiFrameTap`, `anchorService`, `ntfy`,
  `alertStore`, and (with 30 s cache) FH2 `listTasks` for today's flight
  count + `lastFlightAt`.
- `server/src/mqttClient.ts` — MQTT hub + OSD cache + tail buffer (2000 msgs).
  **Also maintains a rolling `mergedOsdHost(sn)` snapshot** that layers each
  new `data.host.*` payload on top of the prior one. This exists because DJI
  sends TWO OSD variants for the dock on the same topic (device state +
  hardware/power); the older `latestOsd` cache only kept the most recent, so
  half the fields (mode_code, cover_state, sub_device, humidity, etc.) read
  `null` at any given moment. Anything reading dock/aircraft telemetry
  should use `mergedOsdHost()`; `osd()` still returns the raw last payload
  for consumers that need one specific variant (e.g., `/api/thermal/osd`).
- `server/src/thermalAnchorService.ts` — R-JPEG anchor capture pipeline
- `server/src/thermalSdkService.ts` — `dji_irp.exe` wrapper. **No mock fallback** —
  throws if the SDK binary is missing. Reads `THERMAL_SDK_BIN` from env.
- `server/src/thermalService.ts` — MQTT point measurement
- `server/src/wsHub.ts` — WebSocket broadcaster (`thermal` channel; AI + alert
  persistence share it, distinguished by `type: "ai"` vs `type: "alertPersisted"`)
- `server/src/akamaiConfig.ts` — Akamai stream registry + per-tile matcher
- `server/src/livestreamService.ts` — FH2 live-stream/start
- `server/src/ntfyService.ts` — ntfy push bridge. Bucket-coalesces real
  alert bursts. Also exposes `sendRaw({ attach })` and `uploadFile()` for
  the Overview's "forward selected via ntfy" flow (photo goes via `Attach`
  header, video is PUT as an attachment message).
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
- `src/App.tsx` — routes + `AlertInboxProvider` wrapper so the header bell,
  Incidents list, and any future alert consumer share ONE `useAlertInbox`
  instance (WS subscription, unread count, ack ts) via context.
- `src/lib/alertInboxContext.tsx` — provider + `useAlertInboxContext()` hook.
- `src/lib/useAlertInbox.ts` — seeds from `/api/alerts`, subscribes to WS
  `alertPersisted` events, exposes `state / ackAll / clear / refresh`.
  After each new WS alert it schedules a `load()` in ~6.5 s so
  photoUrl/videoUrl materialize once the ffmpeg captures land.
- `src/lib/useStatusSummary.ts` — polls `/api/status/summary` every 7 s.
- `src/components/Header/NotificationsBell.tsx` + `.css` — bell with unread
  badge, dropdown listing recent alerts with LIVE indicator, "Mark all
  read", and a "Open Live view →" footer. Consumes the shared inbox.
- `src/components/Dashboard/Dashboard.tsx` — Overview page. Stat grid, system
  status, incidents, telemetry, notifications-sent — all data-bound.
- `src/components/Dashboard/SystemStatus.tsx` + `.css` — 7-cell status card
  (MQTT, Dock, M4TD, Live streams, AI worker, Thermal SDK, Notifications)
  with per-cell state dot + a right-side overall health pill.
- `src/components/Dashboard/TelemetryStrip.tsx` + `.css` — aircraft telemetry
  grid (battery, altitude, speed, wind, heading, position, lifetime).
  Interprets lat=lon=0 as "in dock".
- `src/components/Dashboard/IncidentsList.tsx` + `.css` — multi-select list
  of today's alerts. Row = checkbox + media thumbnail (falls back to a
  colored class icon when no media) + class/trigger/URGENT badge + meta.
  Toolbar: `Forward`, `Clear`, `Seed`. Notice bar for feedback.
- `src/components/Dashboard/AlertPreviewModal.tsx` + `.css` — modal with the
  JPEG snapshot + inline `<video>` for the 5 s clip. ESC/backdrop closes.
- `src/components/Dashboard/NotificationsPanel.tsx` + `.css` — real recent
  ntfy sends (from `/api/notifications/recent`) with a "not configured"
  and "nothing sent yet" empty state.
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
  longer carries a `mode` field. New: `StatusSummary`, `StoredAlert`
  (includes `photoUrl`/`videoUrl`), `NtfySentEntry`, plus fetchers
  `fetchStatusSummary`, `fetchAlerts`, `ackAllAlerts`, `clearAlerts`,
  `forwardAlerts`, `seedTestAlerts`, `fetchRecentNtfy`.

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
- Frontend WebSocket subscribes to the `thermal` channel; two message types
  flow over it:
  - `type: "ai"` — every frame, with detections + non-persisted alerts.
    Consumed by `AiDetectionsOverlay` on the Live view for the box overlay.
  - `type: "alertPersisted"` — only when an alert fires. Carries a full
    `StoredAlert` (with `photoUrl` / `videoUrl` if capture succeeded).
    Consumed by `useAlertInbox` for the header bell + Overview list.
- Every persisted alert is written to `server/data/alerts.log` (JSONL) and
  paired with a JPEG + 5 s MP4 in `server/data/alert-media/` — see the
  "Overview page + persistent AI alerts" section for the full flow.

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

## Overview page + persistent AI alerts

The Overview page (`src/pages/Home.tsx` → `Dashboard`) is entirely data-bound.
It renders four sections:

1. **Today's summary** — 4 stat cards: Flights today (FH2 `listTasks` for
   today), Incidents found (alertStore `todayCount`), Notified (ntfy
   `sentToday`), Live streams (Akamai N/M ready).
2. **System status** — 7 cells, matching the Aircraft telemetry card's
   grammar. Overall health pill on the right (`healthy` / `degraded` /
   `issues` / `offline`), driven by whichever cell is worst.
3. **Incidents** — today's alert rows from the shared inbox. Multi-select
   with checkbox + Select-all; toolbar has Forward, Clear, Seed. Clicking a
   thumbnail or the Preview button opens `AlertPreviewModal` with the JPEG
   snapshot + inline `<video>` for the 5 s clip.
4. **Aircraft telemetry** + **Notifications sent** side-by-side at the
   bottom. Telemetry reads from `mergedOsdHost(aircraftSn)`; notifications
   panel polls `/api/notifications/recent` (a ring of the last 50 real
   pushes — only bucket-flushed alerts count, not test-button sends).

The whole page shares ONE `useStatusSummary()` poll (7 s) and ONE
`useAlertInbox()` instance (provided at App root). Header bell + Overview
Incidents list read from the same inbox context so clearing/acking from one
place stays in sync everywhere.

### Alert data flow (real detection → persisted → UI)

1. Python worker emits JSON alerts on stdout; `aiWorker.ts` reads them.
2. `aiWorker`:
   - Calls `ntfy.ingestAlerts(...)` to bucket-coalesce (10 s window) and push.
   - Calls `alertStore.ingest(...)`, which:
     - Assigns each burst a shared `mediaId` (one photo + one video per
       *frame*, not per alert)
     - Fires `alertMediaService.captureForAlert(mediaId)` — two ffmpegs
       against the AI tap's current RTMP: 1-frame JPEG + 5 s `-c copy` MP4
     - Appends each alert record to `server/data/alerts.log` (JSONL) and
       to the in-memory ring (max 500)
   - Broadcasts `{ type: "alertPersisted", data: <StoredAlert with URLs> }`
     on the WS `thermal` channel.
3. Frontend `useAlertInbox`:
   - Seeds from `GET /api/alerts?limit=100` on mount.
   - On each new WS `alertPersisted`, prepends to state.
   - If `mediaId != null && photoUrl == null`, schedules a `load()` refetch
     in ~6.5 s so URLs materialize once ffmpeg finishes writing the MP4.

### Alert routes (index.ts)

- `GET  /api/alerts?since=&limit=` → `{ alerts, ackTs, unreadCount }`
- `POST /api/alerts/ack-all` → bumps ack ts to now
- `POST /api/alerts/clear` — body `{ ids?: string[], all?: true }`. Rewrites
  the JSONL file; deletes any media whose `mediaId` is no longer referenced.
- `POST /api/alerts/forward` — body `{ ids: string[], url?: string }`.
  For each id: POSTs the text message with an `Attach` header pointing at
  `<PUBLIC_MEDIA_BASE>/api/alerts/<id>/photo.jpg`, then PUTs the MP4 as an
  attachment message (`ntfy.uploadFile`). Errors per id are collected and
  returned; a partial failure still counts the survivors as sent.
- `POST /api/alerts/test-seed` — dev helper; body `{ count: N }` (1..20).
  Inserts fake records via `alertStore.seedForTest()` with mediaId=null so
  no ffmpeg is spawned. Used by the Overview toolbar's Seed button.
- `GET  /api/alerts/:id/photo.jpg`
- `GET  /api/alerts/:id/video.mp4`
- `GET  /api/status/summary` (the Overview polls this)
- `GET  /api/notifications/recent` (last 50 real ntfy sends)

### Forwarding photo attachments via ntfy

For inline photos to render on the phone, ntfy.sh needs to fetch the URL in
the `Attach` header. `http://localhost:4000/...` won't be reachable from
ntfy's servers. Set `PUBLIC_MEDIA_BASE=https://<your public base>` in
`server/.env` (a Cloudflare tunnel, a reverse proxy, etc.) and inline
photos will land. The video PUT attachment is uploaded directly as the
request body, so it doesn't need `PUBLIC_MEDIA_BASE`.

## System log

Separate from the AI alert log (`alerts.log` — detections only), the system
log ([server/src/logger.ts](../server/src/logger.ts)) is a persisted record
of everything the *server itself* did: every HTTP request, MQTT connect /
reconnect / drop, AI worker start / crash / restart, ntfy send + errors,
alert ingest + clear, thermal anchor captures, threshold changes, and any
uncaught exception. This is what you pull after a field test to reconstruct
what happened and when — not just "an alert fired" but "the MQTT broker
dropped at 14:32:07 and the AI worker restarted 3 times before recovering."

Every server module logs through `logger.{debug,info,warn,error}(source,
message, data?)` instead of calling `console.*` directly — grep for
`console\.` in `server/src` before adding new server code; anything that
should be part of the record belongs in `logger`, not a bare `console.log`.

**Storage**: JSONL, one file per UTC day at
`server/data/logs/system-YYYY-MM-DD.log` (same append-only pattern as
`alerts.log`). Unlike `alerts.log`, this one rotates on its own — files
older than `LOG_RETENTION_DAYS` (default 30) are deleted on the next
day-rollover, so it's safe to leave the server running indefinitely.
An in-memory ring (last 2000 entries) backs fast reads without touching
disk.

**Levels**: `debug` / `info` / `warn` / `error`. `LOG_LEVEL` (default
`info`) only filters what prints to the *console* — every level is always
written to disk, since the entire point is "persist everything," not
"print everything." Set `LOG_LEVEL=debug` (or `MQTT_LOG=1` for raw MQTT
payload tracing specifically) when you need the noisy path during
debugging.

**Reading logs**:
- `GET /api/logs?since=&limit=&level=&source=` — fast in-memory query
  (server-uptime window only; use the file endpoints below for history
  from before the last restart).
- `GET /api/logs/files` — list available day files with byte sizes.
- `GET /api/logs/files/:day` (e.g. `2026-09-22`) — downloads that day's
  raw JSONL file. This is the one to grab after a field test.

There's no frontend viewer for this yet — it's `curl`/browser-only for now.
A System-log panel on the Overview page (tailing `/api/logs`) would be a
reasonable follow-up if operators want to watch it live instead of pulling
files after the fact.

**Crash safety**: `index.ts` installs `process.on("uncaughtException"/
"unhandledRejection")` handlers that log the error (with stack) to the
system log and then `process.exit(1)` — same crash behavior Node would have
had anyway (Node terminates on both by default), just with the reason
persisted first instead of only appearing in whatever terminal happened to
be scrolled back far enough.

Env vars: `LOG_DATA_DIR` (default `server/data/logs`), `LOG_LEVEL` (default
`info`), `LOG_RETENTION_DAYS` (default `30`).

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

### `mergedOsdHost(sn)` — read this before writing any dock/aircraft reader

DJI sends TWO OSD payload variants for the dock on the SAME topic
(`thing/product/<sn>/osd`):
- **Device state** — `mode_code`, `cover_state`, `drone_in_dock`,
  `sub_device.device_sn`, `humidity`, `environment_temperature`, etc.
- **Hardware / power** — `acdc_power_input`, `working_current`,
  `job_number`, `backup_battery`, `drone_battery_maintenance_info`, etc.

`mqttHub.osd(sn)` returns the LAST raw payload, so whichever variant you
happen to read at any moment is missing the other variant's fields. The
old code that used `osd()` for status/telemetry read `null` half the time.

`mqttHub.mergedOsdHost(sn)` returns `{ ts, host }` where `host` is a
shallow-merged view of every OSD payload's `data.host.*` seen so far. Use
this any time you want "the current dock/aircraft state" and don't care
which variant it came from. Reserve `osd()` for consumers that need one
specific variant intact (e.g., `/api/thermal/osd` picks the block that
carries `thermal_global_temperature_*`).

## Environment vars in `server/.env`

Key ones (don't need to touch unless credentials rotate):

- `FH2_BASE_URL`, `FH2_USER_TOKEN`, `FH2_PROJECT_UUID` — FlightHub 2 auth
- `MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_CLIENT_ID`,
  `MQTT_DOCK_SN` — HiveMQ + dock SN
- `AI_PYTHON=python` — Windows default; leave as-is
- `DEIM_ROOT`, `DEIM_CONFIG_*`, `DEIM_WEIGHT_*` — DEIMv2 paths (see above)
- `THERMAL_SDK_BIN` — DJI Thermal SDK binary
- `NTFY_URL`, `NTFY_TOKEN`, `NTFY_LINK` — ntfy primary topic + auth + tap
  URL. Also see the "Overview page + persistent AI alerts" section.
- `PUBLIC_MEDIA_BASE` (optional) — public origin ntfy.sh can reach for
  fetching photo URLs in the `Attach` header when forwarding an incident.
  E.g., `https://uavrt.your-tunnel.example`. Falls back to
  `http://localhost:<PORT>` (unreachable from ntfy.sh, so inline photos
  will silently not render on the phone). Videos are PUT directly and
  don't need this.
- `ALERTS_DATA_DIR` (optional) — override where `alerts.log`,
  `alerts.ack.json`, and `alert-media/` live. Defaults to `server/data/`.
- `LOG_DATA_DIR`, `LOG_LEVEL`, `LOG_RETENTION_DAYS` (all optional) — see
  "System log" above. Defaults: `server/data/logs/`, `info`, `30`.

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
7. **`alerts.log` + `alert-media/` rotation** ([server/src/alertStore.ts](../server/src/alertStore.ts))
   — the log grows unbounded (ring is capped at 500 in memory, but the file
   is append-only). At ~200 bytes per record + one JPEG + one MP4 per burst,
   this fills disk fast in a busy scene. Rotate the log at N MB or N days;
   sweep `alert-media/` for files whose mediaId is no longer referenced by
   the ring. `alertStore.clear()` already handles the on-demand case; this
   is about the "leave it running for a week" case.
8. **Set `PUBLIC_MEDIA_BASE`** before relying on the "forward with photo"
   flow in the field — without it, ntfy can't fetch inline photos.
9. **Second AI worker for split view (optional)** — one worker + one tap
   per pane so both cameras get inference simultaneously. Non-trivial:
   Python worker needs stream keying, WS broadcast needs pane routing.
10. **"Notified" stat + Notifications-sent panel don't count Forwarded
    incidents** — only bucket-flushed real alerts land in the sent-log. If
    you want forwards to show up there too, wire the forward route through
    `ntfy.recordSend()` after each successful push.

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
- **The Overview page has no mock data anywhere.** Stat cards, System
  status, Incidents list, Aircraft telemetry, Notifications-sent —
  everything is fed by `/api/status/summary`, `/api/alerts`, or
  `/api/notifications/recent`. If a widget shows "—" it means the
  underlying signal is genuinely null; don't paper over it with a fake.
- **Alert media capture uses `-c copy`.** MediaMTX already streams H.264
  with SPS/PPS; a re-encode would eat CPU and add latency per burst. Copy
  means each 5 s clip costs ~zero CPU and lands in under a second past its
  `-t 5` window. If the source ever changes codecs, revisit.
- **DJI dock OSD comes in TWO variants on the same topic** (device state +
  hardware). `mqttHub.mergedOsdHost(sn)` layers them; never read fields
  directly from `mqttHub.osd(sn)` unless you know you want one specific
  variant intact. See the MQTT status section.
- **Shared alert inbox via context.** `AlertInboxProvider` at `App.tsx`
  owns the ONE `useAlertInbox` instance; header bell + Overview incidents
  list consume it via `useAlertInboxContext()`. Don't ever call
  `useAlertInbox()` directly from a component — you'll get a duplicate WS
  subscription and out-of-sync state.
- **Forward via ntfy sends a text message + a follow-up video PUT.** The
  photo rides along on the text message via the `Attach` header URL, so it
  requires `PUBLIC_MEDIA_BASE` to be reachable from ntfy.sh's servers. The
  video is uploaded directly as a second message's PUT body — no public
  URL needed.

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
