import { useEffect, useRef, useState } from "react";
import type { AiAlert, AiDetection } from "../../lib/api";

/**
 * Canvas overlay that draws AI detection bounding boxes on top of the
 * featured video. Subscribes to the existing thermal WebSocket channel —
 * the AI worker piggybacks its `type: "ai"` messages there so we don't
 * open a second connection.
 *
 * Boxes stay on screen for `ttlMs` after their last update so the overlay
 * doesn't flicker between inference frames (~5 fps).
 */

type Msg = {
  type: "ai";
  seq: number;
  ts: number;
  latencyMs: number;
  modality: "rgb" | "ir";
  detections: AiDetection[];
  alerts: AiAlert[];
};

type BoxState = {
  det: AiDetection;
  temp?: number;
  lastSeenTs: number;
};

const CLASS_COLORS: Record<string, string> = {
  vehicle: "#4c9aff",
  tree: "#3a7a3a",
  metal_fixture: "#a1a5b7",
  green_grass: "#66c266",
  dry_grass: "#c9a464",
  person: "#ffbf47",
  tent_tarp: "#c78bff",
  plastic_waste: "#ee6666",
  fire: "#ff3d3d",
  smoke: "#dddddd",
};

export function AiDetectionsOverlay({
  enabled,
  onAlert,
  ttlMs = 800,
}: {
  enabled: boolean;
  onAlert?: (alert: AiAlert) => void;
  ttlMs?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxesRef = useRef<Map<string, BoxState>>(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws?channel=thermal`;
    let ws: WebSocket | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(url);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as Msg | { type: string };
          if (msg.type !== "ai") return;
          const now = performance.now();
          for (const det of (msg as Msg).detections) {
            const key = `${det.class}@${det.box[0].toFixed(2)},${det.box[1].toFixed(2)}`;
            boxesRef.current.set(key, { det, lastSeenTs: now });
          }
          for (const alert of (msg as Msg).alerts) {
            onAlert?.(alert);
          }
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      stopped = true;
      setConnected(false);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [enabled, onAlert]);

  // Render loop
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, w, h);
          const now = performance.now();
          for (const [key, box] of boxesRef.current) {
            if (now - box.lastSeenTs > ttlMs) {
              boxesRef.current.delete(key);
              continue;
            }
            drawBox(ctx, box, w, h);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [enabled, ttlMs]);

  if (!enabled) return null;
  return (
    <canvas
      ref={canvasRef}
      className="ai-detections-overlay"
      aria-hidden
      title={connected ? "AI overlay: connected" : "AI overlay: connecting…"}
    />
  );
}

function drawBox(ctx: CanvasRenderingContext2D, box: BoxState, W: number, H: number): void {
  const [x1n, y1n, x2n, y2n] = box.det.box;
  const x = x1n * W;
  const y = y1n * H;
  const w = (x2n - x1n) * W;
  const h = (y2n - y1n) * H;
  const color = CLASS_COLORS[box.det.class] ?? "#ff5555";

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  const label = `${box.det.class} · ${(box.det.conf * 100).toFixed(0)}%${
    box.temp != null ? ` · ${box.temp.toFixed(1)}°C` : ""
  }`;
  ctx.font = "600 12px system-ui, sans-serif";
  const metrics = ctx.measureText(label);
  const padX = 4;
  const bgH = 18;
  const bgW = metrics.width + padX * 2;
  ctx.fillStyle = color;
  ctx.fillRect(x, Math.max(0, y - bgH), bgW, bgH);
  ctx.fillStyle = "#000";
  ctx.fillText(label, x + padX, Math.max(bgH - 6, y - 6));
}
