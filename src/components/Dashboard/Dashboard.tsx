import StatCard from "./StatCard";
import IncidentsList from "./IncidentsList";
import SystemStatus from "./SystemStatus";
import TelemetryStrip from "./TelemetryStrip";
import NotificationsPanel from "./NotificationsPanel";
import SystemLogPanel from "./SystemLogPanel";
import { useStatusSummary } from "../../lib/useStatusSummary";
import "./Dashboard.css";

function lastFlightMeta(lastFlightAt: number | null, fh2Available: boolean): string {
  if (!fh2Available) return "FH2 offline";
  if (!lastFlightAt) return "no flights yet";
  const mins = Math.round((Date.now() - lastFlightAt) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export default function Dashboard() {
  const { data: summary } = useStatusSummary(7000);

  const flights = summary?.flights.todayCount;
  const flightsAvailable = !!summary?.flights.fh2Available;
  const incidentsToday = summary?.alerts.todayCount ?? 0;
  const unread = summary?.alerts.unreadCount ?? 0;
  const notified = summary?.ntfy.sentToday ?? 0;
  const topics = summary?.ntfy.topicCount ?? 0;
  const akamaiReady = summary?.akamai.ready ?? 0;
  const akamaiTotal = summary?.akamai.total ?? 0;

  return (
    <div className="dashboard">
      {/* Today's summary */}
      <div className="section-header">
        <h2 className="section-title">Today's summary</h2>
        <span className="section-meta">
          Last flight: {lastFlightMeta(summary?.flights.lastFlightAt ?? null, flightsAvailable)}
        </span>
      </div>
      <div className="stat-grid">
        <StatCard
          label="Flights today"
          value={flightsAvailable && flights != null ? String(flights) : "—"}
          sub={flightsAvailable ? "FH2 tasks" : "FH2 unavailable"}
        />
        <StatCard
          label="Incidents found"
          value={String(incidentsToday)}
          sub={unread > 0 ? `${unread} unread` : "all reviewed"}
          highlight={incidentsToday > 0}
        />
        <StatCard
          label="Notified"
          value={String(notified)}
          sub={`${topics} ntfy topic${topics === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Live streams"
          value={akamaiTotal > 0 ? `${akamaiReady}/${akamaiTotal}` : "—"}
          sub="Akamai relays ready"
        />
      </div>

      {/* System status */}
      <SystemStatus summary={summary} />

      {/* Incidents — data-bound to the persistent AI alert store */}
      <div className="section-header">
        <h2 className="section-title">Incidents</h2>
      </div>
      <IncidentsList />

      {/* Bottom row: aircraft telemetry + real notifications-sent panel */}
      <div className="bottom-row">
        <TelemetryStrip summary={summary} />
        <NotificationsPanel summary={summary} />
      </div>

      {/* System log — live tail of everything the server has logged */}
      <SystemLogPanel />
    </div>
  );
}
