import "dotenv/config";
import { createServer } from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import { Fh2Error, loadFh2AuthConfig, requireProjectConfig } from "./fh2Client.js";
import { listDevices, listMediaForDevice, listOrgDevices, listProjects, listTaskMedia, listTasks } from "./mediaService.js";
import {
  startLivestream,
  switchDockCamera,
  acquireControl,
  switchAircraftLens,
  type QualityType,
  type DockCameraPosition,
  type LensType,
} from "./livestreamService.js";
import { fetchWaylineGeoJson, getWaylineDetails, listWaylines } from "./waylineService.js";
import { mqttHub } from "./mqttClient.js";
import { measureThermalPoint, subscribeDock } from "./thermalService.js";
import { generateThumbnail } from "./thumbService.js";
import { wsHub } from "./wsHub.js";
import { anchorService } from "./thermalAnchorService.js";
import { isSdkAvailable } from "./thermalSdkService.js";
import { aiFrameTap } from "./aiFrameTap.js";
import { aiWorker } from "./aiWorker.js";
import { akamaiRegistry } from "./akamaiConfig.js";
import {
  DEFAULT_THRESHOLDS,
  getEffectiveThresholds,
  getOverrides,
  resetOverrides,
  setOverrides,
} from "./thresholdsService.js";
import { ntfy } from "./ntfyService.js";
import { alertStore } from "./alertStore.js";
import { buildStatusSummary } from "./statusSummary.js";
import { photoPath, videoPath } from "./alertMediaService.js";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { logger } from "./logger.js";

const app = express();
app.use(express.json());

// ---- HTTP access log: every request, persisted, with method/status/duration. ----
app.use((req: Request, res: Response, next: NextFunction) => {
  const t0 = Date.now();
  res.on("finish", () => {
    logger.info("http", `${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  next();
});

let cfg: ReturnType<typeof loadFh2AuthConfig> | null = null;
try {
  cfg = loadFh2AuthConfig();
} catch (err) {
  logger.warn("server", String(err));
  logger.warn("server", "Server will start but /api/* calls will 500 until env is set.");
}

// ---- Process-level safety net: log crashes before Node exits so the field
// operator has a record of WHY the server went down, not just that it did.
// Still exits — Node's default behavior for both events is to terminate,
// and continuing after a truly uncaught error risks running in a corrupted
// state, which is worse than a clean restart during a flight test. ----
process.on("uncaughtException", (err) => {
  logger.error("process", `uncaughtException: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("process", `unhandledRejection: ${(reason as Error)?.message ?? String(reason)}`);
  process.exit(1);
});

const requireAuth = (_req: Request, res: Response, next: NextFunction) => {
  if (!cfg) return res.status(500).json({ error: "FlightHub 2 auth missing on server. Set FH2_BASE_URL and FH2_USER_TOKEN in server/.env" });
  next();
};

const requireCfg = (_req: Request, res: Response, next: NextFunction) => {
  if (!cfg) return res.status(500).json({ error: "FlightHub 2 auth missing on server. See server/.env.example" });
  try {
    requireProjectConfig(cfg);
    next();
  } catch (err) {
    if (err instanceof Fh2Error) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

const wrap = <T>(fn: (req: Request, res: Response) => Promise<T>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (err) {
      next(err);
    }
  };

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    configured: !!cfg?.projectUuid,
    authOnly: !!cfg && !cfg.projectUuid,
    mqtt: mqttHub.status(),
  })
);

app.get("/api/mqtt/status", (_req, res) => res.json(mqttHub.status()));

/**
 * Latest thermal OSD values for an aircraft — used by the frontend to seed
 * palette-inversion min/max instead of the old hardcoded 15..80 defaults.
 */
app.get("/api/thermal/osd", (req, res) => {
  const sn = String(req.query.sn ?? "");
  if (!sn) return res.status(400).json({ error: "sn query required" });
  const entry = mqttHub.osd(sn);
  if (!entry) return res.status(404).json({ error: "no OSD seen for this SN yet" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = entry.payload as any;
  const host = p?.data?.host ?? {};
  // Find any camera-index block that exposes thermal_global_temperature_*.
  let min: number | undefined;
  let max: number | undefined;
  let paletteId: number | undefined;
  let cameraIndex: string | undefined;
  for (const [k, v] of Object.entries(host)) {
    if (typeof v !== "object" || v === null) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = v as any;
    if (typeof b.thermal_global_temperature_max === "number") {
      min = b.thermal_global_temperature_min;
      max = b.thermal_global_temperature_max;
      paletteId = b.thermal_current_palette_style;
      cameraIndex = k;
      break;
    }
  }
  // Point reading, if the drone is currently metering.
  let pointTemp: number | undefined;
  let pointX: number | undefined;
  let pointY: number | undefined;
  const cams = host.cameras;
  if (Array.isArray(cams)) {
    for (const cam of cams) {
      if (cam?.ir_metering_point?.temperature != null) {
        pointTemp = cam.ir_metering_point.temperature;
        pointX = cam.ir_metering_point.x;
        pointY = cam.ir_metering_point.y;
        break;
      }
    }
  }
  res.json({
    ts: entry.ts,
    ageMs: Date.now() - entry.ts,
    min,
    max,
    paletteId,
    cameraIndex,
    point: pointTemp != null ? { temp: pointTemp, x: pointX, y: pointY } : null,
  });
});

app.get("/api/mqtt/tail", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  const topicFilter = req.query.topic ? String(req.query.topic) : undefined;
  res.json({ messages: mqttHub.recent(limit, topicFilter) });
});

app.post("/api/thermal/measure", wrap(async (req) => {
  // Always prefer the env-configured dock SN — DJI Cloud API MQTT commands
  // must go to the dock (the gateway), never the aircraft SN.
  const dockSn = String(process.env.MQTT_DOCK_SN || req.body?.dockSn || "");
  const cameraIndex = String(req.body?.cameraIndex ?? "");
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  if (!dockSn || !cameraIndex || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Fh2Error(400, -1, "dockSn, cameraIndex, x, y required");
  }
  if (!mqttHub.configured()) {
    throw new Fh2Error(
      503,
      -1,
      "MQTT broker not configured. Set MQTT_BROKER_URL (+ credentials) in server/.env and configure FlightHub Sync to publish to it."
    );
  }
  const reading = await measureThermalPoint({ dockSn, cameraIndex, x, y });
  return reading;
}));

app.post("/api/mqtt/subscribe-dock", wrap(async (req) => {
  const sn = String(req.body?.sn ?? "");
  if (!sn) throw new Fh2Error(400, -1, "sn required");
  await subscribeDock(sn);
  return { ok: true };
}));

// ---- Thermal anchor (R-JPEG capture + DJI Thermal SDK decode) ----

app.get("/api/thermal/anchor/status", wrap(async () => {
  return {
    ...anchorService.status(),
    sdkAvailable: await isSdkAvailable(),
    wsClients: wsHub.clientCount("thermal"),
    latest: anchorService.getLatestSummary(),
  };
}));

app.post("/api/thermal/anchor/target", wrap(async (req) => {
  const aircraftSn = String(req.body?.aircraftSn ?? "");
  const cameraIndex = String(req.body?.cameraIndex ?? "99-0-0");
  if (!aircraftSn) throw new Fh2Error(400, -1, "aircraftSn required");
  anchorService.setTarget(aircraftSn, cameraIndex);
  return { ok: true };
}));

app.post("/api/thermal/anchor/capture", requireCfg, wrap(async () => {
  return anchorService.captureOnce(requireProjectConfig(cfg!));
}));

app.post("/api/thermal/anchor/auto", requireCfg, wrap(async (req) => {
  const on = !!req.body?.on;
  const intervalMs = Number(req.body?.intervalMs);
  anchorService.setAutoCapture(
    requireProjectConfig(cfg!),
    on,
    Number.isFinite(intervalMs) ? intervalMs : undefined,
  );
  return anchorService.status();
}));

app.get("/api/projects", requireAuth, wrap(async () => {
  return { list: await listProjects(cfg!) };
}));

app.get("/api/organization/devices", requireAuth, wrap(async () => {
  return { list: await listOrgDevices(cfg!) };
}));

app.get("/api/devices", requireCfg, wrap(async () => {
  return { list: await listDevices(requireProjectConfig(cfg!)) };
}));

app.get("/api/media", requireCfg, wrap(async (req) => {
  const sn = String(req.query.sn ?? "");
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!sn) throw new Fh2Error(400, -1, "sn query param required");
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Fh2Error(400, -1, "from/to (unix seconds) query params required");
  }
  return { list: await listMediaForDevice(requireProjectConfig(cfg!), { sn, from, to }) };
}));

app.get("/api/media/task/:taskUuid", requireCfg, wrap(async (req) => {
  return { list: await listTaskMedia(requireProjectConfig(cfg!), String(req.params.taskUuid)) };
}));

app.get("/api/media/thumb", wrap(async (req, res) => {
  const url = String(req.query.url ?? "");
  if (!url || !/^https?:\/\//i.test(url)) throw new Fh2Error(400, -1, "url query param required (http/https)");
  const jpeg = await generateThumbnail(url);
  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(jpeg);
}));

app.get("/api/waylines", requireCfg, wrap(async () => {
  return { list: await listWaylines(requireProjectConfig(cfg!)) };
}));

app.get("/api/waylines/:id/details", requireCfg, wrap(async (req) => {
  return getWaylineDetails(requireProjectConfig(cfg!), String(req.params.id));
}));

app.get("/api/waylines/:id/geojson", requireCfg, wrap(async (req) => {
  return fetchWaylineGeoJson(requireProjectConfig(cfg!), String(req.params.id));
}));

app.post("/api/aircraft/switch-lens", requireCfg, wrap(async (req) => {
  const { sn, cameraIndex, lensType } = req.body ?? {};
  if (!sn || !cameraIndex || !["wide", "zoom", "ir"].includes(lensType)) {
    throw new Fh2Error(400, -1, "sn, cameraIndex, lensType (wide|zoom|ir) required");
  }
  const projectCfg = requireProjectConfig(cfg!);
  // Acquire control first (required for lens switching).
  await acquireControl(projectCfg, {
    droneSn: String(sn),
    payloadIndex: [String(cameraIndex)],
  });
  await switchAircraftLens(projectCfg, {
    sn: String(sn),
    cameraIndex: String(cameraIndex),
    lensType: lensType as LensType,
  });
  return { ok: true };
}));

app.post("/api/dock/switch-camera", requireCfg, wrap(async (req) => {
  const { sn, cameraIndex, cameraPosition } = req.body ?? {};
  if (!sn || !cameraIndex || (cameraPosition !== "indoor" && cameraPosition !== "outdoor")) {
    throw new Fh2Error(400, -1, "sn, cameraIndex, cameraPosition (indoor|outdoor) required");
  }
  await switchDockCamera(requireProjectConfig(cfg!), {
    sn: String(sn),
    cameraIndex: String(cameraIndex),
    cameraPosition: cameraPosition as DockCameraPosition,
  });
  return { ok: true };
}));

app.post("/api/livestream/start", requireCfg, wrap(async (req) => {
  const { sn, cameraIndex, qualityType, videoExpire } = req.body ?? {};
  if (!sn || !cameraIndex) throw new Fh2Error(400, -1, "sn and cameraIndex required");
  return startLivestream(requireProjectConfig(cfg!), {
    sn: String(sn),
    cameraIndex: String(cameraIndex),
    qualityType: qualityType as QualityType | undefined,
    videoExpire: typeof videoExpire === "number" ? videoExpire : undefined,
  });
}));

// ---- Akamai relay streams (per-tile routing) ----

app.get("/api/livestream/akamai/status", (_req, res) => {
  res.json(akamaiRegistry.status());
});

app.get("/api/livestream/akamai/list", (_req, res) => {
  res.json({ streams: akamaiRegistry.list() });
});

/**
 * Look up the Akamai relay for a specific tile. Callers pass whichever of
 * {aircraftSn, gatewaySn, cameraIndex, lens, position} they know; the
 * registry picks the most specific match.
 *
 * Returns 404 if nothing matches, 503 if a match exists but its source URL
 * still contains a CHANGEME placeholder (i.e. read creds haven't landed).
 */
app.get("/api/livestream/akamai/for-tile", (req, res) => {
  const match = {
    aircraftSn: req.query.aircraftSn ? String(req.query.aircraftSn) : undefined,
    gatewaySn: req.query.gatewaySn ? String(req.query.gatewaySn) : undefined,
    cameraIndex: req.query.cameraIndex ? String(req.query.cameraIndex) : undefined,
    lens: req.query.lens ? String(req.query.lens) : undefined,
    position: req.query.position ? String(req.query.position) : undefined,
  };
  const stream = akamaiRegistry.findForTile(match);
  if (!stream) {
    return res.status(404).json({ error: "no Akamai relay configured for this tile", query: match });
  }
  if (!stream.ready) {
    return res.status(503).json({
      error: "Akamai relay is registered but its source URL still contains a CHANGEME placeholder",
      streamId: stream.id,
      mediamtxPath: stream.mediamtxPath,
    });
  }
  res.json({
    id: stream.id,
    label: stream.label,
    whepUrl: stream.whepUrl,
    rtmpUrl: `rtmp://localhost:1935/${stream.mediamtxPath}`,
    mediamtxPath: stream.mediamtxPath,
  });
});

// ---- AI frame tap (RTMP → ffmpeg → BGR24 frames) ----

app.get("/api/ai/tap/status", (_req, res) => res.json(aiFrameTap.status()));

app.post("/api/ai/tap/start", wrap(async (req) => {
  const streamKey = String(req.body?.streamKey ?? "");
  if (!streamKey) throw new Fh2Error(400, -1, "streamKey required");
  return aiFrameTap.start(streamKey);
}));

app.post("/api/ai/tap/stop", (_req, res) => res.json(aiFrameTap.stop()));

// ---- AI inference worker (Python DEIMv2 subprocess) ----

app.get("/api/ai/worker/status", (_req, res) => res.json(aiWorker.status()));

app.post("/api/ai/worker/start", wrap(async (req) => {
  const modality = String(req.body?.modality ?? "rgb").toLowerCase();
  if (modality !== "rgb" && modality !== "ir") {
    throw new Fh2Error(400, -1, "modality must be 'rgb' or 'ir'");
  }
  return aiWorker.start(modality as "rgb" | "ir");
}));

app.post("/api/ai/worker/stop", (_req, res) => res.json(aiWorker.stop()));

// ---- Alert thresholds ----

app.get("/api/ai/thresholds", (_req, res) => {
  res.json({
    effective: getEffectiveThresholds(),
    overrides: getOverrides(),
    defaults: DEFAULT_THRESHOLDS,
  });
});

app.put("/api/ai/thresholds", wrap(async (req) => {
  const overrides = setOverrides(req.body ?? {});
  aiWorker.restart();
  return { overrides, effective: getEffectiveThresholds(), defaults: DEFAULT_THRESHOLDS };
}));

app.post("/api/ai/thresholds/reset", wrap(async () => {
  resetOverrides();
  aiWorker.restart();
  return { overrides: {}, effective: getEffectiveThresholds(), defaults: DEFAULT_THRESHOLDS };
}));

// ---- ntfy notifications ----

app.get("/api/notifications/status", (_req, res) => {
  res.json({
    configured: ntfy.configured(),
    primary: ntfy.primaryUrl(),
    topics: ntfy.listTopics(),
  });
});

app.post("/api/notifications/test", wrap(async (req) => {
  const urlOverride = typeof req.body?.url === "string" ? req.body.url : undefined;
  return await ntfy.sendRaw({
    title: "UAV-RT test",
    body: "ntfy pipeline reachable — you're wired up.",
    priority: "default",
    tags: ["white_check_mark"],
    click: process.env.NTFY_LINK || "http://localhost:5173/live",
    urlOverride,
  });
}));

app.post("/api/notifications/topics", wrap(async (req) => {
  const url = String(req.body?.url ?? "");
  const label = typeof req.body?.label === "string" ? req.body.label : undefined;
  if (!url) throw new Fh2Error(400, -1, "url required");
  try {
    const topics = ntfy.addTopic(url, label);
    return { topics };
  } catch (e) {
    throw new Fh2Error(400, -1, (e as Error).message);
  }
}));

app.delete("/api/notifications/topics", wrap(async (req) => {
  const url = String(req.query.url ?? req.body?.url ?? "");
  if (!url) throw new Fh2Error(400, -1, "url required");
  return { topics: ntfy.removeTopic(url) };
}));

// ---- Overview status summary (one blob for the Overview page) ----

app.get("/api/status/summary", wrap(async () => {
  return buildStatusSummary(cfg);
}));

app.get("/api/notifications/recent", (_req, res) => {
  res.json({ sends: ntfy.recentSends(20) });
});

// ---- Persistent AI alert log ----

app.get("/api/alerts", (req, res) => {
  const since = Number(req.query.since);
  const limit = Number(req.query.limit);
  const alerts = alertStore.list({
    since: Number.isFinite(since) ? since : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  res.json({
    alerts,
    ackTs: alertStore.getAckTs(),
    unreadCount: alertStore.unreadCount(),
  });
});

app.post("/api/alerts/ack-all", (_req, res) => {
  res.json(alertStore.ackAll());
});

app.post("/api/alerts/clear", wrap(async (req) => {
  const body = req.body ?? {};
  if (body.all === true) return alertStore.clearAll();
  const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown): x is string => typeof x === "string") : [];
  if (!ids.length) throw new Fh2Error(400, -1, "Provide { ids: [...] } or { all: true }");
  return alertStore.clear(ids);
}));

// ---- Alert media (photo + 5s clip) ----

async function serveMedia(res: Response, filePath: string, contentType: string): Promise<void> {
  if (!existsSync(filePath)) {
    res.status(404).json({ error: "media not ready or not available" });
    return;
  }
  const info = await stat(filePath);
  const buf = await readFile(filePath);
  res.set("Content-Type", contentType);
  res.set("Content-Length", String(info.size));
  res.set("Cache-Control", "public, max-age=86400");
  res.send(buf);
}

app.get("/api/alerts/:id/photo.jpg", wrap(async (req, res) => {
  const rec = alertStore.get(String(req.params.id));
  if (!rec || !rec.mediaId) {
    res.status(404).json({ error: "no photo for this alert" });
    return;
  }
  await serveMedia(res, photoPath(rec.mediaId), "image/jpeg");
}));

app.get("/api/alerts/:id/video.mp4", wrap(async (req, res) => {
  const rec = alertStore.get(String(req.params.id));
  if (!rec || !rec.mediaId) {
    res.status(404).json({ error: "no video for this alert" });
    return;
  }
  await serveMedia(res, videoPath(rec.mediaId), "video/mp4");
}));

// ---- Forward selected alerts through ntfy (with photo + video) ----

app.post("/api/alerts/forward", wrap(async (req) => {
  const body = req.body ?? {};
  const ids: string[] = Array.isArray(body.ids)
    ? body.ids.filter((x: unknown): x is string => typeof x === "string")
    : [];
  if (!ids.length) throw new Fh2Error(400, -1, "ids array required");
  const urlOverride = typeof body.url === "string" ? body.url : undefined;

  const results: Array<{ id: string; sent: boolean; errors: string[] }> = [];
  for (const id of ids) {
    const rec = alertStore.get(id);
    if (!rec) {
      results.push({ id, sent: false, errors: ["not found"] });
      continue;
    }
    const withMedia = alertStore.attachMedia(rec);
    const errors: string[] = [];

    // 1) Text notification. Send with attach header pointing to the photo URL
    // if we have one — ntfy fetches it server-side and shows an inline image.
    // Note: ntfy.sh's servers must be able to reach the URL. For localhost
    // dev, set PUBLIC_MEDIA_BASE to your public tunnel or reverse-proxy URL.
    const base = process.env.PUBLIC_MEDIA_BASE || `http://localhost:${process.env.PORT || 4000}`;
    const attach = withMedia.photoUrl ? `${base}${withMedia.photoUrl}` : undefined;
    const title = `Forwarded: ${rec.class} · ${rec.trigger || "manual"}`;
    const parts: string[] = [];
    if (typeof rec.conf === "number") parts.push(`conf ${(rec.conf * 100).toFixed(0)}%`);
    if (typeof rec.temp_c === "number") parts.push(`${rec.temp_c.toFixed(1)}°C`);
    parts.push(rec.modality.toUpperCase());
    parts.push(new Date(rec.ts).toLocaleTimeString());
    const messageBody = parts.join(" · ");

    const textRes = await ntfy.sendRaw({
      title,
      body: messageBody,
      priority: /critical|extreme|unknownhigh/i.test(rec.trigger) || rec.class === "fire" || rec.class === "smoke" ? "max" : "high",
      tags: [rec.class === "fire" ? "fire" : rec.class === "smoke" ? "cloud" : "warning"],
      click: process.env.NTFY_LINK || "http://localhost:5173/",
      attach,
      urlOverride,
    });
    if (!textRes.ok) errors.push(...textRes.errors);

    // 2) Video: upload the mp4 as a follow-up ntfy message so it appears as
    // an attachment (ntfy's `PUT` upload mode). Skipped when the file isn't
    // ready — we don't want to block the whole forward on it.
    if (withMedia.videoUrl) {
      const videoErr = await ntfy.uploadFile({
        filePath: videoPath(rec.mediaId!),
        filename: `${rec.class}-${rec.id.slice(0, 8)}.mp4`,
        contentType: "video/mp4",
        urlOverride,
      });
      if (videoErr.length) errors.push(...videoErr);
    }

    results.push({ id, sent: errors.length === 0, errors });
  }
  return { results };
}));

// ---- Test-seed (dev helper: create fake alerts to exercise the UI) ----

app.post("/api/alerts/test-seed", (req, res) => {
  const n = Math.min(20, Math.max(1, Number(req.body?.count) || 1));
  const classes = ["fire", "smoke", "person", "vehicle", "dry_grass"];
  const triggers = ["combustibleC", "criticalC", "personC", "unknownHighC", ""];
  const created = [];
  for (let i = 0; i < n; i++) {
    const cls = classes[i % classes.length];
    const trigger = triggers[i % triggers.length];
    const rec = alertStore.seedForTest({
      modality: i % 2 === 0 ? "rgb" : "ir",
      class: cls,
      trigger,
      temp_c: cls === "fire" || cls === "smoke" ? 60 + Math.random() * 40 : null,
      conf: 0.65 + Math.random() * 0.3,
      box: [0.2, 0.2, 0.5, 0.5],
      color: cls === "fire" ? "#c83228" : cls === "smoke" ? "#6b6b6b" : "#e87820",
      seq: i,
      mediaId: null,
    });
    created.push(rec);
  }
  res.json({ created });
});

app.get("/api/tasks", requireCfg, wrap(async (req) => {
  const sn = String(req.query.sn ?? "");
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!sn) throw new Fh2Error(400, -1, "sn query param required");
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Fh2Error(400, -1, "from/to (unix seconds) query params required");
  }
  return { list: await listTasks(requireProjectConfig(cfg!), { sn, from, to }) };
}));

// ---- System log (persisted server-side event log; see server/src/logger.ts) ----

app.get("/api/logs", (req, res) => {
  const since = Number(req.query.since);
  const limit = Number(req.query.limit);
  const level = typeof req.query.level === "string" ? req.query.level : undefined;
  const source = typeof req.query.source === "string" ? req.query.source : undefined;
  const validLevel = level === "debug" || level === "info" || level === "warn" || level === "error" ? level : undefined;
  res.json({
    entries: logger.recent({
      since: Number.isFinite(since) ? since : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      level: validLevel,
      source,
    }),
  });
});

app.get("/api/logs/files", (_req, res) => {
  res.json({ files: logger.listFiles() });
});

app.get("/api/logs/files/:day", (req, res) => {
  const day = String(req.params.day);
  const content = logger.readDay(day);
  if (content === null) {
    res.status(404).json({ error: "no log file for that day" });
    return;
  }
  res.set("Content-Type", "application/x-ndjson");
  res.set("Content-Disposition", `attachment; filename="system-${day}.log"`);
  res.send(content);
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof Fh2Error) {
    logger.warn("http", `${err.status} ${err.code}: ${err.message}`);
    return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
      error: err.message,
      code: err.code,
    });
  }
  logger.error("http", (err as Error)?.message ?? "Unknown error", { stack: (err as Error)?.stack });
  res.status(500).json({ error: (err as Error).message ?? "Unknown error" });
});

const port = Number(process.env.PORT ?? 4000);
const httpServer = createServer(app);
wsHub.attach(httpServer);
httpServer.listen(port, () => {
  logger.info("server", `API listening on http://localhost:${port}`);
  logger.info("server", `WebSocket at ws://localhost:${port}/ws?channel=thermal`);
  if (mqttHub.configured()) {
    void (async () => {
      try {
        await mqttHub.ensureConnected();
        const dockSn = process.env.MQTT_DOCK_SN;
        if (dockSn) {
          await subscribeDock(dockSn);
          logger.info("server", `MQTT subscribed to dock ${dockSn}`);
        }
      } catch (err) {
        logger.warn("server", `MQTT connect failed: ${(err as Error).message}`);
      }
    })();
  } else {
    logger.info("server", "MQTT: not configured (MQTT_BROKER_URL blank). Thermal spot metering will fall back to color approximation.");
  }
});
