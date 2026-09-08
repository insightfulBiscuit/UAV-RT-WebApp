# `ai-integration-e2e`

End-to-end test of the real DEIMv2 inference pipeline. No mock exists —
the worker either runs the real detector on CUDA or refuses to start.

## Prereqs

- API + Vite + MediaMTX all up
- Something publishing to an RTMP path — real FH2 Share stream, or a local
  ffmpeg test pattern via `scripts\ai-e2e-test-source.ps1`
- Python 3.12 on PATH (Windows: `python`) with the DEIMv2 dependencies:
  `torch==2.5.1 torchvision==0.20.1 (cu124)`, `numpy`, `opencv-python-headless`,
  `pyyaml`, `transformers`, `faster-coco-eval`, `scipy`, `tensorboard`, `calflops`
- CUDA-capable GPU (Pascal/Volta/Turing/Ampere/Ada), driver >= 525
- The H30T delivery folder at `deimv2/` in the repo root (see `.gitignore`
  for what's ignored; weights and SDK binaries live there but are not tracked)

## Windows quickstart

```powershell
# 1. Start MediaMTX + API + Vite
.\scripts\start-dev.ps1

# 2. Publish a local test pattern (leave running in its own window)
.\scripts\ai-e2e-test-source.ps1

# 3. Confirm the pipeline booted
Invoke-RestMethod http://localhost:4000/api/ai/worker/status | ConvertTo-Json

# 4. Start the frame tap on the 'aitest' stream key
Invoke-RestMethod -Method Post http://localhost:4000/api/ai/tap/start `
  -ContentType 'application/json' -Body '{"streamKey":"aitest"}'

# 5. Start the DEIMv2 worker (RGB weights; use "ir" for thermal tiles)
Invoke-RestMethod -Method Post http://localhost:4000/api/ai/worker/start `
  -ContentType 'application/json' -Body '{"modality":"rgb"}'

# 6. Poll status — first frame lands ~30-40 s after start (model warmup)
Invoke-RestMethod http://localhost:4000/api/ai/worker/status | ConvertTo-Json
```

Then open http://localhost:5173/live and pick a tile. Bounding boxes render
on top of the video within a couple frames of the worker warming up.

## Expected status fields

- `running: true`
- `modality: "rgb"` or `"ir"`
- `framesSent > 0` and `framesReceived` matched within a few frames
- `latencyMsP50` around **30-80 ms** on a small-model / Pascal GPU
- `lastDetectionAt` populated
- `lastAlertAt` populated once a `fire` / `smoke` class detection persists
  across the 3-frame hold window

If the worker fails to load (missing weights, missing DEIM_ROOT, no CUDA),
it exits and `lastError` in the status surfaces the traceback. The frontend
button flips back to idle. There is intentionally no silent fallback.
