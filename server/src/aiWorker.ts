import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { aiFrameTap } from "./aiFrameTap.js";
import { wsHub } from "./wsHub.js";

/** Find the ai_worker/ directory regardless of cwd. */
function resolveAiWorkerDir(): string {
  if (process.env.AI_WORKER_DIR) return resolve(process.env.AI_WORKER_DIR);
  // Try cwd and one level up (server/).
  for (const rel of ["ai_worker", "../ai_worker", "../../ai_worker"]) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(join(p, "inference_worker.py"))) return p;
  }
  return resolve(process.cwd(), "ai_worker");
}

/**
 * Owner of the Python AI inference subprocess.
 *
 * Pipes BGR24 frames from `aiFrameTap` into the worker's stdin (with a JSON
 * header line per frame), reads back one JSON line per frame containing
 * detections + alerts, and broadcasts them over WebSocket on the `ai`
 * channel.
 *
 * Auto-restarts the worker if it crashes, with exponential backoff.
 */

type WorkerStatus = {
  running: boolean;
  modality: "rgb" | "ir";
  mode: "auto" | "real" | "mock";
  framesSent: number;
  framesReceived: number;
  lastDetectionAt: number | null;
  lastAlertAt: number | null;
  pid: number | null;
  lastError: string | null;
  latencyMsP50: number | null;
};

class AiWorker {
  private child: ChildProcess | null = null;
  private modality: "rgb" | "ir" = "rgb";
  private mode: "auto" | "real" | "mock" = "auto";
  private framesSent = 0;
  private framesReceived = 0;
  private lastDetectionAt: number | null = null;
  private lastAlertAt: number | null = null;
  private lastError: string | null = null;
  private latencies: number[] = [];
  private reader: Interface | null = null;
  private frameSubscribed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private frameHandler: ((f: any) => void) | null = null;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = 0;
  private maxInflight = 3;

  status(): WorkerStatus {
    const p50 =
      this.latencies.length > 0
        ? this.latencies.slice().sort((a, b) => a - b)[Math.floor(this.latencies.length / 2)]
        : null;
    return {
      running: !!this.child,
      modality: this.modality,
      mode: this.mode,
      framesSent: this.framesSent,
      framesReceived: this.framesReceived,
      lastDetectionAt: this.lastDetectionAt,
      lastAlertAt: this.lastAlertAt,
      pid: this.child?.pid ?? null,
      lastError: this.lastError,
      latencyMsP50: p50,
    };
  }

  start(modality: "rgb" | "ir", mode: "auto" | "real" | "mock" = "auto"): WorkerStatus {
    if (this.child) this.stop();
    this.modality = modality;
    this.mode = mode;
    this.framesSent = 0;
    this.framesReceived = 0;
    this.lastError = null;
    this.latencies = [];
    this.inflight = 0;

    const python = process.env.AI_PYTHON || "python3";
    const cwd = resolveAiWorkerDir();
    const env = {
      ...process.env,
      AI_MODALITY: modality,
      AI_MODE: mode,
    };

    const child = spawn(python, ["inference_worker.py"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr!.on("data", (buf: Buffer) => {
      const line = buf.toString("utf8").trim();
      if (line) console.log(`[ai_worker] ${line}`);
    });

    this.reader = createInterface({ input: child.stdout! });
    this.reader.on("line", (line) => this.onWorkerLine(line));

    child.on("exit", (code, signal) => {
      console.warn(`[ai_worker] exited code=${code} signal=${signal}`);
      this.child = null;
      this.reader = null;
      this.unsubscribeFrames();
      if (code !== 0 && code !== null) {
        this.scheduleRestart();
      }
    });

    // Subscribe to frames.
    this.subscribeFrames();
    return this.status();
  }

  stop(): WorkerStatus {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.unsubscribeFrames();
    if (this.child) {
      try {
        this.child.stdin?.end();
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    this.child = null;
    this.reader = null;
    return this.status();
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    this.restartAttempt++;
    const delay = Math.min(30_000, 500 * 2 ** this.restartAttempt);
    console.warn(`[ai_worker] scheduling restart in ${delay}ms (attempt ${this.restartAttempt})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start(this.modality, this.mode);
    }, delay);
  }

  private subscribeFrames(): void {
    if (this.frameSubscribed) return;
    this.frameSubscribed = true;
    this.frameHandler = (frame: {
      width: number;
      height: number;
      data: Buffer;
      seq: number;
      ts: number;
    }) => this.pushFrame(frame);
    aiFrameTap.on("frame", this.frameHandler);
  }

  private unsubscribeFrames(): void {
    if (!this.frameSubscribed) return;
    this.frameSubscribed = false;
    if (this.frameHandler) {
      aiFrameTap.off("frame", this.frameHandler);
    }
    this.frameHandler = null;
  }

  private pushFrame(frame: {
    width: number;
    height: number;
    data: Buffer;
    seq: number;
    ts: number;
  }): void {
    if (!this.child?.stdin) return;
    // Simple backpressure — drop frames if the worker is falling behind.
    if (this.inflight >= this.maxInflight) return;

    const header = JSON.stringify({
      w: frame.width,
      h: frame.height,
      seq: frame.seq,
      ts: frame.ts,
      modality: this.modality,
    }) + "\n";

    try {
      this.child.stdin.write(header);
      this.child.stdin.write(frame.data);
      this.framesSent++;
      this.inflight++;
    } catch (err) {
      this.lastError = `write failed: ${(err as Error).message}`;
    }
  }

  private onWorkerLine(line: string): void {
    if (!line.trim()) return;
    let msg: {
      seq: number;
      ts: number;
      latency_ms: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      detections: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      alerts: any[];
    };
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn(`[ai_worker] non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    this.framesReceived++;
    this.inflight = Math.max(0, this.inflight - 1);

    if (typeof msg.latency_ms === "number") {
      this.latencies.push(msg.latency_ms);
      if (this.latencies.length > 60) this.latencies.shift();
    }
    if (msg.detections?.length) this.lastDetectionAt = Date.now();
    if (msg.alerts?.length) this.lastAlertAt = Date.now();

    wsHub.broadcast("thermal", {
      type: "ai",
      seq: msg.seq,
      ts: msg.ts,
      latencyMs: msg.latency_ms,
      modality: this.modality,
      detections: msg.detections ?? [],
      alerts: msg.alerts ?? [],
    });
  }
}

export const aiWorker = new AiWorker();
