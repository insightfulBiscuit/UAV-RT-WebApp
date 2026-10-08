import { useEffect, useRef, useState } from "react";
import {
  ackAllAlerts,
  clearAlerts,
  fetchAlerts,
  type StoredAlert,
} from "./api";

/**
 * Shared inbox for persistent AI alerts.
 *
 * Seeds from GET /api/alerts on mount, then keeps itself up to date by
 * subscribing to WS "alertPersisted" events on the /ws?channel=thermal
 * socket (same channel the AI detection overlay uses).
 *
 * The "unread" count is server-side (a shared ack timestamp), so different
 * tabs and different clients agree. Calling ackAll() marks everything read.
 */

export type InboxState = {
  alerts: StoredAlert[];
  ackTs: number;
  unreadCount: number;
  connected: boolean;
  loading: boolean;
  error: string | null;
};

type Msg =
  | { type: "alertPersisted"; data: StoredAlert }
  | { type: string };

export function useAlertInbox(limit = 50): {
  state: InboxState;
  ackAll: () => Promise<void>;
  refresh: () => Promise<void>;
  clear: (input: { ids?: string[]; all?: boolean }) => Promise<{ removed: number }>;
} {
  const [state, setState] = useState<InboxState>({
    alerts: [],
    ackTs: 0,
    unreadCount: 0,
    connected: false,
    loading: true,
    error: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = async () => {
    try {
      const res = await fetchAlerts({ limit });
      setState((s) => ({
        ...s,
        alerts: res.alerts,
        ackTs: res.ackTs,
        unreadCount: res.unreadCount,
        loading: false,
        error: null,
      }));
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: (err as Error).message }));
    }
  };

  useEffect(() => {
    load();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws?channel=thermal`;
    let ws: WebSocket | null = null;
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(url);
      ws.onopen = () => setState((s) => ({ ...s, connected: true }));
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!stopped) reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => {
        try { ws?.close(); } catch { /* ignore */ }
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as Msg;
          if (msg.type !== "alertPersisted") return;
          const rec = (msg as { type: "alertPersisted"; data: StoredAlert }).data;
          setState((s) => {
            const next = [rec, ...s.alerts].slice(0, limit);
            const unread = rec.ts > s.ackTs ? s.unreadCount + 1 : s.unreadCount;
            return { ...s, alerts: next, unreadCount: unread };
          });
          // Media capture takes ~5s (video). Refetch once shortly after so
          // photoUrl/videoUrl materialize without user interaction.
          if (rec.mediaId && !rec.photoUrl) {
            setTimeout(load, 6500);
          }
        } catch {
          /* ignore parse errors */
        }
      };
    };
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  const ackAll = async () => {
    try {
      const res = await ackAllAlerts();
      setState((s) => ({ ...s, ackTs: res.ackTs, unreadCount: res.unreadCount }));
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error).message }));
    }
  };

  const clear = async (input: { ids?: string[]; all?: boolean }) => {
    const res = await clearAlerts(input);
    // Immediately drop cleared items from the local state; a refresh below
    // will reconcile ackTs/unreadCount from the server.
    if (input.all) {
      setState((s) => ({ ...s, alerts: [], unreadCount: 0 }));
    } else if (input.ids?.length) {
      const gone = new Set(input.ids);
      setState((s) => ({
        ...s,
        alerts: s.alerts.filter((a) => !gone.has(a.id)),
      }));
    }
    await load();
    return res;
  };

  return { state, ackAll, refresh: load, clear };
}
