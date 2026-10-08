import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "./logger.js";

/**
 * ffmpeg-driven RTMP frame tap. Consumes the same stream MediaMTX is
 * publishing and emits raw BGR24 frames at a target FPS/resolution.
 *
 * The `start()` argument is an RTMP path key (e.g. "m4td_thermal"). It is
 * appended to `RTMP_PLAYBACK_URL_BASE` (defaults to `rtmp://localhost:1935`)
 * to form the pull URL. That base MUST match the actual MediaMTX path layout
 * — if the base ends in "/live" and the path is at the root, ffmpeg gets a
 * 404 that it swallows into an EOF loop. We default to the root now so the
 * standard `paths: { m4td_thermal: ... }` layout Just Works.
 *
 * On ffmpeg exit (which happens whenever FH2 Share rotates publishers on the
 * upstream RTMP source — see the "FH2 Share publisher rotation" section of
 * docs/handoff.md), we auto-respawn on a small backoff so the AI pipeline
 * survives the same hand-off gaps the WHEP player does.
 *
 * Optional env:
 *   FFMPEG_BIN     path to ffmpeg (default: "ffmpeg" in PATH)
 *   FFMPEG_LOG=1   print ffmpeg's stderr to console
 */

const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 480;
const FRAME_FPS = 5;
const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3;

const RESPAWN_BACKOFF_MS = 750;

export type TapStatus = {
  running: boolean;
  streamKey: string | null;
  rtmpUrl: string | null;
  frameCount: number;
  lastFrameAt: number | null;
  startedAt: number | null;
  ffmpegPid: number | null;
  lastError: string | null;
  restarts: number;
};

class AiFrameTap extends EventEmitter {
  private child: ChildProcess | null = null;
  private streamKey: string | null = null;
  private rtmpUrl: string | null = null;
  private frameCount = 0;
  private lastFrameAt: number | null = null;
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private restarts = 0;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private wantRunning = false;

  status(): TapStatus {
    return {
      running: this.wantRunning,
      streamKey: this.streamKey,
      rtmpUrl: this.rtmpUrl,
      frameCount: this.frameCount,
      lastFrameAt: this.lastFrameAt,
      startedAt: this.startedAt,
      ffmpegPid: this.child?.pid ?? null,
      lastError: this.lastError,
      restarts: this.restarts,
    };
  }

  start(streamKey: string): TapStatus {
    this.stop();
    this.wantRunning = true;
    this.streamKey = streamKey;
    this.frameCount = 0;
    this.restarts = 0;
    this.startedAt = Date.now();
    logger.info("aiTap", `starting tap on stream "${streamKey}"`);
    this.spawnFfmpeg();
    return this.status();
  }

  stop(): TapStatus {
    if (this.wantRunning) logger.info("aiTap", `stopping tap on stream "${this.streamKey}"`);
    this.wantRunning = false;
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
    if (this.child) {
      try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.child = null;
    this.streamKey = null;
    this.rtmpUrl = null;
    this.startedAt = null;
    return this.status();
  }

  private spawnFfmpeg(): void {
    if (!this.wantRunning || !this.streamKey) return;
    const base = process.env.RTMP_PLAYBACK_URL_BASE
      || process.env.RTMP_PUSH_URL_BASE
      || "rtmp://localhost:1935";
    const rtmpUrl = `${base.replace(/\/+$/, "")}/${this.streamKey}`;
    const bin = process.env.FFMPEG_BIN || "ffmpeg";
    this.rtmpUrl = rtmpUrl;

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

    let buf: Buffer = Buffer.alloc(0);
    child.stdout!.on("data", (chunk: Buffer) => {
      buf = buf.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      while (buf.byteLength >= FRAME_BYTES) {
        const frame = buf.subarray(0, FRAME_BYTES);
        buf = buf.subarray(FRAME_BYTES);
        this.frameCount++;
        this.lastFrameAt = Date.now();
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
      const s = d.toString().trim();
      if (process.env.FFMPEG_LOG === "1") logger.debug("aiTap", s);
      if (/error|failed|Invalid|Unable/i.test(s)) {
        this.lastError = s.slice(-500);
        logger.warn("aiTap", `ffmpeg stderr: ${s.slice(-500)}`);
      }
    });

    child.on("exit", (code, signal) => {
      logger.info("aiTap", `ffmpeg exited (code=${code} signal=${signal})`);
      this.child = null;
      if (!this.wantRunning) return;
      // FH2 Share's publisher rotation causes ffmpeg to EOF ~every 10-15s
      // even when everything is healthy. Auto-respawn to bridge the gap.
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        this.restarts++;
        this.spawnFfmpeg();
      }, RESPAWN_BACKOFF_MS);
    });
  }
}

export const aiFrameTap = new AiFrameTap();
