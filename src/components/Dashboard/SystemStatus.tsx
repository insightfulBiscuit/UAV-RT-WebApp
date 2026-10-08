import {
  LuRadio,
  LuWarehouse,
  LuPlane,
  LuVideo,
  LuCpu,
  LuThermometer,
  LuBellRing,
} from "react-icons/lu";
import type { StatusSummary } from "../../lib/api";
import "./SystemStatus.css";

/**
 * System-status card — same visual grammar as TelemetryStrip:
 * bordered card, title + right-side status pill, then a grid of icon/label/
 * value/sub cells. Each cell carries a small coloured dot to signal state
 * without cluttering the layout.
 */

type CellState = "ok" | "warn" | "bad" | "off";

type Cell = {
  label: string;
  icon: React.ReactNode;
  value: string;
  sub?: string | null;
  state: CellState;
};

function mqttCell(s: StatusSummary): Cell {
  if (!s.mqtt.configured) return { label: "MQTT", icon: <LuRadio size={16} />, value: "not configured", state: "off" };
  if (!s.mqtt.connected)  return { label: "MQTT", icon: <LuRadio size={16} />, value: "disconnected", state: "bad" };
  const age = s.mqtt.lastMsgAgeMs ?? Infinity;
  const state: CellState = age < 5_000 ? "ok" : age < 30_000 ? "warn" : "bad";
  const sub = age === Infinity ? "no messages yet"
    : age < 1000 ? `${age} ms fresh`
    : `${Math.round(age / 1000)} s ago`;
  return { label: "MQTT", icon: <LuRadio size={16} />, value: "connected", state, sub };
}

function dockCell(s: StatusSummary): Cell {
  const d = s.dock;
  if (!d) return { label: "Dock 3", icon: <LuWarehouse size={16} />, value: "no dock SN", state: "off" };
  if (!d.online) return { label: "Dock 3", icon: <LuWarehouse size={16} />, value: "offline", state: "bad" };
  const cover = d.cover_state === 0 ? "closed"
    : d.cover_state === 1 ? "open"
    : d.cover_state === 2 ? "half"
    : "cover ?";
  const temp = d.env_temp != null ? `${d.env_temp.toFixed(1)}°C` : "—";
  return {
    label: "Dock 3",
    icon: <LuWarehouse size={16} />,
    value: `mode ${d.mode_code ?? "?"}`,
    state: "ok",
    sub: `${temp} · cover ${cover}`,
  };
}

function aircraftCell(s: StatusSummary): Cell {
  const a = s.aircraft;
  if (!a) return { label: "M4TD", icon: <LuPlane size={16} />, value: "no data", state: "off" };
  if (!a.online) return { label: "M4TD", icon: <LuPlane size={16} />, value: "offline", state: "bad" };
  const bat = a.battery_pct;
  const state: CellState = bat == null ? "warn" : bat < 20 ? "bad" : bat < 40 ? "warn" : "ok";
  const mode = a.mode_code === 0 ? "standby" : `mode ${a.mode_code ?? "?"}`;
  return {
    label: "M4TD",
    icon: <LuPlane size={16} />,
    value: bat != null ? `${bat}% battery` : "—",
    state,
    sub: mode,
  };
}

function akamaiCell(s: StatusSummary): Cell {
  const { ready, total } = s.akamai;
  const state: CellState = total === 0 ? "off"
    : ready === total ? "ok"
    : ready > 0 ? "warn" : "bad";
  return {
    label: "Live streams",
    icon: <LuVideo size={16} />,
    value: `${ready} / ${total} ready`,
    state,
    sub: "Akamai relays",
  };
}

function aiCell(s: StatusSummary): Cell {
  const a = s.ai;
  if (!a.workerRunning) {
    return { label: "AI worker", icon: <LuCpu size={16} />, value: "stopped", state: "off" };
  }
  const state: CellState = a.framesReceived > 0 ? "ok" : "warn";
  const lat = a.latencyMsP50 != null ? `${a.latencyMsP50} ms p50` : "warming";
  return {
    label: "AI worker",
    icon: <LuCpu size={16} />,
    value: `${a.workerModality.toUpperCase()} running`,
    state,
    sub: lat,
  };
}

function thermalCell(s: StatusSummary): Cell {
  if (!s.thermal.sdkAvailable) {
    return { label: "Thermal SDK", icon: <LuThermometer size={16} />, value: "missing", state: "bad" };
  }
  const age = s.thermal.lastCapturedAt
    ? Math.round((Date.now() - s.thermal.lastCapturedAt) / 1000)
    : null;
  return {
    label: "Thermal SDK",
    icon: <LuThermometer size={16} />,
    value: "ready",
    state: "ok",
    sub: age != null ? `anchor ${age} s ago` : "no anchor yet",
  };
}

function ntfyCell(s: StatusSummary): Cell {
  if (!s.ntfy.configured) {
    return { label: "Notifications", icon: <LuBellRing size={16} />, value: "not configured", state: "off" };
  }
  const topics = s.ntfy.topicCount;
  return {
    label: "Notifications",
    icon: <LuBellRing size={16} />,
    value: `${topics} topic${topics === 1 ? "" : "s"}`,
    state: "ok",
    sub: s.ntfy.sentToday > 0 ? `${s.ntfy.sentToday} sent today` : "0 sent today",
  };
}

function overallHealth(cells: Cell[]): { label: string; className: string } {
  const has = (st: CellState) => cells.some((c) => c.state === st);
  if (has("bad")) return { label: "issues", className: "bad" };
  if (has("warn")) return { label: "degraded", className: "warn" };
  if (has("off") && !cells.some((c) => c.state === "ok")) {
    return { label: "offline", className: "offline" };
  }
  return { label: "healthy", className: "ok" };
}

function CellView({ cell }: { cell: Cell }) {
  return (
    <div className="sys-cell">
      <div className="sys-cell-icon">{cell.icon}</div>
      <div className="sys-cell-body">
        <div className="sys-cell-label">
          <span className={`sys-cell-dot sys-cell-dot-${cell.state}`} aria-hidden />
          {cell.label}
        </div>
        <div className="sys-cell-value">{cell.value}</div>
        {cell.sub ? <div className="sys-cell-sub">{cell.sub}</div> : null}
      </div>
    </div>
  );
}

export default function SystemStatus({ summary }: { summary: StatusSummary | null }) {
  if (!summary) {
    return (
      <div className="system-status-card">
        <div className="system-status-header">
          <div className="system-status-title">System status</div>
          <div className="system-status-pill offline">loading</div>
        </div>
        <div className="system-status-loading">Fetching summary…</div>
      </div>
    );
  }

  const cells: Cell[] = [
    mqttCell(summary),
    dockCell(summary),
    aircraftCell(summary),
    akamaiCell(summary),
    aiCell(summary),
    thermalCell(summary),
    ntfyCell(summary),
  ];
  const health = overallHealth(cells);

  return (
    <div className="system-status-card">
      <div className="system-status-header">
        <div className="system-status-title">System status</div>
        <div className={`system-status-pill ${health.className}`}>{health.label}</div>
      </div>
      <div className="system-status-grid">
        {cells.map((c) => <CellView key={c.label} cell={c} />)}
      </div>
    </div>
  );
}
