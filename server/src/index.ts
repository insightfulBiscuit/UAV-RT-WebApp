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

const app = express();
app.use(express.json());

let cfg: ReturnType<typeof loadFh2AuthConfig> | null = null;
try {
  cfg = loadFh2AuthConfig();
} catch (err) {
  console.warn(String(err));
  console.warn("Server will start but /api/* calls will 500 until env is set.");
}

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

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof Fh2Error) {
    return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
      error: err.message,
      code: err.code,
    });
  }
  console.error(err);
  res.status(500).json({ error: (err as Error).message ?? "Unknown error" });
});

const port = Number(process.env.PORT ?? 4000);
const httpServer = createServer(app);
wsHub.attach(httpServer);
httpServer.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(`WebSocket at ws://localhost:${port}/ws?channel=thermal`);
  if (mqttHub.configured()) {
    void (async () => {
      try {
        await mqttHub.ensureConnected();
        console.log(`MQTT connected: ${process.env.MQTT_BROKER_URL}`);
        const dockSn = process.env.MQTT_DOCK_SN;
        if (dockSn) {
          await subscribeDock(dockSn);
          console.log(`MQTT subscribed to dock ${dockSn}`);
        }
      } catch (err) {
        console.warn(`MQTT connect failed: ${(err as Error).message}`);
      }
    })();
  } else {
    console.log("MQTT: not configured (MQTT_BROKER_URL blank). Thermal spot metering will fall back to color approximation.");
  }
});
