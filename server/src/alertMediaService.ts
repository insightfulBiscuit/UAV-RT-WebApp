import { spawn } from "node:child_process";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { aiFrameTap } from "./aiFrameTap.js";
import { logger } from "./logger.js";

/**
 * Capture a JPEG snapshot + a short MP4 clip for a given alert batch.
 *
 * We reuse the RTMP path the AI tap is already reading from — MediaMTX
 * happily supports multiple concurrent readers on the same path, so
 * ffmpeg here can pull from `rtmp://localhost:1935/<streamKey>` without
 * disturbing the tap.
 *
 * If the tap isn't running (no active stream), we skip capture and the
 * alert simply has no attached media.
 */

const DATA_DIR = process.env.ALERTS_DATA_DIR
  ?? join(process.cwd(), "data");
const MEDIA_DIR = join(DATA_DIR, "alert-media");
const VIDEO_DURATION_S = 5;
const CAPTURE_TIMEOUT_MS = 15_000;

function ensureDir(): void {
  mkdirSync(MEDIA_DIR, { recursive: true });
}

export function mediaDir(): string {
  return MEDIA_DIR;
}

export function photoPath(mediaId: string): string {
  return join(MEDIA_DIR, `${mediaId}.jpg`);
}

export function videoPath(mediaId: string): string {
  return join(MEDIA_DIR, `${mediaId}.mp4`);
}

export function photoExists(mediaId: string): boolean {
  return existsSync(photoPath(mediaId));
}

export function videoExists(mediaId: string): boolean {
  return existsSync(videoPath(mediaId));
}

export function deleteMedia(mediaId: string): void {
  for (const p of [photoPath(mediaId), videoPath(mediaId)]) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }
}

/**
 * Kick off a photo + video capture for a mediaId. Runs in the background;
 * caller doesn't await. If the ffmpeg spawn fails or the tap isn't running,
 * no files are written and the alert simply has no media.
 */
export function captureForAlert(mediaId: string): void {
  const tap = aiFrameTap.status();
  if (!tap.rtmpUrl) {
    // No live stream to pull from — skip.
    logger.debug("alertMedia", `skipping capture for ${mediaId} — no active RTMP source`);
    return;
  }
  logger.debug("alertMedia", `capturing photo+clip for ${mediaId}`);
  ensureDir();

  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const rtmp = tap.rtmpUrl;

  // Two ffmpegs in parallel. Snapshot is fast; video takes VIDEO_DURATION_S.
  runSnapshot(ffmpeg, rtmp, photoPath(mediaId));
  runClip(ffmpeg, rtmp, videoPath(mediaId));
}

function runSnapshot(ffmpeg: string, rtmp: string, outPath: string): void {
  const args = [
    "-y",
    "-loglevel", "error",
    "-rw_timeout", "5000000",
    "-i", rtmp,
    "-frames:v", "1",
    "-f", "image2",
    outPath,
  ];
  spawnBounded(ffmpeg, args, `[alert-snap ${outPath}]`);
}

function runClip(ffmpeg: string, rtmp: string, outPath: string): void {
  // -c copy avoids re-encoding — MediaMTX already streams H.264 with SPS/PPS,
  // so we just wrap ~5 s of packets into an MP4. Copy also means near-zero
  // CPU per capture, which matters if bursts fire many alerts.
  const args = [
    "-y",
    "-loglevel", "error",
    "-rw_timeout", "5000000",
    "-t", String(VIDEO_DURATION_S),
    "-i", rtmp,
    "-c", "copy",
    "-movflags", "+faststart",
    outPath,
  ];
  spawnBounded(ffmpeg, args, `[alert-clip ${outPath}]`);
}

function spawnBounded(cmd: string, args: string[], tag: string): void {
  const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
  const kill = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }, CAPTURE_TIMEOUT_MS);
  child.stderr?.on("data", (buf: Buffer) => {
    const line = buf.toString("utf8").trim();
    if (line) logger.warn("alertMedia", `${tag} ${line.slice(0, 200)}`);
  });
  child.on("exit", () => clearTimeout(kill));
  child.on("error", (err) => {
    clearTimeout(kill);
    logger.warn("alertMedia", `${tag} spawn failed: ${err.message}`);
  });
}
