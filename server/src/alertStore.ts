import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { captureForAlert, deleteMedia, photoExists, videoExists } from "./alertMediaService.js";
import { logger } from "./logger.js";

/**
 * Persistent AI-alert log.
 *
 * Every alert emitted by the Python worker is stored here so the operator
 * can review what fired even after the transient toast is gone and their
 * phone is asleep. Storage is JSONL on disk (one record per line) plus an
 * in-memory ring buffer of the last N for cheap reads.
 *
 * "Unread" is a single ack-timestamp scalar shared across clients — anything
 * newer than the ack ts counts as unread. Per-alert dismissal is a TODO.
 */

export type StoredAlert = {
  id: string;
  ts: number;
  modality: "rgb" | "ir";
  class: string;
  trigger: string;
  temp_c: number | null;
  conf: number;
  box: [number, number, number, number];
  color: string;
  /** Frame sequence from the worker — useful for cross-referencing. */
  seq: number;
  /**
   * All alerts in one batch (same frame) share a mediaId so we only capture
   * one photo+video per batch. `null` when capture was skipped (e.g. no
   * live RTMP stream at ingest time).
   */
  mediaId: string | null;
};

export type StoredAlertWithMedia = StoredAlert & {
  photoUrl: string | null;
  videoUrl: string | null;
};

const RING_MAX = 500;
const DATA_DIR = process.env.ALERTS_DATA_DIR
  ?? join(process.cwd(), "data");
const LOG_PATH = join(DATA_DIR, "alerts.log");
const ACK_PATH = join(DATA_DIR, "alerts.ack.json");

function ensureDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

function readAck(): number {
  try {
    if (!existsSync(ACK_PATH)) return 0;
    const raw = readFileSync(ACK_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.ackTs === "number" ? parsed.ackTs : 0;
  } catch {
    return 0;
  }
}

function writeAck(ts: number): void {
  ensureDir();
  writeFileSync(ACK_PATH, JSON.stringify({ ackTs: ts }, null, 2), "utf8");
}

function tailFile(path: string, maxLines: number): StoredAlert[] {
  if (!existsSync(path)) return [];
  try {
    // For MVP just read the whole file and take the tail. The ring is capped
    // at 500 and each record is ~200 bytes, so we're talking ~100 KB —
    // reading it once at startup is fine. Rotation is a TODO.
    const raw = readFileSync(path, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const slice = lines.slice(-maxLines);
    const out: StoredAlert[] = [];
    for (const line of slice) {
      try {
        const rec = JSON.parse(line) as StoredAlert;
        if (rec && typeof rec.id === "string" && typeof rec.ts === "number") {
          out.push(rec);
        }
      } catch {
        // skip corrupt lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawAlert = Record<string, any>;

class AlertStore {
  private ring: StoredAlert[] = [];
  private ackTs = 0;
  private listeners = new Set<(a: StoredAlert) => void>();
  private loaded = false;

  private load(): void {
    if (this.loaded) return;
    this.ring = tailFile(LOG_PATH, RING_MAX);
    this.ackTs = readAck();
    this.loaded = true;
  }

  /** Called by aiWorker for every batch of alerts. */
  ingest(alerts: RawAlert[], modality: "rgb" | "ir", seq: number): StoredAlert[] {
    if (!alerts?.length) return [];
    this.load();
    ensureDir();
    const now = Date.now();
    // All alerts in this batch share a mediaId so we capture one clip per
    // frame, not per alert. Skip capture entirely when no live stream is up.
    const mediaId = randomUUID();
    let captured = false;
    try {
      captureForAlert(mediaId);
      captured = true;
    } catch (err) {
      logger.warn("alertStore", `media capture failed: ${(err as Error).message}`);
    }
    const created: StoredAlert[] = [];
    for (const raw of alerts) {
      const rec: StoredAlert = {
        id: randomUUID(),
        ts: now,
        modality,
        class: String(raw.class ?? "unknown"),
        trigger: String(raw.trigger ?? ""),
        temp_c: typeof raw.temp_c === "number" ? raw.temp_c : null,
        conf: typeof raw.conf === "number" ? raw.conf : 0,
        box: Array.isArray(raw.box) && raw.box.length === 4
          ? [raw.box[0], raw.box[1], raw.box[2], raw.box[3]]
          : [0, 0, 0, 0],
        color: typeof raw.color === "string" ? raw.color : "#c83228",
        seq,
        mediaId: captured ? mediaId : null,
      };
      this.ring.push(rec);
      created.push(rec);
      try {
        appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n", "utf8");
      } catch (err) {
        logger.warn("alertStore", `append failed: ${(err as Error).message}`);
      }
    }
    if (this.ring.length > RING_MAX) {
      this.ring.splice(0, this.ring.length - RING_MAX);
    }
    for (const cb of this.listeners) {
      for (const rec of created) cb(rec);
    }
    return created;
  }

  /**
   * Directly insert a fake alert record. Used by the test-seed endpoint so
   * the UI can be tested without waiting for a real detection. Does NOT
   * trigger media capture; callers can pass an existing mediaId to attach
   * a pre-supplied photo/video.
   */
  seedForTest(rec: Omit<StoredAlert, "id" | "ts">): StoredAlert {
    this.load();
    ensureDir();
    const full: StoredAlert = {
      ...rec,
      id: randomUUID(),
      ts: Date.now(),
    };
    this.ring.push(full);
    if (this.ring.length > RING_MAX) {
      this.ring.splice(0, this.ring.length - RING_MAX);
    }
    try {
      appendFileSync(LOG_PATH, JSON.stringify(full) + "\n", "utf8");
    } catch (err) {
      logger.warn("alertStore", `append failed: ${(err as Error).message}`);
    }
    for (const cb of this.listeners) cb(full);
    return full;
  }

  /**
   * Remove alerts by id. Rewrites the log file and deletes any associated
   * media files (whose mediaId is no longer referenced by any surviving
   * alert).
   */
  clear(ids: string[]): { removed: number } {
    if (!ids?.length) return { removed: 0 };
    this.load();
    const idSet = new Set(ids);
    const removedMediaIds = new Set<string>();
    const surviving: StoredAlert[] = [];
    for (const rec of this.ring) {
      if (idSet.has(rec.id)) {
        if (rec.mediaId) removedMediaIds.add(rec.mediaId);
      } else {
        surviving.push(rec);
      }
    }
    const removed = this.ring.length - surviving.length;
    this.ring = surviving;
    this.rewriteLog();
    // Only delete media whose mediaId is no longer referenced by anything
    // still in the ring (batch of alerts sharing a mediaId shouldn't lose
    // their photo just because one sibling was cleared).
    const stillReferenced = new Set(
      surviving.map((r) => r.mediaId).filter((m): m is string => !!m),
    );
    for (const mid of removedMediaIds) {
      if (!stillReferenced.has(mid)) deleteMedia(mid);
    }
    logger.info("alertStore", `cleared ${removed} alert(s)`, { ids });
    return { removed };
  }

  clearAll(): { removed: number } {
    this.load();
    const removed = this.ring.length;
    const mediaIds = new Set(
      this.ring.map((r) => r.mediaId).filter((m): m is string => !!m),
    );
    for (const mid of mediaIds) deleteMedia(mid);
    logger.info("alertStore", `cleared all ${removed} alert(s)`);
    this.ring = [];
    this.rewriteLog();
    return { removed };
  }

  /** Lookup one alert by id — used by the media-serving + forward routes. */
  get(id: string): StoredAlert | null {
    this.load();
    return this.ring.find((r) => r.id === id) ?? null;
  }

  private rewriteLog(): void {
    ensureDir();
    const body = this.ring.map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(LOG_PATH, body ? body + "\n" : "", "utf8");
  }

  /** Returns most recent first, with media URLs resolved for anything present. */
  list(opts?: { since?: number; limit?: number }): StoredAlertWithMedia[] {
    this.load();
    const since = opts?.since ?? 0;
    const limit = Math.max(1, Math.min(RING_MAX, opts?.limit ?? 100));
    const filtered = since
      ? this.ring.filter((r) => r.ts >= since)
      : this.ring.slice();
    return filtered
      .slice(-limit)
      .reverse()
      .map((r) => this.attachMedia(r));
  }

  attachMedia(rec: StoredAlert): StoredAlertWithMedia {
    const mid = rec.mediaId;
    return {
      ...rec,
      photoUrl: mid && photoExists(mid) ? `/api/alerts/${rec.id}/photo.jpg` : null,
      videoUrl: mid && videoExists(mid) ? `/api/alerts/${rec.id}/video.mp4` : null,
    };
  }

  unreadCount(): number {
    this.load();
    return this.ring.reduce((n, r) => (r.ts > this.ackTs ? n + 1 : n), 0);
  }

  todayCount(midnightMs: number): number {
    this.load();
    return this.ring.reduce((n, r) => (r.ts >= midnightMs ? n + 1 : n), 0);
  }

  ackAll(): { ackTs: number; unreadCount: number } {
    this.load();
    this.ackTs = Date.now();
    writeAck(this.ackTs);
    return { ackTs: this.ackTs, unreadCount: 0 };
  }

  getAckTs(): number {
    this.load();
    return this.ackTs;
  }

  onIngest(cb: (a: StoredAlert) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

export const alertStore = new AlertStore();
