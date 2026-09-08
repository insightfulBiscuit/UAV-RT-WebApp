import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LuBellRing,
  LuRotateCw,
  LuSave,
  LuThermometer,
  LuTriangleAlert,
  LuRadio,
  LuX,
} from "react-icons/lu";
import {
  fetchAiTapStatus,
  fetchNotificationStatus,
  fetchThresholds,
  resetThresholds,
  saveThresholds,
  sendTestNotification,
  startAiTap,
  stopAiTap,
  type AiTapStatus,
  type NotificationStatus,
  type ThresholdKey,
  type ThresholdSettings,
} from "../../lib/api";

const FIELD_LABELS: Record<ThresholdKey, string> = {
  triggerC:        "Trigger",
  criticalC:       "Critical",
  combustibleC:    "Combustible",
  personC:         "Person",
  unknownHighC:    "Unknown high",
  unknownExtremeC: "Unknown extreme",
  vehicleExtremeC: "Vehicle extreme",
  cooldownS:       "Cooldown",
};

const FIELD_HELP: Record<ThresholdKey, string> = {
  triggerC:        "Generic warm-object baseline (°C)",
  criticalC:       "Generic critical hot spot (°C)",
  combustibleC:    "tree / tent_tarp / plastic_waste / dry_grass (°C)",
  personC:         "Person body-surface anomaly (°C)",
  unknownHighC:    "Unknown-class hot spot, escalation 1 (°C)",
  unknownExtremeC: "Unknown-class extreme, escalation 2 (°C)",
  vehicleExtremeC: 'Vehicle "engine on fire" territory (°C)',
  cooldownS:       "Re-alert cooldown per class × spatial bin (s)",
};

const FIELD_ORDER: ThresholdKey[] = [
  "triggerC", "criticalC", "combustibleC", "personC",
  "unknownHighC", "unknownExtremeC", "vehicleExtremeC", "cooldownS",
];

const PALETTE_OPTIONS: Array<{ id: number; label: string }> = [
  { id: 0, label: "white_hot" },
  { id: 2, label: "iron_red" },
  { id: 9, label: "black_hot" },
];

type Section = "thresholds" | "thermal" | "aitap";

export type SettingsPanelProps = {
  onClose: () => void;
  activeIsThermal: boolean;
  // Thermal matrix bits (owned by parent)
  matrixOn: boolean;
  setMatrixOn: (v: boolean) => void;
  alertThreshold: number;
  setAlertThreshold: (v: number) => void;
  paletteId: number;
  setPaletteId: (v: number) => void;
  osdPaletteId: number | null;
  // AI tap streamKey (backend actually starts from this)
  aiTapStreamKey: string | null;
};

/**
 * Settings modal — one gear, one place. Tabs:
 *   • Alert thresholds (fire/person/vehicle/etc. + reset defaults)
 *   • Thermal matrix (palette, hot-region overlay, alert temp)
 *   • AI tap (server-side ffmpeg frame tap toggle for debugging)
 */
export function ThresholdsPanel(props: SettingsPanelProps) {
  const { onClose } = props;
  const [section, setSection] = useState<Section>("thresholds");
  const [settings, setSettings] = useState<ThresholdSettings | null>(null);
  const [draft, setDraft] = useState<Partial<Record<ThresholdKey, string>>>({});
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [aiTap, setAiTap] = useState<AiTapStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchThresholds().then((s) => { setSettings(s); syncDraft(s); }).catch((e) => setError((e as Error).message));
    void fetchNotificationStatus().then(setStatus).catch(() => setStatus(null));
    void fetchAiTapStatus().then(setAiTap).catch(() => setAiTap(null));
    const id = window.setInterval(() => void fetchAiTapStatus().then(setAiTap).catch(() => {}), 2000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const syncDraft = (s: ThresholdSettings) => {
    const next: Partial<Record<ThresholdKey, string>> = {};
    for (const k of FIELD_ORDER) next[k] = String(s.effective[k]);
    setDraft(next);
  };

  const dirty = useMemo(() => {
    if (!settings) return false;
    return FIELD_ORDER.some((k) => Number(draft[k]) !== settings.effective[k]);
  }, [draft, settings]);

  const overriddenFields = useMemo<Set<ThresholdKey>>(
    () => new Set((settings ? Object.keys(settings.overrides) : []) as ThresholdKey[]),
    [settings],
  );

  const flashFor = (msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 2500);
  };

  const onSave = useCallback(async () => {
    if (!settings) return;
    setBusy(true); setError(null);
    try {
      const patch: Partial<Record<ThresholdKey, number | null>> = {};
      for (const k of FIELD_ORDER) {
        const raw = draft[k];
        if (raw == null || raw === "") { patch[k] = null; continue; }
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${k} isn't a number`);
        patch[k] = n !== settings.defaults[k] ? n : null;
      }
      const next = await saveThresholds(patch);
      setSettings(next); syncDraft(next);
      flashFor("Saved · AI worker restarting");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [draft, settings]);

  const onReset = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const next = await resetThresholds();
      setSettings(next); syncDraft(next);
      flashFor("Reset · AI worker restarting");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, []);

  const onTestPrimary = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const res = await sendTestNotification();
      if (res.ok) flashFor(`Sent to ${res.sent} destination${res.sent === 1 ? "" : "s"}`);
      else setError(res.errors.join("; ") || "Send failed");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, []);

  const onToggleTap = useCallback(async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (aiTap?.running) {
        setAiTap(await stopAiTap());
      } else if (props.aiTapStreamKey) {
        setAiTap(await startAiTap(props.aiTapStreamKey));
      } else {
        setError("No stream selected — pick a camera tile first.");
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [aiTap?.running, busy, props.aiTapStreamKey]);

  if (!settings) {
    return (
      <div className="settings-backdrop" onClick={onClose}>
        <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
          <div className="settings-tabs">
            <span>Loading…</span>
            <button type="button" className="cockpit-btn settings-close" onClick={onClose} aria-label="Close">
              <LuX size={16} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="settings-tabs">
          <button
            type="button"
            className={`settings-tab${section === "thresholds" ? " active" : ""}`}
            onClick={() => setSection("thresholds")}
          >
            <LuTriangleAlert size={13} /> Alert thresholds
          </button>
          {props.activeIsThermal && (
            <button
              type="button"
              className={`settings-tab${section === "thermal" ? " active" : ""}`}
              onClick={() => setSection("thermal")}
            >
              <LuThermometer size={13} /> Thermal matrix
            </button>
          )}
          <button
            type="button"
            className={`settings-tab${section === "aitap" ? " active" : ""}`}
            onClick={() => setSection("aitap")}
          >
            <LuRadio size={13} /> AI tap
          </button>
          <button
            type="button"
            className="cockpit-btn settings-close"
            onClick={onClose}
            aria-label="Close settings"
            title="Close (Esc)"
          >
            <LuX size={16} />
          </button>
        </div>

        {section === "thresholds" && (
          <>
            <div className="settings-section-head">
              <span className="settings-hint">Persists to <code>server/config/thresholds.json</code>. Saving restarts the AI worker.</span>
              {overriddenFields.size > 0 && (
                <span className="thresholds-badge">{overriddenFields.size} overridden</span>
              )}
              <span className="settings-actions">
                <button type="button" className="live-btn refresh" onClick={onSave} disabled={busy || !dirty}>
                  <LuSave size={13} /> Save
                </button>
                <button type="button" className="live-btn refresh" onClick={onReset} disabled={busy || overriddenFields.size === 0}>
                  <LuRotateCw size={13} /> Reset defaults
                </button>
              </span>
            </div>
            <div className="thresholds-grid">
              {FIELD_ORDER.map((k) => {
                const isOverride = overriddenFields.has(k);
                return (
                  <label key={k} className={`thresholds-field${isOverride ? " override" : ""}`} title={FIELD_HELP[k]}>
                    <span>{FIELD_LABELS[k]}</span>
                    <input
                      type="number"
                      step={k === "cooldownS" ? "0.1" : "1"}
                      value={draft[k] ?? ""}
                      onChange={(e) => setDraft((prev) => ({ ...prev, [k]: e.target.value }))}
                      disabled={busy}
                    />
                    <em>default {settings.defaults[k]}</em>
                  </label>
                );
              })}
            </div>
            <div className="thresholds-footer">
              <span className="thresholds-notify">
                <LuBellRing size={13} />
                {status?.configured
                  ? <>ntfy → {status.primary ? <code>{status.primary}</code> : "—"}{status.topics.length > 0 ? ` +${status.topics.length}` : ""}</>
                  : <>ntfy not configured — add a topic under the bell icon</>}
              </span>
              <button
                type="button"
                className="live-btn refresh"
                onClick={onTestPrimary}
                disabled={busy || !status?.configured}
              >
                Send test push (all)
              </button>
            </div>
          </>
        )}

        {section === "thermal" && props.activeIsThermal && (
          <div className="settings-body">
            <label className="settings-row">
              <input
                type="checkbox"
                checked={props.matrixOn}
                onChange={(e) => props.setMatrixOn(e.target.checked)}
              />
              Hot-region overlay
            </label>
            <label className="settings-row">
              <span>Alert temperature (°C)</span>
              <input
                type="number"
                value={props.alertThreshold}
                onChange={(e) => props.setAlertThreshold(Number(e.target.value) || 0)}
              />
            </label>
            <label className="settings-row">
              <span>Palette (inversion LUT)</span>
              <select
                value={props.paletteId}
                onChange={(e) => props.setPaletteId(Number(e.target.value))}
              >
                {PALETTE_OPTIONS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </label>
            {props.osdPaletteId != null && props.osdPaletteId !== props.paletteId && (
              <div className="settings-hint">
                drone-side palette: {PALETTE_OPTIONS.find((p) => p.id === props.osdPaletteId)?.label ?? `id ${props.osdPaletteId}`}
                {" "}(your choice above always wins for the inversion overlay)
              </div>
            )}
          </div>
        )}

        {section === "aitap" && (
          <div className="settings-body">
            <div className="settings-hint">
              The AI tap is a server-side ffmpeg process that turns the RTMP
              stream into raw BGR24 frames for the DEIMv2 worker. Normally the
              app starts it automatically when you enable AI on a live tile —
              this control is here for debugging.
            </div>
            <div className="settings-row">
              <span>Status</span>
              <strong>
                {aiTap?.running
                  ? `running — ${aiTap.frameCount} frames, ${aiTap.restarts ?? 0} restarts`
                  : "idle"}
              </strong>
            </div>
            {aiTap?.rtmpUrl && (
              <div className="settings-row">
                <span>Pulling from</span>
                <code>{aiTap.rtmpUrl}</code>
              </div>
            )}
            {aiTap?.lastError && (
              <div className="settings-row">
                <span>Last error</span>
                <code style={{ color: "var(--danger)" }}>{aiTap.lastError}</code>
              </div>
            )}
            <button
              type="button"
              className="live-btn refresh"
              onClick={onToggleTap}
              disabled={busy}
              style={{ alignSelf: "flex-start" }}
            >
              <LuRadio size={13} /> {aiTap?.running ? "Stop tap" : "Start tap"}
            </button>
          </div>
        )}

        {flash && <div className="thresholds-flash">{flash}</div>}
        {error && <div className="ml-error">{error}</div>}
      </div>
    </div>
  );
}
