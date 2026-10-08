import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { logger } from "./logger.js";

/**
 * ntfy.sh push-notification bridge — multi-topic.
 *
 * Env-configured "primary" topic:
 *   NTFY_URL     full topic URL, e.g. https://ntfy.sh/dji_alert
 *   NTFY_TOKEN   optional Bearer token
 *   NTFY_LINK    optional click-through URL
 *
 * User-configured additional topics are stored in
 * `server/config/ntfy-topics.json` and added/removed via the settings UI.
 * Every alert fans out to the primary topic (if configured) AND every
 * user topic.
 *
 * Coalesces events within a 10 s window per (class, trigger) key so a busy
 * detection scene doesn't spam your phone.
 */

type Alert = {
  class: string;
  conf?: number;
  trigger?: string;
  temp_c?: number | null;
  color?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
};

type WindowKey = string;

type PendingBucket = {
  key: WindowKey;
  cls: string;
  trigger: string;
  firstSeenAt: number;
  count: number;
  lastAlert: Alert;
  timer: ReturnType<typeof setTimeout>;
};

export type TopicEntry = {
  /** Full URL (e.g. https://ntfy.sh/uavrt-secret). */
  url: string;
  /** Human-readable label; optional. */
  label?: string;
};

const COALESCE_MS = 10_000;

const CLASS_EMOJI: Record<string, string> = {
  fire: "fire",
  smoke: "cloud",
  person: "walking",
  vehicle: "car",
  tree: "deciduous_tree",
  dry_grass: "warning",
  tent_tarp: "warning",
  plastic_waste: "warning",
  metal_fixture: "warning",
  green_grass: "warning",
};

function isCritical(alert: Alert): boolean {
  const cls = String(alert.class ?? "").toLowerCase();
  const trigger = String(alert.trigger ?? "").toLowerCase();
  if (cls === "fire" || cls === "smoke") return true;
  return /critical|extreme|unknownhigh/i.test(trigger);
}

const TOPICS_PATH = process.env.NTFY_TOPICS_CONFIG
  ?? join(process.cwd(), "config", "ntfy-topics.json");

function readTopics(): TopicEntry[] {
  if (!existsSync(TOPICS_PATH)) return [];
  try {
    const raw = readFileSync(TOPICS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is TopicEntry =>
        e && typeof e === "object" && typeof (e as TopicEntry).url === "string")
      .map((e) => ({
        url: (e.url).trim(),
        label: typeof e.label === "string" ? e.label : undefined,
      }))
      .filter((e) => /^https?:\/\/\S+$/i.test(e.url));
  } catch (err) {
    logger.warn("ntfy", `failed to read ${TOPICS_PATH}: ${(err as Error).message}`);
    return [];
  }
}

function writeTopics(topics: TopicEntry[]): void {
  mkdirSync(dirname(TOPICS_PATH), { recursive: true });
  writeFileSync(TOPICS_PATH, JSON.stringify(topics, null, 2), "utf8");
}

export type NtfySentEntry = {
  ts: number;
  title: string;
  body: string;
  priority: string;
  destinations: number;
  errors: number;
};

class NtfyService {
  private buckets: Map<WindowKey, PendingBucket> = new Map();
  private sentLog: NtfySentEntry[] = [];
  private sentLogMax = 50;
  private lastSentAt: number | null = null;

  /** Small counters + tail-ring exposed to Overview UI. */
  summary(): {
    configured: boolean;
    topicCount: number;
    sentToday: number;
    lastSentAt: number | null;
  } {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const midnightMs = midnight.getTime();
    const sentToday = this.sentLog.reduce(
      (n, e) => (e.ts >= midnightMs ? n + 1 : n),
      0,
    );
    return {
      configured: this.configured(),
      topicCount: readTopics().length + (this.primaryUrl() ? 1 : 0),
      sentToday,
      lastSentAt: this.lastSentAt,
    };
  }

  recentSends(limit = 20): NtfySentEntry[] {
    return this.sentLog.slice(-limit).reverse();
  }

  /**
   * PUT a file directly to the ntfy topic as an attachment message. Returns
   * an array of destination-specific error strings (empty on full success).
   */
  async uploadFile(opts: {
    filePath: string;
    filename?: string;
    contentType: string;
    urlOverride?: string;
  }): Promise<string[]> {
    if (!existsSync(opts.filePath)) return [`file missing: ${opts.filePath}`];
    const dests = opts.urlOverride ? [opts.urlOverride] : this.allDestinations();
    if (!dests.length) return ["no ntfy destinations configured"];
    let bytes: Buffer;
    try {
      bytes = await readFile(opts.filePath);
    } catch (err) {
      return [`read failed: ${(err as Error).message}`];
    }
    const size = statSync(opts.filePath).size;
    const filename = opts.filename || basename(opts.filePath);
    const errors: string[] = [];
    for (const url of dests) {
      const headers: Record<string, string> = {
        "Content-Type": opts.contentType,
        "Content-Length": String(size),
        Filename: filename,
      };
      if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
      try {
        const res = await fetch(url, { method: "PUT", headers, body: bytes });
        if (!res.ok) errors.push(`${url}: HTTP ${res.status}`);
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
      }
    }
    if (errors.length) logger.warn("ntfy", `uploadFile ${filename} had errors`, { errors });
    return errors;
  }

  private recordSend(entry: NtfySentEntry): void {
    this.sentLog.push(entry);
    if (this.sentLog.length > this.sentLogMax) {
      this.sentLog.splice(0, this.sentLog.length - this.sentLogMax);
    }
    this.lastSentAt = entry.ts;
  }

  primaryUrl(): string | null { return process.env.NTFY_URL || null; }
  configured(): boolean { return !!this.primaryUrl() || readTopics().length > 0; }

  listTopics(): TopicEntry[] { return readTopics(); }

  addTopic(url: string, label?: string): TopicEntry[] {
    const clean = url.trim();
    if (!/^https?:\/\/\S+$/i.test(clean)) throw new Error("Not a valid http(s) URL");
    const topics = readTopics();
    if (!topics.some((t) => t.url === clean)) {
      topics.push({ url: clean, ...(label ? { label } : {}) });
      writeTopics(topics);
      logger.info("ntfy", `topic added${label ? ` (${label})` : ""}`, { url: clean });
    }
    return topics;
  }

  removeTopic(url: string): TopicEntry[] {
    const next = readTopics().filter((t) => t.url !== url);
    writeTopics(next);
    logger.info("ntfy", "topic removed", { url });
    return next;
  }

  /** All destination URLs a notification would be fanned out to. */
  private allDestinations(): string[] {
    const out: string[] = [];
    const primary = this.primaryUrl();
    if (primary) out.push(primary);
    for (const t of readTopics()) if (!out.includes(t.url)) out.push(t.url);
    return out;
  }

  /** Send one arbitrary notification immediately — used by the Test button. */
  async sendRaw(opts: {
    title: string;
    body: string;
    priority?: "min" | "low" | "default" | "high" | "max";
    tags?: string[];
    click?: string;
    attach?: string;        // URL ntfy will fetch + inline as an attachment
    urlOverride?: string;   // send to just this URL (used by "test this topic")
  }): Promise<{ ok: boolean; sent: number; errors: string[] }> {
    const dests = opts.urlOverride ? [opts.urlOverride] : this.allDestinations();
    if (dests.length === 0) {
      return { ok: false, sent: 0, errors: ["No ntfy destinations configured"] };
    }
    const errors: string[] = [];
    let sent = 0;
    for (const url of dests) {
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
        Title: opts.title,
        Priority: opts.priority ?? "default",
      };
      if (opts.tags?.length) headers.Tags = opts.tags.join(",");
      if (opts.click) headers.Click = opts.click;
      if (opts.attach) headers.Attach = opts.attach;
      if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
      try {
        const res = await fetch(url, { method: "POST", headers, body: opts.body });
        if (!res.ok) {
          errors.push(`${url}: HTTP ${res.status}`);
        } else {
          sent++;
        }
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
      }
    }
    if (errors.length) logger.warn("ntfy", `sendRaw "${opts.title}" had errors`, { errors });
    else logger.info("ntfy", `sendRaw "${opts.title}" → ${sent} destination(s)`);
    return { ok: sent > 0 && errors.length === 0, sent, errors };
  }

  /** Called by aiWorker whenever the model emits a batch of alerts. */
  ingestAlerts(alerts: Alert[], modality: "rgb" | "ir"): void {
    if (!this.configured() || !alerts?.length) return;
    for (const alert of alerts) {
      const cls = String(alert.class ?? "unknown");
      const trigger = String(alert.trigger ?? "");
      const key: WindowKey = `${modality}::${cls}::${trigger}`;
      const existing = this.buckets.get(key);
      if (existing) {
        existing.count++;
        existing.lastAlert = alert;
        continue;
      }
      const bucket: PendingBucket = {
        key,
        cls,
        trigger,
        firstSeenAt: Date.now(),
        count: 1,
        lastAlert: alert,
        timer: setTimeout(() => this.flushBucket(key), COALESCE_MS),
      };
      this.buckets.set(key, bucket);
    }
  }

  private async flushBucket(key: WindowKey): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    this.buckets.delete(key);
    const { cls, trigger, count, lastAlert } = bucket;

    const critical = isCritical(lastAlert);
    const emoji = CLASS_EMOJI[cls] ?? "warning";
    const title = critical ? `🚨 ${cls.toUpperCase()} detected` : `⚠ ${cls} detected`;

    const parts: string[] = [];
    if (typeof lastAlert.conf === "number") parts.push(`conf ${(lastAlert.conf * 100).toFixed(0)}%`);
    if (typeof lastAlert.temp_c === "number") parts.push(`${lastAlert.temp_c.toFixed(1)}°C`);
    if (trigger) parts.push(trigger);
    if (count > 1) parts.push(`×${count} in ${COALESCE_MS / 1000}s`);
    const body = parts.join(" · ") || `${cls} alert`;

    const link = process.env.NTFY_LINK || "http://localhost:5173/live";

    const priority = critical ? "max" : "default";
    const res = await this.sendRaw({
      title,
      body,
      priority,
      tags: [emoji],
      click: link,
    });
    // Only log a "sent" entry when at least one destination accepted the push.
    // Test-button sends go through sendRaw directly and aren't logged here on
    // purpose — this ring is meant to reflect real alert deliveries only.
    if (res.sent > 0) {
      this.recordSend({
        ts: Date.now(),
        title,
        body,
        priority,
        destinations: res.sent,
        errors: res.errors.length,
      });
    }
  }
}

export const ntfy = new NtfyService();
