import { mqttHub } from "./mqttClient.js";
import { akamaiRegistry } from "./akamaiConfig.js";
import { aiWorker } from "./aiWorker.js";
import { aiFrameTap } from "./aiFrameTap.js";
import { anchorService } from "./thermalAnchorService.js";
import { isSdkAvailable } from "./thermalSdkService.js";
import { ntfy } from "./ntfyService.js";
import { alertStore } from "./alertStore.js";
import { listTasks } from "./mediaService.js";
import { requireProjectConfig, type Fh2AuthConfig } from "./fh2Client.js";

/**
 * Aggregates every "how healthy is the system + what's the drone doing"
 * signal into one JSON blob the Overview page polls every few seconds.
 *
 * FH2 flight-task fetching is cached (30s) to avoid hammering the API.
 */

export type DockSummary = {
  sn: string;
  online: boolean;
  mode_code: number | null;
  cover_state: number | null;
  drone_in_dock: number | null;
  env_temp: number | null;
  humidity: number | null;
  rainfall: number | null;
  wind_speed: number | null;
  storage_used_kb: number | null;
  storage_total_kb: number | null;
  aircraft_sn: string | null;
  osdAgeMs: number | null;
};

export type AircraftSummary = {
  sn: string;
  online: boolean;
  mode_code: number | null;
  battery_pct: number | null;
  height_m: number | null;
  horizontal_speed: number | null;
  vertical_speed: number | null;
  attitude_head: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  latitude: number | null;
  longitude: number | null;
  total_flight_sorties: number | null;
  total_flight_time_s: number | null;
  total_flight_distance_m: number | null;
  osdAgeMs: number | null;
};

export type StatusSummary = {
  ts: number;
  mqtt: {
    configured: boolean;
    connected: boolean;
    broker: string | null;
    lastMsgAgeMs: number | null;
  };
  dock: DockSummary | null;
  aircraft: AircraftSummary | null;
  akamai: {
    total: number;
    ready: number;
  };
  ai: {
    workerRunning: boolean;
    workerModality: "rgb" | "ir";
    framesReceived: number;
    latencyMsP50: number | null;
    tapRunning: boolean;
    tapFrameCount: number;
    lastAlertAt: number | null;
  };
  thermal: {
    sdkAvailable: boolean;
    hasAnchor: boolean;
    lastCapturedAt: number | null;
  };
  ntfy: {
    configured: boolean;
    topicCount: number;
    sentToday: number;
    lastSentAt: number | null;
  };
  alerts: {
    todayCount: number;
    unreadCount: number;
  };
  flights: {
    todayCount: number | null;
    lastFlightAt: number | null;
    fh2Available: boolean;
  };
};

function startOfLocalDaySec(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

let tasksCache: {
  ts: number;
  todayCount: number;
  lastFlightAt: number | null;
} | null = null;

async function computeFlightStats(
  cfg: Fh2AuthConfig | null,
): Promise<StatusSummary["flights"]> {
  if (!cfg) return { todayCount: null, lastFlightAt: null, fh2Available: false };
  const dockSn = process.env.MQTT_DOCK_SN || "";
  if (!dockSn) return { todayCount: null, lastFlightAt: null, fh2Available: false };
  const now = Date.now();
  if (tasksCache && now - tasksCache.ts < 30_000) {
    return {
      todayCount: tasksCache.todayCount,
      lastFlightAt: tasksCache.lastFlightAt,
      fh2Available: true,
    };
  }
  try {
    const projectCfg = requireProjectConfig(cfg);
    const from = startOfLocalDaySec();
    const to = Math.floor(now / 1000);
    const tasks = await listTasks(projectCfg, { sn: dockSn, from, to });
    // completed_at is a string; try parsing to ms.
    let lastAt = 0;
    for (const t of tasks) {
      const parsed = t.completed_at ? Date.parse(t.completed_at) : NaN;
      if (Number.isFinite(parsed) && parsed > lastAt) lastAt = parsed;
    }
    tasksCache = {
      ts: now,
      todayCount: tasks.length,
      lastFlightAt: lastAt || null,
    };
    return {
      todayCount: tasksCache.todayCount,
      lastFlightAt: tasksCache.lastFlightAt,
      fh2Available: true,
    };
  } catch {
    // FH2 down or not configured — fall through to nulls, but mark fh2Available
    // as false so the frontend shows "—" not "0".
    return { todayCount: null, lastFlightAt: null, fh2Available: false };
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function buildDock(): DockSummary | null {
  const sn = process.env.MQTT_DOCK_SN || "";
  if (!sn) return null;
  const merged = mqttHub.mergedOsdHost(sn);
  if (!merged) {
    return {
      sn,
      online: false,
      mode_code: null,
      cover_state: null,
      drone_in_dock: null,
      env_temp: null,
      humidity: null,
      rainfall: null,
      wind_speed: null,
      storage_used_kb: null,
      storage_total_kb: null,
      aircraft_sn: null,
      osdAgeMs: null,
    };
  }
  const host = merged.host;
  return {
    sn,
    online: true,
    mode_code: num(host.mode_code),
    cover_state: num(host.cover_state),
    drone_in_dock: num(host.drone_in_dock),
    env_temp: num(host.environment_temperature),
    humidity: num(host.humidity),
    rainfall: num(host.rainfall),
    wind_speed: num(host.wind_speed),
    storage_used_kb: num(host.storage?.used),
    storage_total_kb: num(host.storage?.total),
    aircraft_sn: typeof host.sub_device?.device_sn === "string" ? host.sub_device.device_sn : null,
    osdAgeMs: Date.now() - merged.ts,
  };
}

function buildAircraft(aircraftSn: string | null): AircraftSummary | null {
  if (!aircraftSn) return null;
  const merged = mqttHub.mergedOsdHost(aircraftSn);
  if (!merged) {
    return {
      sn: aircraftSn,
      online: false,
      mode_code: null,
      battery_pct: null,
      height_m: null,
      horizontal_speed: null,
      vertical_speed: null,
      attitude_head: null,
      wind_speed: null,
      wind_direction: null,
      latitude: null,
      longitude: null,
      total_flight_sorties: null,
      total_flight_time_s: null,
      total_flight_distance_m: null,
      osdAgeMs: null,
    };
  }
  const host = merged.host;
  return {
    sn: aircraftSn,
    online: true,
    mode_code: num(host.mode_code),
    battery_pct: num(host.battery?.capacity_percent),
    height_m: num(host.height),
    horizontal_speed: num(host.horizontal_speed),
    vertical_speed: num(host.vertical_speed),
    attitude_head: num(host.attitude_head),
    wind_speed: num(host.wind_speed),
    wind_direction: num(host.wind_direction),
    latitude: num(host.latitude),
    longitude: num(host.longitude),
    total_flight_sorties: num(host.total_flight_sorties),
    total_flight_time_s: num(host.total_flight_time),
    total_flight_distance_m: num(host.total_flight_distance),
    osdAgeMs: Date.now() - merged.ts,
  };
}

function lastMqttMsgAgeMs(): number | null {
  const recent = mqttHub.recent(1);
  const last = recent[recent.length - 1];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts = (last as any)?.ts;
  return typeof ts === "number" ? Date.now() - ts : null;
}

export async function buildStatusSummary(
  cfg: Fh2AuthConfig | null,
): Promise<StatusSummary> {
  const mqttStatus = mqttHub.status();
  const dock = buildDock();
  const aircraft = buildAircraft(dock?.aircraft_sn ?? null);

  const akamaiList = akamaiRegistry.list();
  const akamaiReady = akamaiList.filter((s) => s.ready).length;

  const workerStatus = aiWorker.status();
  const tapStatus = aiFrameTap.status();
  const anchor = anchorService.status();
  const ntfyStatus = ntfy.summary();

  const flights = await computeFlightStats(cfg);

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();

  return {
    ts: Date.now(),
    mqtt: {
      configured: mqttStatus.configured,
      connected: mqttStatus.connected,
      broker: mqttStatus.broker ?? null,
      lastMsgAgeMs: lastMqttMsgAgeMs(),
    },
    dock,
    aircraft,
    akamai: { total: akamaiList.length, ready: akamaiReady },
    ai: {
      workerRunning: workerStatus.running,
      workerModality: workerStatus.modality,
      framesReceived: workerStatus.framesReceived,
      latencyMsP50: workerStatus.latencyMsP50,
      tapRunning: tapStatus.running,
      tapFrameCount: tapStatus.frameCount,
      lastAlertAt: workerStatus.lastAlertAt,
    },
    thermal: {
      sdkAvailable: await isSdkAvailable(),
      hasAnchor: anchor.hasAnchor,
      lastCapturedAt: anchor.lastCapturedAt,
    },
    ntfy: ntfyStatus,
    alerts: {
      todayCount: alertStore.todayCount(midnightMs),
      unreadCount: alertStore.unreadCount(),
    },
    flights,
  };
}
