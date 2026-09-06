import ThermalWorker from "./thermalInversionWorker?worker";

/**
 * Client-side owner of the palette-inversion pipeline.
 *
 * The controller:
 *   - Runs one worker for palette inversion.
 *   - Subscribes to /ws?channel=thermal for anchor events from the server.
 *   - Fits a simple linear calibration a·t + b when anchors arrive by comparing
 *     the anchor's stats to whatever the inversion currently reports.
 *   - Fires callbacks with the latest matrix + stats + hot-mask.
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
  preview: number[];
  previewWidth: number;
  previewHeight: number;
};

export type MatrixStats = { min: number; max: number; mean: number };

export type MatrixCallback = (data: {
  width: number;
  height: number;
  temps: Float32Array;
  hotMask: Uint8ClampedArray;
  stats: MatrixStats;
  calibA: number;
  calibB: number;
}) => void;

export type ThermalControllerOptions = {
  paletteId: number;
  min: number;
  max: number;
  threshold: number;
};

export class ThermalMatrixController {
  private worker: Worker;
  private seq = 0;
  private lastStats: MatrixStats | null = null;
  private calibA = 1;
  private calibB = 0;
  private opts: ThermalControllerOptions;
  private cb: MatrixCallback | null = null;
  private ws: WebSocket | null = null;
  private anchorCb: ((a: AnchorSummary) => void) | null = null;
  private stopped = false;

  constructor(opts: ThermalControllerOptions) {
    this.opts = opts;
    this.worker = new ThermalWorker();
    this.worker.onmessage = (evt) => {
      const msg = evt.data;
      if (msg?.type === "matrix" && this.cb) {
        this.lastStats = msg.stats;
        this.cb({
          width: msg.width,
          height: msg.height,
          temps: msg.temps,
          hotMask: msg.hotMask,
          stats: msg.stats,
          calibA: this.calibA,
          calibB: this.calibB,
        });
      }
    };
    this.connectWs();
  }

  setOptions(opts: Partial<ThermalControllerOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  onMatrix(cb: MatrixCallback): void {
    this.cb = cb;
  }

  onAnchor(cb: (a: AnchorSummary) => void): void {
    this.anchorCb = cb;
  }

  async ingestFrame(video: HTMLVideoElement): Promise<void> {
    if (!video.videoWidth || !video.videoHeight || video.paused) return;
    const bitmap = await createImageBitmap(video);
    this.seq++;
    this.worker.postMessage(
      {
        type: "frame",
        seq: this.seq,
        bitmap,
        paletteId: this.opts.paletteId,
        min: this.opts.min,
        max: this.opts.max,
        calibA: this.calibA,
        calibB: this.calibB,
        threshold: this.opts.threshold,
      },
      [bitmap],
    );
  }

  /** When a real anchor arrives, fit a linear correction against our current
   *  live inversion stats. This is a first-order calibration; if we need more,
   *  we can move to bin-by-bin lookup. */
  ingestAnchor(a: AnchorSummary): void {
    if (this.lastStats && a.max - a.min > 0.5) {
      // Fit against min/max endpoints.
      const invSpan = Math.max(1e-6, this.lastStats.max - this.lastStats.min);
      const realSpan = a.max - a.min;
      const nextA = realSpan / invSpan;
      const nextB = a.min - nextA * this.lastStats.min;
      // Damp aggressive jumps.
      this.calibA = this.calibA * 0.5 + nextA * 0.5;
      this.calibB = this.calibB * 0.5 + nextB * 0.5;
    }
    this.anchorCb?.(a);
  }

  private connectWs(): void {
    if (this.stopped) return;
    try {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/ws?channel=thermal`;
      this.ws = new WebSocket(url);
      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg?.type === "anchor" && msg.anchor) this.ingestAnchor(msg.anchor);
        } catch { /* ignore */ }
      };
      this.ws.onclose = () => {
        if (this.stopped) return;
        setTimeout(() => this.connectWs(), 3000);
      };
      this.ws.onerror = () => this.ws?.close();
    } catch { /* retry via onclose */ }
  }

  destroy(): void {
    this.stopped = true;
    try { this.ws?.close(); } catch {}
    this.worker.terminate();
  }
}
