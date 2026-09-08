import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  LuRadio,
  LuRotateCw,
  LuVideo,
  LuCircle,
  LuMaximize,
  LuMinimize,
  LuThermometer,
  LuSettings,
  LuBellRing,
} from "react-icons/lu";
import {
  captureAnchor,
  fetchAkamaiForTile,
  fetchAnchorStatus,
  fetchThermalOsd,
  fetchAiTapStatus,
  fetchDevices,
  fetchMqttStatus,
  measureThermal,
  setAnchorAuto,
  setAnchorTarget,
  startAiTap,
  stopAiTap,
  switchAircraftLens,
  switchDockCamera,
  type AiTapStatus,
  type Camera,
  type Device,
  type DeviceInfo,
  type Lens,
  type MqttStatus,
  type QualityType,
  type ThermalAnchorStatus,
} from "../../lib/api";
import { playWhep, type WhepSession } from "../../lib/whepPlayer";
import { buildInverseLut } from "../../lib/thermalPalettes";
import { ThermalMatrixOverlay } from "./ThermalMatrixOverlay";
import { AiDetectionsOverlay } from "./AiDetectionsOverlay";
import { ThresholdsPanel } from "./ThresholdsPanel";
import { NotificationsPanel } from "./NotificationsPanel";
import { pushAlert } from "../Alerts/AlertToasts";
import {
  fetchAiWorkerStatus,
  startAiWorker,
  stopAiWorker,
  type AiWorkerStatus,
} from "../../lib/api";
import "./Livestream.css";

type SourceKind = "drone" | "dock";
type DockPosition = "indoor" | "outdoor";
type LensKind = "wide" | "zoom" | "ir" | "normal";

type CameraTile = {
  key: string;
  sn: string;
  cameraIndex: string;
  sourceLabel: string;
  cameraLabel: string;
  online: boolean;
  kind: SourceKind;
  dockPosition?: DockPosition;
  lens?: LensKind;
  isCurrentLens?: boolean;
  isPlaceholder?: boolean;
};

/* ---- Tile model ---- */

function prettyLensLabel(lens: LensKind): string {
  switch (lens) {
    case "ir":
      return "Thermal";
    case "wide":
      return "Wide";
    case "zoom":
      return "Zoom";
    case "normal":
      return "Normal";
  }
}

function sourceLabelOf(info: DeviceInfo, _kind: SourceKind): string {
  return info.callsign || info.device_model?.name || info.sn;
}

const HIDDEN_CAMERAS = new Set(["176-0-0"]);

function makeDroneTiles(
  sn: string,
  sourceLabel: string,
  online: boolean,
  cams: Camera[]
): CameraTile[] {
  const out: CameraTile[] = [];
  for (const cam of cams) {
    if (HIDDEN_CAMERAS.has(cam.camera_index)) continue;
    const lens: Lens | undefined = cam.lens_list?.[0];
    const availableRaw =
      (lens?.available_lens_types as string[] | undefined) ??
      (lens?.lens_type ? [lens.lens_type] : []);
    const available = Array.from(new Set(availableRaw)).filter(
      (l): l is LensKind => l === "ir" || l === "wide" || l === "zoom" || l === "normal"
    );
    const currentLens = lens?.lens_type as LensKind | undefined;

    if (available.length === 0) {
      out.push({
        key: `${sn}:${cam.camera_index}`,
        sn,
        cameraIndex: cam.camera_index,
        sourceLabel,
        cameraLabel: cam.camera_index,
        online,
        kind: "drone",
      });
      continue;
    }
    const filtered = available.length > 1 ? available.filter((l) => l !== "normal") : available;

    for (const lensKind of filtered) {
      const isCurrent = lensKind === currentLens;
      out.push({
        key: `${sn}:${cam.camera_index}:${lensKind}`,
        sn,
        cameraIndex: cam.camera_index,
        sourceLabel,
        cameraLabel: prettyLensLabel(lensKind),
        online,
        kind: "drone",
        lens: lensKind,
        isCurrentLens: isCurrent,
        isPlaceholder: !isCurrent,
      });
    }
  }
  return out;
}

function makeDockTiles(
  sn: string,
  sourceLabel: string,
  online: boolean,
  cams: Camera[]
): CameraTile[] {
  const primary = cams[0];
  if (!primary) {
    return [
      {
        key: `${sn}:__none__`,
        sn,
        cameraIndex: "",
        sourceLabel,
        cameraLabel: online ? "No cameras reported" : "Offline",
        online,
        kind: "dock",
      },
    ];
  }
  // Akamai relays a single dock stream (indoor camera). We used to expose a
  // second placeholder tile to flip the dock's outdoor camera on, but that
  // stream isn't published anywhere — see server/config/akamai-streams.json.
  const activePos: DockPosition =
    primary.camera_position === "outdoor" ? "outdoor" : "indoor";
  return [
    {
      key: `${sn}:${primary.camera_index}:${activePos}`,
      sn,
      cameraIndex: primary.camera_index,
      sourceLabel,
      cameraLabel: "Camera",
      online,
      kind: "dock",
      dockPosition: activePos,
    },
  ];
}

function collectTiles(devices: Device[]): CameraTile[] {
  const out: CameraTile[] = [];
  for (const entry of devices) {
    if (entry.drone?.sn) {
      const info = entry.drone;
      const label = sourceLabelOf(info, "drone");
      const online = info.device_online_status !== false;
      const cams = info.camera_list ?? [];
      if (cams.length === 0) {
        out.push({
          key: `${info.sn}:__none__`,
          sn: info.sn,
          cameraIndex: "",
          sourceLabel: label,
          cameraLabel: online ? "No cameras reported" : "Offline",
          online,
          kind: "drone",
        });
      } else {
        out.push(...makeDroneTiles(info.sn, label, online, cams));
      }
    }
    if (entry.gateway?.sn) {
      const info = entry.gateway;
      const label = sourceLabelOf(info, "dock");
      const online = info.device_online_status !== false;
      out.push(...makeDockTiles(info.sn, label, online, info.camera_list ?? []));
    }
  }
  return out;
}

/* ---- Thermal color-to-temperature (approximate) ---- */

type ThermalReading = {
  x: number;
  y: number;
  r?: number;
  g?: number;
  b?: number;
  temp: number;
  source: "mqtt" | "approx";
};

/**
 * Reverse the DJI palette LUT — same pipeline the matrix-overlay Web Worker
 * uses. Given the palette id and range (min/max in °C), turn a pixel's RGB
 * back into a temperature.
 *
 * Result: the click probe now agrees with the matrix overlay's stats within
 * quantization error. Note the accuracy ceiling is still the palette
 * inversion itself (~±5-10 °C on live video because DJI applies spatial DDE
 * before the palette maps to color) — for the "real" ±0.1 °C you need an
 * R-JPEG anchor.
 */
const invLutCache = new Map<number, Uint8Array>();
function getInverseLutCached(paletteId: number): Uint8Array {
  let lut = invLutCache.get(paletteId);
  if (!lut) {
    lut = buildInverseLut(paletteId);
    invLutCache.set(paletteId, lut);
  }
  return lut;
}

/**
 * Sample an averaged temperature from a small window around (px, py) in the
 * source video frame. Averaging over ~5×5 pixels squashes H.264 compression
 * ringing that otherwise makes single-pixel probes jump by whole °C between
 * clicks on visually-identical spots.
 */
function paletteInvertedTemp(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  frameW: number,
  frameH: number,
  paletteId: number,
  tMin: number,
  tMax: number,
): number {
  const halfKernel = 3; // 7x7 window
  const x0 = Math.max(0, Math.floor(px) - halfKernel);
  const y0 = Math.max(0, Math.floor(py) - halfKernel);
  const x1 = Math.min(frameW, Math.floor(px) + halfKernel + 1);
  const y1 = Math.min(frameH, Math.floor(py) + halfKernel + 1);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const data = ctx.getImageData(x0, y0, w, h).data;

  const inv = getInverseLutCached(paletteId);
  const range = Math.max(1e-6, tMax - tMin);
  // Take the 90th-percentile temp in the window — biases toward the hottest
  // corner of the sample so clicking on a small hot dot next to cool pixels
  // still returns the hot value, matching what a person expects "point the
  // probe at that spot" to mean.
  const temps: number[] = new Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] >> 3;
    const g = data[i + 1] >> 3;
    const b = data[i + 2] >> 3;
    const idx = inv[(r << 10) | (g << 5) | b];
    temps[p] = tMin + (idx / 255) * range;
  }
  temps.sort((a, b) => a - b);
  return temps[Math.min(temps.length - 1, Math.floor(temps.length * 0.9))];
}

/* ---- Main Live view ---- */

type StreamStatus = "idle" | "starting" | "connecting" | "live" | "error";

export default function Livestream() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [quality, setQuality] = useState<QualityType>("adaptive");
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [thermalMin, setThermalMin] = useState(0);
  const [thermalMax, setThermalMax] = useState(60);
  const [thermalReading, setThermalReading] = useState<ThermalReading | null>(null);
  const [mqttStatus, setMqttStatus] = useState<MqttStatus | null>(null);

  const [status, setStatus] = useState<StreamStatus>("idle");
  const [streamError, setStreamError] = useState<string | null>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<WhepSession | null>(null);

  // --- Palette-inversion matrix state (Option 5: hybrid) ---
  const [matrixOn, setMatrixOn] = useState(true);
  const [alertThreshold, setAlertThreshold] = useState(60);
  const [paletteId, setPaletteId] = useState(2); // DJI iron_red (thermal_current_palette_style=2)
  const paletteSeededRef = useRef(false);
  const [matrixStats, setMatrixStats] = useState<{
    min: number; max: number; mean: number; calibA: number; calibB: number;
  } | null>(null);
  const [anchorStatus, setAnchorStatus] = useState<ThermalAnchorStatus | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [aiTap, setAiTap] = useState<AiTapStatus | null>(null);
  const [videoAspect, setVideoAspect] = useState<string>("16 / 9");
  const [osdRange, setOsdRange] = useState<{ min: number; max: number } | null>(null);
  const [osdPaletteId, setOsdPaletteId] = useState<number | null>(null);
  const [aiWorker, setAiWorker] = useState<AiWorkerStatus | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [activeMediamtxPath, setActiveMediamtxPath] = useState<string | null>(null);
  // Once a user manually stops AI, don't auto-restart it until they toggle it
  // back on. Sticky for the lifetime of the page — a refresh re-enables auto.
  const aiUserDisabledRef = useRef(false);
  // Prevents the auto-effect from firing repeated start/stop cycles when the
  // polled aiWorker/aiTap state races with an in-flight API call.
  const aiAutoBusyRef = useRef(false);

  const loadDevices = useCallback(async (signal?: AbortSignal) => {
    setRefreshingDevices(true);
    try {
      const r = await fetchDevices(signal);
      setDevices(r.list);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setSwitchError((e as Error).message);
    } finally {
      setRefreshingDevices(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadDevices(ctrl.signal);
    fetchMqttStatus(ctrl.signal).then(setMqttStatus).catch(() => setMqttStatus(null));
    fetchAnchorStatus(ctrl.signal).then(setAnchorStatus).catch(() => setAnchorStatus(null));
    fetchAiTapStatus(ctrl.signal).then(setAiTap).catch(() => setAiTap(null));
    fetchAiWorkerStatus(ctrl.signal).then(setAiWorker).catch(() => setAiWorker(null));
    const id = window.setInterval(() => loadDevices(), 10000);
    const anchorId = window.setInterval(
      () => void fetchAnchorStatus().then(setAnchorStatus).catch(() => {}),
      5000,
    );
    const tapId = window.setInterval(
      () => void fetchAiTapStatus().then(setAiTap).catch(() => {}),
      2000,
    );
    const workerId = window.setInterval(
      () => void fetchAiWorkerStatus().then(setAiWorker).catch(() => {}),
      2500,
    );
    return () => {
      ctrl.abort();
      window.clearInterval(id);
      window.clearInterval(anchorId);
      window.clearInterval(tapId);
      window.clearInterval(workerId);
      sessionRef.current?.stop();
    };
  }, [loadDevices]);

  const tiles = useMemo(() => collectTiles(devices), [devices]);

  // Auto-select the first streamable tile, preferring a Wide camera.
  useEffect(() => {
    if (selectedKey && tiles.some((t) => t.key === selectedKey)) return;
    const streamable = tiles.filter((t) => t.online && t.cameraIndex && !t.isPlaceholder);
    const first =
      streamable.find((t) => t.lens === "wide") ??
      streamable.find((t) => t.cameraLabel === "Wide") ??
      streamable.find((t) => t.kind === "drone") ??
      streamable[0] ??
      tiles.find((t) => t.cameraIndex && !t.isPlaceholder) ??
      tiles[0];
    if (first) setSelectedKey(first.key);
  }, [tiles, selectedKey]);

  const active = tiles.find((t) => t.key === selectedKey) ?? null;
  // Placeholder marker is a UX hint that a drone lens isn't the *currently
  // selected* one on the drone — but Akamai relays all three M4TD lenses in
  // parallel, so the WHEP stream is available regardless of drone-side state.
  // Streaming is gated purely on device online + camera identity here.
  const canStream = !!(active && active.online && active.cameraIndex);

  // Auto-fit the featured video's aspect ratio to whatever the source
  // actually delivers. FH2 Share's thermal encoder pushes 960×720 (4:3);
  // wide/zoom push 16:9. Without this the video letterboxes into a fixed
  // 16:9 box and the thermal image looks squished / has black bars.
  useEffect(() => {
    if (status !== "live") return;
    const container = videoContainerRef.current;
    if (!container) return;
    const findVideo = () => container.querySelector<HTMLVideoElement>("video");
    const apply = () => {
      const v = findVideo();
      if (v?.videoWidth && v.videoHeight) {
        setVideoAspect(`${v.videoWidth} / ${v.videoHeight}`);
      }
    };
    // Wait briefly for the WHEP player to attach the <video> element
    const attempts = [0, 100, 300, 800, 2000, 4000];
    const timers = attempts.map((ms) => window.setTimeout(apply, ms));
    const v = findVideo();
    v?.addEventListener("loadedmetadata", apply);
    v?.addEventListener("resize", apply);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      v?.removeEventListener("loadedmetadata", apply);
      v?.removeEventListener("resize", apply);
    };
  }, [status, active?.key]);

  // Single-stream policy: only the featured camera runs a WHEP session.
  // FH2 pushes RTMP to our MediaMTX, which re-publishes as WHEP for the
  // browser. Server-side ffmpeg can tap the same RTMP for AI inference.
  useEffect(() => {
    if (!canStream || !videoContainerRef.current || !active) return;
    const container = videoContainerRef.current;
    let cancelled = false;

    void (async () => {
      const prev = sessionRef.current;
      sessionRef.current = null;
      if (prev) {
        try { prev.stop(); } catch { /* ignore */ }
      }
      setStreamError(null);
      setStatus("starting");
      try {
        // Look up the Akamai relay for THIS tile. FH2's Share feature pushes
        // to our operator-owned MediaMTX; our local MediaMTX pulls from there
        // on demand and re-publishes as WHEP for the browser.
        const akamai = await fetchAkamaiForTile({
          aircraftSn: active.kind === "drone" ? active.sn : undefined,
          gatewaySn: active.kind === "dock" ? active.sn : undefined,
          cameraIndex: active.cameraIndex,
          lens: active.lens,
          position: active.dockPosition,
        });
        if (cancelled) return;
        if (!akamai.whepUrl) {
          throw new Error(
            "WHEP_PLAYBACK_URL_BASE not configured on the server — set it in server/.env to point at MediaMTX.",
          );
        }
        setActiveMediamtxPath(akamai.mediamtxPath ?? null);
        setStatus("connecting");
        const session = await playWhep(akamai.whepUrl, container, (err) => {
          setStreamError(err.message);
          setStatus("error");
        });
        if (cancelled) {
          session.stop();
          return;
        }
        sessionRef.current = session;
        setStatus("live");
      } catch (e) {
        if (!cancelled) {
          setStreamError((e as Error).message);
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.sn, active?.cameraIndex, canStream, quality]);

  const handleSwitchDock = useCallback(
    async (tile: CameraTile) => {
      if (!tile.dockPosition) return;
      setSwitchError(null);
      setSelectedKey(tile.key);
      try {
        await switchDockCamera({
          sn: tile.sn,
          cameraIndex: tile.cameraIndex,
          cameraPosition: tile.dockPosition,
        });
        setTimeout(() => void loadDevices(), 900);
      } catch (e) {
        setSwitchError((e as Error).message);
      }
    },
    [loadDevices]
  );

  const handleSwitchLens = useCallback(
    async (tile: CameraTile) => {
      if (!tile.lens || tile.lens === "normal") return;
      setSwitchError(null);
      setThermalReading(null);
      setSelectedKey(tile.key);
      try {
        await switchAircraftLens({
          sn: tile.sn,
          cameraIndex: tile.cameraIndex,
          lensType: tile.lens,
        });
        setTimeout(() => void loadDevices(), 800);
        setTimeout(() => void loadDevices(), 2200);
      } catch (e) {
        setSwitchError((e as Error).message);
      }
    },
    [loadDevices]
  );

  const onTileClick = (tile: CameraTile, _evt?: React.MouseEvent) => {
    if (tile.isPlaceholder && tile.dockPosition) return void handleSwitchDock(tile);
    if (tile.isPlaceholder && tile.lens && tile.lens !== "normal")
      return void handleSwitchLens(tile);
    if (!tile.online || !tile.cameraIndex) return;
    if (tile.key === selectedKey) return;
    setThermalReading(null);
    setSelectedKey(tile.key);
  };

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (videoWrapRef.current) {
      try {
        await videoWrapRef.current.requestFullscreen();
      } catch (e) {
        setSwitchError(`Fullscreen not available: ${(e as Error).message}`);
      }
    }
  }, []);

  const activeIsThermal = active?.lens === "ir";

  // AI auto-follows the active tile: when the user views a streaming camera,
  // start the tap + worker on that stream (IR modality for thermal, RGB for
  // wide/zoom). When they leave the tile OR manually turn AI off, stop
  // everything. The auto-busy ref + snapshot-fetch pattern prevents the 2.5 s
  // poll from racing with an in-flight model warm-up (~35 s).
  useEffect(() => {
    if (aiUserDisabledRef.current) return;
    if (aiBusy) return;
    if (aiAutoBusyRef.current) return;
    const shouldRun = !!(canStream && active && activeMediamtxPath);
    let cancelled = false;
    aiAutoBusyRef.current = true;

    void (async () => {
      try {
        if (shouldRun && active && activeMediamtxPath) {
          const streamKey = activeMediamtxPath;
          const modality: "rgb" | "ir" = active.lens === "ir" ? "ir" : "rgb";
          const tap = await fetchAiTapStatus();
          if (cancelled) return;
          if (!tap.running || tap.streamKey !== streamKey) {
            const s = await startAiTap(streamKey);
            if (!cancelled) setAiTap(s);
          } else {
            setAiTap(tap);
          }
          if (cancelled) return;
          const worker = await fetchAiWorkerStatus();
          if (cancelled) return;
          if (!worker.running || worker.modality !== modality) {
            const w = await startAiWorker({ modality });
            if (!cancelled) setAiWorker(w);
          } else {
            setAiWorker(worker);
          }
        } else {
          const worker = await fetchAiWorkerStatus();
          if (cancelled) return;
          if (worker.running) {
            const w = await stopAiWorker();
            if (!cancelled) setAiWorker(w);
          } else {
            setAiWorker(worker);
          }
          const tap = await fetchAiTapStatus();
          if (cancelled) return;
          if (tap.running) {
            const s = await stopAiTap();
            if (!cancelled) setAiTap(s);
          } else {
            setAiTap(tap);
          }
        }
      } catch { /* poll will surface */ }
      finally { aiAutoBusyRef.current = false; }
    })();
    return () => { cancelled = true; };
  }, [canStream, active?.key, active?.lens, activeMediamtxPath, aiBusy]);

  // When a thermal camera is selected, tell the anchor service which aircraft/camera
  // to shoot photos on. Only sends once per (sn, cameraIndex) change.
  useEffect(() => {
    if (!activeIsThermal || !active) return;
    void setAnchorTarget({ aircraftSn: active.sn, cameraIndex: active.cameraIndex }).catch(() => {});
  }, [activeIsThermal, active?.sn, active?.cameraIndex]);

  const handleCaptureAnchor = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    setSwitchError(null);
    try {
      await captureAnchor();
      const s = await fetchAnchorStatus();
      setAnchorStatus(s);
    } catch (e) {
      setSwitchError(`Anchor capture failed: ${(e as Error).message}`);
    } finally {
      setCapturing(false);
    }
  }, [capturing]);

  const handleToggleAi = useCallback(async () => {
    if (aiBusy || !active) return;
    setAiBusy(true);
    setSwitchError(null);
    try {
      const running = !!aiWorker?.running;
      if (running) {
        aiUserDisabledRef.current = true;
        // Stop worker first, then the frame tap.
        await stopAiWorker().then(setAiWorker);
        if (aiTap?.running) await stopAiTap().then(setAiTap);
      } else {
        aiUserDisabledRef.current = false;
        const streamKey = activeMediamtxPath
          ?? `${active.sn}_${active.cameraIndex.replace(/[^A-Za-z0-9_-]/g, "-")}`;
        if (!aiTap?.running) {
          await startAiTap(streamKey).then(setAiTap);
        }
        const modality: "rgb" | "ir" = active.lens === "ir" ? "ir" : "rgb";
        await startAiWorker({ modality }).then(setAiWorker);
      }
    } catch (e) {
      setSwitchError(`AI toggle failed: ${(e as Error).message}`);
    } finally {
      setAiBusy(false);
    }
  }, [aiBusy, active, aiWorker?.running, aiTap?.running]);

  const handleToggleAuto = useCallback(async () => {
    try {
      const next = !anchorStatus?.autoCapture;
      const interval = anchorStatus?.intervalMs || 2000;
      await setAnchorAuto({ on: next, intervalMs: interval });
      const s = await fetchAnchorStatus();
      setAnchorStatus(s);
    } catch (e) {
      setSwitchError(`Auto-anchor toggle failed: ${(e as Error).message}`);
    }
  }, [anchorStatus?.autoCapture, anchorStatus?.intervalMs]);

  const handleSetInterval = useCallback(async (intervalMs: number) => {
    try {
      // Keep the current on/off state; just push the new interval.
      await setAnchorAuto({ on: !!anchorStatus?.autoCapture, intervalMs });
      const s = await fetchAnchorStatus();
      setAnchorStatus(s);
    } catch (e) {
      setSwitchError(`Anchor interval change failed: ${(e as Error).message}`);
    }
  }, [anchorStatus?.autoCapture]);

  // Real thermal OSD stream — the drone's own radiometric endpoints for the
  // palette. Polled ~1 Hz from the aircraft's OSD via MQTT. Falls back to a
  // safe indoor range only until the first OSD arrives.
  useEffect(() => {
    if (!activeIsThermal || active?.kind !== "drone") return;
    let cancelled = false;
    const poll = () => {
      void fetchThermalOsd(active.sn)
        .then((r) => {
          if (cancelled) return;
          if (typeof r.min === "number" && typeof r.max === "number" && r.max > r.min) {
            setOsdRange({ min: r.min, max: r.max });
          }
          if (typeof r.paletteId === "number") {
            setOsdPaletteId(r.paletteId);
            // Seed the local palette selection ONCE from OSD so the default
            // matches whatever the drone is currently showing. After that,
            // the user's dropdown choice wins — we never overwrite it, even
            // if the drone-side palette changes.
            if (!paletteSeededRef.current) {
              paletteSeededRef.current = true;
              setPaletteId(r.paletteId);
            }
          }
        })
        .catch(() => {});
    };
    poll();
    const id = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeIsThermal, active?.sn, active?.kind]);

  const osdMin = osdRange?.min ?? 15;
  const osdMax = osdRange?.max ?? 80;

  const handleThermalClick = useCallback(
    async (evt: React.MouseEvent<HTMLDivElement>) => {
      const overlay = evt.currentTarget;
      const rect = overlay.getBoundingClientRect();
      const relX = (evt.clientX - rect.left) / rect.width;
      const relY = (evt.clientY - rect.top) / rect.height;

      // Preferred path: real DJI radiometric reading via MQTT.
      if (mqttStatus?.connected && active) {
        // Show a "measuring…" placeholder marker while awaiting the reply.
        setThermalReading({ x: relX, y: relY, temp: Number.NaN, source: "mqtt" });
        try {
          const res = await measureThermal({
            dockSn: active.sn, // The dock forwards to the aircraft; if the
            // dock SN differs from the aircraft SN, MQTT_DOCK_SN in .env is used
            // by the backend as a fallback.
            cameraIndex: active.cameraIndex,
            x: relX,
            y: relY,
          });
          setThermalReading({ x: relX, y: relY, temp: res.temp, source: "mqtt" });
          return;
        } catch (e) {
          setSwitchError(`MQTT thermal read failed, falling back to approximation: ${(e as Error).message}`);
          // fall through to approximation
        }
      }

      // Fallback: reverse the palette LUT locally — same math as the matrix
      // overlay so the probe reading and the "Max" stat agree. Range is taken
      // from the drone's OSD if available (real radiometric span) and falls
      // back to the user-set thermalMin/thermalMax only when OSD is silent.
      const video = videoContainerRef.current?.querySelector<HTMLVideoElement>("video");
      if (!video || !video.videoWidth) {
        setSwitchError("Video isn't ready to read yet.");
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch (e) {
        setSwitchError(`Cross-origin blocked: ${(e as Error).message}`);
        return;
      }
      const px = Math.floor(relX * canvas.width);
      const py = Math.floor(relY * canvas.height);
      // Prefer OSD range (radiometric truth from the drone) over user
      // thermalMin/thermalMax which are only useful when OSD is silent.
      const rangeMin = osdRange?.min ?? thermalMin;
      const rangeMax = osdRange?.max ?? thermalMax;
      const temp = paletteInvertedTemp(
        ctx, px, py, canvas.width, canvas.height, paletteId, rangeMin, rangeMax,
      );
      const centerPixel = ctx.getImageData(px, py, 1, 1).data;
      setThermalReading({
        x: relX, y: relY,
        r: centerPixel[0], g: centerPixel[1], b: centerPixel[2],
        temp,
        source: "approx",
      });
    },
    [thermalMin, thermalMax, mqttStatus, active, osdRange, paletteId]
  );

  return (
    <div className="cockpit">
      <div className="cockpit-header">
        <h2 className="section-title">Live view</h2>
        <div className="cockpit-header-right">
          <label className="ml-field cockpit-quality">
            <span>Quality</span>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value as QualityType)}
            >
              <option value="adaptive">Adaptive</option>
              <option value="smooth">Smooth</option>
              <option value="ultra_high_definition">High definition</option>
            </select>
          </label>
          <button
            className="live-btn refresh"
            onClick={() => loadDevices()}
            disabled={refreshingDevices}
            type="button"
            title="Re-check device status"
          >
            <LuRotateCw size={14} className={refreshingDevices ? "spin" : ""} />
            Refresh
          </button>
          <button
            className="live-btn refresh"
            onClick={handleToggleAi}
            disabled={aiBusy || !canStream}
            type="button"
            title={
              aiWorker?.running
                ? `DEIMv2 running (${aiWorker.modality} · ${aiWorker.latencyMsP50 ?? "?"}ms). Click to stop.`
                : "Start AI object detection on the live stream"
            }
          >
            <LuRadio size={14} className={aiWorker?.running ? "spin" : ""} />
            AI
            {aiWorker?.running && <span className="ai-live-dot" aria-hidden />}
          </button>
          <button
            className="live-btn refresh"
            onClick={() => setSettingsOpen(true)}
            type="button"
            title="Alert thresholds · thermal matrix · AI tap"
            aria-label="Open settings"
          >
            <LuSettings size={14} />
          </button>
          <button
            className="live-btn refresh"
            onClick={() => setNotificationsOpen(true)}
            type="button"
            title="ntfy subscriber topics"
            aria-label="Manage notification topics"
          >
            <LuBellRing size={14} />
          </button>
          <StatusPill status={status} />
        </div>
      </div>

      {activeIsThermal && (
        <div className="cockpit-thermal-controls">
          <LuThermometer size={14} />
          <span className="cockpit-thermal-label">
            Thermal spot metering
            {mqttStatus?.connected ? (
              <span className="cockpit-thermal-mode real">DJI · real-time</span>
            ) : (
              <span className="cockpit-thermal-mode approx">Approximate (MQTT not connected)</span>
            )}
          </span>
          {!mqttStatus?.connected && (
            <>
              <label className="ml-field ml-field-tight">
                <span>Min °C</span>
                <input
                  type="number"
                  value={thermalMin}
                  onChange={(e) => setThermalMin(Number(e.target.value) || 0)}
                />
              </label>
              <label className="ml-field ml-field-tight">
                <span>Max °C</span>
                <input
                  type="number"
                  value={thermalMax}
                  onChange={(e) => setThermalMax(Number(e.target.value) || 0)}
                />
              </label>
            </>
          )}
          {thermalReading && Number.isFinite(thermalReading.temp) && (
            <span className="cockpit-thermal-reading">
              Last: <strong>{thermalReading.temp.toFixed(1)}°C</strong>
              {thermalReading.source === "mqtt" ? " (DJI)" : " (approx.)"}
            </span>
          )}
          {thermalReading && !Number.isFinite(thermalReading.temp) && (
            <span className="cockpit-thermal-reading">Measuring…</span>
          )}
        </div>
      )}

      {activeIsThermal && (
        <div className="matrix-anchor-bar">
          <LuThermometer size={13} />
          <span>Anchor:</span>
          <span
            className={`matrix-source ${
              anchorStatus?.latest?.source === "sdk" ? "sdk" : "none"
            }`}
          >
            {anchorStatus?.latest?.source === "sdk" ? "SDK" : "None"}
          </span>
          {anchorStatus?.latest && (
            <span className="matrix-anchor-age">
              {Math.round((Date.now() - anchorStatus.latest.capturedAt) / 1000)}s ago
            </span>
          )}
          <label className="matrix-toggle">
            <input
              type="checkbox"
              checked={!!anchorStatus?.autoCapture}
              onChange={handleToggleAuto}
            />
            Auto-anchor
          </label>
          <label className="matrix-toggle" title="Time between anchor captures. DJI photo round-trip is 4-8s so short intervals queue.">
            every
            <select
              value={anchorStatus?.intervalMs ?? 2000}
              onChange={(e) => void handleSetInterval(Number(e.target.value))}
              style={{ marginLeft: 4 }}
            >
              <option value={2000}>2 s</option>
              <option value={5000}>5 s</option>
              <option value={8000}>8 s</option>
              <option value={15000}>15 s</option>
              <option value={30000}>30 s</option>
            </select>
          </label>
          <button
            className="live-btn refresh"
            onClick={handleCaptureAnchor}
            disabled={capturing}
            type="button"
          >
            {capturing ? "Capturing…" : "Capture anchor"}
          </button>
        </div>
      )}

      {settingsOpen && (
        <ThresholdsPanel
          onClose={() => setSettingsOpen(false)}
          activeIsThermal={activeIsThermal}
          matrixOn={matrixOn}
          setMatrixOn={setMatrixOn}
          alertThreshold={alertThreshold}
          setAlertThreshold={setAlertThreshold}
          paletteId={paletteId}
          setPaletteId={setPaletteId}
          osdPaletteId={osdPaletteId}
          aiTapStreamKey={activeMediamtxPath}
        />
      )}
      {notificationsOpen && <NotificationsPanel onClose={() => setNotificationsOpen(false)} />}

      {switchError && <div className="ml-error">{switchError}</div>}
      {streamError && <div className="ml-error">Stream error: {streamError}</div>}

      {tiles.length === 0 ? (
        <div className="cockpit-empty">
          <LuRadio size={44} />
          <p>No devices bound to this project.</p>
        </div>
      ) : (
        <div className="cockpit-layout">
          <div
            ref={videoWrapRef}
            className="cockpit-featured"
            style={{ aspectRatio: videoAspect }}
          >
            {canStream ? (
              <div ref={videoContainerRef} className="cockpit-featured-video" />
            ) : (
              <div className="cockpit-featured-fallback">
                <LuVideo size={48} />
                <p>{active ? placeholderMessage(active) : "No camera selected"}</p>
              </div>
            )}

            {canStream && aiWorker?.running && (
              <AiDetectionsOverlay enabled onAlert={pushAlert} />
            )}

            {activeIsThermal && canStream && matrixOn && (
              <ThermalMatrixOverlay
                videoContainerRef={videoContainerRef}
                paletteId={paletteId}
                osdMin={osdMin}
                osdMax={osdMax}
                threshold={alertThreshold}
                enabled={matrixOn}
                fps={5}
                onStats={setMatrixStats}
              />
            )}

            {activeIsThermal && canStream && (
              <div className="cockpit-thermal-overlay" onClick={handleThermalClick}>
                {thermalReading && (
                  <div
                    className="cockpit-thermal-marker"
                    style={{
                      left: `${thermalReading.x * 100}%`,
                      top: `${thermalReading.y * 100}%`,
                    }}
                  >
                    <span className="cockpit-thermal-crosshair" />
                    <span className="cockpit-thermal-value">
                      {Number.isFinite(thermalReading.temp)
                        ? `${thermalReading.temp.toFixed(1)}°C`
                        : "…"}
                    </span>
                  </div>
                )}
              </div>
            )}

            {canStream && status !== "live" && (
              <div className="cockpit-loading">
                <span className="cockpit-loading-dot" />
                <span>{loadingLabel(status)}</span>
              </div>
            )}

            {active && (
              <div className="cockpit-featured-caption">
                <span className="cockpit-featured-title">{active.sourceLabel}</span>
                <span className="cockpit-featured-sub">{active.cameraLabel}</span>
              </div>
            )}
            {activeIsThermal && (
              <div className="cockpit-thermal-stats" aria-hidden>
                <span>Max <strong>{osdRange ? `${osdRange.max.toFixed(1)}°C` : "—"}</strong></span>
                <span>Min <strong>{osdRange ? `${osdRange.min.toFixed(1)}°C` : "—"}</strong></span>
                <span>Mean <strong>{matrixStats && Number.isFinite(matrixStats.mean) ? `${matrixStats.mean.toFixed(1)}°C` : "—"}</strong></span>
                <span>Alert <strong>{alertThreshold}°C</strong></span>
              </div>
            )}
            {status === "live" && (
              <span className="cockpit-featured-live">
                <span className="live-dot" /> LIVE
              </span>
            )}
            {canStream && (
              <div className="cockpit-featured-tools">
                <button
                  type="button"
                  className="cockpit-btn"
                  onClick={toggleFullscreen}
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {isFullscreen ? <LuMinimize size={16} /> : <LuMaximize size={16} />}
                </button>
              </div>
            )}
          </div>


          {/* Right rail */}
          <aside className="cockpit-rail">
            <div className="cockpit-rail-header">Cameras</div>
            {tiles.map((tile) => {
              const isActive = tile.key === selectedKey;
              const canPick = tile.online && tile.cameraIndex;
              return (
                <button
                  key={tile.key}
                  type="button"
                  className={`rail-tile${isActive ? " active" : ""}${
                    tile.isPlaceholder ? " placeholder" : ""
                  }${tile.online ? "" : " offline"}`}
                  onClick={(evt) => onTileClick(tile, evt)}
                  disabled={!canPick && !tile.isPlaceholder}
                  title={
                    tile.isPlaceholder && tile.dockPosition
                      ? `Switch dock to ${tile.cameraLabel}`
                      : tile.isPlaceholder && tile.lens
                      ? `Switch lens to ${tile.cameraLabel}`
                      : `View ${tile.sourceLabel} — ${tile.cameraLabel}`
                  }
                >
                  <div className="rail-tile-thumb">
                    <LuVideo size={20} />
                    {isActive && status === "live" && (
                      <span className="rail-tile-live">
                        <span className="live-dot" /> LIVE
                      </span>
                    )}
                    {tile.isPlaceholder && !isActive && (
                      <span className="rail-tile-switch">SWITCH</span>
                    )}
                    {tile.lens === "ir" && (
                      <span className="rail-tile-ir">
                        <LuThermometer size={10} /> IR
                      </span>
                    )}
                  </div>
                  <div className="rail-tile-meta">
                    <div className="rail-tile-title">{tile.sourceLabel}</div>
                    <div className="rail-tile-sub">{tile.cameraLabel}</div>
                  </div>
                  <span
                    className={`rail-tile-dot ${tile.online ? "online" : "offline"}`}
                    aria-label={tile.online ? "online" : "offline"}
                  >
                    <LuCircle size={8} />
                  </span>
                </button>
              );
            })}
          </aside>
        </div>
      )}
    </div>
  );
}

function placeholderMessage(tile: CameraTile): string {
  if (!tile.online) return `${tile.sourceLabel} is offline`;
  if (!tile.cameraIndex) return "No camera reported for this device";
  if (tile.isPlaceholder) return `Click a camera tile to start streaming`;
  return "Select a camera";
}

function loadingLabel(s: StreamStatus): string {
  switch (s) {
    case "starting":
      return "Requesting stream from FlightHub…";
    case "connecting":
      return "Connecting…";
    case "error":
      return "Stream failed";
    default:
      return "…";
  }
}

function StatusPill({ status }: { status: StreamStatus }) {
  return (
    <span className={`live-pill live-pill-${status}`}>
      {status === "live" && <span className="live-dot" />}
      {status.toUpperCase()}
    </span>
  );
}

