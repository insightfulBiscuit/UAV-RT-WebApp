import { useEffect, useRef, useState } from "react";
import { ThermalMatrixController, type AnchorSummary } from "../../lib/thermalMatrix";

/**
 * Overlay canvas showing a hot-region highlight above `threshold`.
 * Attaches to a <video> ref via a running loop (~5 fps by default).
 *
 * Live temperature min/max/mean and calibration curve state are surfaced
 * back to the parent through onStats.
 */
export function ThermalMatrixOverlay({
  videoContainerRef,
  paletteId,
  osdMin,
  osdMax,
  threshold,
  enabled,
  fps = 5,
  onStats,
  onAnchor,
}: {
  videoContainerRef: React.RefObject<HTMLDivElement | null>;
  paletteId: number;
  osdMin: number;
  osdMax: number;
  threshold: number;
  enabled: boolean;
  fps?: number;
  onStats?: (s: {
    min: number;
    max: number;
    mean: number;
    calibA: number;
    calibB: number;
  }) => void;
  onAnchor?: (a: AnchorSummary) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<ThermalMatrixController | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const ctl = new ThermalMatrixController({
      paletteId,
      min: osdMin,
      max: osdMax,
      threshold,
    });
    ctl.onMatrix((data) => {
      onStats?.({
        min: data.stats.min,
        max: data.stats.max,
        mean: data.stats.mean,
        calibA: data.calibA,
        calibB: data.calibB,
      });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = data.width;
      canvas.height = data.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Copy into a fresh Uint8ClampedArray backed by ArrayBuffer (avoids the
      // SharedArrayBuffer vs ArrayBuffer type narrowing on ImageData).
      const copy = new Uint8ClampedArray(data.hotMask.byteLength);
      copy.set(data.hotMask);
      const img = new ImageData(copy, data.width, data.height);
      ctx.putImageData(img, 0, 0);
    });
    if (onAnchor) ctl.onAnchor(onAnchor);
    controllerRef.current = ctl;
    setReady(true);
    return () => {
      ctl.destroy();
      controllerRef.current = null;
      setReady(false);
    };
    // Intentionally: recreate on paletteId change so LUT rebuilds cleanly
  }, [enabled, paletteId]);

  useEffect(() => {
    controllerRef.current?.setOptions({ min: osdMin, max: osdMax, threshold });
  }, [osdMin, osdMax, threshold]);

  useEffect(() => {
    if (!enabled || !ready) return;
    let raf = 0;
    let cancelled = false;
    const period = 1000 / Math.max(1, fps);
    let last = 0;
    const loop = async (ts: number) => {
      if (cancelled) return;
      if (ts - last >= period) {
        last = ts;
        const video =
          videoContainerRef.current?.querySelector<HTMLVideoElement>("video");
        if (video && controllerRef.current) {
          try {
            await controllerRef.current.ingestFrame(video);
          } catch { /* ignore transient frame errors */ }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [enabled, ready, fps, videoContainerRef]);

  if (!enabled) return null;
  return (
    <canvas
      ref={canvasRef}
      className="thermal-matrix-overlay"
      aria-hidden
    />
  );
}
