/// <reference lib="webworker" />

import { buildInverseLut } from "./thermalPalettes";

/**
 * Web Worker: turns a video frame into a temperature matrix + hot-region mask.
 *
 * Pipeline:
 *   1. Main thread posts an ImageBitmap + palette id + range (min/max) +
 *      optional calibration curve.
 *   2. Worker inverts the palette voxel-grid to recover a normalized 0..1
 *      thermal index per pixel.
 *   3. Applies the calibration curve to translate normalized → °C.
 *   4. Builds a hot-mask (pixels above `threshold`°C).
 *   5. Posts back the matrix + mask (as transferable ArrayBuffers).
 */

type PostIn = {
  type: "frame";
  seq: number;
  bitmap: ImageBitmap;
  paletteId: number;
  min: number;
  max: number;
  /** optional linear calibration: t_actual = a * t_inferred + b */
  calibA?: number;
  calibB?: number;
  threshold: number;
};

type PostOut =
  | { type: "matrix"; seq: number; width: number; height: number; temps: Float32Array; hotMask: Uint8ClampedArray; stats: { min: number; max: number; mean: number } }
  | { type: "error"; seq: number; message: string };

const cache: { paletteId: number; inv: Uint8Array } = {
  paletteId: -1,
  inv: new Uint8Array(0),
};

self.onmessage = (evt: MessageEvent<PostIn>) => {
  const msg = evt.data;
  if (!msg || msg.type !== "frame") return;
  try {
    const { bitmap, paletteId, min, max, calibA = 1, calibB = 0, threshold, seq } = msg;

    // Downsample the video frame to a fixed grid so worker cost is stable
    // across viewport sizes. 320x180 is plenty for hot-spot detection.
    const w = 320;
    const h = 180;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h).data;
    bitmap.close?.();

    if (cache.paletteId !== paletteId) {
      cache.paletteId = paletteId;
      cache.inv = buildInverseLut(paletteId);
    }
    const inv = cache.inv;

    const range = Math.max(1e-6, max - min);
    const temps = new Float32Array(w * h);
    const hotMask = new Uint8ClampedArray(w * h * 4);

    let tMin = Infinity;
    let tMax = -Infinity;
    let tSum = 0;

    for (let i = 0, p = 0; i < img.length; i += 4, p++) {
      const r = img[i] >> 3;
      const g = img[i + 1] >> 3;
      const b = img[i + 2] >> 3;
      const idx = inv[(r << 10) | (g << 5) | b];
      const norm = idx / 255;
      const inferredC = min + norm * range;
      const t = calibA * inferredC + calibB;
      temps[p] = t;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
      tSum += t;

      if (t >= threshold) {
        // Red tint proportional to how hot
        const heat = Math.min(1, (t - threshold) / Math.max(5, threshold * 0.3));
        hotMask[i] = 255;
        hotMask[i + 1] = Math.round(80 * (1 - heat));
        hotMask[i + 2] = 0;
        hotMask[i + 3] = Math.round(120 + 100 * heat);
      } else {
        hotMask[i] = 0;
        hotMask[i + 1] = 0;
        hotMask[i + 2] = 0;
        hotMask[i + 3] = 0;
      }
    }

    const out: PostOut = {
      type: "matrix",
      seq,
      width: w,
      height: h,
      temps,
      hotMask,
      stats: { min: tMin, max: tMax, mean: tSum / temps.length },
    };
    (self as unknown as Worker).postMessage(out, [temps.buffer, hotMask.buffer]);
  } catch (err) {
    const out: PostOut = { type: "error", seq: msg.seq, message: (err as Error).message };
    (self as unknown as Worker).postMessage(out);
  }
};

export {};
