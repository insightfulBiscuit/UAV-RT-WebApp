import { useEffect } from "react";
import { LuX } from "react-icons/lu";
import type { StoredAlert } from "../../lib/api";
import "./AlertPreviewModal.css";

/**
 * Modal previewer for one alert's captured photo + 5s clip. Loads media
 * lazily (the browser fetches the URLs when the modal mounts).
 */
export default function AlertPreviewModal({
  alert,
  onClose,
}: {
  alert: StoredAlert;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const when = new Date(alert.ts).toLocaleString();
  const cls = alert.class.replace(/_/g, " ");

  return (
    <div className="alert-preview-backdrop" onClick={onClose}>
      <div className="alert-preview-card" onClick={(e) => e.stopPropagation()}>
        <div className="alert-preview-header">
          <div className="alert-preview-title">
            <span className="alert-preview-swatch" style={{ background: alert.color }} />
            <span className="alert-preview-name">{cls}</span>
            {alert.trigger ? <span className="alert-preview-trigger">· {alert.trigger}</span> : null}
          </div>
          <button className="alert-preview-close" onClick={onClose} aria-label="Close">
            <LuX size={16} />
          </button>
        </div>

        <div className="alert-preview-meta">
          {when} ·{" "}
          <span className="alert-preview-modality">{alert.modality.toUpperCase()}</span>
          {alert.temp_c != null ? ` · ${alert.temp_c.toFixed(1)}°C` : ""}
          {" · conf "}
          {(alert.conf * 100).toFixed(0)}%
        </div>

        <div className="alert-preview-body">
          {alert.photoUrl ? (
            <div className="alert-preview-media">
              <div className="alert-preview-media-label">Snapshot</div>
              <img src={alert.photoUrl} alt="Alert snapshot" className="alert-preview-photo" />
            </div>
          ) : (
            <div className="alert-preview-missing">Photo not available.</div>
          )}
          {alert.videoUrl ? (
            <div className="alert-preview-media">
              <div className="alert-preview-media-label">5 s clip</div>
              <video
                src={alert.videoUrl}
                className="alert-preview-video"
                controls
                autoPlay
                playsInline
                muted
                loop
              />
            </div>
          ) : (
            <div className="alert-preview-missing">Video clip still capturing — reopen in a few seconds.</div>
          )}
        </div>
      </div>
    </div>
  );
}
