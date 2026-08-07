export type Camera = {
  camera_index: string;
  camera_position?: string;
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
  url: string;
  url_type: string;
};

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
