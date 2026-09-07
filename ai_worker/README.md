# AI inference worker

Python subprocess spawned by the Node backend. Consumes BGR24 frames on stdin,
emits detection + alert JSON on stdout. Broadcasts to browsers via the existing
WebSocket hub.

## Runtime modes (`AI_MODE` env)

- **`mock`** — random-ish plausible boxes. No PyTorch / CUDA / weights needed.
  Use it on any dev box for pipeline validation.
- **`real`** — real DEIMv2 on CUDA. Fails hard if weights or CUDA missing.
- **`auto`** — try real, fall back to mock. **Default.**

## Install on a CUDA host (`AI_MODE=real`)

```bash
# 1. Install PyTorch matching your CUDA version
#    https://pytorch.org/get-started/locally/
pip install torch==2.4.0 torchvision==0.19.0 --index-url https://download.pytorch.org/whl/cu121

# 2. Rest of the deps
pip install -r requirements.txt

# 3. Get the DEIMv2 codebase (from the H30T delivery — see readme in that zip)
git clone <path-or-tarball-of-DEIMv2> /opt/deimv2

# 4. Drop the .pth weights somewhere accessible
mkdir -p /opt/deimv2/new_models
cp /path/to/deimv2_dinov3_s_dji_ir_50e_best_stg2.pth  /opt/deimv2/new_models/
cp /path/to/deimv2_dinov3_s_dji_rgb_50e_best_stg2.pth /opt/deimv2/new_models/

# 5. Point the worker at them via env
export DEIM_ROOT=/opt/deimv2
export DEIM_WEIGHT_IR=/opt/deimv2/new_models/deimv2_dinov3_s_dji_ir_50e_best_stg2.pth
export DEIM_WEIGHT_RGB=/opt/deimv2/new_models/deimv2_dinov3_s_dji_rgb_50e_best_stg2.pth
```

Then when starting the API server, those env vars need to be present. Add them
to `server/.env` (which `dotenv/config` loads), or export them in the shell.

## Test standalone (without Node)

```bash
cd ai_worker
AI_MODE=mock python3 inference_worker.py < /dev/null
# → logs "modality=rgb mode=mock" then blocks reading stdin.
```

To exercise the actual detection loop, pipe a raw BGR24 stream in:

```bash
ffmpeg -re -f lavfi -i "testsrc2=size=640x480:rate=5" \
       -pix_fmt bgr24 -f rawvideo - 2>/dev/null | \
python3 -c "
import struct, sys, json
w, h = 640, 480
frame_bytes = w * h * 3
seq = 0
while True:
    buf = sys.stdin.buffer.read(frame_bytes)
    if len(buf) < frame_bytes: break
    hdr = json.dumps({'w': w, 'h': h, 'seq': seq, 'ts': seq*200, 'modality':'rgb'}) + '\n'
    sys.stdout.buffer.write(hdr.encode())
    sys.stdout.buffer.write(buf)
    sys.stdout.buffer.flush()
    seq += 1
" | AI_MODE=mock python3 inference_worker.py 2>ai.log
```

You should see JSON lines with `detections: [...]` scroll by.

## Class list + thresholds

Copied verbatim from H30T's `config/product_config.json` — see `config.py`.

10 classes (in this order — matches DEIMv2's dataset):
`vehicle, tree, metal_fixture, green_grass, dry_grass, person, tent_tarp,
plastic_waste, fire, smoke`

Alert triggers:
- **fire, smoke** → always alert on detection (no temperature threshold)
- **person** → alert if box temp ≥ 75°C
- **vehicle** → alert if box temp ≥ 110°C
- **tree / tent_tarp / plastic_waste / dry_grass** → alert if box temp ≥ 60°C
- Any other class → escalating tiers at 80/90/110°C

Cooldown per (class, spatial-box-key) = 5.1s. Persistence = 3 consecutive frames.

## Notes

- Temperature fusion is placeholder in `build_temp_lookup`. The frontend
  attaches temps from the palette-inversion overlay for now. Full per-box
  temperature from R-JPEG anchors is a future upgrade.
- The Node wrapper (`server/src/aiWorker.ts`) auto-restarts the worker on
  crash with exponential backoff.
