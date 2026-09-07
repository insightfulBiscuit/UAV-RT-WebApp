import { useEffect, useState } from "react";
import { LuTriangleAlert, LuX } from "react-icons/lu";
import type { AiAlert } from "../../lib/api";
import "./AlertToasts.css";

type ActiveToast = AiAlert & {
  id: string;
  arrivedAt: number;
};

/**
 * Global alert-toast host. Renders website popups for AI alerts. Auto-dismisses
 * after `dismissMs`; can be dismissed manually. Publisher of the alerts is
 * whoever calls `pushAlert()` — the Livestream AI overlay wires this up.
 */

const listeners = new Set<(a: AiAlert) => void>();

export function pushAlert(a: AiAlert): void {
  for (const cb of listeners) cb(a);
}

export function AlertToasts({ dismissMs = 8000 }: { dismissMs?: number }) {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);

  useEffect(() => {
    const onAlert = (a: AiAlert) => {
      const toast: ActiveToast = {
        ...a,
        id: `${a.box_key}-${Date.now()}`,
        arrivedAt: Date.now(),
      };
      setToasts((prev) => [...prev, toast].slice(-5));
    };
    listeners.add(onAlert);
    return () => {
      listeners.delete(onAlert);
    };
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((x) => now - x.arrivedAt < dismissMs));
    }, 500);
    return () => clearInterval(t);
  }, [toasts.length, dismissMs]);

  if (toasts.length === 0) return null;
  return (
    <div className="alert-toasts">
      {toasts.map((t) => (
        <div key={t.id} className="alert-toast" style={{ borderColor: t.color }}>
          <div className="alert-toast-icon" style={{ background: t.color }}>
            <LuTriangleAlert size={18} />
          </div>
          <div className="alert-toast-body">
            <div className="alert-toast-title">
              {t.class.replace(/_/g, " ")} · {t.trigger}
            </div>
            <div className="alert-toast-meta">
              {t.temp_c != null ? `${t.temp_c.toFixed(1)}°C · ` : ""}
              conf {(t.conf * 100).toFixed(0)}%
            </div>
          </div>
          <button
            className="alert-toast-close"
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            aria-label="Dismiss"
          >
            <LuX size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
