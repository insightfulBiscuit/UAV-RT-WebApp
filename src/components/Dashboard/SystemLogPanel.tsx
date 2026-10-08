import { useEffect, useState } from "react";
import { LuScrollText, LuPause, LuPlay, LuDownload } from "react-icons/lu";
import { fetchLogs, type LogEntry, type LogLevel } from "../../lib/api";
import "./SystemLogPanel.css";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const POLL_MS = 5000;

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

/**
 * Live tail of the persisted system log (see server/src/logger.ts). Polls
 * `/api/logs` — the in-memory ring, so this only shows activity since the
 * server last started. Pulling history from before a restart means grabbing
 * a day file directly: `/api/logs/files/:day`.
 */
export default function SystemLogPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [minLevel, setMinLevel] = useState<LogLevel>("info");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (paused) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetchLogs({ level: minLevel, limit: 200 });
        if (stopped) return;
        setEntries(res.entries);
        setError(null);
      } catch (err) {
        if (stopped) return;
        setError((err as Error).message);
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [minLevel, paused]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="syslog-card">
      <div className="syslog-header">
        <div className="syslog-title">
          <LuScrollText size={16} />
          System log
        </div>
        <div className="syslog-controls">
          <select
            className="syslog-level-select"
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as LogLevel)}
            title="Minimum level shown"
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l}+</option>
            ))}
          </select>
          <button
            type="button"
            className={`syslog-icon-btn ${paused ? "active" : ""}`}
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Resume live tail" : "Pause"}
          >
            {paused ? <LuPlay size={14} /> : <LuPause size={14} />}
          </button>
          <a
            className="syslog-icon-btn"
            href={`/api/logs/files/${today}`}
            title={`Download today's log (${today})`}
          >
            <LuDownload size={14} />
          </a>
        </div>
      </div>

      <div className="syslog-list">
        {error ? (
          <div className="syslog-empty">Failed to load: {error}</div>
        ) : entries.length === 0 ? (
          <div className="syslog-empty">No log entries at this level yet.</div>
        ) : (
          entries.map((e, i) => (
            <div key={`${e.ts}-${i}`} className={`syslog-row level-${e.level}`}>
              <span className="syslog-time">{timeLabel(e.ts)}</span>
              <span className={`syslog-level-badge level-${e.level}`}>{e.level}</span>
              <span className="syslog-source">[{e.source}]</span>
              <span className="syslog-message">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
