"""
Round-trip validation of palette inversion.

For each M4T sample:
  1. Get the ground-truth temperature matrix (dji_irp -a measure)
  2. Get the rendered BGR24 image (dji_irp -a process --palette=iron_red)
  3. Run OUR palette-inversion logic (using the real DJI LUT) on the render
  4. Measure the recovery error against ground truth
"""

import json
import numpy as np
from pathlib import Path

W, H = 640, 512
OUT = Path("/Volumes/Dnl_512_SSD/Github/UAV-RT-WebApp/scratchpad/thermal_sdk_val/out")
LUTS = json.loads(
    Path("/Volumes/Dnl_512_SSD/Github/UAV-RT-WebApp/src/assets/djiPalettes.json").read_text()
)


def build_inverse_lut(lut_rgb: np.ndarray) -> np.ndarray:
    """Voxel grid keyed by (r>>3, g>>3, b>>3) → nearest palette idx."""
    grid = np.zeros(32 * 32 * 32, dtype=np.uint8)
    for vr in range(32):
        for vg in range(32):
            for vb in range(32):
                target = np.array([(vr << 3) | 4, (vg << 3) | 4, (vb << 3) | 4], dtype=np.int32)
                d = 0.3 * (lut_rgb[:, 0] - target[0]) ** 2 \
                  + 0.59 * (lut_rgb[:, 1] - target[1]) ** 2 \
                  + 0.11 * (lut_rgb[:, 2] - target[2]) ** 2
                grid[(vr << 10) | (vg << 5) | vb] = d.argmin()
    return grid


def invert_frame(bgr: np.ndarray, inv_lut: np.ndarray, tmin: float, tmax: float) -> np.ndarray:
    """Same math as the Web Worker in src/lib/thermalInversionWorker.ts."""
    rgb = bgr[:, [2, 1, 0]]  # BGR → RGB
    idx_lookup = ((rgb[:, 0] >> 3).astype(np.int32) << 10) \
               | ((rgb[:, 1] >> 3).astype(np.int32) << 5) \
               |  (rgb[:, 2] >> 3).astype(np.int32)
    palette_idx = inv_lut[idx_lookup]
    norm = palette_idx.astype(np.float32) / 255.0
    return tmin + norm * (tmax - tmin)


for palette_name in ("white_hot", "iron_red", "black_hot"):
    print(f"\n== Palette: {palette_name} ==")
    lut = np.array(LUTS[palette_name], dtype=np.uint8)
    inv_lut = build_inverse_lut(lut)

    for i in range(1, 6):
        temps = np.fromfile(OUT / f"M4T_{i}.raw", dtype=np.int16).astype(np.float32) / 10.0
        bgr = np.fromfile(OUT / f"M4T_{i}_{palette_name}.rgb", dtype=np.uint8).reshape(-1, 3)

        # DJI renders using ADAPTIVE min/max per frame → use them here.
        # In production we get these from OSD (thermal_global_temperature_min/max).
        tmin, tmax = temps.min(), temps.max()
        recovered = invert_frame(bgr, inv_lut, tmin, tmax)

        err = np.abs(recovered - temps)
        print(f"  M4T_{i} ({tmin:6.1f} → {tmax:6.1f}°C, spread {tmax-tmin:4.1f}): "
              f"avg |Δ|={err.mean():4.2f}°C  p95={np.percentile(err, 95):4.2f}°C  "
              f"max={err.max():5.2f}°C")
