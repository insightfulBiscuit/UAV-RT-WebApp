import { useEffect, useRef, useState } from "react";
import { LuBell, LuCheckCheck } from "react-icons/lu";
import { useNavigate } from "react-router-dom";
import { useAlertInboxContext } from "../../lib/alertInboxContext";
import type { StoredAlert } from "../../lib/api";
import "./NotificationsBell.css";

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function Row({ alert, unread, now }: { alert: StoredAlert; unread: boolean; now: number }) {
  const cls = alert.class.replace(/_/g, " ");
  return (
    <div className={`notif-bell-row${unread ? " unread" : ""}`}>
      <div className="notif-bell-swatch" style={{ background: alert.color }} />
      <div className="notif-bell-body">
        <div className="notif-bell-title">
          {cls}
          {alert.trigger ? <span className="notif-bell-trigger"> · {alert.trigger}</span> : null}
        </div>
        <div className="notif-bell-meta">
          {alert.temp_c != null ? `${alert.temp_c.toFixed(1)}°C · ` : ""}
          conf {(alert.conf * 100).toFixed(0)}% ·{" "}
          <span className="notif-bell-modality">{alert.modality.toUpperCase()}</span> · {ago(alert.ts, now)}
        </div>
      </div>
    </div>
  );
}

export default function NotificationsBell() {
  const { state, ackAll } = useAlertInboxContext();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  // Refresh relative-time display every 20s while dropdown is open.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const unread = state.unreadCount;
  const badge = unread > 99 ? "99+" : String(unread);

  return (
    <div className="notif-bell-wrap" ref={wrapRef}>
      <button
        className="header-icon-btn notif-bell-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        title="Notifications"
      >
        <LuBell size={16} />
        {unread > 0 ? <span className="notif-bell-badge">{badge}</span> : null}
      </button>

      {open ? (
        <div className="notif-bell-dropdown" role="dialog" aria-label="AI alerts">
          <div className="notif-bell-header">
            <span className="notif-bell-header-title">Alerts</span>
            <span className={`notif-bell-status ${state.connected ? "live" : "offline"}`}>
              {state.connected ? "live" : "offline"}
            </span>
            <div className="notif-bell-spacer" />
            <button
              className="notif-bell-action"
              onClick={() => ackAll()}
              disabled={unread === 0}
              title="Mark all as read"
            >
              <LuCheckCheck size={14} />
              <span>Mark all read</span>
            </button>
          </div>

          <div className="notif-bell-list">
            {state.loading ? (
              <div className="notif-bell-empty">Loading…</div>
            ) : state.error ? (
              <div className="notif-bell-empty">Failed: {state.error}</div>
            ) : state.alerts.length === 0 ? (
              <div className="notif-bell-empty">No alerts yet.</div>
            ) : (
              state.alerts.map((a) => (
                <Row key={a.id} alert={a} unread={a.ts > state.ackTs} now={now} />
              ))
            )}
          </div>

          <div className="notif-bell-footer">
            <button
              className="notif-bell-footer-btn"
              onClick={() => {
                setOpen(false);
                navigate("/live");
              }}
            >
              Open Live view →
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
