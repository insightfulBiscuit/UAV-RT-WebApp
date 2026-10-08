import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * System-wide structured logger.
 *
 * Every server module logs through here instead of `console.*` directly, so
 * there is ONE persisted, queryable record of everything the system did —
 * MQTT connects/drops, AI worker lifecycle, alert ingestion, ntfy sends,
 * thermal anchor captures, threshold changes, HTTP requests, and any
 * uncaught error. This is what you pull after a field test to reconstruct
 * what happened when something looked wrong on the day.
 *
 * Storage: JSONL, one file per UTC day at `server/data/logs/system-YYYY-MM-DD.log`
 * (same pattern as `alertStore`'s `alerts.log`). Files older than
 * LOG_RETENTION_DAYS (default 30) are pruned once per day-rollover.
 * An in-memory ring (last 2000 entries) backs the fast `/api/logs` query path
 * without touching disk.
 *
 * LOG_LEVEL (default "info") only filters what prints to the console —
 * every level is still written to disk, since the point of this module is
 * "persist everything," not "print everything."
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  data?: unknown;
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const DATA_DIR = process.env.LOG_DATA_DIR ?? join(process.cwd(), "data", "logs");
const CONSOLE_LEVEL: LogLevel =
  process.env.LOG_LEVEL && process.env.LOG_LEVEL in LEVEL_ORDER
    ? (process.env.LOG_LEVEL as LogLevel)
    : "info";
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) > 0
  ? Number(process.env.LOG_RETENTION_DAYS)
  : 30;
const RING_MAX = 2000;

function ensureDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

function dayStamp(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function pathForDay(day: string): string {
  return join(DATA_DIR, `system-${day}.log`);
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

class Logger {
  private ring: LogEntry[] = [];
  private currentDay = "";

  private write(entry: LogEntry, day: string): void {
    try {
      ensureDir();
      appendFileSync(pathForDay(day), JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      // Can't recurse into logger.error here (would loop on a persistent
      // disk failure) — fall back to console directly.
      console.error(`[logger] append failed: ${(err as Error).message}`);
    }
  }

  private prune(): void {
    try {
      ensureDir();
      const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
      for (const name of readdirSync(DATA_DIR)) {
        const m = name.match(/^system-(\d{4}-\d{2}-\d{2})\.log$/);
        if (!m) continue;
        const t = Date.parse(m[1]);
        if (Number.isFinite(t) && t < cutoff) {
          try { unlinkSync(join(DATA_DIR, name)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  log(level: LogLevel, source: string, message: string, data?: unknown): void {
    const ts = Date.now();
    const entry: LogEntry = { ts, level, source, message, ...(data !== undefined ? { data } : {}) };

    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring.shift();

    const day = dayStamp(new Date(ts));
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.prune(); // once per day-rollover, not once per write
    }
    this.write(entry, day);

    if (LEVEL_ORDER[level] >= LEVEL_ORDER[CONSOLE_LEVEL]) {
      const time = new Date(ts).toLocaleTimeString();
      const prefix = `[${time}] ${level.toUpperCase().padEnd(5)} [${source}]`;
      const line = data !== undefined ? `${prefix} ${message} ${safeStringify(data)}` : `${prefix} ${message}`;
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(line);
    }
  }

  debug(source: string, message: string, data?: unknown): void { this.log("debug", source, message, data); }
  info(source: string, message: string, data?: unknown): void { this.log("info", source, message, data); }
  warn(source: string, message: string, data?: unknown): void { this.log("warn", source, message, data); }
  error(source: string, message: string, data?: unknown): void { this.log("error", source, message, data); }

  /** Fast in-memory query — backs `GET /api/logs`. Most-recent first. */
  recent(opts?: { limit?: number; level?: LogLevel; source?: string; since?: number }): LogEntry[] {
    const limit = Math.max(1, Math.min(RING_MAX, opts?.limit ?? 200));
    let items = this.ring;
    if (opts?.since) items = items.filter((e) => e.ts >= opts.since!);
    if (opts?.level) items = items.filter((e) => LEVEL_ORDER[e.level] >= LEVEL_ORDER[opts.level!]);
    if (opts?.source) items = items.filter((e) => e.source === opts.source);
    return items.slice(-limit).reverse();
  }

  /** On-disk day files available for download, oldest first. */
  listFiles(): Array<{ day: string; bytes: number }> {
    try {
      ensureDir();
      return readdirSync(DATA_DIR)
        .map((name) => name.match(/^system-(\d{4}-\d{2}-\d{2})\.log$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => ({ day: m[1], bytes: statSync(pathForDay(m[1])).size }))
        .sort((a, b) => a.day.localeCompare(b.day));
    } catch {
      return [];
    }
  }

  /** Raw JSONL content for one day file — used by the download route. */
  readDay(day: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const p = pathForDay(day);
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }
}

export const logger = new Logger();
