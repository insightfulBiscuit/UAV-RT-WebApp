# AI inference worker

Python subprocess spawned by the Node backend. Consumes BGR24 frames on stdin,
emits detection + alert JSON on stdout. Broadcasts to browsers via the existing
WebSocket hub.

No mock detector exists — the worker requires DEIMv2 + CUDA and refuses to
start otherwise. This is by design: the system operates real or not at all.

## Install (CUDA host)

```bash
# 1. PyTorch matching your CUDA driver
python -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124

# 2. DEIMv2 supporting deps
python -m pip install numpy opencv-python-headless pyyaml transformers \
                     faster-coco-eval scipy tensorboard calflops

# 3. Delivery folder in the repo (see repo root .gitignore)
#    deimv2/
#      DEIMv2/                # codebase
#      new_models/*.pth       # trained weights (~1.3 GB, not tracked)
#      third_party/dji_thermal_sdk/   # DJI SDK for R-JPEG anchors
```

Then in `server/.env`:

```
DEIM_ROOT=<repo>/deimv2
DEIM_CONFIG_RGB=configs/deimv2/deimv2_dinov3_s_dji_10class.yml
DEIM_CONFIG_IR=configs/deimv2/deimv2_dinov3_s_dji_10class.yml
DEIM_WEIGHT_RGB=new_models/deimv2_dinov3_s_dji_rgb_50e_best_stg2.pth
DEIM_WEIGHT_IR=new_models/deimv2_dinov3_s_dji_ir_50e_best_stg2.pth
```

Restart the API server (`tsx watch` picks up `.env` on restart).

## Class list + thresholds

Class list copied verbatim from H30T's `config/product_config.json` — see
`config.py`.

10 classes (in this order — matches DEIMv2's dataset):
`vehicle, tree, metal_fixture, green_grass, dry_grass, person, tent_tarp,
plastic_waste, fire, smoke`

Alert triggers:
- **fire, smoke** → always alert on detection (no temperature threshold)
- **person** → alert if box temp ≥ 75°C
- **vehicle** → alert if box temp ≥ 110°C
- **tree / tent_tarp / plastic_waste / dry_grass** → alert if box temp ≥ 60°C
- Any other class → escalating tiers at 80/90/110°C

Cooldown per (class, spatial-box-key) = 5.1 s. Persistence = 3 consecutive
frames.

## Notes

- Temperature fusion is a placeholder in `build_temp_lookup`. The frontend
  attaches temps from the palette-inversion overlay for now. Full per-box
  temperature from R-JPEG anchors is a future upgrade.
- The Node wrapper (`server/src/aiWorker.ts`) auto-restarts the worker on
  crash with exponential backoff. If the crash is a config/env issue, the
  restart will fail the same way and `lastError` in the API status shows it.
