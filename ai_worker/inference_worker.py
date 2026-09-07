"""
AI inference worker — spawned by the Node backend as a subprocess.

Protocol (stdin):
    Each frame is a JSON header line (newline-terminated), followed by the
    raw BGR24 pixel payload of size w*h*3 bytes:

        {"w":640,"h":480,"seq":123,"ts":1788666622361,"modality":"ir"}\n
        <921600 bytes of BGR>
        {"w":640,"h":480,"seq":124,"ts":1788666622561,"modality":"ir"}\n
        ...

Protocol (stdout):
    One JSON line per processed frame:

        {"seq":123,"ts":1788666622361,"latency_ms":38,
         "detections":[{"class":"person","conf":0.87,"box":[0.12,0.31,0.28,0.62]}],
         "alerts":[{"class":"person","conf":0.87,"box":[...],"trigger":"person>75C",
                    "temp_c":78.1,"box_key":"person@0.20,0.47","cooldown_left":0}]}

The Node side treats stderr as human-readable logs.
"""
from __future__ import annotations

import json
import os
import struct
import sys
import time
from collections import defaultdict, deque
from typing import Any

import numpy as np

from config import (
    ALERT_THRESHOLDS, CLASS_COLORS, CLASSES, COMBUSTIBLES,
    CONF_MIN, DETECTION_HOLD_FRAMES,
)
from detector import BaseDetector, build_detector


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Persistence + cooldown for alerts
# ---------------------------------------------------------------------------

class AlertEngine:
    """
    Emits at most one alert per (class, spatial-box-key) per cooldown window.
    Requires the detection to persist across N recent frames (suppresses
    one-frame false positives). Temperature-conditioned per H30T's config.
    """

    def __init__(self) -> None:
        self._recent: dict[str, deque[int]] = defaultdict(lambda: deque(maxlen=32))
        self._last_alert_ts: dict[str, float] = {}
        self._cooldown_s = float(ALERT_THRESHOLDS["cooldownS"])

    def _persistence_key(self, cls: str, x1: float, y1: float, x2: float, y2: float) -> str:
        # Coarse spatial grid — same tracked object across frames maps to
        # the same key even as its box drifts by a few pixels.
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        return f"{cls}@{cx * 20:.0f},{cy * 20:.0f}"

    def evaluate(
        self,
        frame_idx: int,
        detections: list[dict[str, Any]],
        temp_lookup,
    ) -> list[dict[str, Any]]:
        alerts: list[dict[str, Any]] = []
        now = time.time()
        for det in detections:
            cls = det["class"]
            x1, y1, x2, y2 = det["box"]
            key = self._persistence_key(cls, x1, y1, x2, y2)
            history = self._recent[key]
            history.append(frame_idx)

            # Must appear in >= DETECTION_HOLD_FRAMES of the last few frames.
            if len(history) < DETECTION_HOLD_FRAMES:
                continue
            recent_window = [f for f in history if frame_idx - f <= DETECTION_HOLD_FRAMES * 2]
            if len(recent_window) < DETECTION_HOLD_FRAMES:
                continue

            # Cooldown.
            last = self._last_alert_ts.get(key, 0.0)
            if now - last < self._cooldown_s:
                continue

            # Temperature-conditioned trigger.
            temp = temp_lookup(x1, y1, x2, y2) if temp_lookup else None
            trigger = self._classify_trigger(cls, temp)
            if trigger is None:
                continue

            self._last_alert_ts[key] = now
            alerts.append({
                "class": cls,
                "conf": det.get("conf"),
                "box": det["box"],
                "trigger": trigger,
                "temp_c": round(temp, 1) if isinstance(temp, (int, float)) else None,
                "box_key": key,
                "cooldown_left": round(self._cooldown_s, 1),
                "color": CLASS_COLORS.get(cls, "#ff5555"),
            })
        return alerts

    def _classify_trigger(self, cls: str, temp: float | None) -> str | None:
        t = ALERT_THRESHOLDS
        # Class-triggering (temperature-independent): fire / smoke always alert.
        if cls in ("fire", "smoke"):
            return f"class:{cls}"
        if temp is None:
            return None
        if cls == "person" and temp >= t["personC"]:
            return f"person>{t['personC']}C"
        if cls == "vehicle" and temp >= t["vehicleExtremeC"]:
            return f"vehicle>{t['vehicleExtremeC']}C"
        if cls in COMBUSTIBLES and temp >= t["combustibleC"]:
            return f"combustible>{t['combustibleC']}C"
        if temp >= t["unknownExtremeC"]:
            return f"any>{t['unknownExtremeC']}C"
        if temp >= t["unknownHighC"]:
            return f"any>{t['unknownHighC']}C"
        if temp >= t["criticalC"]:
            return f"any>{t['criticalC']}C"
        return None


# ---------------------------------------------------------------------------
# Frame reader
# ---------------------------------------------------------------------------

def read_exact(stream, n: int) -> bytes | None:
    out = bytearray()
    while len(out) < n:
        chunk = stream.read(n - len(out))
        if not chunk:
            return None
        out.extend(chunk)
    return bytes(out)


def read_frame(stream) -> tuple[dict[str, Any], np.ndarray] | None:
    """
    Reads one header line + payload. Returns (header, frame_bgr) or None on EOF.
    """
    header_bytes = bytearray()
    while True:
        b = stream.read(1)
        if not b:
            return None
        if b == b"\n":
            break
        header_bytes.extend(b)
        if len(header_bytes) > 4096:
            log("[ai] header too long — protocol out of sync; exiting")
            return None
    try:
        header = json.loads(header_bytes.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        log(f"[ai] bad header: {exc}: {header_bytes[:200]!r}")
        return None
    w, h = int(header["w"]), int(header["h"])
    body = read_exact(stream, w * h * 3)
    if body is None:
        return None
    frame = np.frombuffer(body, dtype=np.uint8).reshape(h, w, 3)
    return header, frame


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def build_temp_lookup(header: dict[str, Any]):
    """
    Placeholder for temperature fusion. When the browser sends OSD min/max
    for the current frame (via a side-channel) we'd wire it here. For now
    we return None → temperature-conditioned alerts require the frontend's
    palette-inversion overlay to attach `temp_c` on the browser side.
    """
    return None


def main() -> int:
    modality = os.environ.get("AI_MODALITY", "rgb").lower()
    if modality not in ("rgb", "ir"):
        log(f"AI_MODALITY must be rgb or ir (got {modality!r}); defaulting to rgb")
        modality = "rgb"
    log(f"[ai] modality={modality} mode={os.environ.get('AI_MODE', 'auto')}")

    detector: BaseDetector = build_detector(modality)
    log(f"[ai] detector ready: {type(detector).__name__} ({detector.modality})")

    alerts = AlertEngine()
    stdin = sys.stdin.buffer
    stdout = sys.stdout
    frame_idx = 0

    log("[ai] ready — reading frames from stdin")
    while True:
        item = read_frame(stdin)
        if item is None:
            log("[ai] stdin closed; exiting")
            return 0
        header, frame = item
        seq = int(header.get("seq", frame_idx))
        ts = int(header.get("ts", time.time() * 1000))
        frame_idx += 1

        t0 = time.perf_counter()
        try:
            dets = detector.infer(frame)
        except Exception as exc:  # noqa: BLE001
            log(f"[ai] detector error on seq={seq}: {exc}")
            dets = []
        latency_ms = round((time.perf_counter() - t0) * 1000, 1)

        det_dicts = [d.to_dict() for d in dets]
        alerts_out = alerts.evaluate(frame_idx, det_dicts, build_temp_lookup(header))

        stdout.write(json.dumps({
            "seq": seq,
            "ts": ts,
            "latency_ms": latency_ms,
            "detections": det_dicts,
            "alerts": alerts_out,
        }) + "\n")
        stdout.flush()

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
