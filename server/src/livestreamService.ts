import { Fh2Config, fh2Post } from "./fh2Client.js";

export type QualityType = "adaptive" | "smooth" | "ultra_high_definition";

export type StartLivestreamParams = {
  sn: string;
  cameraIndex: string;
  videoExpire?: number;
  qualityType?: QualityType;
};

/**
 * Response we hand to the frontend. `whepUrl` is what the browser plays.
 * `rtmpUrl` is where FH2 told the dock to push (kept for diagnostics + AI tap).
 * `streamKey` is the shared identifier used by both.
 */
export type LivestreamStart = {
  expire_ts: number;
  streamKey: string;
  whepUrl: string | null;
  rtmpUrl: string | null;
  raw: {
    url_type?: string;
    url?: string;
  };
};

/**
 * Compose a stable stream key from SN + camera_index. Kept URL-safe so it
 * can appear in both RTMP paths and WHEP URLs without extra encoding.
 */
export function streamKeyFor(sn: string, cameraIndex: string): string {
  return `${sn}_${cameraIndex.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * Ask FH2 to make the dock push RTMP to our MediaMTX. FH2 supports
 * `url_type: "rtmp"` with a caller-supplied push URL. We build that URL from
 * env config so the dock and the browser always talk about the same stream.
 *
 * Required env:
 *   RTMP_PUSH_URL_BASE       e.g. rtmp://media.example.com:1935/live
 *   WHEP_PLAYBACK_URL_BASE   e.g. https://media.example.com:8889/live
 *
 * The stream key gets appended:  {base}/{streamKey}          (RTMP push)
 *                                {base}/{streamKey}/whep     (WHEP playback)
 */
export async function startLivestream(
  cfg: Fh2Config,
  params: StartLivestreamParams,
): Promise<LivestreamStart> {
  const rtmpBase = process.env.RTMP_PUSH_URL_BASE;
  const whepBase = process.env.WHEP_PLAYBACK_URL_BASE;
  if (!rtmpBase) {
    throw new Error(
      "RTMP_PUSH_URL_BASE not set on the server. Point it at your MediaMTX ingest (e.g. rtmp://media.example.com:1935/live).",
    );
  }
  const streamKey = streamKeyFor(params.sn, params.cameraIndex);
  const rtmpUrl = `${rtmpBase.replace(/\/+$/, "")}/${streamKey}`;

  // DJI FH2 request field is `type` (not `url_type`); response echoes it back
  // as `url_type`. Accepted values include "rtmp", "rtsp", "gb28181", "agora",
  // "webrtc". FH2 falls back to Volcengine if `type` is missing or unsupported.
  const raw = await fh2Post<{ expire_ts: number; url_type?: string; url?: string }>(
    cfg,
    "/live-stream/start",
    {
      sn: params.sn,
      camera_index: params.cameraIndex,
      video_expire: params.videoExpire ?? 7200,
      quality_type: params.qualityType ?? "adaptive",
      type: "rtmp",
      url: rtmpUrl,
    },
  );

  const whepUrl = whepBase
    ? `${whepBase.replace(/\/+$/, "")}/${streamKey}/whep`
    : null;

  return {
    expire_ts: raw.expire_ts,
    streamKey,
    whepUrl,
    rtmpUrl,
    raw,
  };
}

export type DockCameraPosition = "indoor" | "outdoor";

export async function switchDockCamera(
  cfg: Fh2Config,
  params: { sn: string; cameraIndex: string; cameraPosition: DockCameraPosition },
): Promise<void> {
  await fh2Post<unknown>(cfg, "/device/change-camera", {
    sn: params.sn,
    camera_index: params.cameraIndex,
    camera_position: params.cameraPosition,
  });
}

export type LensType = "wide" | "zoom" | "ir";

export async function acquireControl(
  cfg: Fh2Config,
  params: { droneSn: string; payloadIndex: string[] },
): Promise<unknown> {
  return fh2Post<unknown>(cfg, "/device/control", {
    drone_sn: params.droneSn,
    payload_index: params.payloadIndex,
  });
}

export async function switchAircraftLens(
  cfg: Fh2Config,
  params: { sn: string; cameraIndex: string; lensType: LensType },
): Promise<void> {
  await fh2Post<unknown>(cfg, "/device/change-lens", {
    sn: params.sn,
    camera_index: params.cameraIndex,
    lens_type: params.lensType,
  });
}
