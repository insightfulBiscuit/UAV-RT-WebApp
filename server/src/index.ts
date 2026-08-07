import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { Fh2Error, loadFh2AuthConfig, requireProjectConfig } from "./fh2Client.js";
import { listDevices, listMediaForDevice, listOrgDevices, listProjects, listTaskMedia, listTasks } from "./mediaService.js";
import { startLivestream, type QualityType } from "./livestreamService.js";
import { fetchWaylineGeoJson, getWaylineDetails, listWaylines } from "./waylineService.js";

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
  res.json({ ok: true, configured: !!cfg?.projectUuid, authOnly: !!cfg && !cfg.projectUuid })
);

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

app.get("/api/waylines", requireCfg, wrap(async () => {
  return { list: await listWaylines(requireProjectConfig(cfg!)) };
}));

app.get("/api/waylines/:id/details", requireCfg, wrap(async (req) => {
  return getWaylineDetails(requireProjectConfig(cfg!), String(req.params.id));
}));

app.get("/api/waylines/:id/geojson", requireCfg, wrap(async (req) => {
  return fetchWaylineGeoJson(requireProjectConfig(cfg!), String(req.params.id));
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

app.post("/api/livestream/whep", requireAuth, express.text({ type: "application/sdp", limit: "1mb" }), wrap(async (req, res) => {
  const target = String(req.query.url ?? "");
  if (!target) throw new Fh2Error(400, -1, "url query param required");
  if (!/^https?:\/\//i.test(target)) throw new Fh2Error(400, -1, "url must be http(s)");
  const upstream = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/sdp", Accept: "application/sdp" },
    body: req.body as string,
  });
  const answer = await upstream.text();
  if (!upstream.ok) throw new Fh2Error(upstream.status, -1, `WHEP HTTP ${upstream.status}: ${answer.slice(0, 300)}`);
  res.type("application/sdp").send(answer);
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
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
