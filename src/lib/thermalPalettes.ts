/**
 * DJI thermal-camera palette lookup tables (LUTs).
 *
 * The DJI Thermal SDK's `thermal_current_palette_style` field (in the aircraft
 * OSD) uses these ids — verified against `dji_irp --palette=<name>`:
 *   0 white_hot   1 fulgurite   2 iron_red    3 hot_iron    4 medical
 *   5 arctic      6 rainbow1    7 rainbow2    8 tint        9 black_hot
 *
 * The LUTs below were **empirically extracted** by rendering the shipped
 * M4T sample R-JPEGs through the SDK with each palette and reversing
 * (temperature → RGB) → LUT. Source data in
 * `scratchpad/thermal_sdk_val/djiPalettes.json`.
 *
 * Not all 10 palettes are populated yet — only the three we can verify with
 * the shipped samples (0, 2, 9). Others fall back to white_hot (0).
 */

// Real DJI LUTs sampled from the M4T dataset (see comment above).
import djiPalettes from "../assets/djiPalettes";

export type PaletteId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

function makeWhiteHot(): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    lut[i * 3 + 0] = i;
    lut[i * 3 + 1] = i;
    lut[i * 3 + 2] = i;
  }
  return lut;
}

function makeBlackHot(): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = 255 - i;
    lut[i * 3 + 0] = v;
    lut[i * 3 + 1] = v;
    lut[i * 3 + 2] = v;
  }
  return lut;
}

function loadDjiLut(name: "white_hot" | "iron_red" | "black_hot"): Uint8Array {
  const arr = (djiPalettes as Record<string, number[][]>)[name];
  if (!Array.isArray(arr)) return makeWhiteHot();
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = arr[i] ?? [0, 0, 0];
    lut[i * 3 + 0] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

const LUTS: Record<number, Uint8Array> = {
  0: loadDjiLut("white_hot"),
  1: makeBlackHot(),               // "fulgurite" not extracted yet — fallback
  2: loadDjiLut("iron_red"),
  9: loadDjiLut("black_hot"),
  // 3-8 fall back to white_hot in getPaletteLut() below
};

export function getPaletteLut(paletteId: number): Uint8Array {
  return LUTS[paletteId] ?? LUTS[0];
}

/**
 * Build the inverse LUT: RGB → 0..1 normalized index.
 *
 * We precompute a 32³ voxel grid keyed by (r>>3, g>>3, b>>3). Each voxel
 * stores the palette index whose LUT entry is closest to that RGB triple.
 * At inversion time we look up the voxel in O(1). The voxel granularity
 * (5 bits per channel = 8 units) is a good balance between memory and
 * quantization error for 8-bit video.
 */
export function buildInverseLut(paletteId: number): Uint8Array {
  const lut = getPaletteLut(paletteId);
  const grid = new Uint8Array(32 * 32 * 32);
  for (let vr = 0; vr < 32; vr++) {
    for (let vg = 0; vg < 32; vg++) {
      for (let vb = 0; vb < 32; vb++) {
        const rTarget = (vr << 3) | 0x04;
        const gTarget = (vg << 3) | 0x04;
        const bTarget = (vb << 3) | 0x04;
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < 256; i++) {
          const dr = lut[i * 3 + 0] - rTarget;
          const dg = lut[i * 3 + 1] - gTarget;
          const db = lut[i * 3 + 2] - bTarget;
          // Weighted per BT.601 luminance; matches how H.264 preserves detail
          const d = 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db;
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        grid[(vr << 10) | (vg << 5) | vb] = best;
      }
    }
  }
  return grid;
}
