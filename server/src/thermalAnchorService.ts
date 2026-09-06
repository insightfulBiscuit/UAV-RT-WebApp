import { mqttHub, type MqttMessage } from "./mqttClient.js";
import { decodeRJpeg, isSdkAvailable, type TemperatureMatrix } from "./thermalSdkService.js";
import { wsHub } from "./wsHub.js";
import type { Fh2Config } from "./fh2Client.js";
import { acquireControl } from "./livestreamService.js";
import { listMediaForDevice } from "./mediaService.js";

/**
 * "Anchor" = a ground-truth thermal snapshot with a full per-pixel matrix,
 * obtained by triggering a thermal photo on the M4TD, downloading the R-JPEG
 * that lands in the Media Library, and decoding it with the DJI Thermal SDK.
 *
 * These anchors are used to calibrate the browser's live palette-inversion
 * math (Option 1 in the design). The frontend consumes them via WebSocket.
 */

export type AnchorSummary = {
  id: string;
  capturedAt: number;
  width: number;
  height: number;
  min: number;
  max: number;
  mean: number;
  source: "sdk" | "mock";
  /** downsampled preview for the UI: 80x64 float32 as regular array */
  preview: number[];
  previewWidth: number;
  previewHeight: number;
};

class AnchorService {
  private latest: TemperatureMatrix | null = null;
  private autoCapture = false;
  private intervalMs = 8000;
  private timer: ReturnType<typeof setInterval> | null = null;
  private capturing = false;
  private aircraftSn: string | null = null;
  private cameraIndex = "99-0-0";

  status() {
    return {
      autoCapture: this.autoCapture,
      intervalMs: this.intervalMs,
      hasAnchor: !!this.latest,
      lastCapturedAt: this.latest?.capturedAt ?? null,
      lastSource: this.latest?.source ?? null,
      aircraftSn: this.aircraftSn,
      cameraIndex: this.cameraIndex,
    };
  }

  setTarget(aircraftSn: string, cameraIndex: string) {
    this.aircraftSn = aircraftSn;
    this.cameraIndex = cameraIndex;
  }

  setAutoCapture(cfg: Fh2Config, on: boolean, intervalMs?: number) {
    this.autoCapture = on;
    // Minimum 2s cadence. DJI's actual photo-capture round-trip is ~4-8s so
    // requests below that will queue and effectively run at the drone's max
    // rate. We still let the operator ask for 2s — the pipeline handles
    // overlapping requests correctly by rejecting a new capture while one is
    // in flight (see captureOnce).
    if (typeof intervalMs === "number" && intervalMs >= 2000) {
      this.intervalMs = intervalMs;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (on) {
      this.timer = setInterval(() => {
        void this.captureOnce(cfg).catch((err) =>
          console.warn(`anchor auto-capture failed: ${(err as Error).message}`),
        );
      }, this.intervalMs);
    }
  }

  /**
   * Full capture pipeline. Returns a compact summary; the full matrix is
   * broadcast over WebSocket to clients on the "thermal" channel.
   */
  async captureOnce(cfg: Fh2Config): Promise<AnchorSummary> {
    if (this.capturing) throw new Error("An anchor capture is already in flight");
    if (!this.aircraftSn) throw new Error("aircraftSn not set — pick a thermal camera first");
    if (!mqttHub.configured() || !mqttHub.status().connected) {
      throw new Error("MQTT not connected");
    }
    this.capturing = true;
    const t0 = Date.now();
    try {
      // 1) Fire a photo-take command via MQTT to the dock. The dock forwards
      //    to the aircraft. Method / payload shape follows DJI Cloud API v1.
      const dockSn = process.env.MQTT_DOCK_SN;
      if (!dockSn) throw new Error("MQTT_DOCK_SN not set");
      // Acquire flight/payload control first — several DJI Cloud API camera
      // services silently no-op unless the caller owns the aircraft.
      try {
        await acquireControl(cfg, {
          droneSn: this.aircraftSn,
          payloadIndex: [this.cameraIndex],
        });
      } catch (err) {
        console.warn(`acquireControl failed (continuing): ${(err as Error).message}`);
      }

      // DJI Cloud API v1: for a dock+aircraft product, camera services can be
      // addressed at EITHER the dock SN (relays over OcuSync) OR the aircraft
      // SN directly. Fire both and take whichever succeeds first.
      const targets = [this.aircraftSn, dockSn].filter(
        (v, i, a) => v && a.indexOf(v) === i,
      ) as string[];
      const invokes = targets.map((sn) =>
        mqttHub
          .invoke(sn, "camera_photo_take", { payload_index: this.cameraIndex }, 6000)
          .catch((err) => {
            console.warn(`camera_photo_take on ${sn} failed: ${(err as Error).message}`);
            return null;
          }),
      );
      await Promise.race(invokes).catch(() => null);

      // 2) Wait for the R-JPEG to appear in the FH2 Media Library (~2-5s).
      const url = await waitForFreshMediaUrl(cfg, this.aircraftSn, t0 - 5, 25000);
      if (!url) throw new Error("Timed out waiting for the R-JPEG to appear in Media Library");

      // 3) Download and decode.
      const res = await fetch(url);
      if (!res.ok) throw new Error(`R-JPEG download failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const matrix = await decodeRJpeg(buf);

      // 4) Cache + broadcast.
      this.latest = matrix;
      const summary = this.toSummary(matrix);
      wsHub.broadcast("thermal", { type: "anchor", anchor: summary });
      return summary;
    } finally {
      this.capturing = false;
    }
  }

  getLatestSummary(): AnchorSummary | null {
    return this.latest ? this.toSummary(this.latest) : null;
  }

  private toSummary(m: TemperatureMatrix): AnchorSummary {
    // Downsample for the UI preview. Simple box filter.
    const previewW = 80;
    const previewH = 64;
    const preview = new Array<number>(previewW * previewH);
    const stepX = m.width / previewW;
    const stepY = m.height / previewH;
    for (let y = 0; y < previewH; y++) {
      for (let x = 0; x < previewW; x++) {
        const sx = Math.floor(x * stepX);
        const sy = Math.floor(y * stepY);
        preview[y * previewW + x] = m.data[sy * m.width + sx];
      }
    }
    return {
      id: `anchor-${m.capturedAt}`,
      capturedAt: m.capturedAt,
      width: m.width,
      height: m.height,
      min: m.min,
      max: m.max,
      mean: m.mean,
      source: m.source,
      preview,
      previewWidth: previewW,
      previewHeight: previewH,
    };
  }
}

export const anchorService = new AnchorService();

/** Poll the Media Library for a media item newer than `sinceUnixSec`. */
async function waitForFreshMediaUrl(
  cfg: Fh2Config,
  sn: string,
  sinceUnixSec: number,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const to = Math.floor(Date.now() / 1000) + 60;
  const from = sinceUnixSec;
  while (Date.now() < deadline) {
    try {
      const list = await listMediaForDevice(cfg, { sn, from, to });
      const fresh = list.find(
        (m) => new Date(m.create_at).getTime() / 1000 > sinceUnixSec && m.original_url,
      );
      if (fresh) return fresh.original_url;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

// Also listen for `file_upload_progress` MQTT events; when the dock reports
// a completed upload we can short-circuit the polling above.
mqttHub.on("message", (msg: MqttMessage) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = msg.payload as any;
  const method = payload?.method;
  if (
    typeof method === "string" &&
    (method === "file_upload_progress" || method === "file_upload_callback")
  ) {
    // Only used as a hint; the media-list poll still owns the URL discovery.
    wsHub.broadcast("thermal", { type: "upload_progress", raw: payload });
  }
});

void isSdkAvailable();
