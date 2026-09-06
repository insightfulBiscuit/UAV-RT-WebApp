# `akamai-tile-routing-e2e`

End-to-end test of the multi-stream Akamai relay routing, using a **synthetic
RTMP publisher** so we don't need the coworker's read credentials.

The test proves:

1. The Akamai registry loads config correctly.
2. Per-tile lookup picks the most specific matching relay.
3. Streams with `CHANGEME_` placeholders in their source URL correctly return
   503, and the frontend toggle disables itself for them.
4. A "ready" stream serves WHEP through our local MediaMTX and the browser
   plays it.
5. The AI frame tap can consume the same RTMP path server-side.

## Prerequisites

- MediaMTX running locally on ports 1935/8889 (already up from earlier
  sessions — `/opt/homebrew/opt/mediamtx/bin/mediamtx docker/mediamtx/mediamtx.yml`)
- API + Vite servers running
- `ffmpeg` on `PATH`

## Runner

```bash
bash scratchpad/akamai_e2e/run.sh
```

The runner:
1. Points the backend at `scratchpad/akamai_e2e/akamai-streams.test.json`
   (via `AKAMAI_STREAMS_CONFIG`) — one entry maps the M4TD Wide tile to
   `rtmp://localhost:1935/test_akamai`.
2. Starts an ffmpeg process publishing a test pattern to that path.
3. Restarts the API server so it picks up the test config.
4. Curls the endpoints to verify shape.
5. Prints instructions for the browser check.

## What to verify in the browser

Open http://localhost:5173/live and:

1. **M4TD Wide tile** — the Akamai button in the header shows as ENABLED
   (`Akamai` label, not greyed out).
2. **M4TD Thermal or Zoom tile** — the Akamai button shows as DISABLED
   (tooltip: "Registered but source URL still has CHANGEME_ placeholders").
3. **Dock 3 tiles** — Akamai button DISABLED (same reason).
4. Click M4TD Wide, click **Akamai** — button label changes to `Akamai ON`,
   the video pane switches to the ffmpeg-generated test pattern (color bars
   + moving text).
5. Click any other tile — Akamai auto-disables (safety guard).

## Programmatic checks

The runner also verifies these `curl` responses:

- `GET /api/livestream/akamai/status` → `readyStreams: 1`
- `GET /api/livestream/akamai/list` → one entry, `ready: true`
- `GET /api/livestream/akamai/for-tile?aircraftSn=1581F8HGX264P00A1P3U&cameraIndex=99-0-0&lens=wide`
  → 200 with `whepUrl: http://localhost:8889/test_akamai/whep`
- `GET /api/livestream/akamai/for-tile?aircraftSn=1581F8HGX264P00A1P3U&cameraIndex=99-0-0&lens=ir`
  → 404 (no match — the test config only has `wide`)
- `GET http://localhost:9997/v3/paths/list` (MediaMTX API) → path
  `test_akamai` is `ready: true` with an `rtmpConn` publisher.

## Restore production config

The runner reverts the API to the default config on stop. Otherwise:

```bash
kill $(lsof -ti :4000)  # kill test API
cd server && npx tsx watch src/index.ts  # restart with default config
```
