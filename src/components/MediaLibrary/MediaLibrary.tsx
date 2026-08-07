import { useEffect, useMemo, useState } from "react";
import { LuDownload, LuImage, LuVideo, LuFile, LuX } from "react-icons/lu";
import { fetchDevices, fetchMedia, type Device, type MediaItem } from "../../lib/api";
import "./MediaLibrary.css";

type FileTypeFilter = "all" | "image" | "video" | "ppk";

function toUnix(dateStr: string, endOfDay = false): number {
  const d = new Date(dateStr);
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function humanSize(bytes: number): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function TypeIcon({ type }: { type: string }) {
  if (type === "image") return <LuImage size={14} />;
  if (type === "video") return <LuVideo size={14} />;
  return <LuFile size={14} />;
}

export default function MediaLibrary() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceSn, setDeviceSn] = useState<string>("");
  const [from, setFrom] = useState<string>(isoDaysAgo(7));
  const [to, setTo] = useState<string>(isoToday());
  const [typeFilter, setTypeFilter] = useState<FileTypeFilter>("all");
  const [taskFilter, setTaskFilter] = useState<string>("");
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MediaItem | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchDevices(ctrl.signal)
      .then((r) => {
        setDevices(r.list);
        const firstSn = r.list[0]?.gateway?.sn ?? r.list[0]?.drone?.sn;
        if (firstSn && !deviceSn) setDeviceSn(firstSn);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!deviceSn) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetchMedia({ sn: deviceSn, from: toUnix(from), to: toUnix(to, true) }, ctrl.signal)
      .then((r) => setItems(r.list))
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [deviceSn, from, to]);

  const tasks = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of items) map.set(it.task_uuid, it.task_name || it.task_uuid.slice(0, 8));
    return [...map.entries()].map(([uuid, name]) => ({ uuid, name }));
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (typeFilter !== "all" && it.file_type !== typeFilter) return false;
      if (taskFilter && it.task_uuid !== taskFilter) return false;
      return true;
    });
  }, [items, typeFilter, taskFilter]);

  return (
    <div className="media-lib">
      <div className="section-header">
        <h2 className="section-title">Media library</h2>
        <span className="section-meta">
          {loading ? "Loading…" : `${filtered.length} of ${items.length} files`}
        </span>
      </div>

      <div className="media-filters">
        <label className="ml-field">
          <span>Device</span>
          <select value={deviceSn} onChange={(e) => setDeviceSn(e.target.value)}>
            {devices.length === 0 && <option value="">No devices</option>}
            {devices.map((d) => {
              const gw = d.gateway;
              if (!gw?.sn) return null;
              const label = gw.callsign || gw.device_model?.name || gw.sn;
              return (
                <option key={gw.sn} value={gw.sn}>
                  {label}{gw.device_online_status === false ? " (offline)" : ""}
                </option>
              );
            })}
          </select>
        </label>
        <label className="ml-field">
          <span>From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="ml-field">
          <span>To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="ml-field">
          <span>Type</span>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as FileTypeFilter)}>
            <option value="all">All</option>
            <option value="image">Images</option>
            <option value="video">Videos</option>
            <option value="ppk">PPK</option>
          </select>
        </label>
        <label className="ml-field">
          <span>Mission</span>
          <select value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)}>
            <option value="">All missions</option>
            {tasks.map((t) => (
              <option key={t.uuid} value={t.uuid}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <div className="ml-error">Failed to load: {error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div className="ml-empty">No media in the selected range.</div>
      )}

      <div className="media-grid">
        {filtered.map((it) => (
          <button
            key={it.uuid}
            className="media-card"
            onClick={() => setPreview(it)}
            type="button"
          >
            <div className="media-thumb">
              {it.preview_url ? (
                <img src={it.preview_url} alt={it.name} loading="lazy" />
              ) : (
                <div className="media-thumb-fallback">
                  <TypeIcon type={it.file_type} />
                </div>
              )}
              <span className="media-type-badge">
                <TypeIcon type={it.file_type} />
              </span>
            </div>
            <div className="media-meta">
              <div className="media-name" title={it.name}>{it.name}</div>
              <div className="media-sub">
                {humanSize(it.size)} · {new Date(it.create_at).toLocaleDateString()}
              </div>
            </div>
          </button>
        ))}
      </div>

      {preview && (
        <div className="ml-modal-backdrop" onClick={() => setPreview(null)}>
          <div className="ml-modal" onClick={(e) => e.stopPropagation()}>
            <button className="ml-modal-close" onClick={() => setPreview(null)} aria-label="Close">
              <LuX size={18} />
            </button>
            <div className="ml-modal-body">
              {preview.file_type === "video" ? (
                <video src={preview.original_url} controls autoPlay />
              ) : preview.file_type === "image" ? (
                <img src={preview.original_url} alt={preview.name} />
              ) : (
                <div className="ml-modal-fallback">
                  <LuFile size={48} />
                  <p>{preview.name}</p>
                </div>
              )}
            </div>
            <div className="ml-modal-footer">
              <div className="ml-modal-info">
                <div className="ml-modal-title">{preview.name}</div>
                <div className="ml-modal-sub">
                  {preview.task_name} · {humanSize(preview.size)} ·{" "}
                  {new Date(preview.create_at).toLocaleString()}
                </div>
              </div>
              <a
                className="ml-download"
                href={preview.original_url}
                download={preview.name + preview.suffix}
                target="_blank"
                rel="noreferrer"
              >
                <LuDownload size={14} /> Download
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
