import { Fh2AuthConfig, Fh2Config, fh2Get } from "./fh2Client.js";

export type FlightTask = {
  name: string;
  uuid: string;
  task_type: string;
  status: string;
  sn: string;
  landing_dock_sn?: string;
  begin_at: string;
  end_at: string;
  run_at: string;
  completed_at: string;
  wayline_uuid?: string;
  folder_id?: number;
  media_upload_status?: string;
};

export type MediaFile = {
  uuid: string;
  name: string;
  file_type: "image" | "video" | "ppk" | string;
  suffix: string;
  size: number;
  preview_url: string;
  original_url: string;
  create_at: string;
  update_at: string;
};

export type MediaItem = MediaFile & {
  task_uuid: string;
  task_name: string;
  device_sn: string;
};

export type DeviceInfo = {
  sn: string;
  callsign?: string;
  device_online_status?: boolean;
  device_model?: { name?: string; class?: string };
};

export type Device = {
  gateway?: DeviceInfo;
  drone?: DeviceInfo;
};

export type Project = {
  uuid: string;
  name: string;
  introduction?: string;
  org_uuid?: string;
  created_at?: number;
  updated_at?: number;
};

export async function listProjects(cfg: Fh2AuthConfig): Promise<Project[]> {
  const data = await fh2Get<{ list: Project[] }>(cfg, "/project");
  return data.list ?? [];
}

export async function listDevices(cfg: Fh2Config): Promise<Device[]> {
  const data = await fh2Get<{ list: Device[] }>(cfg, "/project/device");
  return data.list ?? [];
}

export async function listOrgDevices(cfg: Fh2AuthConfig): Promise<Device[]> {
  const data = await fh2Get<{ list: Device[] }>(cfg, "/device");
  return data.list ?? [];
}

export async function listTasks(
  cfg: Fh2Config,
  params: { sn: string; from: number; to: number; status?: string[] }
): Promise<FlightTask[]> {
  const data = await fh2Get<{ list: FlightTask[] }>(cfg, "/flight-task/list", {
    sn: params.sn,
    begin_at: params.from,
    end_at: params.to,
    status: params.status,
  });
  return data.list ?? [];
}

export async function listTaskMedia(cfg: Fh2Config, taskUuid: string): Promise<MediaFile[]> {
  const data = await fh2Get<{ list: MediaFile[] }>(cfg, `/flight-task/${taskUuid}/media`);
  return data.list ?? [];
}

export async function listMediaForDevice(
  cfg: Fh2Config,
  params: { sn: string; from: number; to: number }
): Promise<MediaItem[]> {
  const tasks = await listTasks(cfg, params);
  const perTask = await Promise.all(
    tasks.map(async (task) => {
      try {
        const files = await listTaskMedia(cfg, task.uuid);
        return files.map<MediaItem>((f) => ({
          ...f,
          task_uuid: task.uuid,
          task_name: task.name,
          device_sn: task.sn,
        }));
      } catch {
        return [] as MediaItem[];
      }
    })
  );
  const seen = new Set<string>();
  const deduped: MediaItem[] = [];
  for (const item of perTask.flat()) {
    if (seen.has(item.uuid)) continue;
    seen.add(item.uuid);
    deduped.push(item);
  }
  return deduped.sort((a, b) => (a.create_at < b.create_at ? 1 : -1));
}
