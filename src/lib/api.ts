export type LensType = "wide" | "zoom" | "ir" | "normal";

export type Lens = {
  lens_type: LensType | string;
  available_lens_types?: (LensType | string)[];
};

export type Camera = {
  camera_index: string;
  camera_position?: string;
  lens_list?: Lens[];
};

export type DeviceInfo = {
  sn: string;
  callsign?: string;
  device_online_status?: boolean;
  device_model?: { name?: string; class?: string };
  camera_list?: Camera[] | null;
};

export type Device = {
  gateway?: DeviceInfo;
  drone?: DeviceInfo;
};

export type LivestreamStart = {
  expire_ts: number;
  streamKey: string;
  whepUrl: string | null;
  rtmpUrl: string | null;
  raw: { url_type?: string; url?: string };
};

export type AiTapStatus = {
  running: boolean;
  streamKey: string | null;
  rtmpUrl: string | null;
  frameCount: number;
  lastFrameAt: number | null;
  startedAt: number | null;
  ffmpegPid: number | null;
  lastError: string | null;
  restarts?: number;
};

export async function fetchAiTapStatus(signal?: AbortSignal): Promise<AiTapStatus> {
  return json<AiTapStatus>(await fetch("/api/ai/tap/status", { signal }));
}

export type AkamaiStream = {
  id: string;
  label: string;
  whepUrl: string;
  rtmpUrl: string;
  mediamtxPath: string;
};

export type AkamaiStreamListEntry = AkamaiStream & {
  match: { aircraftSn?: string; gatewaySn?: string; cameraIndex?: string; lens?: string; position?: string };
  source: string;
  ready: boolean;
};

export type AkamaiTileQuery = {
  aircraftSn?: string;
  gatewaySn?: string;
  cameraIndex?: string;
  lens?: string;
  position?: string;
};

export async function fetchAkamaiList(signal?: AbortSignal): Promise<{ streams: AkamaiStreamListEntry[] }> {
  return json<{ streams: AkamaiStreamListEntry[] }>(
    await fetch("/api/livestream/akamai/list", { signal }),
  );
}

/**
 * Look up an Akamai relay for a specific tile. Throws on 404/503 with the
 * server's error body — the caller can use those to decide whether to fall
 * back to FH2 or show a "not configured" state.
 */
export async function fetchAkamaiForTile(
  q: AkamaiTileQuery,
  signal?: AbortSignal,
): Promise<AkamaiStream> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v) qs.set(k, v);
  }
  return json<AkamaiStream>(
    await fetch(`/api/livestream/akamai/for-tile?${qs.toString()}`, { signal }),
  );
}

export async function startAiTap(streamKey: string): Promise<AiTapStatus> {
  return json<AiTapStatus>(
    await fetch("/api/ai/tap/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamKey }),
    }),
  );
}

export async function stopAiTap(): Promise<AiTapStatus> {
  return json<AiTapStatus>(await fetch("/api/ai/tap/stop", { method: "POST" }));
}

export type QualityType = "adaptive" | "smooth" | "ultra_high_definition";

export type MediaItem = {
  uuid: string;
  name: string;
  file_type: string;
  suffix: string;
  size: number;
  preview_url: string;
  original_url: string;
  create_at: string;
  update_at: string;
  task_uuid: string;
  task_name: string;
  device_sn: string;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function fetchDevices(signal?: AbortSignal): Promise<{ list: Device[] }> {
  return json<{ list: Device[] }>(await fetch("/api/devices", { signal }));
}

export async function fetchOrgDevices(signal?: AbortSignal): Promise<{ list: Device[] }> {
  return json<{ list: Device[] }>(await fetch("/api/organization/devices", { signal }));
}

export type WaylineSummary = {
  id: string;
  name: string;
  size?: number;
  template_types?: string[];
  device_model_key?: string;
  payload_information?: Array<{ domain?: string; type?: string; lens_type?: string }>;
  update_time?: number;
};

export type WaylineGeoJson = GeoJSON.FeatureCollection & {
  bbox?: [number, number, number, number];
  meta: { id: string; name: string; waypointCount: number; hasAltitude: boolean };
};

export async function fetchWaylines(signal?: AbortSignal): Promise<{ list: WaylineSummary[] }> {
  return json<{ list: WaylineSummary[] }>(await fetch("/api/waylines", { signal }));
}

export async function fetchWaylineGeojson(
  id: string,
  signal?: AbortSignal
): Promise<WaylineGeoJson> {
  return json<WaylineGeoJson>(
    await fetch(`/api/waylines/${encodeURIComponent(id)}/geojson`, { signal })
  );
}

export async function startLivestream(
  params: { sn: string; cameraIndex: string; qualityType?: QualityType },
  signal?: AbortSignal
): Promise<LivestreamStart> {
  return json<LivestreamStart>(
    await fetch("/api/livestream/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    })
  );
}

export type MqttStatus = {
  configured: boolean;
  connected: boolean;
  broker?: string;
};

export async function fetchMqttStatus(signal?: AbortSignal): Promise<MqttStatus> {
  return json<MqttStatus>(await fetch("/api/mqtt/status", { signal }));
}

export type ThermalMeasurement = {
  temp: number;
  x: number;
  y: number;
  actualX?: number;
  actualY?: number;
  globalMin?: number;
  globalMax?: number;
  source: string;
  osdAgeMs?: number;
};

export type ThermalAnchorStatus = {
  autoCapture: boolean;
  intervalMs: number;
  hasAnchor: boolean;
  lastCapturedAt: number | null;
  lastSource: "sdk" | null;
  aircraftSn: string | null;
  cameraIndex: string;
  sdkAvailable: boolean;
  wsClients: number;
  latest: {
    id: string;
    capturedAt: number;
    width: number;
    height: number;
    min: number;
    max: number;
    mean: number;
    source: "sdk";
    preview: number[];
    previewWidth: number;
    previewHeight: number;
  } | null;
};

export type ThermalOsdReading = {
  ts: number;
  ageMs: number;
  min?: number;
  max?: number;
  paletteId?: number;
  cameraIndex?: string;
  point: { temp: number; x: number; y: number } | null;
};

export type AiDetection = {
  class: string;
  conf: number;
  /** normalized [x1, y1, x2, y2] */
  box: [number, number, number, number];
};

export type AiAlert = AiDetection & {
  trigger: string;
  temp_c: number | null;
  box_key: string;
  cooldown_left: number;
  color: string;
};

export type AiWorkerStatus = {
  running: boolean;
  modality: "rgb" | "ir";
  framesSent: number;
  framesReceived: number;
  lastDetectionAt: number | null;
  lastAlertAt: number | null;
  pid: number | null;
  lastError: string | null;
  latencyMsP50: number | null;
};

export async function fetchAiWorkerStatus(signal?: AbortSignal): Promise<AiWorkerStatus> {
  return json<AiWorkerStatus>(await fetch("/api/ai/worker/status", { signal }));
}

export async function startAiWorker(params: {
  modality: "rgb" | "ir";
}): Promise<AiWorkerStatus> {
  return json<AiWorkerStatus>(
    await fetch("/api/ai/worker/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }),
  );
}

export async function stopAiWorker(): Promise<AiWorkerStatus> {
  return json<AiWorkerStatus>(await fetch("/api/ai/worker/stop", { method: "POST" }));
}

export type ThresholdKey =
  | "triggerC" | "criticalC" | "combustibleC" | "personC"
  | "unknownHighC" | "unknownExtremeC" | "vehicleExtremeC" | "cooldownS";

export type ThresholdSettings = {
  effective: Record<ThresholdKey, number>;
  overrides: Partial<Record<ThresholdKey, number>>;
  defaults: Record<ThresholdKey, number>;
};

export async function fetchThresholds(signal?: AbortSignal): Promise<ThresholdSettings> {
  return json<ThresholdSettings>(await fetch("/api/ai/thresholds", { signal }));
}

export async function saveThresholds(
  overrides: Partial<Record<ThresholdKey, number | null>>,
): Promise<ThresholdSettings> {
  return json<ThresholdSettings>(
    await fetch("/api/ai/thresholds", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overrides),
    }),
  );
}

export async function resetThresholds(): Promise<ThresholdSettings> {
  return json<ThresholdSettings>(
    await fetch("/api/ai/thresholds/reset", { method: "POST" }),
  );
}

export type NtfyTopic = { url: string; label?: string };

export type NotificationStatus = {
  configured: boolean;
  primary: string | null;
  topics: NtfyTopic[];
};

export async function fetchNotificationStatus(signal?: AbortSignal): Promise<NotificationStatus> {
  return json<NotificationStatus>(await fetch("/api/notifications/status", { signal }));
}

export async function sendTestNotification(
  urlOverride?: string,
): Promise<{ ok: boolean; sent: number; errors: string[] }> {
  return json(await fetch("/api/notifications/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(urlOverride ? { url: urlOverride } : {}),
  }));
}

export async function addNtfyTopic(url: string, label?: string): Promise<{ topics: NtfyTopic[] }> {
  return json(await fetch("/api/notifications/topics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, label }),
  }));
}

export async function removeNtfyTopic(url: string): Promise<{ topics: NtfyTopic[] }> {
  return json(await fetch(`/api/notifications/topics?url=${encodeURIComponent(url)}`, {
    method: "DELETE",
  }));
}

export type StatusSummary = {
  ts: number;
  mqtt: { configured: boolean; connected: boolean; broker: string | null; lastMsgAgeMs: number | null };
  dock: {
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
  } | null;
  aircraft: {
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
  } | null;
  akamai: { total: number; ready: number };
  ai: {
    workerRunning: boolean;
    workerModality: "rgb" | "ir";
    framesReceived: number;
    latencyMsP50: number | null;
    tapRunning: boolean;
    tapFrameCount: number;
    lastAlertAt: number | null;
  };
  thermal: { sdkAvailable: boolean; hasAnchor: boolean; lastCapturedAt: number | null };
  ntfy: { configured: boolean; topicCount: number; sentToday: number; lastSentAt: number | null };
  alerts: { todayCount: number; unreadCount: number };
  flights: { todayCount: number | null; lastFlightAt: number | null; fh2Available: boolean };
};

export async function fetchStatusSummary(signal?: AbortSignal): Promise<StatusSummary> {
  return json<StatusSummary>(await fetch("/api/status/summary", { signal }));
}

export type NtfySentEntry = {
  ts: number;
  title: string;
  body: string;
  priority: string;
  destinations: number;
  errors: number;
};

export async function fetchRecentNtfy(signal?: AbortSignal): Promise<{ sends: NtfySentEntry[] }> {
  return json<{ sends: NtfySentEntry[] }>(await fetch("/api/notifications/recent", { signal }));
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  data?: unknown;
};

export async function fetchLogs(
  opts?: { since?: number; limit?: number; level?: LogLevel; source?: string },
  signal?: AbortSignal,
): Promise<{ entries: LogEntry[] }> {
  const qs = new URLSearchParams();
  if (opts?.since != null) qs.set("since", String(opts.since));
  if (opts?.limit != null) qs.set("limit", String(opts.limit));
  if (opts?.level) qs.set("level", opts.level);
  if (opts?.source) qs.set("source", opts.source);
  return json<{ entries: LogEntry[] }>(await fetch(`/api/logs?${qs.toString()}`, { signal }));
}

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
  seq: number;
  mediaId: string | null;
  photoUrl: string | null;
  videoUrl: string | null;
};

export type AlertsListResponse = {
  alerts: StoredAlert[];
  ackTs: number;
  unreadCount: number;
};

export async function fetchAlerts(
  opts?: { since?: number; limit?: number },
  signal?: AbortSignal,
): Promise<AlertsListResponse> {
  const qs = new URLSearchParams();
  if (opts?.since != null) qs.set("since", String(opts.since));
  if (opts?.limit != null) qs.set("limit", String(opts.limit));
  const url = qs.toString() ? `/api/alerts?${qs.toString()}` : "/api/alerts";
  return json<AlertsListResponse>(await fetch(url, { signal }));
}

export async function ackAllAlerts(): Promise<{ ackTs: number; unreadCount: number }> {
  return json(await fetch("/api/alerts/ack-all", { method: "POST" }));
}

export async function clearAlerts(
  input: { ids?: string[]; all?: boolean },
): Promise<{ removed: number }> {
  return json(await fetch("/api/alerts/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export type ForwardResult = {
  results: Array<{ id: string; sent: boolean; errors: string[] }>;
};

export async function forwardAlerts(
  input: { ids: string[]; url?: string },
): Promise<ForwardResult> {
  return json(await fetch("/api/alerts/forward", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function seedTestAlerts(count = 3): Promise<{ created: StoredAlert[] }> {
  return json(await fetch("/api/alerts/test-seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  }));
}

export async function fetchThermalOsd(sn: string, signal?: AbortSignal): Promise<ThermalOsdReading> {
  return json<ThermalOsdReading>(
    await fetch(`/api/thermal/osd?sn=${encodeURIComponent(sn)}`, { signal }),
  );
}

export async function fetchAnchorStatus(signal?: AbortSignal): Promise<ThermalAnchorStatus> {
  return json<ThermalAnchorStatus>(await fetch("/api/thermal/anchor/status", { signal }));
}

export async function setAnchorTarget(
  params: { aircraftSn: string; cameraIndex: string },
): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch("/api/thermal/anchor/target", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }),
  );
}

export async function captureAnchor(): Promise<unknown> {
  return json<unknown>(
    await fetch("/api/thermal/anchor/capture", { method: "POST" }),
  );
}

export async function setAnchorAuto(params: { on: boolean; intervalMs?: number }): Promise<unknown> {
  return json<unknown>(
    await fetch("/api/thermal/anchor/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }),
  );
}

export async function measureThermal(
  params: { dockSn: string; cameraIndex: string; x: number; y: number },
  signal?: AbortSignal
): Promise<ThermalMeasurement> {
  return json<ThermalMeasurement>(
    await fetch("/api/thermal/measure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    })
  );
}

export async function switchAircraftLens(
  params: { sn: string; cameraIndex: string; lensType: "wide" | "zoom" | "ir" },
  signal?: AbortSignal
): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch("/api/aircraft/switch-lens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    })
  );
}

export type DockCameraPosition = "indoor" | "outdoor";

export async function switchDockCamera(
  params: { sn: string; cameraIndex: string; cameraPosition: DockCameraPosition },
  signal?: AbortSignal
): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(
    await fetch("/api/dock/switch-camera", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    })
  );
}

export async function fetchMedia(
  params: { sn: string; from: number; to: number },
  signal?: AbortSignal
): Promise<{ list: MediaItem[] }> {
  const qs = new URLSearchParams({
    sn: params.sn,
    from: String(params.from),
    to: String(params.to),
  });
  return json<{ list: MediaItem[] }>(await fetch(`/api/media?${qs.toString()}`, { signal }));
}
