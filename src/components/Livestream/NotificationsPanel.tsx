import { useCallback, useEffect, useState } from "react";
import { LuBellRing, LuPlus, LuSend, LuTrash, LuX } from "react-icons/lu";
import {
  addNtfyTopic,
  fetchNotificationStatus,
  removeNtfyTopic,
  sendTestNotification,
  type NotificationStatus,
} from "../../lib/api";

/**
 * Standalone ntfy topic manager. Users can type a full ntfy URL
 * (`https://ntfy.sh/whatever`) and add it, delete existing ones, and fire a
 * test push to any single topic to verify their phone subscription.
 *
 * The primary topic (`NTFY_URL` env) is shown but not editable — it's the
 * ambient default and lives in server/.env.
 */
export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await fetchNotificationStatus()); }
    catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    void refresh();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh, onClose]);

  const flashFor = (msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 2500);
  };

  const onAccept = async () => {
    const url = draftUrl.trim();
    if (!url) return;
    setBusy("add"); setError(null);
    try {
      const res = await addNtfyTopic(url, draftLabel.trim() || undefined);
      setStatus((prev) => prev ? { ...prev, topics: res.topics, configured: true } : prev);
      setDraftUrl(""); setDraftLabel("");
      flashFor("Added");
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const onDelete = async (url: string) => {
    setBusy(url); setError(null);
    try {
      const res = await removeNtfyTopic(url);
      setStatus((prev) => prev ? { ...prev, topics: res.topics } : prev);
      flashFor("Removed");
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const onTest = async (url?: string) => {
    setBusy(url ?? "test-all"); setError(null);
    try {
      const res = await sendTestNotification(url);
      if (res.ok) flashFor(`Sent to ${res.sent}`);
      else setError(res.errors.join("; ") || "Send failed");
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal notifications-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="settings-tabs">
          <span className="settings-tab active"><LuBellRing size={13} /> Subscriber topics</span>
          <button type="button" className="cockpit-btn settings-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <LuX size={16} />
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-hint">
            Every AI alert is fanned out to the primary topic (from
            <code> server/.env</code>) plus every topic listed below.
            Install the ntfy app on your phone, subscribe to a topic URL, then
            hit <strong>Send test</strong> next to it to confirm delivery.
          </div>

          <div className="ntfy-primary">
            <span>Primary</span>
            <code>{status?.primary ?? "not configured — set NTFY_URL in server/.env"}</code>
            <button
              type="button"
              className="live-btn refresh"
              disabled={!status?.primary || busy === "test-primary"}
              onClick={() => void onTest(status?.primary ?? undefined)}
              title="Send a test push to just the primary topic"
            >
              <LuSend size={13} /> Test
            </button>
          </div>

          <div className="ntfy-list">
            {(status?.topics ?? []).length === 0 && (
              <div className="settings-hint">No additional topics yet.</div>
            )}
            {(status?.topics ?? []).map((t) => (
              <div key={t.url} className="ntfy-row">
                <div className="ntfy-row-main">
                  <code>{t.url}</code>
                  {t.label && <em>{t.label}</em>}
                </div>
                <button
                  type="button"
                  className="live-btn refresh"
                  disabled={busy === t.url}
                  onClick={() => void onTest(t.url)}
                  title="Send a test push to this topic"
                >
                  <LuSend size={13} /> Test
                </button>
                <button
                  type="button"
                  className="live-btn refresh"
                  disabled={busy === t.url}
                  onClick={() => void onDelete(t.url)}
                  title="Remove this topic"
                >
                  <LuTrash size={13} /> Remove
                </button>
              </div>
            ))}
          </div>

          <div className="ntfy-add">
            <input
              type="url"
              placeholder="https://ntfy.sh/my_topic"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              disabled={busy === "add"}
            />
            <input
              type="text"
              placeholder="Label (optional)"
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              disabled={busy === "add"}
              style={{ maxWidth: 180 }}
            />
            <button
              type="button"
              className="live-btn refresh"
              onClick={() => void onAccept()}
              disabled={busy === "add" || !draftUrl.trim()}
            >
              <LuPlus size={13} /> Accept
            </button>
          </div>

          <div className="ntfy-footer">
            <button
              type="button"
              className="live-btn refresh"
              disabled={busy === "test-all" || !status?.configured}
              onClick={() => void onTest()}
            >
              Send test to all
            </button>
          </div>
        </div>

        {flash && <div className="thresholds-flash">{flash}</div>}
        {error && <div className="ml-error">{error}</div>}
      </div>
    </div>
  );
}
