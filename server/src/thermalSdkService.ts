import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Wrapper around DJI Thermal SDK v1.8 `dji_irp` binary.
 *
 * Expected env:
 *   THERMAL_SDK_BIN  — absolute path to `dji_irp` (or `dji_irp.exe` on Windows)
 *   THERMAL_SDK_LIB  — LD_LIBRARY_PATH for the shared libs (Linux)
 *
 * If the binary is not available the anchor pipeline refuses to run — no
 * mock fallback, by design.
 */

export type TemperatureMatrix = {
  width: number;
  height: number;
  /** row-major float32; length = width * height; degrees Celsius */
  data: Float32Array;
  min: number;
  max: number;
  mean: number;
  source: "sdk";
  capturedAt: number;
};

const SDK_BIN = process.env.THERMAL_SDK_BIN || "dji_irp";
const SDK_LIB = process.env.THERMAL_SDK_LIB || "";
let sdkAvailable: boolean | null = null;

/** Cheap probe — checks whether the binary can be spawned at all. */
export async function isSdkAvailable(): Promise<boolean> {
  if (sdkAvailable !== null) return sdkAvailable;
  return new Promise((resolve) => {
    execFile(SDK_BIN, ["--version"], { timeout: 3000 }, (err) => {
      sdkAvailable = !err;
      if (!sdkAvailable) {
        console.warn(
          `Thermal SDK binary not found (tried "${SDK_BIN}"). ` +
            `Set THERMAL_SDK_BIN to a valid dji_irp path. Anchor decoding is disabled until then.`,
        );
      }
      resolve(!!sdkAvailable);
    });
  });
}

/**
 * Decode an R-JPEG buffer into a temperature matrix.
 *
 * The `dji_irp` utility reads an R-JPEG and writes a raw float32 or int16
 * temperature grid (depending on flags). We use `-a measure -s <input> -o <output>`
 * which writes float32 CxHxW. Width/height come from the R-JPEG's EXIF or
 * from a fixed 640x512 assumption for the M4TD IR sensor.
 */
export async function decodeRJpeg(rjpegBuf: Buffer): Promise<TemperatureMatrix> {
  const available = await isSdkAvailable();
  if (!available) {
    throw new Error(
      `DJI Thermal SDK binary unavailable (tried "${SDK_BIN}"). ` +
        `Set THERMAL_SDK_BIN in server/.env before capturing anchors.`,
    );
  }

  const stamp = randomUUID().slice(0, 12);
  const inputPath = join(tmpdir(), `rjpeg-${stamp}.jpg`);
  const outputPath = join(tmpdir(), `rjpeg-${stamp}.raw`);
  writeFileSync(inputPath, rjpegBuf);

  try {
    await new Promise<void>((resolve, reject) => {
      const env = SDK_LIB ? { ...process.env, LD_LIBRARY_PATH: SDK_LIB } : process.env;
      execFile(
        SDK_BIN,
        ["-s", inputPath, "-a", "measure", "-o", outputPath],
        { timeout: 10000, env },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`dji_irp failed: ${stderr || err.message}`));
          resolve();
        },
      );
    });

    if (!existsSync(outputPath)) throw new Error("dji_irp produced no output");
    const raw = readFileSync(outputPath);

    // DJI Thermal SDK v1.8 `measure` action writes INT16 (little-endian) where
    // each unit = 0.1 °C. Sensor is 640×512 on M3T/M3TD/M4T. Verified by
    // running dji_irp against `dataset/M4T/DJI_0001_R.JPG` — output was
    // 655360 bytes = 640 × 512 × 2.
    const width = 640;
    const height = 512;
    const expectedBytes = width * height * 2;
    if (raw.byteLength < expectedBytes) {
      throw new Error(`dji_irp output smaller than expected (${raw.byteLength} < ${expectedBytes})`);
    }
    const int16 = new Int16Array(raw.buffer, raw.byteOffset, width * height);
    const data = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) data[i] = int16[i] / 10.0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return {
      width,
      height,
      data,
      min,
      max,
      mean: sum / data.length,
      source: "sdk",
      capturedAt: Date.now(),
    };
  } finally {
    for (const p of [inputPath, outputPath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch { /* ignore */ }
    }
  }
}
