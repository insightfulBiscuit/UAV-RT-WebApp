from __future__ import annotations

import argparse
import json
import math
import os
import re
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np


TEMP_RE = re.compile(r"(?<!\d)(-?\d{1,3}(?:\.\d)?)(?:\s*[cC])?")


def now_ms() -> int:
    return int(time.time() * 1000)


def post_json(url: str, payload: dict[str, Any], timeout_s: float = 2.0) -> None:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        resp.read()


def parse_region(text: str, width: int, height: int) -> tuple[int, int, int, int]:
    if not text or text.lower() == "left":
        return 0, 0, width // 2, height
    if text.lower() == "full":
        return 0, 0, width, height
    parts = [float(x.strip()) for x in text.split(",")]
    if len(parts) != 4:
        raise ValueError("--ocr-region must be left, full, or x,y,w,h")
    x, y, w, h = parts
    if max(parts) <= 1.0:
        return int(x * width), int(y * height), int(w * width), int(h * height)
    return int(x), int(y), int(w), int(h)


def build_templates() -> dict[str, list[np.ndarray]]:
    templates: dict[str, list[np.ndarray]] = {ch: [] for ch in "0123456789."}
    fonts = [cv2.FONT_HERSHEY_SIMPLEX, cv2.FONT_HERSHEY_DUPLEX]
    for font in fonts:
        for scale in (0.7, 0.9, 1.1, 1.35, 1.6, 1.9, 2.25):
            thickness = max(1, int(round(scale * 2)))
            for ch in templates:
                (tw, th), baseline = cv2.getTextSize(ch, font, scale, thickness)
                canvas = np.zeros((th + baseline + 14, tw + 14), dtype=np.uint8)
                cv2.putText(canvas, ch, (7, th + 5), font, scale, 255, thickness, cv2.LINE_AA)
                ys, xs = np.where(canvas > 20)
                if len(xs) == 0:
                    continue
                glyph = canvas[max(0, ys.min() - 2) : min(canvas.shape[0], ys.max() + 3), max(0, xs.min() - 2) : min(canvas.shape[1], xs.max() + 3)]
                glyph = cv2.resize(glyph, (24, 36), interpolation=cv2.INTER_AREA)
                _, glyph = cv2.threshold(glyph, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                templates[ch].append(glyph)
    return templates


TEMPLATES = build_templates()


def normalize_char_image(img: np.ndarray) -> np.ndarray:
    if img.size == 0:
        return np.zeros((36, 24), dtype=np.uint8)
    img = cv2.resize(img, (24, 36), interpolation=cv2.INTER_AREA)
    _, img = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return img


def classify_char(char_img: np.ndarray) -> tuple[str, float]:
    normalized = normalize_char_image(char_img)
    best_ch = ""
    best_score = -1.0
    for ch, glyphs in TEMPLATES.items():
        for glyph in glyphs:
            score = cv2.matchTemplate(normalized, glyph, cv2.TM_CCOEFF_NORMED)[0][0]
            if score > best_score:
                best_score = float(score)
                best_ch = ch
    return best_ch, best_score


def bright_text_mask(roi: np.ndarray) -> np.ndarray:
    roi2 = cv2.resize(roi, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_LINEAR)
    hsv = cv2.cvtColor(roi2, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    white = (v > 170) & (s < 105)
    yellow = (v > 145) & (s > 55) & (h > 12) & (h < 45)
    red = (v > 145) & (s > 55) & ((h < 8) | (h > 170))
    mask = np.zeros(v.shape, dtype=np.uint8)
    mask[white | yellow | red] = 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    return mask


def component_boxes(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    n, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, 8)
    boxes = []
    area_min = max(10, int(mask.shape[0] * mask.shape[1] * 0.000015))
    area_max = int(mask.shape[0] * mask.shape[1] * 0.015)
    for i in range(1, n):
        x, y, w, h, area = [int(v) for v in stats[i]]
        if area < area_min or area > area_max:
            continue
        if h < 10 or w < 2:
            continue
        if h > mask.shape[0] * 0.25 or w > mask.shape[1] * 0.25:
            continue
        boxes.append((x, y, w, h))
    return boxes


def merge_digit_boxes(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    if not boxes:
        return []
    boxes = sorted(boxes, key=lambda b: (b[1] // 24, b[0]))
    merged: list[tuple[int, int, int, int]] = []
    for box in boxes:
        x, y, w, h = box
        if not merged:
            merged.append(box)
            continue
        px, py, pw, ph = merged[-1]
        same_line = abs((y + h / 2) - (py + ph / 2)) < max(h, ph) * 0.55
        close = x - (px + pw) < max(8, int(max(h, ph) * 0.28))
        if same_line and close:
            nx = min(px, x)
            ny = min(py, y)
            nr = max(px + pw, x + w)
            nb = max(py + ph, y + h)
            merged[-1] = (nx, ny, nr - nx, nb - ny)
        else:
            merged.append(box)
    return merged


def ocr_by_components(mask: np.ndarray) -> Optional[tuple[float, str, float]]:
    boxes = component_boxes(mask)
    if not boxes:
        return None
    boxes = sorted(boxes, key=lambda b: b[0])
    rows: list[list[tuple[int, int, int, int]]] = []
    for box in boxes:
        x, y, w, h = box
        cy = y + h / 2
        matched = False
        for row in rows:
            row_cy = sum(b[1] + b[3] / 2 for b in row) / len(row)
            if abs(cy - row_cy) < max(h, np.mean([b[3] for b in row])) * 0.75:
                row.append(box)
                matched = True
                break
        if not matched:
            rows.append([box])
    candidates: list[tuple[float, str, float]] = []
    for row in rows:
        row = sorted(row, key=lambda b: b[0])
        median_h = float(np.median([b[3] for b in row]))
        chars: list[str] = []
        scores: list[float] = []
        last_right: Optional[int] = None
        for x, y, w, h in row:
            if h < median_h * 0.38 and w < median_h * 0.45:
                ch, score = ".", 0.95
            else:
                pad = 2
                char_img = mask[max(0, y - pad) : min(mask.shape[0], y + h + pad), max(0, x - pad) : min(mask.shape[1], x + w + pad)]
                ch, score = classify_char(char_img)
            if last_right is not None and x - last_right > median_h * 0.45:
                chars.append(" ")
            chars.append(ch)
            scores.append(score)
            last_right = x + w
        text = "".join(chars)
        for m in TEMP_RE.finditer(text):
            try:
                value = float(m.group(1))
            except ValueError:
                continue
            if -40.0 <= value <= 550.0:
                confidence = float(np.mean(scores)) if scores else 0.0
                candidates.append((value, text, confidence))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[2], item[0]), reverse=True)
    return candidates[0]


def ocr_temperature(frame: np.ndarray, region: str, debug_dir: Optional[Path], seq: int) -> Optional[tuple[float, str, float]]:
    h, w = frame.shape[:2]
    x, y, rw, rh = parse_region(region, w, h)
    x = max(0, min(w - 1, x))
    y = max(0, min(h - 1, y))
    rw = max(1, min(w - x, rw))
    rh = max(1, min(h - y, rh))
    roi = frame[y : y + rh, x : x + rw]
    mask = bright_text_mask(roi)
    result = ocr_by_components(mask)
    if debug_dir and seq % 10 == 0:
        debug_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(debug_dir / "last_roi.jpg"), roi)
        cv2.imwrite(str(debug_dir / "last_mask.jpg"), mask)
    return result


def run_bridge(args: argparse.Namespace) -> None:
    debug_dir = Path(args.debug_dir) if args.debug_dir else None
    cap: Optional[cv2.VideoCapture] = None
    last_post_ms = 0
    seq = 0
    last_value: Optional[float] = None
    stable_count = 0
    start_ms = now_ms()
    os.environ.setdefault(
        "OPENCV_FFMPEG_CAPTURE_OPTIONS",
        f"rw_timeout;{int(args.open_timeout_s * 1000000)}|stimeout;{int(args.open_timeout_s * 1000000)}",
    )
    while True:
        try:
            if args.run_seconds > 0 and now_ms() - start_ms >= args.run_seconds * 1000:
                print("[video-temp-ocr] run_seconds reached", flush=True)
                return
            if cap is None or not cap.isOpened():
                print(f"[video-temp-ocr] opening {args.video_source}", flush=True)
                cap = cv2.VideoCapture()
                if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
                    cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, int(args.open_timeout_s * 1000))
                if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
                    cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, int(args.read_timeout_s * 1000))
                cap.open(args.video_source, cv2.CAP_FFMPEG)
                if not cap.isOpened():
                    raise RuntimeError("VideoCapture open failed")
            ok, frame = cap.read()
            if not ok or frame is None:
                raise RuntimeError("VideoCapture read failed")
            seq += 1
            t_ms = now_ms()
            if t_ms - last_post_ms < args.min_interval_ms:
                continue
            result = ocr_temperature(frame, args.ocr_region, debug_dir, seq)
            if result is None:
                if seq % max(1, int(args.log_every_frames)) == 0:
                    print("[video-temp-ocr] no temperature text recognized", flush=True)
                continue
            value, text, confidence = result
            if confidence < args.min_confidence:
                continue
            if last_value is not None and abs(value - last_value) <= args.stable_delta_c:
                stable_count += 1
            else:
                stable_count = 1
            last_value = value
            if stable_count < args.stable_samples:
                continue
            payload = {
                "type": "h30t_global_temp",
                "device_time_ms": t_ms,
                "seq": f"video-ocr-{t_ms}",
                "source": "PILOT2_RTMP_VIDEO_OCR",
                "transport_mode": "rtmp_video_ocr_no_usb_no_msdk",
                "avg_c": "",
                "min_c": "",
                "max_c": value,
                "width": 1280,
                "height": 1024,
                "ocr_text": text,
                "ocr_confidence": round(confidence, 3),
                "device_id": args.device_id,
            }
            post_json(args.viewer_url, payload, timeout_s=args.http_timeout_s)
            last_post_ms = t_ms
            print(f"[video-temp-ocr] posted max={value:.1f}C conf={confidence:.2f} text='{text}'", flush=True)
        except KeyboardInterrupt:
            return
        except Exception as exc:
            print(f"[video-temp-ocr] reconnecting: {exc}", flush=True)
            if cap is not None:
                cap.release()
            cap = None
            time.sleep(max(0.2, args.reconnect_s))


def run_self_test(args: argparse.Namespace) -> None:
    img = np.zeros((720, 1280, 3), dtype=np.uint8)
    cv2.rectangle(img, (0, 0), (640, 720), (30, 30, 30), -1)
    cv2.putText(img, "MAX 69.1 C", (60, 120), cv2.FONT_HERSHEY_SIMPLEX, 1.7, (245, 245, 245), 3, cv2.LINE_AA)
    result = ocr_temperature(img, "left", Path(args.debug_dir) if args.debug_dir else None, 10)
    print(json.dumps({"ok": result is not None, "result": result}, ensure_ascii=True))
    if result is None or not math.isclose(result[0], 69.1, abs_tol=1.0):
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Read H30T temperature text from RTMP video only and inject it into the viewer.")
    parser.add_argument("--video-source", default="rtmp://127.0.0.1:1935/live/m400")
    parser.add_argument("--viewer-url", default="http://127.0.0.1:8010/upload_h30t_global")
    parser.add_argument("--device-id", default="M400-H30T")
    parser.add_argument("--ocr-region", default="left", help="left, full, or x,y,w,h. Values <=1 are relative.")
    parser.add_argument("--min-interval-ms", type=int, default=900)
    parser.add_argument("--min-confidence", type=float, default=0.32)
    parser.add_argument("--stable-samples", type=int, default=1)
    parser.add_argument("--stable-delta-c", type=float, default=1.5)
    parser.add_argument("--reconnect-s", type=float, default=1.0)
    parser.add_argument("--http-timeout-s", type=float, default=2.0)
    parser.add_argument("--open-timeout-s", type=float, default=6.0)
    parser.add_argument("--read-timeout-s", type=float, default=4.0)
    parser.add_argument("--run-seconds", type=float, default=0.0)
    parser.add_argument("--debug-dir", default="outputs/wireless/video_temp_ocr_debug")
    parser.add_argument("--log-every-frames", type=int, default=90)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        run_self_test(args)
    else:
        run_bridge(args)


if __name__ == "__main__":
    main()
