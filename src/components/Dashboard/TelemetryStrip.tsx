import { LuBattery, LuArrowUp, LuGauge, LuWind, LuCompass, LuMapPin, LuTimer } from "react-icons/lu";
import type { StatusSummary } from "../../lib/api";
import "./TelemetryStrip.css";

function fmt(v: number | null | undefined, digits = 0, suffix = ""): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}${suffix}`;
}

function fmtLatLon(lat: number | null, lon: number | null): string {
  if (lat == null || lon == null) return "—";
  if (lat === 0 && lon === 0) return "in dock";
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function modeLabel(code: number | null): string {
  switch (code) {
    case 0: return "Standby";
    case 1: return "Takeoff prep";
    case 2: return "Ready";
    case 3: return "Manual";
    case 4: return "Auto takeoff";
    case 5: return "Waypoint";
    case 6: return "Panorama";
    case 7: return "Active track";
    case 8: return "ADS-B avoidance";
    case 9: return "Auto RTH";
    case 10: return "Auto land";
    case 11: return "Force land";
    case 12: return "Tri-motor land";
    case 13: return "Upgrade";
    case 14: return "Waiting";
    case 15: return "Guided";
    case 17: return "Airborne RTH";
    case 33: return "Motors on";
    default: return code != null ? `mode ${code}` : "—";
  }
}

type CellProps = {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string | null;
};

function Cell({ icon, label, value, sub }: CellProps) {
  return (
    <div className="tel-cell">
      <div className="tel-cell-icon">{icon}</div>
      <div className="tel-cell-body">
        <div className="tel-cell-label">{label}</div>
        <div className="tel-cell-value">{value}</div>
        {sub ? <div className="tel-cell-sub">{sub}</div> : null}
      </div>
    </div>
  );
}

export default function TelemetryStrip({ summary }: { summary: StatusSummary | null }) {
  const a = summary?.aircraft;

  return (
    <div className="telemetry-strip-card">
      <div className="telemetry-strip-header">
        <div className="telemetry-strip-title">Aircraft telemetry</div>
        <div className={`telemetry-strip-status ${a?.online ? "online" : "offline"}`}>
          {a?.online ? "live" : "offline"}
          {a?.osdAgeMs != null ? ` · ${Math.round(a.osdAgeMs / 100) / 10}s` : ""}
        </div>
      </div>
      <div className="telemetry-strip-grid">
        <Cell
          icon={<LuBattery size={16} />}
          label="Battery"
          value={fmt(a?.battery_pct, 0, "%")}
          sub={modeLabel(a?.mode_code ?? null)}
        />
        <Cell
          icon={<LuArrowUp size={16} />}
          label="Altitude"
          value={fmt(a?.height_m, 0, " m")}
          sub={a?.vertical_speed != null ? `vs ${a.vertical_speed.toFixed(1)} m/s` : null}
        />
        <Cell
          icon={<LuGauge size={16} />}
          label="Speed"
          value={fmt(a?.horizontal_speed, 1, " m/s")}
          sub={a?.horizontal_speed && a.horizontal_speed > 0.1 ? "in flight" : "grounded"}
        />
        <Cell
          icon={<LuWind size={16} />}
          label="Wind"
          value={fmt(a?.wind_speed, 1, " m/s")}
          sub={a?.wind_direction != null ? `${Math.round(a.wind_direction)}°` : null}
        />
        <Cell
          icon={<LuCompass size={16} />}
          label="Heading"
          value={fmt(a?.attitude_head, 0, "°")}
        />
        <Cell
          icon={<LuMapPin size={16} />}
          label="Position"
          value={fmtLatLon(a?.latitude ?? null, a?.longitude ?? null)}
        />
        <Cell
          icon={<LuTimer size={16} />}
          label="Lifetime"
          value={fmt(a?.total_flight_sorties, 0, " sorties")}
          sub={`${fmtDuration(a?.total_flight_time_s ?? null)} · ${fmt(
            (a?.total_flight_distance_m ?? 0) / 1000,
            1,
            " km",
          )}`}
        />
      </div>
    </div>
  );
}
