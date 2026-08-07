import { Fh2Config, fh2Post } from "./fh2Client.js";

export type QualityType = "adaptive" | "smooth" | "ultra_high_definition";

export type StartLivestreamParams = {
  sn: string;
  cameraIndex: string;
  videoExpire?: number;
  qualityType?: QualityType;
};

export type LivestreamStart = {
  expire_ts: number;
  url: string;
  url_type: string;
};

export async function startLivestream(
  cfg: Fh2Config,
  params: StartLivestreamParams
): Promise<LivestreamStart> {
  return fh2Post<LivestreamStart>(cfg, "/live-stream/start", {
    sn: params.sn,
    camera_index: params.cameraIndex,
    video_expire: params.videoExpire ?? 7200,
    quality_type: params.qualityType ?? "adaptive",
  });
}
