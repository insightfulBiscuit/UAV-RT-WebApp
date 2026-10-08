import { useEffect, useState } from "react";
import { LuBellRing, LuBellOff, LuTriangleAlert } from "react-icons/lu";
import { fetchRecentNtfy, type NtfySentEntry, type StatusSummary } from "../../lib/api";
import "./NotificationsPanel.css";

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function priorityClass(priority: string): string {
  if (priority === "max") return "urgent";
  if (priority === "high") return "warn";
  return "info";
}

/**
 * Live "notifications sent" panel — reads the ntfy send-log ring buffer.
 * The summary is passed in so the header row can show topic count + today's
 * count without a second poll.
 */
export default function NotificationsPanel({ summary }: { summary: StatusSummary | null }) {
  const [sends, setSends] = useState<NtfySentEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetchRecentNtfy();
        if (stopped) return;
        setSends(res.sends);
        setError(null);
      } catch (err) {
        if (stopped) return;
        setError((err as Error).message);
      }
    };
    tick();
    const t = setInterval(tick, 15_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  const configured = summary?.ntfy.configured ?? false;
  const topicCount = summary?.ntfy.topicCount ?? 0;
  const sentToday = summary?.ntfy.sentToday ?? 0;

  return (
    <div className="notifications-card">
      <div className="notifications-header">
        <div className="notifications-title">Notifications sent</div>
        <div className="notifications-meta">
          {configured
            ? `${topicCount} topic${topicCount === 1 ? "" : "s"} · ${sentToday} today`
            : "not configured"}
        </div>
      </div>

      <div className="notif-list">
        {error ? (
          <div className="notif-empty">Failed to load: {error}</div>
        ) : !configured ? (
          <div className="notif-empty">
            <LuBellOff size={20} />
            <div>Add an ntfy topic in Live view → Alert thresholds → Send test push.</div>
          </div>
        ) : sends.length === 0 ? (
          <div className="notif-empty">
            <LuBellRing size={20} />
            <div>No pushes sent yet. Alerts will fan out to your topic(s) when the AI fires.</div>
          </div>
        ) : (
          sends.map((s) => (
            <div key={s.ts} className="notif-item">
              <div className={`notif-icon ${priorityClass(s.priority)}`}>
                <LuTriangleAlert size={16} color="#fff" />
              </div>
              <div className="notif-body">
                <div className="notif-title-row">{s.title}</div>
                <div className="notif-meta">
                  {s.body} · {ago(s.ts)} · {s.destinations} sent
                  {s.errors > 0 ? ` · ${s.errors} err` : ""}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
