import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
    console.warn(`[ntfy] failed to read ${TOPICS_PATH}: ${(err as Error).message}`);
    return [];
  }
}

function writeTopics(topics: TopicEntry[]): void {
  mkdirSync(dirname(TOPICS_PATH), { recursive: true });
  writeFileSync(TOPICS_PATH, JSON.stringify(topics, null, 2), "utf8");
}

class NtfyService {
  private buckets: Map<WindowKey, PendingBucket> = new Map();

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
    }
    return topics;
  }

  removeTopic(url: string): TopicEntry[] {
    const next = readTopics().filter((t) => t.url !== url);
    writeTopics(next);
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

    await this.sendRaw({
      title,
      body,
      priority: critical ? "max" : "default",
      tags: [emoji],
      click: link,
    });
  }
}

export const ntfy = new NtfyService();
