import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * ffmpeg-driven RTMP frame tap. Consumes the same RTMP stream MediaMTX is
 * ingesting from FH2 and emits raw BGR24 frames at a target FPS/resolution
 * ready to hand to a Python AI worker or an in-process ONNX runtime later.
 *
 * This is a SCAFFOLD — no inference wired yet. It counts frames and exposes
 * the running state so we can prove the video pipeline works end-to-end
 * before adding the AI worker.
 *
 * Required env:
 *   RTMP_PLAYBACK_URL_BASE   e.g. rtmp://localhost:1935/live
 *                            (defaults to RTMP_PUSH_URL_BASE)
 *
 * Optional env:
 *   FFMPEG_BIN               path to ffmpeg (default: "ffmpeg" in PATH)
 *   FFMPEG_LOG=1             print ffmpeg's stderr to console
 */

const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 480;
const FRAME_FPS = 5;
const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3;

export type TapStatus = {
  running: boolean;
  streamKey: string | null;
  rtmpUrl: string | null;
  frameCount: number;
  lastFrameAt: number | null;
  startedAt: number | null;
  ffmpegPid: number | null;
  lastError: string | null;
};

class AiFrameTap extends EventEmitter {
  private child: ChildProcess | null = null;
  private streamKey: string | null = null;
  private rtmpUrl: string | null = null;
  private frameCount = 0;
  private lastFrameAt: number | null = null;
  private startedAt: number | null = null;
  private lastError: string | null = null;

  status(): TapStatus {
    return {
      running: !!this.child,
      streamKey: this.streamKey,
      rtmpUrl: this.rtmpUrl,
      frameCount: this.frameCount,
      lastFrameAt: this.lastFrameAt,
      startedAt: this.startedAt,
      ffmpegPid: this.child?.pid ?? null,
      lastError: this.lastError,
    };
  }

  start(streamKey: string): TapStatus {
    if (this.child) this.stop();

    const base = process.env.RTMP_PLAYBACK_URL_BASE || process.env.RTMP_PUSH_URL_BASE;
    if (!base) {
      this.lastError = "RTMP_PLAYBACK_URL_BASE (or RTMP_PUSH_URL_BASE) not set";
      throw new Error(this.lastError);
    }
    const rtmpUrl = `${base.replace(/\/+$/, "")}/${streamKey}`;
    const bin = process.env.FFMPEG_BIN || "ffmpeg";

    // Grab raw BGR24 frames at a fixed size/fps for stable downstream cost.
    // `-fflags nobuffer` + `-flags low_delay` prioritize latency over quality.
    const args = [
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-rtmp_live", "live",
      "-i", rtmpUrl,
      "-vf", `fps=${FRAME_FPS},scale=${FRAME_WIDTH}:${FRAME_HEIGHT}`,
      "-pix_fmt", "bgr24",
      "-f", "rawvideo",
      "pipe:1",
    ];

    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.streamKey = streamKey;
    this.rtmpUrl = rtmpUrl;
    this.frameCount = 0;
    this.lastFrameAt = null;
    this.startedAt = Date.now();
    this.lastError = null;

    let buf: Buffer = Buffer.alloc(0);
    child.stdout!.on("data", (chunk: Buffer) => {
      buf = buf.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      while (buf.byteLength >= FRAME_BYTES) {
        const frame = buf.subarray(0, FRAME_BYTES);
        buf = buf.subarray(FRAME_BYTES);
        this.frameCount++;
        this.lastFrameAt = Date.now();
        // Emit to any listener — the AI worker will subscribe here.
        this.emit("frame", {
          width: FRAME_WIDTH,
          height: FRAME_HEIGHT,
          pixfmt: "bgr24",
          data: frame,
          seq: this.frameCount,
          ts: this.lastFrameAt,
        });
      }
    });

    child.stderr!.on("data", (d: Buffer) => {
      if (process.env.FFMPEG_LOG === "1") console.log(`[ffmpeg] ${d.toString().trim()}`);
      // Cache the most-recent error-ish line for status reporting.
      const s = d.toString().trim();
      if (/error|failed|Invalid|Unable/i.test(s)) this.lastError = s.slice(-500);
    });

    child.on("exit", (code, signal) => {
      console.log(`ffmpeg frame tap exited (code=${code} signal=${signal})`);
      this.child = null;
      this.streamKey = null;
      this.rtmpUrl = null;
    });

    return this.status();
  }

  stop(): TapStatus {
    if (this.child) {
      try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.child = null;
    return this.status();
  }
}

export const aiFrameTap = new AiFrameTap();
