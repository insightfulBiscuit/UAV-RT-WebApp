import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";

const CACHE_DIR = join(tmpdir(), "uavrt-thumbs");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
}

function ffprobe(inputPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", inputPath], (err) => {
      resolve(!err);
    });
  });
}

function extractFrame(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-i", inputPath,
        "-vframes", "1",
        "-ss", "0.5",
        "-vf", "scale=480:-2",
        "-q:v", "4",
        outputPath,
      ],
      { timeout: 15000 },
      (err) => {
        if (err) {
          execFile(
            "ffmpeg",
            ["-y", "-i", inputPath, "-vframes", "1", "-vf", "scale=480:-2", "-q:v", "4", outputPath],
            { timeout: 15000 },
            (err2) => (err2 ? reject(err2) : resolve()),
          );
        } else {
          resolve();
        }
      },
    );
  });
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; UAV-RT/1.0)" },
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  if (!res.body) throw new Error("Empty response body");
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

export async function generateThumbnail(mediaUrl: string): Promise<Buffer> {
  const hash = urlHash(mediaUrl);
  const cachedJpeg = join(CACHE_DIR, `${hash}.jpg`);

  if (existsSync(cachedJpeg)) {
    return readFileSync(cachedJpeg);
  }

  const ext = mediaUrl.split("?")[0].split(".").pop()?.toLowerCase() ?? "bin";
  const tempInput = join(CACHE_DIR, `${hash}_src.${ext}`);

  try {
    await downloadToFile(mediaUrl, tempInput);

    const valid = await ffprobe(tempInput);
    if (!valid) throw new Error("ffprobe could not read the file");

    await extractFrame(tempInput, cachedJpeg);
    return readFileSync(cachedJpeg);
  } finally {
    try {
      const { unlinkSync } = await import("node:fs");
      if (existsSync(tempInput)) unlinkSync(tempInput);
    } catch {}
  }
}
