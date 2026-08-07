import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuPlay, LuSquare, LuRadio, LuRotateCw } from "react-icons/lu";
import {
  fetchDevices,
  startLivestream,
  type Camera,
  type Device,
  type QualityType,
} from "../../lib/api";
import { playWhep, type WhepSession } from "../../lib/whep";
import "./Livestream.css";

type StreamStatus = "idle" | "starting" | "connecting" | "live" | "error" | "stopped";

export default function Livestream() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [droneSn, setDroneSn] = useState<string>("");
  const [cameraIndex, setCameraIndex] = useState<string>("");
  const [quality, setQuality] = useState<QualityType>("adaptive");
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [streamInfo, setStreamInfo] = useState<{ url: string; expiresAt: Date } | null>(null);
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<WhepSession | null>(null);

  const loadDevices = useCallback(async (signal?: AbortSignal) => {
    setRefreshingDevices(true);
    try {
      const r = await fetchDevices(signal);
      setDevices(r.list);
      setDroneSn((prev) => {
        if (prev) return prev;
        const firstDrone = r.list.find((d) => d.drone?.sn);
        return firstDrone?.drone?.sn ?? "";
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRefreshingDevices(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadDevices(ctrl.signal);
    return () => {
      ctrl.abort();
      sessionRef.current?.stop();
    };
  }, [loadDevices]);

  const activeDrone = useMemo(() => {
    return devices.find((d) => d.drone?.sn === droneSn)?.drone;
  }, [devices, droneSn]);

  const cameras: Camera[] = useMemo(() => {
    return activeDrone?.camera_list ?? [];
  }, [activeDrone]);

  useEffect(() => {
    if (cameras.length > 0 && !cameras.some((c) => c.camera_index === cameraIndex)) {
      setCameraIndex(cameras[0].camera_index);
    }
    if (cameras.length === 0) setCameraIndex("");
  }, [cameras, cameraIndex]);

  const droneOptions = useMemo(() => {
    return devices
      .filter((d) => d.drone?.sn)
      .map((d) => d.drone!);
  }, [devices]);

  const canStart =
    !!droneSn &&
    !!cameraIndex &&
    activeDrone?.device_online_status !== false &&
    (status === "idle" || status === "stopped" || status === "error");

  async function handleStart() {
    if (!videoRef.current || !droneSn || !cameraIndex) return;
    setError(null);
    setStatus("starting");
    try {
      const s = await startLivestream({ sn: droneSn, cameraIndex, qualityType: quality });
      setStreamInfo({ url: s.url, expiresAt: new Date(s.expire_ts * 1000) });
      setStatus("connecting");
      const session = await playWhep(s.url, videoRef.current, (err) => {
        setError(err.message);
        setStatus("error");
      });
      sessionRef.current = session;
      setStatus("live");
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
    }
  }

  function handleStop() {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setStatus("stopped");
    setStreamInfo(null);
  }

  const droneOffline = activeDrone?.device_online_status === false;

  return (
    <div className="live">
      <div className="section-header">
        <h2 className="section-title">Live view</h2>
        <StatusPill status={status} />
      </div>

      <div className="live-controls">
        <label className="ml-field">
          <span>Drone</span>
          <select value={droneSn} onChange={(e) => setDroneSn(e.target.value)}>
            {droneOptions.length === 0 && <option value="">No drones</option>}
            {droneOptions.map((d) => (
              <option key={d.sn} value={d.sn}>
                {(d.callsign || d.device_model?.name || d.sn) +
                  (d.device_online_status === false ? " (offline)" : "")}
              </option>
            ))}
          </select>
        </label>
        <label className="ml-field">
          <span>Camera</span>
          <select
            value={cameraIndex}
            onChange={(e) => setCameraIndex(e.target.value)}
            disabled={cameras.length === 0}
          >
            {cameras.length === 0 && <option value="">No cameras</option>}
            {cameras.map((c) => (
              <option key={c.camera_index} value={c.camera_index}>
                {c.camera_position ? `${c.camera_position} · ` : ""}
                {c.camera_index}
              </option>
            ))}
          </select>
        </label>
        <label className="ml-field">
          <span>Quality</span>
          <select value={quality} onChange={(e) => setQuality(e.target.value as QualityType)}>
            <option value="adaptive">Adaptive</option>
            <option value="smooth">Smooth</option>
            <option value="ultra_high_definition">High definition</option>
          </select>
        </label>
        <div className="live-actions">
          <button
            className="live-btn refresh"
            onClick={() => loadDevices()}
            disabled={refreshingDevices}
            type="button"
            title="Re-check device status"
          >
            <LuRotateCw size={14} className={refreshingDevices ? "spin" : ""} /> Refresh
          </button>
          {status === "live" ? (
            <button className="live-btn stop" onClick={handleStop} type="button">
              <LuSquare size={14} /> Stop
            </button>
          ) : (
            <button className="live-btn go" onClick={handleStart} disabled={!canStart} type="button">
              <LuPlay size={14} /> Go live
            </button>
          )}
        </div>
      </div>

      {droneOffline && (
        <div className="live-notice">
          Drone is offline in FlightHub 2. Livestream will fail until the aircraft powers on and connects.
        </div>
      )}

      {cameras.length === 0 && !droneOffline && droneSn && (
        <div className="live-notice">
          No cameras reported for this drone yet. The camera list only populates after the aircraft is powered on.
        </div>
      )}

      {error && <div className="ml-error">{error}</div>}

      <div className="live-video-wrap">
        <video
          ref={videoRef}
          className="live-video"
          autoPlay
          playsInline
          muted
          controls={status === "live"}
        />
        {status !== "live" && (
          <div className="live-video-overlay">
            <LuRadio size={40} />
            <p>{overlayText(status, droneOffline)}</p>
          </div>
        )}
      </div>

      {streamInfo && (
        <div className="live-meta">
          Stream expires {streamInfo.expiresAt.toLocaleTimeString()} ·{" "}
          <span className="live-mono">{new URL(streamInfo.url).host}</span>
        </div>
      )}
    </div>
  );
}

function overlayText(status: StreamStatus, offline: boolean): string {
  if (offline) return "Drone offline — cannot start stream";
  switch (status) {
    case "starting":
      return "Requesting stream from FlightHub…";
    case "connecting":
      return "Negotiating WebRTC connection…";
    case "error":
      return "Stream failed — see message above";
    case "stopped":
      return "Stream stopped";
    default:
      return "Press “Go live” to begin streaming";
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
