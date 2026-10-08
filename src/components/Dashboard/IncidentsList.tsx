import { useMemo, useState } from "react";
import {
  LuFlame, LuUser, LuCar, LuTriangleAlert, LuCloud, LuTreePine,
  LuTrash2, LuSend, LuImage, LuVideo, LuCircleCheck, LuFlaskConical,
} from "react-icons/lu";
import { useNavigate } from "react-router-dom";
import type { StoredAlert } from "../../lib/api";
import { forwardAlerts, seedTestAlerts } from "../../lib/api";
import { useAlertInboxContext } from "../../lib/alertInboxContext";
import AlertPreviewModal from "./AlertPreviewModal";
import "./IncidentsList.css";

function startOfLocalDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function iconFor(cls: string) {
  const size = 18;
  const color = "#fff";
  switch (cls) {
    case "fire": return <LuFlame size={size} color={color} />;
    case "smoke": return <LuCloud size={size} color={color} />;
    case "person": return <LuUser size={size} color={color} />;
    case "vehicle": return <LuCar size={size} color={color} />;
    case "tree":
    case "dry_grass":
    case "green_grass": return <LuTreePine size={size} color={color} />;
    default: return <LuTriangleAlert size={size} color={color} />;
  }
}

function isUrgent(alert: StoredAlert): boolean {
  if (alert.class === "fire" || alert.class === "smoke") return true;
  return /critical|extreme|unknownhigh/i.test(alert.trigger);
}

export default function IncidentsList() {
  const { state, clear, refresh } = useAlertInboxContext();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<StoredAlert | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const navigate = useNavigate();

  const midnight = startOfLocalDay();
  const today = useMemo(
    () => state.alerts.filter((a) => a.ts >= midnight),
    [state.alerts, midnight],
  );

  const allSelected = today.length > 0 && today.every((a) => selected.has(a.id));
  const selectedList = today.filter((a) => selected.has(a.id));
  const selectionCount = selectedList.length;

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(today.map((a) => a.id)));
  };
  const clearSelected = async () => {
    if (selectionCount === 0) return;
    const ids = [...selected];
    setSelected(new Set());
    const res = await clear({ ids });
    setNotice(`Cleared ${res.removed} incident${res.removed === 1 ? "" : "s"}.`);
    setTimeout(() => setNotice(null), 3500);
  };
  const forwardSelected = async () => {
    if (selectionCount === 0 || forwarding) return;
    setForwarding(true);
    setNotice("Forwarding via ntfy…");
    try {
      const ids = [...selected];
      const res = await forwardAlerts({ ids });
      const okCount = res.results.filter((r) => r.sent).length;
      const failCount = res.results.length - okCount;
      setNotice(
        failCount === 0
          ? `Forwarded ${okCount} incident${okCount === 1 ? "" : "s"} to ntfy.`
          : `Forwarded ${okCount}; ${failCount} failed. See browser console.`,
      );
      if (failCount > 0) {
        console.warn("[forward] partial failure:", res.results.filter((r) => !r.sent));
      }
    } catch (err) {
      setNotice(`Forward failed: ${(err as Error).message}`);
    } finally {
      setForwarding(false);
      setTimeout(() => setNotice(null), 5000);
    }
  };
  const seedSome = async () => {
    if (seeding) return;
    setSeeding(true);
    try {
      await seedTestAlerts(5);
      await refresh();
      setNotice("Seeded 5 test incidents.");
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      setNotice(`Seed failed: ${(err as Error).message}`);
    } finally {
      setSeeding(false);
    }
  };

  const inSelectionMode = selectionCount > 0;

  return (
    <div className="incidents-card">
      <div className="incidents-toolbar">
        <div className="incidents-toolbar-left">
          {today.length > 0 ? (
            <label className="incidents-select-all">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={selectAll}
                aria-label="Select all today's incidents"
              />
              <span>
                {inSelectionMode
                  ? `${selectionCount} selected`
                  : `${today.length} today`}
              </span>
            </label>
          ) : (
            <span className="incidents-toolbar-empty">0 today</span>
          )}
        </div>
        <div className="incidents-toolbar-right">
          <button
            className="incidents-btn"
            onClick={forwardSelected}
            disabled={!inSelectionMode || forwarding}
            title="Forward selected to ntfy (with photo + video)"
          >
            <LuSend size={14} />
            <span>Forward</span>
          </button>
          <button
            className="incidents-btn danger"
            onClick={clearSelected}
            disabled={!inSelectionMode}
            title="Delete selected incidents + their media"
          >
            <LuTrash2 size={14} />
            <span>Clear</span>
          </button>
          <button
            className="incidents-btn ghost"
            onClick={seedSome}
            disabled={seeding}
            title="Seed 5 fake incidents (dev)"
          >
            <LuFlaskConical size={14} />
            <span>Seed</span>
          </button>
        </div>
      </div>

      {notice ? <div className="incidents-notice">{notice}</div> : null}

      {state.loading ? (
        <div className="incidents-empty">Loading incidents…</div>
      ) : state.error ? (
        <div className="incidents-empty">Failed to load: {state.error}</div>
      ) : today.length === 0 ? (
        <div className="incidents-empty">
          <LuCircleCheck size={24} />
          <div>No incidents today. AI detections will appear here as they fire.</div>
          <div className="incidents-empty-sub">
            <button className="incidents-empty-btn" onClick={() => navigate("/live")}>
              Open Live view →
            </button>
          </div>
        </div>
      ) : (
        <ul className="incidents-rows">
          {today.map((a) => {
            const isSel = selected.has(a.id);
            const urgent = isUrgent(a);
            return (
              <li
                key={a.id}
                className={`incident-row${isSel ? " selected" : ""}${urgent ? " urgent" : ""}`}
                onClick={() => toggle(a.id)}
              >
                <label
                  className="incident-check"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => toggle(a.id)}
                    aria-label={`Select ${a.class} incident`}
                  />
                </label>

                <div
                  className="incident-thumb"
                  onClick={(e) => { e.stopPropagation(); setPreview(a); }}
                  title={a.photoUrl ? "Open preview" : "Media still capturing…"}
                >
                  {a.photoUrl ? (
                    <img src={a.photoUrl} alt="" />
                  ) : (
                    <div className="incident-thumb-icon" style={{ background: a.color }}>
                      {iconFor(a.class)}
                    </div>
                  )}
                  <div className="incident-thumb-badges">
                    {a.photoUrl ? <span title="Photo"><LuImage size={11} /></span> : null}
                    {a.videoUrl ? <span title="5s clip"><LuVideo size={11} /></span> : null}
                  </div>
                </div>

                <div className="incident-info">
                  <div className="incident-title-row">
                    <span className="incident-title-cls">{a.class.replace(/_/g, " ")}</span>
                    {a.trigger ? <span className="incident-title-trigger">· {a.trigger}</span> : null}
                    {urgent ? <span className="incident-badge urgent">Urgent</span> : null}
                  </div>
                  <div className="incident-meta">
                    {formatTime(a.ts)} · {a.modality.toUpperCase()}
                    {a.temp_c != null ? ` · ${a.temp_c.toFixed(1)}°C` : ""}
                    {" · conf "}
                    {(a.conf * 100).toFixed(0)}%
                  </div>
                </div>

                <button
                  className="incident-preview-btn"
                  onClick={(e) => { e.stopPropagation(); setPreview(a); }}
                >
                  Preview →
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {preview ? <AlertPreviewModal alert={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}
