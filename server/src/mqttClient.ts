import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { logger } from "./logger.js";

/**
 * DJI Cloud API v1.x speaks these Thing-Model topics per device gateway
 * (the dock SN, which forwards to the aircraft). See:
 * https://developer.dji.com/doc/cloud-api-tutorial/en/
 */
export function servicesTopic(sn: string): string {
  return `thing/product/${sn}/services`;
}
export function servicesReplyTopic(sn: string): string {
  return `thing/product/${sn}/services_reply`;
}
export function eventsTopic(sn: string): string {
  return `thing/product/${sn}/events`;
}
export function eventsReplyTopic(sn: string): string {
  return `thing/product/${sn}/events_reply`;
}
export function osdTopic(sn: string): string {
  return `thing/product/${sn}/osd`;
}
export function stateTopic(sn: string): string {
  return `thing/product/${sn}/state`;
}

type MqttEnv = {
  url: string;
  username?: string;
  password?: string;
  clientId?: string;
};

function normalizeBrokerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^mqtts?:\/\//i.test(trimmed) || /^wss?:\/\//i.test(trimmed)) return trimmed;
  // No scheme: default to plain TCP MQTT on 1883 (FH2 only supports MQTT-over-TCP).
  // If a :port is present, keep it; otherwise append :1883.
  const hasPort = /:\d+(\/|$)/.test(trimmed);
  return `mqtt://${trimmed}${hasPort ? "" : ":1883"}`;
}

function loadEnv(): MqttEnv | null {
  const raw = process.env.MQTT_BROKER_URL;
  if (!raw) return null;
  return {
    url: normalizeBrokerUrl(raw),
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: process.env.MQTT_CLIENT_ID || `uavrt-server-${randomUUID().slice(0, 8)}`,
  };
}

export type MqttMessage = {
  topic: string;
  payload: unknown;
  raw: string;
};

/**
 * Persistent MQTT connection. Emits 'message' events for each incoming
 * payload with the raw string + parsed JSON. Auto-subscribes to
 * dock event/reply/osd topics whenever `subscribeDock(sn)` is called.
 */
class MqttHub extends EventEmitter {
  private client: MqttClient | null = null;
  private env: MqttEnv | null = null;
  private subscribedDocks = new Set<string>();
  private pendingReplies = new Map<string, (msg: MqttMessage) => void>();
  private tail: Array<{ ts: number; topic: string; payload: unknown }> = [];
  private tailMax = 2000;
  // Latest OSD payload per SN. OSD is a periodic snapshot (~1Hz per device).
  private latestOsd = new Map<string, { ts: number; payload: unknown }>();
  // Merged view of `data.host.*` fields across successive OSD payloads for
  // each SN. DJI splits the dock's OSD into two variants (device state +
  // hardware/power) on the same topic; caching only the last one drops
  // whichever variant didn't arrive most recently. Merging fixes that.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mergedHost = new Map<string, { ts: number; host: Record<string, any> }>();

  osd(sn: string): { ts: number; payload: unknown } | undefined {
    return this.latestOsd.get(sn);
  }

  /** Merged `data.host` snapshot for an SN across all OSD variants seen. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mergedOsdHost(sn: string): { ts: number; host: Record<string, any> } | undefined {
    return this.mergedHost.get(sn);
  }

  /** Property set — publishes to `.../property/set` and awaits reply. */
  async propertySet(
    sn: string,
    data: Record<string, unknown>,
    timeoutMs = 3000
  ): Promise<MqttMessage> {
    const client = await this.ensureConnected();
    await this.subscribeDock(sn);
    const tid = randomUUID();
    const bid = randomUUID();
    const payload = { tid, bid, timestamp: Date.now(), data };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(tid);
        reject(new Error(`property_set timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingReplies.set(tid, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      client.publish(
        `thing/product/${sn}/property/set`,
        JSON.stringify(payload),
        { qos: 1 },
        (err) => {
          if (err) {
            clearTimeout(timer);
            this.pendingReplies.delete(tid);
            reject(err);
          }
        }
      );
    });
  }

  recent(limit = 50, topicFilter?: string): Array<{ ts: number; topic: string; payload: unknown }> {
    const items = topicFilter
      ? this.tail.filter((m) => m.topic.includes(topicFilter))
      : this.tail;
    return items.slice(-limit);
  }

  constructor() {
    super();
    this.env = loadEnv();
  }

  configured(): boolean {
    return !!this.env;
  }

  status(): { configured: boolean; connected: boolean; broker?: string } {
    return {
      configured: !!this.env,
      connected: !!this.client?.connected,
      broker: this.env?.url,
    };
  }

  async ensureConnected(): Promise<MqttClient> {
    if (!this.env) throw new Error("MQTT_BROKER_URL not set on the server");
    if (this.client?.connected) return this.client;
    if (this.client) return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MQTT connect timeout")), 8000);
      this.client!.once("connect", () => {
        clearTimeout(timer);
        resolve(this.client!);
      });
      this.client!.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    logger.info("mqtt", `connecting to ${this.env.url}`, { clientId: this.env.clientId });
    const client = mqtt.connect(this.env.url, {
      username: this.env.username,
      password: this.env.password,
      clientId: this.env.clientId,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      clean: true,
    });
    this.client = client;

    client.on("connect", () => logger.info("mqtt", `connected to ${this.env!.url}`));
    client.on("reconnect", () => logger.warn("mqtt", "reconnecting"));
    client.on("close", () => logger.warn("mqtt", "connection closed"));
    client.on("offline", () => logger.warn("mqtt", "offline"));
    client.on("error", (err) => logger.error("mqtt", `client error: ${err.message}`));

    client.on("message", (topic, payloadBuf) => {
      const raw = payloadBuf.toString("utf8");
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch { payload = raw; }
      const msg: MqttMessage = { topic, payload, raw };
      // Ring buffer for /api/mqtt/tail debugging.
      this.tail.push({ ts: Date.now(), topic, payload });
      if (this.tail.length > this.tailMax) this.tail.shift();
      if (process.env.MQTT_LOG === "1") {
        const short = raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
        logger.debug("mqtt", `${topic}  ${short}`);
      }
      // Cache OSD snapshots per SN (e.g. thing/product/{sn}/osd).
      const osdMatch = topic.match(/^thing\/product\/([^/]+)\/osd$/);
      if (osdMatch) {
        const sn = osdMatch[1];
        this.latestOsd.set(sn, { ts: Date.now(), payload });
        // Merge host-block fields into the rolling snapshot so both DJI
        // OSD variants (state + hardware) can be read together.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const host = (payload as any)?.data?.host;
        if (host && typeof host === "object") {
          const prev = this.mergedHost.get(sn)?.host ?? {};
          this.mergedHost.set(sn, { ts: Date.now(), host: { ...prev, ...host } });
        }
      }
      // Correlate reply-topic messages back to callers awaiting their tid.
      // Only match messages on a REPLY topic — never on our own outgoing
      // request topics (which may echo back through wildcard subscriptions).
      const isReplyTopic = /\/(services_reply|events|property\/set_reply)$/.test(topic);
      const tid = (payload as { tid?: string } | null)?.tid;
      if (isReplyTopic && tid && this.pendingReplies.has(tid)) {
        const cb = this.pendingReplies.get(tid)!;
        this.pendingReplies.delete(tid);
        try { cb(msg); } catch { /* ignore */ }
      }
      this.emit("message", msg);
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MQTT connect timeout")), 8000);
      client.once("connect", () => {
        clearTimeout(timer);
        // Re-subscribe to any known docks after a reconnect.
        for (const sn of this.subscribedDocks) void this.subscribeDock(sn);
        resolve(client);
      });
      client.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async subscribeDock(sn: string): Promise<void> {
    const client = await this.ensureConnected();
    this.subscribedDocks.add(sn);
    // DJI Cloud API v1 topic families. Wildcard-subscribe under each root so
    // we don't have to guess the exact topic; EMQX ACL usually blocks bare `#`.
    const topics = [
      `thing/product/${sn}/#`,
      `sys/product/${sn}/#`,
      `thing/#`,
      `sys/#`,
      `product/#`,
    ];
    // Subscribe one at a time; skip any topic the broker rejects instead of
    // failing the whole connection.
    for (const t of topics) {
      await new Promise<void>((resolve) => {
        client.subscribe(t, { qos: 1 }, (err, granted) => {
          if (err) {
            logger.warn("mqtt", `subscribe rejected: ${t} (${err.message})`);
          } else if (granted && granted[0] && granted[0].qos === 128) {
            logger.warn("mqtt", `subscribe not authorized: ${t}`);
          } else {
            logger.info("mqtt", `subscribed: ${t}`);
          }
          resolve();
        });
      });
    }
  }

  /** Publish a DJI Cloud API "Thing-Model" service call. Waits for the reply. */
  async invoke(
    sn: string,
    method: string,
    data: Record<string, unknown> = {},
    timeoutMs = 6000
  ): Promise<MqttMessage> {
    const client = await this.ensureConnected();
    await this.subscribeDock(sn);
    const tid = randomUUID();
    const bid = randomUUID();
    const payload = {
      tid,
      bid,
      timestamp: Date.now(),
      method,
      data,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(tid);
        reject(new Error(`MQTT ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingReplies.set(tid, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      client.publish(
        servicesTopic(sn),
        JSON.stringify(payload),
        { qos: 1 },
        (err) => {
          if (err) {
            clearTimeout(timer);
            this.pendingReplies.delete(tid);
            reject(err);
          }
        }
      );
    });
  }
}

export const mqttHub = new MqttHub();
