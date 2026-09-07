# `ai-integration-e2e`

End-to-end test of the AI inference pipeline. Uses `AI_MODE=mock` so it runs
without CUDA / weights — validates plumbing on any dev machine.

## Prereqs

- API + Vite + MediaMTX all up
- Something publishing to the M4TD Wide path (FH2 Share, or ffmpeg test pattern)
- Python 3.10+ on PATH
- `pip install numpy opencv-python-headless` on the Python that Node will spawn

## Steps

### 1. Confirm the pipeline compiles and boots

```bash
curl -s http://localhost:4000/api/ai/worker/status | python3 -m json.tool
```

Expected: `{"running": false, "modality": "rgb", ...}`.

### 2. Publish something to feed the tap

If FH2 is already pushing M4TD Wide, skip this. Otherwise:

```bash
ssh root@172.232.174.165 "grep M4TD_WIDE_PUB_PW ~/.mediamtx_pws"
ffmpeg -re -f lavfi -i "testsrc2=size=640x480:rate=15" -c:v libx264 -preset ultrafast \
  -f flv "rtmp://172.232.174.165:1935/live/m4td_wide?user=m4td_wide_pub&pass=<pw>"
```

### 3. Open the browser, click M4TD Wide, click "AI" button

http://localhost:5173/live → click M4TD Wide tile → click the new **AI** button in
the header (spinning icon means it's active). This chain-starts:

1. The RTMP frame tap (`aiFrameTap`) if not already running
2. The Python worker (`inference_worker.py` with `AI_MODE=auto` → mock on Mac)

The button label should transition: `AI` → `AI · 3` → `AI · 12` (frame count).

### 4. Verify detection boxes render

Bounding boxes should appear on the video within ~2 seconds. Each box shows
`class · conf%`. On the mock detector these will be nonsense classes (person,
vehicle, fire, tree) drifting slowly across random positions.

### 5. Verify alerts fire

Any `fire` or `smoke` mock detection immediately triggers a red **toast pop-up**
in the top-right corner. It auto-dismisses after 8s. Real classes with
temperature triggers (person > 75°C, etc.) require the palette-inversion
overlay to attach `temp_c` — not exercised in mock.

### 6. Verify status

```bash
curl -s http://localhost:4000/api/ai/worker/status | python3 -m json.tool
```

Expected fields worth checking:
- `running: true`
- `framesSent > 0` and `framesReceived > 0` (matched within a couple of frames)
- `latencyMsP50` around 5-20 ms for mock (would be 30-80 on CUDA-small model)
- `lastDetectionAt` recently updated
- `lastAlertAt` populated if a mock `fire`/`smoke` fired

### 7. Stop the AI

Click the AI button again. Backend stops both the tap and the Python subprocess.
Status flips back to `running: false`.

## Switching to real DEIMv2 (CUDA host)

After following the install steps in `ai_worker/README.md`:

```bash
export DEIM_ROOT=/opt/deimv2
export DEIM_WEIGHT_IR=/opt/deimv2/new_models/deimv2_dinov3_s_dji_ir_50e_best_stg2.pth
export DEIM_WEIGHT_RGB=/opt/deimv2/new_models/deimv2_dinov3_s_dji_rgb_50e_best_stg2.pth
export AI_MODE=real
# restart the API server so it inherits the env
```

Then start the AI button on a real (M4TD Thermal or Wide) tile with actual drone
video. Detections should follow real objects.

## Files added/changed for this test

- `ai_worker/` — whole subtree
- `server/src/aiWorker.ts` — spawns Python, pipes frames, reads detections
- `server/src/index.ts` — 3 routes: `/api/ai/worker/{status,start,stop}`
- `src/lib/api.ts` — AI types + fetchers
- `src/components/Livestream/AiDetectionsOverlay.tsx` — canvas box overlay
- `src/components/Livestream/Livestream.tsx` — AI button + overlay wiring
- `src/components/Alerts/AlertToasts.tsx` + `.css` — toast popups
- `src/App.tsx` — mount `<AlertToasts />`
