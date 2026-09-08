from __future__ import annotations

import argparse
import csv
import gc
import os
import json
import queue
import re
import smtplib
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from collections import deque
from dataclasses import dataclass, field
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtmp_live;live|fflags;nobuffer|flags;low_delay|max_delay;500000|probesize;32768|analyzeduration;0|rw_timeout;5000000",
)
os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "16")

import cv2
import numpy as np

try:
    import psutil
except Exception:
    psutil = None

try:
    from dji_thermal_sdk import MeasurementParams
except Exception:
    class MeasurementParams:
        def __init__(
            self,
            distance_m: float = 5.0,
            humidity_percent: float = 70.0,
            emissivity: float = 0.95,
            reflection_c: float = 25.0,
        ) -> None:
            self.distance_m = distance_m
            self.humidity_percent = humidity_percent
            self.emissivity = emissivity
            self.reflection_c = reflection_c
from h30t_matrix_utils import MATRIX_HEIGHT, MATRIX_WIDTH, append_csv, ensure_dir, now_ms
from pc_h30t_wireless_system import BOX_TEMPERATURE_FIELDS, summarize_box
from pc_receive_h30t_global_temp_udp import GLOBAL_FIELDS
from pc_receive_h30t_matrix_jpg_http import make_handler


DJI_DETECTION_CLASSES = [
    "vehicle",
    "tree",
    "metal_fixture",
    "green_grass",
    "dry_grass",
    "person",
    "tent_tarp",
    "plastic_waste",
    "fire",
    "smoke",
]
FIRE_SMOKE_LABELS = {"fire", "flame", "smoke"}


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


@dataclass
class BufferedCompositeFrame:
    arrival_ms: int
    pair_jpeg: bytes
    ir_thumbnail: np.ndarray | None


@dataclass
class MatrixVideoMatch:
    video_arrival_ms: int
    row: dict[str, Any]
    correlation: float


@dataclass(frozen=True)
class InferenceRequest:
    frame_time_ms: int
    frame: np.ndarray
    crop_offset_xy: tuple[int, int] = (0, 0)
    full_frame_size: tuple[int, int] | None = None
    hot_max_c: float | None = None
    stream: str = "rgb"


@dataclass
class CapturedVideoFrame:
    seq: int
    arrival_ms: int
    frame: np.ndarray


@dataclass
class AlertVideoFrame:
    frame_time_ms: int
    frame: np.ndarray
    boxes: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class LiveState:
    output_dir: Path
    lock: threading.Lock = field(default_factory=threading.Lock)
    latest_global: dict[str, Any] | None = None
    latest_matrix_row: dict[str, Any] | None = None
    latest_matrix_values: np.ndarray | None = None
    latest_matrix_frame: np.ndarray | None = None
    latest_boxes: list[dict[str, Any]] = field(default_factory=list)
    latest_box_rows: list[dict[str, Any]] = field(default_factory=list)
    latest_video_size: tuple[int, int] = (MATRIX_WIDTH, MATRIX_HEIGHT)
    latest_display_jpeg: bytes | None = None
    latest_ir_jpeg: bytes | None = None
    latest_rgb_jpeg: bytes | None = None
    latest_ir_frame: np.ndarray | None = None
    latest_rgb_frame: np.ndarray | None = None
    latest_frame_time_ms: int = 0
    latest_pair_jpeg: bytes | None = None
    preview_sequence: int = 0
    latest_matrix_compare: dict[str, Any] | None = None
    latest_alert: dict[str, Any] | None = None
    alert_history: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=20))
    alert_active: bool = False
    last_alert_event_ms: int = 0
    last_alert_attempt_ms: int = 0
    last_alert_evidence_ms: int = 0
    latest_alert_detection_jpeg: bytes | None = None
    latest_alert_ir_jpeg: bytes | None = None
    latest_alert_video_path: str = ""
    alert_processing_count: int = 0
    udp_count: int = 0
    matrix_count: int = 0
    frame_count: int = 0
    started_ms: int = field(default_factory=now_ms)
    last_fused_matrix_seq: str | None = None
    rgb_frame_count: int = 0
    rgb_status: str = "disabled"
    ir_frame_time_ms: int = 0
    rgb_frame_time_ms: int = 0
    video_buffer: deque[BufferedCompositeFrame] = field(default_factory=lambda: deque(maxlen=1))
    alert_video_frames: deque[AlertVideoFrame] = field(default_factory=lambda: deque(maxlen=72))
    last_alert_video_store_ms: int = 0
    matrix_matches: deque[MatrixVideoMatch] = field(default_factory=lambda: deque(maxlen=12))
    matrix_history: deque[tuple[dict[str, Any], np.ndarray]] = field(default_factory=lambda: deque(maxlen=4))
    sync_delay_samples_ms: deque[int] = field(default_factory=lambda: deque(maxlen=8))
    matrix_interval_samples_ms: deque[int] = field(default_factory=lambda: deque(maxlen=8))
    last_matrix_device_time_ms: int = 0
    matrix_video_offset_ms: float | None = None
    sync_playback_delay_ms: int = 0
    sync_video_temp_delta_ms: int | None = None
    sync_visual_correlation: float | None = None
    displayed_matrix_row: dict[str, Any] | None = None
    pair_sequence: int = 0
    pair_publish_times_ms: deque[int] = field(default_factory=lambda: deque(maxlen=180))
    source_frame_times_ms: deque[int] = field(default_factory=lambda: deque(maxlen=180))
    display_fps: float = 0.0
    global_history: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=240))
    displayed_global_row: dict[str, Any] | None = None
    detection_history: deque[tuple[int, list[dict[str, Any]]]] = field(default_factory=lambda: deque(maxlen=240))
    last_detection_time_ms: int = 0
    last_detection_submit_ms: int = 0
    latest_detection_boxes: list[dict[str, Any]] = field(default_factory=list)
    latest_detection_frame_time_ms: int = 0
    latest_ir_detection_boxes: list[dict[str, Any]] = field(default_factory=list)
    latest_rgb_detection_boxes: list[dict[str, Any]] = field(default_factory=list)
    latest_ir_detection_frame_time_ms: int = 0
    latest_rgb_detection_frame_time_ms: int = 0
    ir_detection_history: deque[tuple[int, list[dict[str, Any]]]] = field(default_factory=lambda: deque(maxlen=240))
    rgb_detection_history: deque[tuple[int, list[dict[str, Any]]]] = field(default_factory=lambda: deque(maxlen=240))
    inference_inflight: bool = False
    inference_inflight_by_stream: dict[str, bool] = field(default_factory=lambda: {"ir": False, "rgb": False})
    last_detection_submit_by_stream: dict[str, int] = field(default_factory=lambda: {"ir": 0, "rgb": 0})
    detector_status: str = "disabled"
    ir_detector_status: str = "disabled"
    rgb_detector_status: str = "disabled"
    detector_fps: float = 0.0
    ir_detector_fps: float = 0.0
    rgb_detector_fps: float = 0.0
    detector_latency_ms: float = 0.0
    ir_detector_latency_ms: float = 0.0
    rgb_detector_latency_ms: float = 0.0
    detector_count: int = 0
    ir_detector_count: int = 0
    rgb_detector_count: int = 0
    detector_mode: str = "idle"
    inference_stream_mode: str = "both"
    requested_inference_stream_mode: str = "both"
    detector_device: str = "disabled"
    effective_playback_delay_ms: int = 0
    sync_global_delta_ms: int | None = None
    temperature_video_offset_ms: int = 1000
    max_temp_frame_delta_ms: int = 350
    max_detection_age_ms: int = 1200
    min_inference_interval_ms: int = 1000
    stable_temp_hold_ms: int = 1200
    max_matrix_display_age_ms: int = 6000
    strict_sync_active: bool = False
    msdk_hotspot_offset_x: float = 0.0
    msdk_hotspot_offset_y: float = 0.0
    hotspot_calibration_count: int = 0
    video_status: str = "starting"
    video_reconnect_count: int = 0
    video_read_error_count: int = 0
    active_web_streams: int = 0
    web_stream_total: int = 0
    last_memory_log_ms: int = 0
    web_output_fps: float = 25.0
    jpeg_quality: int = 65


def current_rss_mib() -> float | None:
    if psutil is None:
        return None
    try:
        return float(psutil.Process(os.getpid()).memory_info().rss) / (1024.0 * 1024.0)
    except Exception:
        return None


def log_runtime_status(state: LiveState, prefix: str = "runtime", force: bool = False) -> None:
    ts = now_ms()
    with state.lock:
        if not force and ts - state.last_memory_log_ms < 10_000:
            return
        state.last_memory_log_ms = ts
        rss = current_rss_mib()
        parts = [
            f"[{prefix}]",
            f"frames={state.frame_count}",
            f"reconnects={state.video_reconnect_count}",
            f"read_errors={state.video_read_error_count}",
            f"web_streams={state.active_web_streams}",
            f"buffer={len(state.video_buffer)}",
            f"status={state.video_status}",
        ]
    if rss is not None:
        parts.append(f"rss={rss:.1f} MiB")
    print(" ".join(parts), flush=True)


def release_capture(cap: cv2.VideoCapture | None) -> None:
    if cap is not None:
        try:
            cap.release()
        except Exception:
            pass


def open_video_capture(source: int | str, state: LiveState, label: str = "video") -> cv2.VideoCapture:
    if isinstance(source, str) and source.startswith(("rtmp://", "rtmps://", "rtsp://", "http://", "https://")):
        cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
    else:
        cap = cv2.VideoCapture(source)
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass
    if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
        try:
            cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000)
        except Exception:
            pass
    if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
        try:
            cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000)
        except Exception:
            pass
    with state.lock:
        if label == "video":
            state.video_status = "open" if cap.isOpened() else f"waiting {mask_stream_url(source)}"
            state.video_reconnect_count += 1
        elif label == "rgb":
            state.rgb_status = "open" if cap.isOpened() else f"waiting {mask_stream_url(source)}"
    print(f"[{label}] open status={'open' if cap.isOpened() else 'waiting'} reconnects={state.video_reconnect_count if label == 'video' else '-'}", flush=True)
    return cap


def read_capture_frame(cap: cv2.VideoCapture | None, state: LiveState, label: str = "video") -> tuple[bool, np.ndarray | None, str | None]:
    if cap is None or not cap.isOpened():
        return False, None, "not-open"
    try:
        ok, frame = cap.read()
        if not ok or frame is None:
            return False, None, "empty"
        return True, frame, None
    except (MemoryError, SystemError, cv2.error) as exc:
        with state.lock:
            if label == "video":
                state.video_read_error_count += 1
                state.video_status = f"read error: {type(exc).__name__}"
            elif label == "rgb":
                state.rgb_status = f"read error: {type(exc).__name__}"
        print(f"[{label}] read failed: {type(exc).__name__}: {exc}", flush=True)
        return False, None, type(exc).__name__


class LatestVideoReader:
    def __init__(
        self,
        source: int | str,
        state: LiveState,
        stop_event: threading.Event,
        read_failures_before_reconnect: int,
    ) -> None:
        self.source = source
        self.state = state
        self.stop_event = stop_event
        self.read_failures_before_reconnect = max(1, int(read_failures_before_reconnect))
        self.lock = threading.Lock()
        self.latest: CapturedVideoFrame | None = None
        self.thread = threading.Thread(target=self._run, name="h30t-video-reader", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def get_latest(self) -> CapturedVideoFrame | None:
        with self.lock:
            if self.latest is None:
                return None
            return CapturedVideoFrame(self.latest.seq, self.latest.arrival_ms, self.latest.frame.copy())

    def _run(self) -> None:
        cap: cv2.VideoCapture | None = None
        seq = 0
        consecutive_failures = 0
        reconnect_backoff_s = 0.1
        try:
            while not self.stop_event.is_set():
                if cap is None or not cap.isOpened():
                    cap = open_video_capture(self.source, self.state, "video")
                    if not cap.isOpened():
                        self.stop_event.wait(reconnect_backoff_s)
                        reconnect_backoff_s = min(5.0, reconnect_backoff_s * 1.5)
                        continue
                    reconnect_backoff_s = 0.1
                    consecutive_failures = 0

                ok, frame, read_error = read_capture_frame(cap, self.state, "video")
                if not ok or frame is None:
                    consecutive_failures += 1
                    with self.state.lock:
                        self.state.video_status = f"read gap ({read_error or 'empty'}) {consecutive_failures}/{self.read_failures_before_reconnect}"
                        self.state.video_read_error_count += 1
                    if consecutive_failures >= self.read_failures_before_reconnect:
                        release_capture(cap)
                        cap = None
                        if read_error is not None:
                            gc.collect()
                        with self.state.lock:
                            self.state.video_status = f"reconnecting ({read_error or 'closed'})"
                        log_runtime_status(self.state, "video", force=True)
                        self.stop_event.wait(reconnect_backoff_s)
                        reconnect_backoff_s = min(5.0, reconnect_backoff_s * 1.5)
                    else:
                        self.stop_event.wait(0.005)
                    continue

                consecutive_failures = 0
                reconnect_backoff_s = 0.1
                seq += 1
                arrival_ms = now_ms()
                with self.lock:
                    self.latest = CapturedVideoFrame(seq, arrival_ms, frame)
                with self.state.lock:
                    self.state.video_status = "open"
        finally:
            release_capture(cap)


def parse_video_source(value: str) -> int | str:
    try:
        return int(value)
    except ValueError:
        return value


def mask_stream_url(value: Any) -> str:
    text = str(value)
    if not text.startswith(("rtmp://", "rtmps://", "rtsp://", "http://", "https://")):
        return text
    try:
        parts = urlsplit(text)
        netloc = parts.netloc
        if "@" in netloc and ":" in netloc.split("@", 1)[0]:
            userinfo, hostinfo = netloc.rsplit("@", 1)
            user = userinfo.split(":", 1)[0]
            netloc = f"{user}:***@{hostinfo}"
        query_items = []
        for key, value_item in parse_qsl(parts.query, keep_blank_values=True):
            query_items.append((key, "***" if key.lower() in {"pass", "password", "token", "key"} else value_item))
        return urlunsplit((parts.scheme, netloc, parts.path, urlencode(query_items), parts.fragment))
    except Exception:
        return re.sub(r"([?&]pass=)[^&\s]+", r"\1***", text)


def draw_text(frame: np.ndarray, text: str, x: int, y: int, color: tuple[int, int, int] = (255, 255, 255)) -> None:
    scale = 0.58
    available_width = max(40, frame.shape[1] - x - 8)
    text_width = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)[0][0]
    if text_width > available_width:
        scale = max(0.32, scale * available_width / text_width)
    cv2.putText(frame, text, (x + 1, y + 1), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(frame, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)


def display_temp(value: Any) -> str:
    try:
        if value == "" or value is None:
            return "-"
        return f"{float(value):.2f}"
    except (TypeError, ValueError):
        return str(value)


def thermal_thumbnail(frame: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    row_std = gray.std(axis=1)
    row_mean = gray.mean(axis=1)
    valid_rows = np.flatnonzero((row_std > 2.0) | (row_mean > 8.0))
    if valid_rows.size >= 8:
        gray = gray[int(valid_rows[0]):int(valid_rows[-1]) + 1, :]
    target_ratio = MATRIX_WIDTH / MATRIX_HEIGHT
    current_ratio = gray.shape[1] / max(1, gray.shape[0])
    if current_ratio > target_ratio:
        target_width = max(1, int(round(gray.shape[0] * target_ratio)))
        x0 = max(0, (gray.shape[1] - target_width) // 2)
        gray = gray[:, x0:x0 + target_width]
    elif current_ratio < target_ratio:
        target_height = max(1, int(round(gray.shape[1] / target_ratio)))
        y0 = max(0, (gray.shape[0] - target_height) // 2)
        gray = gray[y0:y0 + target_height, :]
    thumb = cv2.resize(gray, (160, 128), interpolation=cv2.INTER_AREA)
    thumb = cv2.GaussianBlur(thumb, (5, 5), 0)
    normalized = thumb.astype(np.float32)
    normalized -= float(normalized.mean())
    std = float(normalized.std())
    if std > 1e-6:
        normalized /= std
    return normalized


def thumbnail_correlation(left: np.ndarray, right: np.ndarray) -> float:
    if left.shape != right.shape:
        return -1.0
    return float(np.clip(np.mean(left * right), -1.0, 1.0))


def matrix_values_thumbnail(values: np.ndarray) -> np.ndarray:
    matrix = np.asarray(values, dtype=np.float32).reshape((MATRIX_HEIGHT, MATRIX_WIDTH))
    low, high = np.percentile(matrix, [1, 99])
    scale = max(1e-6, float(high - low))
    gray = np.clip((matrix - low) * (255.0 / scale), 0, 255).astype(np.uint8)
    return thermal_thumbnail(gray)


def as_int_ms(value: Any) -> int | None:
    try:
        if value == "":
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def estimate_device_to_pc_offset_ms(rows: list[dict[str, Any]]) -> float | None:
    offsets: list[float] = []
    for row in rows[-80:]:
        device_time = as_int_ms(row.get("device_time_ms"))
        pc_time = as_int_ms(row.get("pc_receive_time_ms"))
        if device_time is None or pc_time is None:
            continue
        offset = float(pc_time - device_time)
        if abs(offset) <= 10 * 60 * 1000:
            offsets.append(offset)
    if len(offsets) < 3:
        return None
    return float(np.median(offsets))


def nearest_global_for_device_time(rows: list[dict[str, Any]], device_time_ms: int) -> dict[str, Any] | None:
    usable = [row for row in rows if as_int_ms(row.get("device_time_ms")) is not None]
    if not usable:
        return None
    return min(usable, key=lambda item: abs(int(as_int_ms(item.get("device_time_ms")) or 0) - device_time_ms))


def msdk_point_to_matrix(row: dict[str, Any], prefix: str) -> tuple[int, int] | None:
    x = as_float(row.get(f"{prefix}_point_x_raw"))
    y = as_float(row.get(f"{prefix}_point_y_raw"))
    if x is None or y is None:
        return None
    # MSDK reports coordinates in the left-IR/right-RGB composite canvas.
    mx = int(round(np.clip(x * 2.0, 0.0, 1.0) * (MATRIX_WIDTH - 1)))
    my = int(round(np.clip(y, 0.0, 1.0) * (MATRIX_HEIGHT - 1)))
    return mx, my


def calibrate_app3_with_msdk(
    apparent: np.ndarray,
    global_row: dict[str, Any],
) -> tuple[np.ndarray, dict[str, Any]] | None:
    min_point = msdk_point_to_matrix(global_row, "min")
    max_point = msdk_point_to_matrix(global_row, "max")
    target_min = as_float(global_row.get("min_c"))
    target_avg = as_float(global_row.get("avg_c"))
    target_max = as_float(global_row.get("max_c"))
    if min_point is None or max_point is None or None in (target_min, target_avg, target_max):
        return None

    # The 16:9 composite letterboxes the native 5:4 thermal image vertically.
    visible = apparent[MATRIX_HEIGHT // 8:MATRIX_HEIGHT * 7 // 8, :]
    min_x, min_y = min_point
    max_x, max_y = max_point
    source_min = float(apparent[min_y, min_x])
    source_max = float(apparent[max_y, max_x])
    source_avg = float(np.mean(visible))
    source_square_avg = float(np.mean(np.square(visible, dtype=np.float64)))
    system = np.array(
        [
            [source_min * source_min, source_min, 1.0],
            [source_square_avg, source_avg, 1.0],
            [source_max * source_max, source_max, 1.0],
        ],
        dtype=np.float64,
    )
    targets = np.array([target_min, target_avg, target_max], dtype=np.float64)
    try:
        a, b, c = np.linalg.solve(system, targets)
    except np.linalg.LinAlgError:
        return None
    low, high = float(np.min(visible)), float(np.max(visible))
    if min(2.0 * a * low + b, 2.0 * a * high + b) <= 0.0:
        return None
    calibrated = (a * apparent * apparent + b * apparent + c).astype(np.float32)
    return calibrated, {
        "calibration_a": float(a),
        "calibration_b": float(b),
        "calibration_c": float(c),
        "source_min_at_msdk_point_c": source_min,
        "source_visible_avg_c": source_avg,
        "source_max_at_msdk_point_c": source_max,
        "target_min_c": target_min,
        "target_avg_c": target_avg,
        "target_max_c": target_max,
        "min_point_matrix_x": min_x,
        "min_point_matrix_y": min_y,
        "max_point_matrix_x": max_x,
        "max_point_matrix_y": max_y,
    }


def dummy_detect(frame: np.ndarray, frame_time_ms: int) -> list[dict[str, Any]]:
    height, width = frame.shape[:2]
    return [
        {
            "track_id": None,
            "class_name": "dummy_roi",
            "conf": 1.0,
            "x1": int(width * 0.35),
            "y1": int(height * 0.35),
            "x2": int(width * 0.65),
            "y2": int(height * 0.65),
            "frame_time_ms": frame_time_ms,
        }
    ]


def detect(frame: np.ndarray, frame_time_ms: int, detector: str) -> list[dict[str, Any]]:
    if detector == "none":
        return []
    return dummy_detect(frame, frame_time_ms)


def matrix_roi(matrix: np.ndarray, box: dict[str, Any], video_width: int, video_height: int) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    x1 = int(round(float(box["x1"]) / video_width * MATRIX_WIDTH))
    y1 = int(round(float(box["y1"]) / video_height * MATRIX_HEIGHT))
    x2 = int(round(float(box["x2"]) / video_width * MATRIX_WIDTH))
    y2 = int(round(float(box["y2"]) / video_height * MATRIX_HEIGHT))
    x1 = max(0, min(MATRIX_WIDTH - 1, x1))
    x2 = max(0, min(MATRIX_WIDTH, x2))
    y1 = max(0, min(MATRIX_HEIGHT - 1, y1))
    y2 = max(0, min(MATRIX_HEIGHT, y2))
    if x2 <= x1:
        x2 = min(MATRIX_WIDTH, x1 + 1)
    if y2 <= y1:
        y2 = min(MATRIX_HEIGHT, y1 + 1)
    return matrix[y1:y2, x1:x2], (x1, y1, x2, y2)


def fixed_crop_bounds(center_x: int, center_y: int, crop_size: int, width: int, height: int) -> tuple[int, int, int, int]:
    crop_w = min(crop_size, width)
    crop_h = min(crop_size, height)
    x1 = int(round(center_x - crop_w / 2))
    y1 = int(round(center_y - crop_h / 2))
    x1 = max(0, min(width - crop_w, x1))
    y1 = max(0, min(height - crop_h, y1))
    return x1, y1, x1 + crop_w, y1 + crop_h


def hot_region_matrix_center(matrix: np.ndarray, threshold_c: float) -> tuple[float, int, int] | None:
    if matrix.size == 0:
        return None
    finite = np.asarray(matrix, dtype=np.float32)
    if not np.isfinite(finite).any():
        return None
    max_index = int(np.nanargmax(finite))
    max_y, max_x = np.unravel_index(max_index, finite.shape)
    max_c = float(finite[max_y, max_x])
    if max_c <= threshold_c:
        return None

    hot_mask = np.isfinite(finite) & (finite > threshold_c)
    labels_count, labels = cv2.connectedComponents(hot_mask.astype(np.uint8), connectivity=8)
    if labels_count <= 1:
        return max_c, int(max_x), int(max_y)
    label = int(labels[max_y, max_x])
    if label <= 0:
        return max_c, int(max_x), int(max_y)
    ys, xs = np.nonzero(labels == label)
    if xs.size == 0:
        return max_c, int(max_x), int(max_y)
    return max_c, int(round(float(xs.mean()))), int(round(float(ys.mean())))


def build_hot_inference_request(
    state: LiveState,
    frame_time_ms: int,
    frame: np.ndarray,
    threshold_c: float,
    crop_size: int,
) -> InferenceRequest | None:
    if threshold_c <= 0 or crop_size <= 0:
        return InferenceRequest(frame_time_ms, frame.copy(), (0, 0), (frame.shape[1], frame.shape[0]), None)
    with state.lock:
        matrix = None if state.latest_matrix_values is None else state.latest_matrix_values.copy()
    if matrix is None:
        return None
    hot = hot_region_matrix_center(matrix, threshold_c)
    if hot is None:
        return None
    hot_max_c, matrix_x, matrix_y = hot
    height, width = frame.shape[:2]
    video_x = int(round(np.clip(matrix_x / max(1, MATRIX_WIDTH - 1), 0.0, 1.0) * (width - 1)))
    video_y = int(round(np.clip(matrix_y / max(1, MATRIX_HEIGHT - 1), 0.0, 1.0) * (height - 1)))
    x1, y1, x2, y2 = fixed_crop_bounds(video_x, video_y, crop_size, width, height)
    crop = frame[y1:y2, x1:x2].copy()
    if crop.size == 0:
        return None
    return InferenceRequest(frame_time_ms, crop, (x1, y1), (width, height), hot_max_c)


def box_temp_row(
    matrix_row: dict[str, Any],
    box: dict[str, Any],
    roi: np.ndarray,
    matrix_box: tuple[int, int, int, int],
    video_width: int,
    video_height: int,
) -> dict[str, Any]:
    values = roi.reshape(-1).astype(float).tolist()
    stats = summarize_box(values)
    x1m, y1m, x2m, y2m = matrix_box
    matrix_time = int(matrix_row["device_time_ms"] or matrix_row["pc_receive_time_ms"])
    return {
        "matrix_seq": matrix_row["seq"],
        "matrix_device_time_ms": matrix_row["device_time_ms"],
        "matrix_pc_receive_time_ms": matrix_row["pc_receive_time_ms"],
        "nearest_detection_frame_time_ms": box["frame_time_ms"],
        "time_diff_ms": abs(int(box["frame_time_ms"]) - matrix_time),
        "track_id": "" if box.get("track_id") is None else box.get("track_id"),
        "class_name": box.get("class_name", ""),
        "conf": f"{float(box.get('conf', 0.0)):.6f}",
        "x1_video": int(box["x1"]),
        "y1_video": int(box["y1"]),
        "x2_video": int(box["x2"]),
        "y2_video": int(box["y2"]),
        "x1_matrix": x1m,
        "y1_matrix": y1m,
        "x2_matrix": x2m,
        "y2_matrix": y2m,
        "box_avg_c": f"{stats['avg']:.6f}",
        "box_min_c": f"{stats['min']:.6f}",
        "box_max_c": f"{stats['max']:.6f}",
        "box_p90_c": f"{stats['p90']:.6f}",
        "box_p95_c": f"{stats['p95']:.6f}",
        "hot_ratio_45": f"{stats['hot_ratio_45']:.6f}",
        "hot_ratio_60": f"{stats['hot_ratio_60']:.6f}",
        "hot_area_px_60": int(stats["hot_area_px_60"]),
    }


def run_udp_loop(state: LiveState, host: str, port: int, stop_event: threading.Event) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        sock.bind((host, port))
    except OSError as exc:
        print(f"[udp] bind failed on {host}:{port}: {type(exc).__name__} errno={getattr(exc, 'errno', None)} winerror={getattr(exc, 'winerror', None)}", flush=True)
        stop_event.set()
        sock.close()
        return
    sock.settimeout(0.5)
    csv_path = state.output_dir / "global_temperature.csv"
    print(f"[udp] listening on {host}:{port}", flush=True)
    while not stop_event.is_set():
        try:
            data, _addr = sock.recvfrom(65535)
        except socket.timeout:
            continue
        try:
            msg = json.loads(data.decode("utf-8"))
        except Exception as exc:
            print(f"[udp] bad packet: {exc}", flush=True)
            continue
        row = accept_global_temperature(state, msg, csv_path)
        print(f"[udp] seq={msg.get('seq')} avg={msg.get('avg_c')} min={msg.get('min_c')} max={msg.get('max_c')}", flush=True)
    sock.close()


def accept_global_temperature(state: LiveState, msg: dict[str, Any], csv_path: Path) -> dict[str, Any]:
    pc_time = now_ms()
    device_time = msg.get("device_time_ms")
    delay = pc_time - int(device_time) if isinstance(device_time, int) else ""
    row = {field: msg.get(field, "") for field in GLOBAL_FIELDS}
    row["pc_receive_time_ms"] = pc_time
    row["delay_ms"] = delay
    append_csv(csv_path, GLOBAL_FIELDS, row)
    with state.lock:
        state.latest_global = row
        state.global_history.append(row)
        state.udp_count += 1
    return row


MATRIX_MSDK_CALIBRATED_FIELDS = [
    "seq", "device_time_ms", "pc_receive_time_ms", "calibration_mode", "calibration_time_delta_ms",
    "matrix_raw_apparent_min_c", "matrix_raw_apparent_avg_c", "matrix_raw_apparent_max_c",
    "matrix_min_c", "matrix_avg_c", "matrix_max_c",
    "matrix_min_x", "matrix_min_y", "matrix_max_x", "matrix_max_y",
    "calibration_a", "calibration_b", "calibration_c",
    "source_min_at_msdk_point_c", "source_visible_avg_c", "source_max_at_msdk_point_c",
    "target_min_c", "target_avg_c", "target_max_c",
]


def on_matrix_upload(state: LiveState, result: dict[str, Any]) -> None:
    row = result["row"]
    values = np.asarray(result["values"], dtype=np.float32).reshape((MATRIX_HEIGHT, MATRIX_WIDTH))
    apparent_values = values
    jpg_path = str(row.get("jpg_path") or "")
    matrix_frame = cv2.imread(jpg_path, cv2.IMREAD_COLOR) if jpg_path else None
    compare_row = None
    matched_frame = None
    match_correlation = None
    if matrix_frame is not None or values.size:
        matrix_thumb = thermal_thumbnail(matrix_frame) if matrix_frame is not None else matrix_values_thumbnail(values)
        try:
            device_time_ms = int(row.get("device_time_ms") or 0)
        except (TypeError, ValueError):
            device_time_ms = 0
        with state.lock:
            candidates = [item for item in state.video_buffer if item.ir_thumbnail is not None]
            global_rows = list(state.global_history)
            measured_offset = state.matrix_video_offset_ms
            clock_offset_ms = estimate_device_to_pc_offset_ms(global_rows)
            nearest_global = nearest_global_for_device_time(global_rows, device_time_ms) if device_time_ms > 0 else None
        if device_time_ms > 0 and candidates:
            if clock_offset_ms is not None:
                expected_arrival_ms = device_time_ms + clock_offset_ms
            elif measured_offset is not None:
                expected_arrival_ms = device_time_ms + measured_offset
            else:
                expected_arrival_ms = candidates[-1].arrival_ms
            scored: list[tuple[float, float, float, BufferedCompositeFrame]] = []
            newest_arrival_ms = candidates[-1].arrival_ms
            for candidate in candidates:
                correlation = thumbnail_correlation(matrix_thumb, candidate.ir_thumbnail)
                time_distance_ms = abs(candidate.arrival_ms - expected_arrival_ms)
                recency_distance_ms = max(0, newest_arrival_ms - candidate.arrival_ms)
                # Static thermal scenes can make many frames look visually identical.
                # Keep visual correlation, but make MSDK clock alignment and recency
                # strong enough to avoid choosing stale frames.
                time_penalty = min(time_distance_ms / 2500.0, 2.0) * 0.22
                recency_penalty = min(recency_distance_ms / 6000.0, 1.0) * 0.06
                score = correlation - time_penalty - recency_penalty
                scored.append((score, correlation, time_distance_ms, candidate))
            _score, match_correlation, match_time_distance_ms, matched_frame = max(scored, key=lambda item: item[0])
    if nearest_global is not None and row.get("matrix_source") != "DJI_THERMAL_SDK":
        calibrated_result = calibrate_app3_with_msdk(apparent_values, nearest_global)
        if calibrated_result is not None:
            values, calibration = calibrated_result
            row["matrix_raw_apparent_min_c"] = row.get("matrix_min_c", "")
            row["matrix_raw_apparent_avg_c"] = row.get("matrix_avg_c", "")
            row["matrix_raw_apparent_max_c"] = row.get("matrix_max_c", "")
            row["matrix_min_c"] = f"{calibration['target_min_c']:.6f}"
            row["matrix_avg_c"] = f"{calibration['target_avg_c']:.6f}"
            row["matrix_max_c"] = f"{calibration['target_max_c']:.6f}"
            row["matrix_min_x"] = calibration["min_point_matrix_x"]
            row["matrix_min_y"] = calibration["min_point_matrix_y"]
            row["matrix_max_x"] = calibration["max_point_matrix_x"]
            row["matrix_max_y"] = calibration["max_point_matrix_y"]
            row["calibration_mode"] = "MSDK_SAME_FRAME_MONOTONIC_QUADRATIC"
            row["calibration_time_delta_ms"] = abs(int(nearest_global.get("device_time_ms") or 0) - device_time_ms)
            row.update({key: f"{value:.9f}" if isinstance(value, float) else value for key, value in calibration.items()})
            append_csv(
                state.output_dir / "matrix_msdk_calibrated.csv",
                MATRIX_MSDK_CALIBRATED_FIELDS,
                {field: row.get(field, "") for field in MATRIX_MSDK_CALIBRATED_FIELDS},
            )
    with state.lock:
        state.latest_matrix_row = row
        state.latest_matrix_values = values
        state.matrix_history.append((dict(row), values))
        if matrix_frame is not None:
            state.latest_matrix_frame = matrix_frame
        state.matrix_count += 1
        global_row = dict(nearest_global) if nearest_global is not None else (dict(state.latest_global) if state.latest_global else None)
        if matched_frame is not None and match_correlation is not None:
            matrix_device_time_ms = int(row["device_time_ms"])
            measured_offset_ms = matched_frame.arrival_ms - matrix_device_time_ms
            if match_time_distance_ms <= 2500 or match_correlation >= 0.35:
                if state.matrix_video_offset_ms is None:
                    state.matrix_video_offset_ms = float(measured_offset_ms)
                else:
                    state.matrix_video_offset_ms = 0.9 * state.matrix_video_offset_ms + 0.1 * measured_offset_ms
            measured_delay_ms = max(0, now_ms() - matched_frame.arrival_ms + 150)
            state.sync_delay_samples_ms.append(measured_delay_ms)
            if state.last_matrix_device_time_ms > 0:
                interval_ms = matrix_device_time_ms - state.last_matrix_device_time_ms
                if 500 <= interval_ms <= 30000:
                    state.matrix_interval_samples_ms.append(interval_ms)
            state.last_matrix_device_time_ms = matrix_device_time_ms
            # Do not hold the live video stream waiting for low-frequency matrix
            # uploads. The matrix is used as the freshest temperature overlay;
            # playback remains low-latency and is capped to a small fallback delay
            # only when MSDK global temperature is temporarily absent.
            state.sync_playback_delay_ms = 0
            state.matrix_matches.append(MatrixVideoMatch(matched_frame.arrival_ms, dict(row), match_correlation))
            state.sync_visual_correlation = match_correlation
            if row.get("calibration_mode"):
                state.msdk_hotspot_offset_x = 0.0
                state.msdk_hotspot_offset_y = 0.0
                state.hotspot_calibration_count += 1
        elif state.displayed_matrix_row is None:
            state.displayed_matrix_row = dict(row)
    if global_row:
        compare_row = build_matrix_global_compare(row, global_row)
        append_csv(
            state.output_dir / "matrix_global_compare.csv",
            MATRIX_GLOBAL_COMPARE_FIELDS,
            compare_row,
        )
        with state.lock:
            state.latest_matrix_compare = compare_row
    print(
        f"[matrix] seq={row['seq']} avg={row['matrix_avg_c']} min={row['matrix_min_c']} max={row['matrix_max_c']} "
        f"raw_max={row.get('matrix_raw_apparent_max_c', row['matrix_max_c'])} mode={row.get('calibration_mode', row.get('matrix_source', 'APP3_APPARENT'))} extract_ms={row['extract_ms']}",
        flush=True,
    )
    if matched_frame is not None and match_correlation is not None:
        print(
            f"[sync] matrix_seq={row['seq']} video_arrival_ms={matched_frame.arrival_ms} "
            f"correlation={match_correlation:.3f} playback_delay_ms={state.sync_playback_delay_ms}",
            flush=True,
        )
    if compare_row:
        print(
            f"[matrix-check] matrix_seq={compare_row['matrix_seq']} global_seq={compare_row['global_seq']} "
            f"d_avg={compare_row['delta_avg_c']} d_min={compare_row['delta_min_c']} d_max={compare_row['delta_max_c']} "
            f"max_dist_px={compare_row['max_point_dist_px']}",
        flush=True,
    )


def load_latest_matrix_snapshot(state: LiveState) -> None:
    summary_path = state.output_dir / "matrix_summary.csv"
    if not summary_path.exists():
        return
    try:
        with summary_path.open("r", encoding="utf-8", newline="") as f:
            rows = list(csv.DictReader(f))
        if not rows:
            return
        row = rows[-1]
        jpg_value = row.get("jpg_path", "")
        if not jpg_value:
            return
        jpg_path = Path(jpg_value)
        if not jpg_path.is_absolute():
            jpg_path = Path.cwd() / jpg_path
        frame = cv2.imread(str(jpg_path), cv2.IMREAD_COLOR)
        if frame is None:
            return
        with state.lock:
            state.latest_matrix_row = row
            state.latest_matrix_frame = frame
        print(f"[matrix] loaded latest snapshot seq={row.get('seq')} jpg={jpg_path}", flush=True)
    except Exception as exc:
        print(f"[matrix] load latest snapshot failed: {exc}", flush=True)


MATRIX_GLOBAL_COMPARE_FIELDS = [
    "matrix_seq",
    "global_seq",
    "matrix_pc_receive_time_ms",
    "global_pc_receive_time_ms",
    "time_diff_ms",
    "matrix_avg_c",
    "global_avg_c",
    "delta_avg_c",
    "matrix_min_c",
    "global_min_c",
    "delta_min_c",
    "matrix_max_c",
    "global_max_c",
    "delta_max_c",
    "matrix_min_x",
    "matrix_min_y",
    "global_min_x_px",
    "global_min_y_px",
    "min_point_dist_px",
    "matrix_max_x",
    "matrix_max_y",
    "global_max_x_px",
    "global_max_y_px",
    "max_point_dist_px",
]


def as_float(value: Any) -> float | None:
    try:
        if value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def point_dist(x1: float | None, y1: float | None, x2: float | None, y2: float | None) -> float | None:
    if x1 is None or y1 is None or x2 is None or y2 is None:
        return None
    return float(((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5)


def build_matrix_global_compare(matrix_row: dict[str, Any], global_row: dict[str, Any]) -> dict[str, Any]:
    matrix_time = int(matrix_row.get("pc_receive_time_ms") or 0)
    global_time = int(global_row.get("pc_receive_time_ms") or 0)
    m_avg = as_float(matrix_row.get("matrix_avg_c"))
    g_avg = as_float(global_row.get("avg_c"))
    m_min = as_float(matrix_row.get("matrix_min_c"))
    g_min = as_float(global_row.get("min_c"))
    m_max = as_float(matrix_row.get("matrix_max_c"))
    g_max = as_float(global_row.get("max_c"))
    m_min_x = as_float(matrix_row.get("matrix_min_x"))
    m_min_y = as_float(matrix_row.get("matrix_min_y"))
    m_max_x = as_float(matrix_row.get("matrix_max_x"))
    m_max_y = as_float(matrix_row.get("matrix_max_y"))
    global_min_point = msdk_point_to_matrix(global_row, "min")
    global_max_point = msdk_point_to_matrix(global_row, "max")
    g_min_x = float(global_min_point[0]) if global_min_point else None
    g_min_y = float(global_min_point[1]) if global_min_point else None
    g_max_x = float(global_max_point[0]) if global_max_point else None
    g_max_y = float(global_max_point[1]) if global_max_point else None
    min_dist = point_dist(m_min_x, m_min_y, g_min_x, g_min_y)
    max_dist = point_dist(m_max_x, m_max_y, g_max_x, g_max_y)
    return {
        "matrix_seq": matrix_row.get("seq", ""),
        "global_seq": global_row.get("seq", ""),
        "matrix_pc_receive_time_ms": matrix_time,
        "global_pc_receive_time_ms": global_time,
        "time_diff_ms": abs(matrix_time - global_time) if matrix_time and global_time else "",
        "matrix_avg_c": matrix_row.get("matrix_avg_c", ""),
        "global_avg_c": global_row.get("avg_c", ""),
        "delta_avg_c": f"{(m_avg - g_avg):.6f}" if m_avg is not None and g_avg is not None else "",
        "matrix_min_c": matrix_row.get("matrix_min_c", ""),
        "global_min_c": global_row.get("min_c", ""),
        "delta_min_c": f"{(m_min - g_min):.6f}" if m_min is not None and g_min is not None else "",
        "matrix_max_c": matrix_row.get("matrix_max_c", ""),
        "global_max_c": global_row.get("max_c", ""),
        "delta_max_c": f"{(m_max - g_max):.6f}" if m_max is not None and g_max is not None else "",
        "matrix_min_x": matrix_row.get("matrix_min_x", ""),
        "matrix_min_y": matrix_row.get("matrix_min_y", ""),
        "global_min_x_px": global_row.get("min_point_x_px", ""),
        "global_min_y_px": global_row.get("min_point_y_px", ""),
        "min_point_dist_px": f"{min_dist:.3f}" if min_dist is not None else "",
        "matrix_max_x": matrix_row.get("matrix_max_x", ""),
        "matrix_max_y": matrix_row.get("matrix_max_y", ""),
        "global_max_x_px": global_row.get("max_point_x_px", ""),
        "global_max_y_px": global_row.get("max_point_y_px", ""),
        "max_point_dist_px": f"{max_dist:.3f}" if max_dist is not None else "",
    }


def run_http_server(
    state: LiveState,
    host: str,
    port: int,
    offset_c: float,
    stop_event: threading.Event,
    thermal_sdk_lib: str | None,
    measurement_params: MeasurementParams,
) -> None:
    def on_global(message: dict[str, Any]) -> None:
        row = accept_global_temperature(state, message, state.output_dir / "global_temperature.csv")
        print(f"[http-global] seq={row.get('seq')} avg={row.get('avg_c')} min={row.get('min_c')} max={row.get('max_c')}", flush=True)

    handler = make_handler(
        state.output_dir,
        offset_c,
        callback=lambda result: on_matrix_upload(state, result),
        global_callback=on_global,
        thermal_sdk_enabled=True,
        thermal_sdk_library=thermal_sdk_lib,
        measurement_params=measurement_params,
        allow_matrix_upload=False,
    )
    try:
        server = ReusableThreadingHTTPServer((host, port), handler)
    except OSError as exc:
        print(f"[http] bind failed on {host}:{port}: {type(exc).__name__} errno={getattr(exc, 'errno', None)} winerror={getattr(exc, 'winerror', None)}", flush=True)
        stop_event.set()
        return
    print(f"[http] listening on {host}:{port}/upload_h30t_global; matrix storage disabled", flush=True)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
    thread.start()
    stop_event.wait()
    server.shutdown()


def run_web_viewer(state: LiveState, host: str, port: int, stop_event: threading.Event) -> None:
    class LiveHandler(BaseHTTPRequestHandler):
        def write_bytes(self, body: bytes, content_type: str) -> None:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return

        def stream_mjpeg(self, stream_kind: str, delay_s: float = 0.03) -> None:
            self.send_response(200)
            self.send_header("Age", "0")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()
            last_sequence = -1
            next_send = time.perf_counter()
            with state.lock:
                state.active_web_streams += 1
                state.web_stream_total += 1
                active = state.active_web_streams
                total = state.web_stream_total
            print(f"[web] stream open kind={stream_kind} active={active} total={total}", flush=True)
            try:
                while not stop_event.is_set():
                    with state.lock:
                        if stream_kind == "ir":
                            jpeg = state.latest_ir_jpeg or state.latest_display_jpeg
                        elif stream_kind == "rgb":
                            jpeg = state.latest_rgb_jpeg
                        elif stream_kind == "pair":
                            jpeg = state.latest_pair_jpeg or state.latest_display_jpeg or state.latest_ir_jpeg
                        else:
                            jpeg = state.latest_display_jpeg
                        sequence = state.pair_sequence if stream_kind == "pair" else state.preview_sequence
                    now_perf = time.perf_counter()
                    if jpeg is None or sequence == last_sequence or now_perf < next_send:
                        stop_event.wait(min(0.02, max(0.001, next_send - now_perf)))
                        continue
                    try:
                        self.wfile.write(b"--frame\r\n")
                        self.wfile.write(b"Content-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii"))
                        self.wfile.write(jpeg)
                        self.wfile.write(b"\r\n")
                        self.wfile.flush()
                        last_sequence = sequence
                        next_send = time.perf_counter() + delay_s
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, OSError):
                        break
            finally:
                with state.lock:
                    state.active_web_streams = max(0, state.active_web_streams - 1)
                    active = state.active_web_streams
                print(f"[web] stream close kind={stream_kind} active={active}", flush=True)

        def render_page(self, title: str, image_path: str) -> bytes:
            return (
                "<!doctype html><html><head><meta charset='utf-8'>"
                f"<title>{title}</title>"
                "<style>body{margin:0;background:#111;color:#eee;font-family:Arial,sans-serif}"
                "header{height:34px;display:flex;align-items:center;gap:16px;padding:7px 14px;background:#222}"
                "a{color:#8fd3ff;text-decoration:none}img{display:block;max-width:100vw;max-height:calc(100vh - 48px);margin:auto}"
                "#status{position:fixed;right:10px;top:8px;background:rgba(0,0,0,.65);padding:6px 9px;border-radius:4px}</style>"
                f"</head><body><header><strong>{title}</strong><a href='/ir'>IR</a><a href='/rgb'>RGB</a><a href='/'>Both</a></header>"
                "<div id='status'>starting</div>"
                f"<img id='frame' src='{image_path}'>"
                "<script>"
                "const img=document.getElementById('frame');const st=document.getElementById('status');"
                f"async function tick(){{img.src='{image_path}?t='+Date.now();"
                "try{const r=await fetch('/status.json?t='+Date.now());const j=await r.json();"
                "st.textContent=`ir ${j.frames} rgb ${j.rgb_frames} matrices ${j.matrices} udp ${j.udp}`;}catch(e){st.textContent='status unavailable';}}"
                "setInterval(tick,120);tick();"
                "</script></body></html>"
            ).encode("utf-8")

        def do_GET(self) -> None:
            if self.path in ("/", "/index.html"):
                body = (
                    "<!doctype html><html><head><meta charset='utf-8'>"
                    "<title>H30T Wireless Live</title>"
                    "<style>*{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden;background:#0b0c0e;color:#eee;font-family:Arial,sans-serif}"
                    "header{min-height:54px;display:flex;align-items:center;gap:12px;padding:7px 14px;background:#1c2025;border-bottom:1px solid #343b45;flex-wrap:wrap}"
                    "a{color:#8fd3ff;text-decoration:none}.statusbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.pill{font-size:12px;padding:3px 7px;border:1px solid #59616c;background:#252b32;color:#ddd}.pill.ok{border-color:#48a868;color:#c9ffd5}.pill.warn{border-color:#d6a642;color:#ffe1a3}.pill.bad{border-color:#e04b4b;color:#ffd8d8}.content{height:calc(100vh - 54px);display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:10px;padding:10px;overflow:hidden}"
                    ".video{min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:10px;overflow:hidden}.pane{min-width:0;min-height:0;display:grid;grid-template-rows:32px minmax(0,1fr);background:#08090a;border:1px solid #303741}.pane h2{margin:0;padding:7px 10px;font-size:15px;font-weight:600;color:#e6edf3;background:#1b2128}.pane img{display:block;width:100%;height:100%;object-fit:contain;min-height:0;background:#050607}"
                    ".telemetry{min-height:0;padding:12px;background:#171b20;border:1px solid #343b45;display:grid;grid-template-rows:auto auto auto auto minmax(0,1fr);gap:10px;overflow:hidden}"
                    ".temps{font-size:16px;line-height:1.35;color:#b8ffbd;white-space:normal;overflow-wrap:anywhere}.matrix{color:#8fd3ff}.source{color:#ffd38f;font-size:13px;line-height:1.35}.meta{color:#c4cad1;font-size:13px;line-height:1.35;white-space:normal}"
                    ".alert{min-height:0;font-size:14px;line-height:1.38;color:#eee;background:#222831;border:1px solid #59616c;padding:10px;overflow:auto}.alert.warning{border-color:#d6a642}.alert.critical{border-color:#e04b4b;color:#ffd8d8}.alert img{display:block;width:100%;height:190px;object-fit:contain;margin-top:8px;border:1px solid #59616c;background:#08090a;cursor:zoom-in}.alert video{display:block;width:100%;height:220px;object-fit:contain;margin-top:8px;border:1px solid #59616c;background:#08090a}.evidenceGrid{display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px}.modebtn{border:1px solid #59616c;background:#252b32;color:#ddd;padding:4px 8px;cursor:pointer}.modebtn.active{border-color:#48a868;color:#c9ffd5}.lightbox{position:fixed;inset:0;background:rgba(0,0,0,.88);display:none;align-items:center;justify-content:center;z-index:20;padding:24px}.lightbox.open{display:flex}.lightbox img{max-width:96vw;max-height:94vh;object-fit:contain;border:1px solid #59616c;background:#000}"
                    "@media(max-width:1100px){.content{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) 320px}.telemetry{grid-template-columns:1fr;grid-template-rows:auto auto auto auto minmax(0,1fr)}.alert img{height:150px}}@media(max-width:720px){body{overflow:auto}.content{height:auto;min-height:calc(100vh - 54px);grid-template-columns:1fr;grid-template-rows:auto auto}.video{grid-template-columns:1fr;grid-template-rows:48vh 48vh}.telemetry{height:520px}.meta{text-align:left}header{gap:10px;padding-left:10px;padding-right:10px}}</style>"
                    "</head><body><header><strong>H30T Wireless Live</strong><a href='/ir'>IR</a><a href='/rgb'>RGB</a><button class='modebtn' data-mode='both'>Both</button><button class='modebtn' data-mode='rgb'>RGB AI</button><button class='modebtn' data-mode='ir'>IR AI</button><div class='statusbar'><span id='videoPill' class='pill'>Video: starting</span><span id='tempPill' class='pill'>Temp: waiting</span><span id='aiPill' class='pill'>AI: loading</span><span id='alertPill' class='pill'>Alert: waiting</span><span id='memPill' class='pill'>Mem: -</span></div></header>"
                    "<div class='content'><div class='video'><section class='pane'><h2>IR</h2><img id='ir' src='/ir.mjpg'></section><section class='pane'><h2>RGB</h2><img id='rgb' src='/rgb.mjpg'></section></div>"
                    "<aside class='telemetry'><div id='msdk' class='temps'>Global temperature: waiting</div><div id='matrix' class='temps matrix'>Temperature matrix: disabled</div><div id='source' class='source'>Synchronization: calibrating</div><div id='meta' class='meta'>starting</div><div id='alert' class='alert'>Alert: waiting</div></aside></div><div id='lightbox' class='lightbox'><img id='lightboxImg'></div>"
                    "<script>"
                    "const msdk=document.getElementById('msdk');const matrix=document.getElementById('matrix');const source=document.getElementById('source');const meta=document.getElementById('meta');const alertBox=document.getElementById('alert');const videoPill=document.getElementById('videoPill');const tempPill=document.getElementById('tempPill');const aiPill=document.getElementById('aiPill');const alertPill=document.getElementById('alertPill');const memPill=document.getElementById('memPill');const modeBtns=[...document.querySelectorAll('.modebtn')];const lightbox=document.getElementById('lightbox');const lightboxImg=document.getElementById('lightboxImg');let lastAlertKey='';modeBtns.forEach(b=>b.onclick=async()=>{await fetch('/set_inference_mode?mode='+encodeURIComponent(b.dataset.mode));tick();});lightbox.onclick=()=>{lightbox.classList.remove('open');lightboxImg.src='';};alertBox.onclick=e=>{if(e.target&&e.target.tagName==='IMG'){lightboxImg.src=e.target.src;lightbox.classList.add('open');}};"
                    "function pill(el,text,cls){el.textContent=text;el.className='pill '+cls;}"
                    "async function tick(){"
                    "try{const r=await fetch('/status.json?t='+Date.now());const j=await r.json();"
                    "msdk.textContent=j.msdk_temperature_text;matrix.textContent=j.matrix_temperature_text;source.textContent=j.synchronization_text;"
                    "modeBtns.forEach(b=>b.classList.toggle('active',b.dataset.mode===j.inference_stream_mode));meta.textContent=`source ${j.source_fps.toFixed(1)} fps | web ${j.output_fps.toFixed(1)} fps | mode ${j.inference_stream_mode} | IR AI ${j.ir_detector_fps.toFixed(1)} fps | RGB AI ${j.rgb_detector_fps.toFixed(1)} fps | UDP ${j.udp}`;"
                    "const tempFresh=j.latest_global&&j.latest_global_age_ms!==null&&j.latest_global_age_ms<=5000;const videoOk=j.video_status==='open'&&j.has_ir;const aiOk=(j.ir_detector_fps||0)>0||(j.rgb_detector_fps||0)>0||String(j.detector_status||'').includes('ready');pill(videoPill,videoOk?`Video: OK ${j.source_fps.toFixed(1)} fps`:`Video: ${j.video_status||'waiting'}`,videoOk?'ok':'warn');pill(tempPill,tempFresh?`Temp: OK max ${j.latest_global.max_c} C`:'Temp: waiting/stale',tempFresh?'ok':'warn');pill(aiPill,aiOk?`AI ${j.inference_stream_mode}: IR ${j.ir_detector_fps.toFixed(1)} RGB ${j.rgb_detector_fps.toFixed(1)}`:`AI: ${j.detector_status||'waiting'}`,aiOk?'ok':'warn');pill(memPill,`Mem: ${j.rss_mib||'-'} MiB`,(j.rss_mib||0)>3500?'bad':((j.rss_mib||0)>2500?'warn':'ok'));"
                    "const a=j.latest_alert;if(a){const key=[a.event_id,a.status,a.risk_type,a.ntfy_send_status,a.email_status,a.detection_count,a.frame_samples,j.alert_processing_count,a.video_clip].join('|');if(key!==lastAlertKey){lastAlertKey=key;alertBox.className='alert '+(a.severity||'');const rs=(a.reasons||[]).join(' | ');const imgKey=encodeURIComponent((a.event_id||'latest')+'_'+(a.status||''));const vid=a.status==='complete'&&a.video_clip?`<video controls muted src='/alert_video.mp4?event=${imgKey}'></video>`:'';const imgs=a.status==='complete'?`<div class='evidenceGrid'><img title='Click to enlarge detection evidence' src='/alert_detection.jpg?event=${imgKey}'><img title='Click to enlarge IR evidence' src='/alert_ir.jpg?event=${imgKey}'></div>`:'';alertBox.innerHTML=`<b>Alert ${a.status||''}: ${a.risk_type||''}</b><br>time ${a.event_time||'-'}<br>global max ${a.global_max_c??'-'} C avg ${a.global_avg_c??'-'} C<br>boxes ${a.detection_count??0}, frame ${a.frame_samples??0}, background ${j.alert_processing_count??0}<br>${rs}<br>ntfy: ${a.ntfy_send_status||'-'}<br>smtp: ${a.email_status||'-'}${vid}${imgs}`;}}else if(lastAlertKey!==''){lastAlertKey='';alertBox.textContent='Alert: waiting';alertBox.className='alert';}"
                    "if(a){pill(alertPill,`Alert: ${a.risk_type||a.status}`,a.severity==='critical'?'bad':(a.severity==='warning'?'warn':'ok'));}else{pill(alertPill,'Alert: waiting','ok');}"
                    "}catch(e){meta.textContent='status unavailable';}}"
                    "setInterval(tick,250);tick();"
                    "</script></body></html>"
                ).encode("utf-8")
                self.write_bytes(body, "text/html; charset=utf-8")
                return
            if self.path.startswith("/status.json"):
                with state.lock:
                    status_now_ms = now_ms()
                    selected_global = (state.displayed_global_row or state.latest_global) if state.strict_sync_active else state.latest_global
                    global_row = dict(selected_global) if selected_global else None
                    latest_global_age_ms = now_ms() - int(state.latest_global.get("pc_receive_time_ms") or 0) if state.latest_global else None
                    matrix_row = dict(state.displayed_matrix_row or state.latest_matrix_row) if (state.displayed_matrix_row or state.latest_matrix_row) else None
                    matrix_age_ms = now_ms() - int(matrix_row.get("pc_receive_time_ms") or now_ms()) if matrix_row else None
                    matrix_is_fresh = matrix_age_ms is not None and matrix_age_ms <= state.max_matrix_display_age_ms
                    fresh_matrix_row = matrix_row if matrix_is_fresh else None
                    sync_delta_ms = abs(state.ir_frame_time_ms - state.rgb_frame_time_ms) if state.ir_frame_time_ms and state.rgb_frame_time_ms else None
                    age_ms = now_ms() - int(global_row.get("pc_receive_time_ms") or 0) if global_row else None
                    if global_row and latest_global_age_ms is not None and latest_global_age_ms <= 3000:
                        temp_source = str(global_row.get("source") or "temperature")
                        if temp_source.startswith("PILOT2_"):
                            source_label = "Pilot2 OSD"
                        elif temp_source.startswith("NETWORK_"):
                            source_label = "Network thermal"
                        else:
                            source_label = "MSDK default region"
                        msdk_temperature_text = f"{source_label} | Avg {display_temp(global_row.get('avg_c'))} C | Min {display_temp(global_row.get('min_c'))} C | Max {display_temp(global_row.get('max_c'))} C | temperature/frame delta {state.sync_global_delta_ms if state.sync_global_delta_ms is not None else '-'} ms"
                    elif fresh_matrix_row:
                        msdk_temperature_text = (
                            "MSDK region | unavailable from RC Key timeout; "
                            f"using DJI Thermal SDK matrix fallback Max {fresh_matrix_row.get('matrix_max_c')} C | "
                            f"Min {fresh_matrix_row.get('matrix_min_c')} C | Avg {fresh_matrix_row.get('matrix_avg_c')} C"
                        )
                    else:
                        msdk_temperature_text = f"MSDK region | unavailable{f' (stale {age_ms} ms)' if age_ms is not None else ''}"
                    if matrix_row:
                        raw_max = matrix_row.get("matrix_raw_apparent_max_c")
                        stale_suffix = " | STALE - waiting for new matrix" if not matrix_is_fresh else ""
                        if matrix_row.get("calibration_mode"):
                            matrix_temperature_text = (
                                f"APP3 matrix (MSDK same-frame calibrated) | Max {matrix_row.get('matrix_max_c')} C | "
                                f"Min {matrix_row.get('matrix_min_c')} C | Avg {matrix_row.get('matrix_avg_c')} C | "
                                f"raw apparent max {raw_max} C | age {matrix_age_ms} ms{stale_suffix}"
                            )
                        elif matrix_row.get("matrix_source") == "DJI_THERMAL_SDK":
                            matrix_temperature_text = (
                                f"DJI Thermal SDK matrix | Max {matrix_row.get('matrix_max_c')} C | "
                                f"Min {matrix_row.get('matrix_min_c')} C | Avg {matrix_row.get('matrix_avg_c')} C | age {matrix_age_ms} ms{stale_suffix}"
                            )
                        else:
                            matrix_temperature_text = (
                                f"APP3 apparent matrix (not radiometrically corrected) | Max {matrix_row.get('matrix_max_c')} C | "
                                f"Min {matrix_row.get('matrix_min_c')} C | Avg {matrix_row.get('matrix_avg_c')} C | age {matrix_age_ms} ms{stale_suffix}"
                            )
                    else:
                        matrix_temperature_text = "Temperature matrix storage and display are disabled"
                    if latest_global_age_ms is not None and latest_global_age_ms <= 3000:
                        selected_source = str((global_row or {}).get("source") or "")
                        if selected_source.startswith("PILOT2_"):
                            sync_label = "Pilot2 OSD/video sync"
                        elif selected_source.startswith("NETWORK_"):
                            sync_label = "Network thermal/video sync"
                        else:
                            sync_label = "MSDK/video sync"
                        synchronization_text = (
                            f"{sync_label} | compensated delta {state.sync_global_delta_ms if state.sync_global_delta_ms is not None else '-'} ms | "
                            f"configured offset {state.temperature_video_offset_ms} ms | strict limit {state.max_temp_frame_delta_ms} ms"
                        )
                    elif fresh_matrix_row:
                        synchronization_text = (
                            f"Low-latency video + matrix fallback | playback delay {state.effective_playback_delay_ms} ms | "
                            f"frame delta {state.sync_video_temp_delta_ms if state.sync_video_temp_delta_ms is not None else '-'} ms | "
                            f"visual match {state.sync_visual_correlation:.3f}" if state.sync_visual_correlation is not None else "Synchronized matrix/video | calibrating"
                        )
                    elif matrix_row and not matrix_is_fresh:
                        synchronization_text = (
                            f"Low-latency video | matrix stale age {matrix_age_ms} ms | playback delay {state.effective_playback_delay_ms} ms | "
                            "waiting for RC matrix/MSDK temperature"
                        )
                    else:
                        synchronization_text = "Low-latency video | waiting for live MSDK temperature or matrix"
                    recent_video_times = [item for item in state.source_frame_times_ms if item >= status_now_ms - 3000]
                    recent_pair_times = [item for item in state.pair_publish_times_ms if item >= status_now_ms - 3000]
                    source_fps = (len(recent_video_times) - 1) * 1000.0 / max(1, recent_video_times[-1] - recent_video_times[0]) if len(recent_video_times) >= 2 else 0.0
                    output_fps = (len(recent_pair_times) - 1) * 1000.0 / max(1, recent_pair_times[-1] - recent_pair_times[0]) if len(recent_pair_times) >= 2 else 0.0
                    body = json.dumps(
                        {
                            "frames": state.frame_count,
                            "rgb_frames": state.rgb_frame_count,
                            "udp": state.udp_count,
                            "matrices": state.matrix_count,
                            "has_frame": state.latest_display_jpeg is not None,
                            "has_ir": state.latest_ir_jpeg is not None,
                            "has_rgb": state.latest_rgb_jpeg is not None,
                            "rgb_status": state.rgb_status,
                            "sync_delta_ms": sync_delta_ms,
                            "msdk_temperature_text": msdk_temperature_text,
                            "matrix_temperature_text": matrix_temperature_text,
                            "synchronization_text": synchronization_text,
                            "source_fps": source_fps,
                            "output_fps": output_fps,
                            "detector_status": state.detector_status,
                            "detector_device": state.detector_device,
                            "detector_fps": state.detector_fps,
                            "detector_latency_ms": state.detector_latency_ms,
                            "detector_count": state.detector_count,
                            "inference_stream_mode": state.requested_inference_stream_mode,
                            "ir_detector_status": state.ir_detector_status,
                            "rgb_detector_status": state.rgb_detector_status,
                            "ir_detector_fps": state.ir_detector_fps,
                            "rgb_detector_fps": state.rgb_detector_fps,
                            "ir_detector_latency_ms": state.ir_detector_latency_ms,
                            "rgb_detector_latency_ms": state.rgb_detector_latency_ms,
                            "ir_detector_count": state.ir_detector_count,
                            "rgb_detector_count": state.rgb_detector_count,
                            "effective_playback_delay_ms": state.effective_playback_delay_ms,
                            "temperature_frame_delta_ms": state.sync_global_delta_ms,
                            "max_temperature_frame_delta_ms": state.max_temp_frame_delta_ms,
                            "msdk_hotspot_offset_x": state.msdk_hotspot_offset_x,
                            "msdk_hotspot_offset_y": state.msdk_hotspot_offset_y,
                            "hotspot_calibration_count": state.hotspot_calibration_count,
                            "pair_sequence": state.pair_sequence,
                            "latest_global": state.latest_global,
                            "latest_global_age_ms": latest_global_age_ms,
                            "latest_matrix": state.latest_matrix_row,
                            "latest_alert": state.latest_alert,
                            "alert_active": state.alert_active,
                            "alert_processing_count": state.alert_processing_count,
                            "video_status": state.video_status,
                            "video_reconnect_count": state.video_reconnect_count,
                            "video_read_error_count": state.video_read_error_count,
                            "active_web_streams": state.active_web_streams,
                            "rss_mib": current_rss_mib(),
                        }
                    ).encode("utf-8")
                self.write_bytes(body, "application/json")
                return
            if self.path.startswith("/set_inference_mode"):
                try:
                    query = self.path.split("?", 1)[1] if "?" in self.path else ""
                    params = dict(parse_qsl(query))
                    mode = str(params.get("mode") or "").lower()
                except Exception:
                    mode = ""
                if mode not in {"both", "rgb", "ir"}:
                    self.write_bytes(b'{"ok":false,"error":"mode must be both, rgb, or ir"}', "application/json")
                    return
                with state.lock:
                    state.requested_inference_stream_mode = mode
                    state.inference_stream_mode = mode
                    state.detector_status = f"inference mode set to {mode}"
                self.write_bytes(json.dumps({"ok": True, "mode": mode}).encode("utf-8"), "application/json")
                return
            if self.path.startswith("/pair.mjpg") or self.path.startswith("/ir.mjpg") or self.path.startswith("/rgb.mjpg"):
                stream_kind = "pair"
                if self.path.startswith("/ir.mjpg"):
                    stream_kind = "ir"
                elif self.path.startswith("/rgb.mjpg"):
                    stream_kind = "rgb"
                with state.lock:
                    delay = 1.0 / max(1.0, state.web_output_fps)
                self.stream_mjpeg(stream_kind, delay)
                return
            if self.path.startswith("/pair.jpg"):
                with state.lock:
                    jpeg = state.latest_pair_jpeg or state.latest_display_jpeg or state.latest_ir_jpeg
                if jpeg is None:
                    frame = make_waiting_frame()
                    jpeg = encode_jpeg(frame, 82) or b""
                self.write_bytes(jpeg, "image/jpeg")
                return
            if self.path.startswith("/frame.jpg") or self.path.startswith("/ir.jpg"):
                with state.lock:
                    jpeg = state.latest_ir_jpeg or state.latest_display_jpeg
                if jpeg is None:
                    frame = make_waiting_frame()
                    jpeg = encode_jpeg(frame, 82) or b""
                self.write_bytes(jpeg, "image/jpeg")
                return
            if self.path.startswith("/rgb.jpg"):
                with state.lock:
                    jpeg = state.latest_rgb_jpeg
                    status = state.rgb_status
                if jpeg is None:
                    frame = make_waiting_frame()
                    draw_text(frame, f"Waiting for RGB video: {status}", 40, frame.shape[0] // 2 + 36, (120, 180, 255))
                    jpeg = encode_jpeg(frame, 82) or b""
                self.write_bytes(jpeg, "image/jpeg")
                return
            if self.path.startswith("/alert_detection.jpg"):
                with state.lock:
                    jpeg = state.latest_alert_detection_jpeg
                if jpeg is None:
                    frame = make_waiting_frame(960, 540)
                    draw_text(frame, "Waiting for alert detection frame", 40, frame.shape[0] // 2, (0, 255, 255))
                    jpeg = encode_jpeg(frame, 82) or b""
                self.write_bytes(jpeg, "image/jpeg")
                return
            if self.path.startswith("/alert_ir.jpg"):
                with state.lock:
                    jpeg = state.latest_alert_ir_jpeg
                if jpeg is None:
                    frame = make_waiting_frame(960, 540)
                    draw_text(frame, "Waiting for alert IR frame", 40, frame.shape[0] // 2, (0, 255, 255))
                    jpeg = encode_jpeg(frame, 82) or b""
                self.write_bytes(jpeg, "image/jpeg")
                return
            if self.path.startswith("/alert_video.mp4"):
                with state.lock:
                    path_value = state.latest_alert_video_path
                path = Path(path_value) if path_value else None
                if path is not None and path.is_file():
                    self.write_bytes(path.read_bytes(), "video/mp4")
                else:
                    self.write_bytes(b"", "video/mp4")
                return
            if self.path.startswith("/ir"):
                self.write_bytes(self.render_page("H30T IR + Temperature", "/ir.jpg"), "text/html; charset=utf-8")
                return
            if self.path.startswith("/rgb"):
                self.write_bytes(self.render_page("H30T RGB", "/rgb.jpg"), "text/html; charset=utf-8")
                return
            if self.path != "/stream.mjpg":
                self.send_error(404)
                return
            with state.lock:
                delay = 1.0 / max(1.0, state.web_output_fps)
            self.stream_mjpeg("display", delay)

        def log_message(self, fmt: str, *args: Any) -> None:
            return

    try:
        server = ReusableThreadingHTTPServer((host, port), LiveHandler)
    except OSError as exc:
        print(f"[web] bind failed on {host}:{port}: {type(exc).__name__} errno={getattr(exc, 'errno', None)} winerror={getattr(exc, 'winerror', None)}", flush=True)
        stop_event.set()
        return
    print(f"[web] live viewer: http://127.0.0.1:{port}/", flush=True)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
    thread.start()
    stop_event.wait()
    server.shutdown()


def run_web_encoder_loop(state: LiveState, stop_event: threading.Event) -> None:
    next_encode = time.perf_counter()
    while not stop_event.is_set():
        with state.lock:
            active = state.active_web_streams
            fps = state.web_output_fps
            quality = state.jpeg_quality
            ir_frame = None if state.latest_ir_frame is None else state.latest_ir_frame.copy()
            rgb_frame = None if state.latest_rgb_frame is None else state.latest_rgb_frame.copy()
        if active <= 0:
            stop_event.wait(0.05)
            next_encode = time.perf_counter()
            continue
        now_perf = time.perf_counter()
        if now_perf < next_encode:
            stop_event.wait(min(0.02, next_encode - now_perf))
            continue
        next_encode = max(now_perf, next_encode) + 1.0 / max(1.0, fps)
        ir_jpeg = encode_jpeg(ir_frame, quality) if ir_frame is not None else None
        rgb_jpeg = encode_jpeg(rgb_frame, quality) if rgb_frame is not None else None
        if ir_jpeg is None and rgb_jpeg is None:
            continue
        ts = now_ms()
        with state.lock:
            if ir_jpeg is not None:
                state.latest_display_jpeg = ir_jpeg
                state.latest_ir_jpeg = ir_jpeg
                state.ir_frame_time_ms = ts
            if rgb_jpeg is not None:
                state.latest_rgb_jpeg = rgb_jpeg
                state.rgb_frame_time_ms = ts
            state.preview_sequence += 1
            state.pair_sequence += 1
            state.pair_publish_times_ms.append(ts)


def draw_overlay(frame: np.ndarray, state: LiveState, display_fps: float, video_status: str) -> None:
    with state.lock:
        global_row = dict(state.displayed_global_row or state.latest_global) if (state.displayed_global_row or state.latest_global) else None
        compare_row = dict(state.latest_matrix_compare) if state.latest_matrix_compare else None
        matrix_row = dict(state.latest_matrix_row) if state.latest_matrix_row else None
        udp_count = state.udp_count
        matrix_count = state.matrix_count
        sync_delta_ms = state.sync_global_delta_ms
    cv2.rectangle(frame, (0, 0), (frame.shape[1], 104), (20, 20, 20), -1)
    draw_text(frame, "H30T live video + global temperature", 12, 24, (0, 255, 255))
    if global_row:
        age = now_ms() - int(global_row.get("pc_receive_time_ms") or now_ms())
        if age <= 5000:
            temp_source = str(global_row.get("source") or "temperature")
            source_label = "Pilot2 OSD" if temp_source.startswith("PILOT2_") else "MSDK global"
            draw_text(
                frame,
                f"{source_label} avg/min/max: {display_temp(global_row.get('avg_c'))}/{display_temp(global_row.get('min_c'))}/{display_temp(global_row.get('max_c'))} C delta={sync_delta_ms if sync_delta_ms is not None else '-'} ms age={age} ms",
                12,
                50,
                (180, 255, 180),
            )
        else:
            draw_text(frame, f"MSDK global: stale UDP age={age} ms, waiting for RC realtime update", 12, 50, (80, 180, 255))
            if matrix_row:
                draw_text(
                    frame,
                    f"Realtime global fallback from APP3 matrix avg/min/max: {matrix_row.get('matrix_avg_c')}/{matrix_row.get('matrix_min_c')}/{matrix_row.get('matrix_max_c')} C",
                    12,
                    76,
                    (180, 255, 180),
                )
    else:
        if matrix_row:
            draw_text(
                frame,
                f"Realtime global from APP3 matrix avg/min/max: {matrix_row.get('matrix_avg_c')}/{matrix_row.get('matrix_min_c')}/{matrix_row.get('matrix_max_c')} C",
                12,
                50,
                (180, 255, 180),
            )
            draw_text(frame, "MSDK REGION UDP: waiting; RC reports KeyThermalRegionMetersureTemperature timeout", 12, 76, (120, 180, 255))
        else:
            draw_text(frame, "Global temperature: waiting for RC UDP or APP3 matrix", 12, 50, (120, 180, 255))
    if compare_row:
        draw_text(
            frame,
            f"Matrix check dAvg/dMin/dMax: {compare_row.get('delta_avg_c')}/{compare_row.get('delta_min_c')}/{compare_row.get('delta_max_c')} C maxPtDist={compare_row.get('max_point_dist_px')} px",
            12,
            100,
            (180, 220, 255),
        )
    elif matrix_row and global_row:
        draw_text(
            frame,
            f"APP3 matrix realtime avg/min/max: {matrix_row.get('matrix_avg_c')}/{matrix_row.get('matrix_min_c')}/{matrix_row.get('matrix_max_c')} C (MSDK UDP waiting)",
            12,
            100,
            (180, 220, 255),
        )
    else:
        draw_text(frame, f"video={video_status} display_fps={display_fps:.1f} udp={udp_count} matrix_checks={matrix_count}", 12, 100)


def update_box_temperatures(
    state: LiveState,
    boxes: list[dict[str, Any]],
    video_width: int,
    video_height: int,
    matched_matrix_row: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if not boxes:
        return []
    with state.lock:
        matrix = None
        matrix_row = None
        requested_seq = str(matched_matrix_row.get("seq")) if matched_matrix_row else None
        if requested_seq is not None:
            for candidate_row, candidate_values in reversed(state.matrix_history):
                if str(candidate_row.get("seq")) == requested_seq:
                    matrix = candidate_values
                    matrix_row = dict(candidate_row)
                    break
        elif state.latest_matrix_values is not None and state.latest_matrix_row is not None:
            matrix = state.latest_matrix_values
            matrix_row = dict(state.latest_matrix_row)
    rows: list[dict[str, Any]] = []
    if matrix is None or matrix_row is None:
        return rows
    for box in boxes:
        roi, matrix_box = matrix_roi(matrix, box, video_width, video_height)
        row = box_temp_row(matrix_row, box, roi, matrix_box, video_width, video_height)
        rows.append(row)
    with state.lock:
        state.latest_box_rows = rows
        seq = str(matrix_row["seq"])
        should_write = seq != state.last_fused_matrix_seq
        if should_write:
            state.last_fused_matrix_seq = seq
    if rows and should_write:
        for row in rows:
            append_csv(state.output_dir / "box_temperature.csv", BOX_TEMPERATURE_FIELDS, row)
    return rows


def draw_boxes(frame: np.ndarray, boxes: list[dict[str, Any]], temp_rows: list[dict[str, Any]]) -> None:
    if not boxes:
        return
    temp_by_index = {idx: row for idx, row in enumerate(temp_rows)}
    for idx, box in enumerate(boxes):
        x1, y1, x2, y2 = int(box["x1"]), int(box["y1"]), int(box["x2"]), int(box["y2"])
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 240, 255), 2)
        label = f"{box.get('class_name', 'object')} {float(box.get('conf', 0.0)):.2f}"
        row = temp_by_index.get(idx)
        if row:
            label += f" max {float(row['box_max_c']):.1f} avg {float(row['box_avg_c']):.1f} C"
        draw_text(frame, label, x1, max(128, y1 - 8), (0, 255, 255))


def encode_jpeg(frame: np.ndarray, quality: int = 82) -> bytes | None:
    try:
        ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
        return encoded.tobytes() if ok else None
    except (MemoryError, SystemError, cv2.error) as exc:
        print(f"[jpeg] encode failed: {type(exc).__name__}: {exc}", flush=True)
        gc.collect()
        return None


def hstack_frames(left: np.ndarray, right: np.ndarray) -> np.ndarray | None:
    try:
        return np.hstack((left, right))
    except (MemoryError, SystemError, ValueError) as exc:
        print(f"[video] hstack failed: {type(exc).__name__}: {exc}", flush=True)
        gc.collect()
        return None


def copy_frame(frame: np.ndarray, label: str = "frame") -> np.ndarray | None:
    try:
        return frame.copy()
    except (MemoryError, SystemError, ValueError) as exc:
        print(f"[video] {label} copy failed: {type(exc).__name__}: {exc}", flush=True)
        gc.collect()
        return None


def matrix_heatmap_image(matrix: np.ndarray, width: int = 960) -> np.ndarray:
    values = np.asarray(matrix, dtype=np.float32).reshape((MATRIX_HEIGHT, MATRIX_WIDTH))
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        low, high = 0.0, 1.0
    else:
        low, high = np.percentile(finite, [1, 99])
        if high <= low:
            high = low + 1.0
    gray = np.clip((values - low) * (255.0 / max(1e-6, high - low)), 0, 255).astype(np.uint8)
    heat = cv2.applyColorMap(gray, cv2.COLORMAP_INFERNO)
    scale = max(1, int(round(width / max(1, heat.shape[1]))))
    heat = cv2.resize(heat, (heat.shape[1] * scale, heat.shape[0] * scale), interpolation=cv2.INTER_NEAREST)
    draw_text(heat, f"Matrix heatmap {float(np.nanmin(values)):.1f}..{float(np.nanmax(values)):.1f} C", 12, 26, (255, 255, 255))
    return heat


def detection_iou(a: dict[str, Any], b: dict[str, Any]) -> float:
    ax1, ay1, ax2, ay2 = float(a["x1"]), float(a["y1"]), float(a["x2"]), float(a["y2"])
    bx1, by1, bx2, by2 = float(b["x1"]), float(b["y1"]), float(b["x2"]), float(b["y2"])
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    return float(inter / max(1e-6, area_a + area_b - inter))


def nms_detections(boxes: list[dict[str, Any]], iou_threshold: float = 0.5) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    for box in sorted(boxes, key=lambda item: float(item.get("conf", 0.0)), reverse=True):
        if all(
            str(box.get("class_name")) != str(other.get("class_name")) or detection_iou(box, other) < iou_threshold
            for other in kept
        ):
            kept.append(box)
    return kept


def map_boxes_to_frame(
    boxes: list[dict[str, Any]],
    source_size: tuple[int, int],
    target_size: tuple[int, int],
    mapped_from: str,
) -> list[dict[str, Any]]:
    source_width, source_height = source_size
    target_width, target_height = target_size
    if source_width <= 0 or source_height <= 0 or target_width <= 0 or target_height <= 0:
        return [dict(box) for box in boxes]
    scale_x = target_width / source_width
    scale_y = target_height / source_height
    mapped_boxes: list[dict[str, Any]] = []
    for box in boxes:
        mapped = dict(box)
        mapped["x1"] = max(0, min(target_width - 1, int(round(float(box["x1"]) * scale_x))))
        mapped["y1"] = max(0, min(target_height - 1, int(round(float(box["y1"]) * scale_y))))
        mapped["x2"] = max(1, min(target_width, int(round(float(box["x2"]) * scale_x))))
        mapped["y2"] = max(1, min(target_height, int(round(float(box["y2"]) * scale_y))))
        mapped["mapped_from"] = mapped_from
        mapped_boxes.append(mapped)
    return mapped_boxes


def iter_tiles(width: int, height: int, tile_size: int, overlap: int) -> list[tuple[int, int, int, int]]:
    tile_size = max(64, int(tile_size))
    overlap = max(0, min(int(overlap), tile_size - 1))
    stride = max(1, tile_size - overlap)
    xs = list(range(0, max(1, width - tile_size + 1), stride))
    ys = list(range(0, max(1, height - tile_size + 1), stride))
    if not xs or xs[-1] + tile_size < width:
        xs.append(max(0, width - tile_size))
    if not ys or ys[-1] + tile_size < height:
        ys.append(max(0, height - tile_size))
    tiles: list[tuple[int, int, int, int]] = []
    for y in sorted(set(ys)):
        for x in sorted(set(xs)):
            tiles.append((x, y, min(width, x + tile_size), min(height, y + tile_size)))
    return tiles


def infer_tiled(
    frame: np.ndarray,
    frame_time_ms: int,
    detector_name: str,
    detector: Any,
    tile_size: int,
    overlap: int,
) -> list[dict[str, Any]]:
    height, width = frame.shape[:2]
    boxes: list[dict[str, Any]] = []
    for x1, y1, x2, y2 in iter_tiles(width, height, tile_size, overlap):
        tile = frame[y1:y2, x1:x2]
        if tile.size == 0:
            continue
        if detector_name == "deimv2" and detector is not None:
            tile_boxes, _latency_ms = detector.infer(tile, frame_time_ms)
        elif detector_name == "dummy":
            tile_boxes = dummy_detect(tile, frame_time_ms)
        else:
            tile_boxes = []
        for box in tile_boxes:
            mapped = dict(box)
            mapped["x1"] = max(0, min(width - 1, int(box["x1"]) + x1))
            mapped["y1"] = max(0, min(height - 1, int(box["y1"]) + y1))
            mapped["x2"] = max(1, min(width, int(box["x2"]) + x1))
            mapped["y2"] = max(1, min(height, int(box["y2"]) + y1))
            mapped["tile_x1"] = x1
            mapped["tile_y1"] = y1
            boxes.append(mapped)
    return nms_detections(boxes)


def nearest_matrix_sample(
    matrices: list[tuple[dict[str, Any], np.ndarray]],
    frame_time_ms: int,
) -> tuple[dict[str, Any], np.ndarray] | None:
    if not matrices:
        return None
    return min(matrices, key=lambda item: abs(int(item[0].get("pc_receive_time_ms") or frame_time_ms) - frame_time_ms))


def nearest_realtime_boxes(state: LiveState, frame_time_ms: int, max_age_ms: int = 1800) -> list[dict[str, Any]]:
    with state.lock:
        if not state.detection_history:
            return []
        detection_time, boxes = min(state.detection_history, key=lambda item: abs(item[0] - frame_time_ms))
    if abs(detection_time - frame_time_ms) > max_age_ms:
        return []
    return [dict(box) for box in boxes]


def fire_smoke_boxes(boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        dict(box)
        for box in boxes
        if str(box.get("class_name", "")).strip().lower() in FIRE_SMOKE_LABELS
    ]


def nearest_global_sample(state: LiveState, frame_time_ms: int, max_age_ms: int | None = None) -> dict[str, Any] | None:
    with state.lock:
        if not state.global_history:
            return None
        row = min(
            state.global_history,
            key=lambda item: abs(int(item.get("pc_receive_time_ms") or frame_time_ms) + state.temperature_video_offset_ms - frame_time_ms),
        )
    delta_ms = abs(int(row.get("pc_receive_time_ms") or frame_time_ms) + state.temperature_video_offset_ms - frame_time_ms)
    limit_ms = state.max_temp_frame_delta_ms if max_age_ms is None else max_age_ms
    return dict(row) if delta_ms <= limit_ms else None


def global_samples_for_frames(state: LiveState, frame_times_ms: list[int], max_age_ms: int | None = None) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    seen: set[int] = set()
    for frame_time_ms in frame_times_ms:
        row = nearest_global_sample(state, frame_time_ms, max_age_ms=max_age_ms)
        if row is None:
            continue
        key = int(row.get("pc_receive_time_ms") or row.get("device_time_ms") or frame_time_ms)
        if key in seen:
            continue
        seen.add(key)
        samples.append(row)
    return samples


def alert_box_temperature_rows(
    matrix_row: dict[str, Any] | None,
    matrix: np.ndarray | None,
    boxes: list[dict[str, Any]],
    video_width: int,
    video_height: int,
) -> list[dict[str, Any]]:
    if matrix_row is None or matrix is None:
        return []
    rows: list[dict[str, Any]] = []
    for box in boxes:
        roi, matrix_box = matrix_roi(matrix, box, video_width, video_height)
        rows.append(box_temp_row(matrix_row, box, roi, matrix_box, video_width, video_height))
    return rows


def classify_alert_risk_legacy(
    global_max_c: float | None,
    global_avg_c: float | None,
    box_rows: list[dict[str, Any]],
    boxes: list[dict[str, Any]],
    critical_c: float,
) -> dict[str, Any]:
    max_box_c = max((as_float(row.get("box_max_c")) or -999.0 for row in box_rows), default=None)
    avg_box_c = max((as_float(row.get("box_avg_c")) or -999.0 for row in box_rows), default=None)
    fire_labels = FIRE_SMOKE_LABELS
    heat_sensitive_labels = {
        "person", "car", "truck", "bus", "motorcycle", "bicycle", "boat", "airplane",
        "vehicle", "traffic light", "bench", "potted plant", "tree", "building",
        "green_grass", "dry_grass", "plastic_waste", "tent_tarp",
    }
    labels = {str(box.get("class_name", "")).strip().lower() for box in boxes}
    hottest = max([value for value in [global_max_c, max_box_c] if value is not None], default=None)
    reasons: list[str] = []
    risk_type = "none"
    severity = "info"
    remote_alert_required = False

    if labels & fire_labels:
        remote_alert_required = True
        risk_type = "fire_risk"
        severity = "critical"
        if hottest is None:
            reasons.append(f"Fire or smoke detected ({', '.join(sorted(labels & fire_labels))}); no fresh temperature is available")
        else:
            reasons.append(f"Fire or smoke detected ({', '.join(sorted(labels & fire_labels))}) at {hottest:.1f} C")
    elif hottest is None:
        risk_type = "unknown"
        severity = "warning"
        reasons.append("Temperature data is insufficient to confirm risk")
    elif hottest >= critical_c:
        remote_alert_required = True
        if labels & fire_labels:
            risk_type = "fire_risk"
            severity = "critical"
            reasons.append(f"Fire or smoke detected at {hottest:.1f} C")
        elif labels & heat_sensitive_labels:
            risk_type = "potential_fire_risk"
            severity = "critical"
            reasons.append(f"A heat-sensitive object reached {hottest:.1f} C and requires review")
        else:
            risk_type = "unknown_high_temperature"
            severity = "critical"
            reasons.append(f"Temperature reached {hottest:.1f} C without a confirmed fire object")
    elif labels & fire_labels and hottest >= 55.0:
        remote_alert_required = True
        risk_type = "potential_fire_risk"
        severity = "critical"
        reasons.append(f"Fire or smoke detected at {hottest:.1f} C and requires review")
    elif hottest >= 55.0:
        risk_type = "elevated_temperature"
        severity = "warning"
        reasons.append(f"Temperature {hottest:.1f} C is below {critical_c:.1f} C; screen warning only")
    else:
        reasons.append(f"Temperature {hottest:.1f} C is below the trigger threshold")

    return {
        "risk_type": risk_type,
        "severity": severity,
        "remote_alert_required": remote_alert_required,
        "ntfy_required": remote_alert_required,
        "email_required": remote_alert_required,
        "global_max_c": global_max_c,
        "global_avg_c": global_avg_c,
        "max_box_c": max_box_c,
        "max_box_avg_c": avg_box_c,
        "labels": sorted(label for label in labels if label),
        "reasons": reasons,
    }


def classify_alert_risk(
    global_max_c: float | None,
    global_avg_c: float | None,
    box_rows: list[dict[str, Any]],
    boxes: list[dict[str, Any]],
    critical_c: float,
    combustible_c: float = 60.0,
    person_c: float = 75.0,
    unknown_high_c: float | None = None,
    unknown_extreme_c: float | None = None,
    vehicle_extreme_c: float | None = None,
) -> dict[str, Any]:
    max_box_c = max((as_float(row.get("box_max_c")) or -999.0 for row in box_rows), default=None)
    avg_box_c = max((as_float(row.get("box_avg_c")) or -999.0 for row in box_rows), default=None)
    fire_labels = FIRE_SMOKE_LABELS
    person_labels = {"person"}
    vehicle_labels = {
        "vehicle", "car", "truck", "bus", "motorcycle", "motorbike", "bicycle", "train", "boat", "airplane", "aeroplane",
    }
    combustible_labels = {
        "grass", "dry grass", "hay", "straw", "paper", "cardboard", "carton", "book",
        "wood", "timber", "tree", "plant", "potted plant", "bush", "vegetation", "fabric",
        "cloth", "curtain", "sofa", "couch", "mattress", "plastic", "trash", "garbage",
        "green_grass", "dry_grass", "plastic_waste", "tent_tarp",
    }
    labels = {str(box.get("class_name", "")).strip().lower() for box in boxes}
    fire_hits = labels & fire_labels
    combustible_hits = labels & combustible_labels
    person_hits = labels & person_labels
    vehicle_hits = labels & vehicle_labels
    contextual_hits = fire_hits | combustible_hits | person_hits | vehicle_hits
    hottest = max([value for value in (global_max_c, max_box_c) if value is not None], default=None)
    reasons: list[str] = []
    risk_type = "none"
    severity = "info"
    remote_alert_required = False
    high_c = unknown_high_c if unknown_high_c is not None else max(90.0, critical_c + 10.0)
    extreme_c = unknown_extreme_c if unknown_extreme_c is not None else max(110.0, critical_c + 30.0)
    vehicle_extreme = vehicle_extreme_c if vehicle_extreme_c is not None else extreme_c

    if fire_hits:
        remote_alert_required = True
        severity = "critical"
        risk_type = "fire_risk"
        if hottest is None:
            reasons.append(f"Fire or smoke detected ({', '.join(sorted(fire_hits))}); no fresh temperature is available")
        else:
            reasons.append(f"Fire or smoke detected ({', '.join(sorted(fire_hits))}) at {hottest:.1f} C")
    elif hottest is None:
        risk_type = "unknown"
        severity = "warning"
        reasons.append("No fresh global temperature is available; risk cannot be confirmed")
    elif combustible_hits and hottest >= combustible_c:
        remote_alert_required = True
        risk_type = "potential_fire_risk"
        severity = "critical"
        reasons.append(f"Combustible material detected ({', '.join(sorted(combustible_hits))}) at {hottest:.1f} C")
    elif person_hits and hottest >= person_c:
        remote_alert_required = True
        risk_type = "person_near_high_temperature"
        severity = "critical" if hottest >= critical_c else "warning"
        reasons.append(f"Person detected near high temperature {hottest:.1f} C")
    elif vehicle_hits and not (fire_hits or combustible_hits):
        if hottest >= vehicle_extreme:
            remote_alert_required = True
            risk_type = "extreme_vehicle_temperature"
            severity = "critical"
            reasons.append(f"Vehicle temperature reached {hottest:.1f} C, above the extreme threshold {vehicle_extreme:.1f} C")
        elif hottest >= critical_c:
            risk_type = "sun_heated_vehicle"
            severity = "warning"
            reasons.append(f"Vehicle detected at {hottest:.1f} C; daytime solar heating is likely, phone alert suppressed")
        elif hottest >= 55.0:
            risk_type = "warm_vehicle"
            severity = "info"
            reasons.append(f"Vehicle temperature {hottest:.1f} C is elevated but below the critical threshold")
        else:
            reasons.append(f"Vehicle temperature {hottest:.1f} C is below the alert threshold")
    elif hottest >= extreme_c:
        remote_alert_required = True
        risk_type = "extreme_unclassified_temperature"
        severity = "critical"
        reasons.append(f"Unclassified temperature reached {hottest:.1f} C, above the extreme threshold {extreme_c:.1f} C")
    elif hottest >= high_c:
        risk_type = "unclassified_high_temperature"
        severity = "warning"
        reasons.append(f"Unclassified high temperature {hottest:.1f} C; phone alert suppressed without fire, combustible, or person detection")
    elif hottest >= 55.0:
        risk_type = "elevated_temperature_no_combustible"
        severity = "warning"
        reasons.append(f"Elevated temperature {hottest:.1f} C; no high-risk object detected")
    else:
        reasons.append(f"Temperature {hottest:.1f} C is below the alert threshold")

    return {
        "alert_policy": "contextual_v2",
        "risk_type": risk_type,
        "severity": severity,
        "remote_alert_required": remote_alert_required,
        "ntfy_required": remote_alert_required,
        "email_required": remote_alert_required,
        "global_max_c": global_max_c,
        "global_avg_c": global_avg_c,
        "max_box_c": max_box_c,
        "max_box_avg_c": avg_box_c,
        "labels": sorted(label for label in labels if label),
        "context_labels": sorted(label for label in contextual_hits if label),
        "reasons": reasons,
    }


def send_alert_email(alert: dict[str, Any], image_paths: list[Path]) -> tuple[bool, str]:
    host = os.environ.get("H30T_SMTP_HOST", "").strip()
    user = os.environ.get("H30T_SMTP_USER", "").strip()
    password = os.environ.get("H30T_SMTP_PASSWORD", "").strip()
    if not host or not user or not password:
        return False, "SMTP not configured: set H30T_SMTP_HOST, H30T_SMTP_USER, H30T_SMTP_PASSWORD"
    port = int(os.environ.get("H30T_SMTP_PORT", "587"))
    to_addr = os.environ.get("H30T_ALERT_EMAIL_TO", "928536001@qq.com").strip()
    from_addr = os.environ.get("H30T_SMTP_FROM", user).strip()
    message = EmailMessage()
    message["Subject"] = f"H30T risk alert {alert.get('risk_type')} max {alert.get('global_max_c')}"
    message["From"] = from_addr
    message["To"] = to_addr
    lines = [
        f"Event: {alert.get('event_id')}",
        f"Risk: {alert.get('risk_type')} / {alert.get('severity')}",
        f"Global max/avg: {alert.get('global_max_c')} / {alert.get('global_avg_c')} C",
        f"Max box temp/avg: {alert.get('max_box_c')} / {alert.get('max_box_avg_c')} C",
        "Reasons:",
    ]
    lines.extend(f"- {reason}" for reason in alert.get("reasons", []))
    lines.append("Detections:")
    for item in alert.get("detections", []):
        lines.append(
            f"- {item.get('class_name')} conf={item.get('conf')} "
            f"box_max={item.get('box_max_c')} box_avg={item.get('box_avg_c')}"
        )
    message.set_content("\n".join(lines))
    for path in image_paths:
        if not path.exists():
            continue
        data = path.read_bytes()
        message.add_attachment(data, maintype="image", subtype="jpeg", filename=path.name)
    try:
        use_ssl = os.environ.get("H30T_SMTP_SSL", "").strip().lower() in {"1", "true", "yes"}
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, timeout=20) as smtp:
                smtp.login(user, password)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(host, port, timeout=20) as smtp:
                smtp.starttls()
                smtp.login(user, password)
                smtp.send_message(message)
        return True, f"email sent to {to_addr}"
    except Exception as exc:
        return False, f"email failed: {exc}"


def ntfy_enabled() -> bool:
    return os.environ.get("H30T_ENABLE_NTFY", "true").strip().lower() not in {"0", "false", "no", "off"}


def smtp_backup_enabled() -> bool:
    return os.environ.get("H30T_ENABLE_SMTP", "false").strip().lower() in {"1", "true", "yes", "on"}


def alert_event_time(alert: dict[str, Any]) -> str:
    created_ms = as_int_ms(alert.get("created_ms")) or now_ms()
    local_time = time.localtime(created_ms / 1000.0)
    timezone = time.strftime("%Z", local_time)
    return time.strftime("%Y-%m-%d %H:%M:%S", local_time) + (f" {timezone}" if timezone else "")


def append_alert_history(output_dir: Path, alert: dict[str, Any]) -> None:
    history_path = ensure_dir(output_dir / "alerts") / "alert_history.jsonl"
    with history_path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(alert, ensure_ascii=False, separators=(",", ":")) + "\n")


def build_remote_alert_text(alert: dict[str, Any]) -> str:
    labels = alert.get("labels") or []
    if not labels:
        labels = sorted({str(item.get("class_name", "")).strip() for item in alert.get("detections", []) if item.get("class_name")})
    classes = ", ".join(labels) if labels else "none"
    detection_details = []
    for item in alert.get("detections", [])[:8]:
        detection_details.append(f"{item.get('class_name') or 'unknown'} {float(item.get('conf') or 0.0):.2f}")
    detections = ", ".join(detection_details) if detection_details else "none"
    return "\n".join(
        [
            "H30T remote alert",
            f"risk_type: {alert.get('risk_type')}",
            f"global_max_temp: {alert.get('global_max_c')} C",
            f"global_avg_temp: {alert.get('global_avg_c')} C",
            f"detected_classes: {classes}",
            f"detections: {detections}",
            f"detection_count: {alert.get('detection_count', 0)}",
            f"event_time: {alert_event_time(alert)}",
            f"viewer_url: {os.environ.get('H30T_VIEWER_URL', 'http://127.0.0.1:8765/')}",
        ]
    )


def send_alert_ntfy(alert: dict[str, Any]) -> tuple[bool, str]:
    if not ntfy_enabled():
        return False, "disabled by H30T_ENABLE_NTFY"
    server = os.environ.get("H30T_NTFY_SERVER", "https://ntfy.sh").strip().rstrip("/")
    topic = os.environ.get("H30T_NTFY_TOPIC", "h30t_kangnan_alert_6729938201").strip().strip("/")
    if not server or not topic:
        return False, "ntfy not configured: set H30T_NTFY_SERVER and H30T_NTFY_TOPIC"
    url = f"{server}/{topic}"
    message = build_remote_alert_text(alert)
    video_path_value = str(alert.get("video_clip") or "").strip()
    video_path = Path(video_path_value) if video_path_value else None
    detection_path_value = str(alert.get("detection_image") or "").strip()
    detection_path = Path(detection_path_value) if detection_path_value else None
    has_video_attachment = video_path is not None and video_path.is_file()
    has_image_attachment = detection_path is not None and detection_path.is_file()
    attachment_path = video_path if has_video_attachment else detection_path
    has_attachment = attachment_path is not None and attachment_path.is_file()
    body = attachment_path.read_bytes() if has_attachment and attachment_path is not None else message.encode("utf-8")
    headers = {
        "X-Title": f"H30T {alert.get('risk_type', 'alert')} {alert.get('global_max_c')} C",
        "X-Priority": "urgent" if alert.get("severity") == "critical" else "high",
        "X-Tags": "warning,fire",
        "Content-Type": "video/mp4" if has_video_attachment else ("image/jpeg" if has_image_attachment else "text/plain; charset=utf-8"),
    }
    if has_attachment and attachment_path is not None:
        headers["X-Filename"] = attachment_path.name
        headers["X-Message"] = message.replace("\n", " | ")
    token = os.environ.get("H30T_NTFY_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    errors: list[str] = []
    for attempt in range(1, 4):
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                response.read()
                attachment = f", attachment={attachment_path.name}" if has_attachment and attachment_path is not None else ""
                return True, f"sent to {url} ({response.status}, attempt={attempt}{attachment})"
        except urllib.error.HTTPError as exc:
            errors.append(f"attempt {attempt}: HTTP {exc.code} {exc.reason}")
        except Exception as exc:
            errors.append(f"attempt {attempt}: {exc}")
        if attempt < 3:
            time.sleep(float(attempt))
    return False, "ntfy failed after 3 attempts: " + "; ".join(errors)


def draw_hotspot(
    frame: np.ndarray,
    matrix_row: dict[str, Any] | None,
    global_row: dict[str, Any] | None,
    msdk_offset: tuple[float, float] = (0.0, 0.0),
) -> None:
    use_msdk = global_row is not None
    source = "MSDK" if use_msdk else "APP3"
    row = global_row if use_msdk else matrix_row
    if not row:
        return
    msdk_point = msdk_point_to_matrix(row, "max") if use_msdk else None
    x = float(msdk_point[0]) if msdk_point else as_float(row.get("matrix_max_x"))
    y = float(msdk_point[1]) if msdk_point else as_float(row.get("matrix_max_y"))
    value = as_float(row.get("max_c") if use_msdk else row.get("matrix_max_c"))
    if x is None or y is None or value is None:
        return
    if use_msdk:
        x += msdk_offset[0]
        y += msdk_offset[1]
    px = int(round(np.clip(x / max(1, MATRIX_WIDTH - 1), 0.0, 1.0) * (frame.shape[1] - 1)))
    py = int(round(np.clip(y / max(1, MATRIX_HEIGHT - 1), 0.0, 1.0) * (frame.shape[0] - 1)))
    cv2.circle(frame, (px, py), 10, (0, 0, 255), 2, cv2.LINE_AA)
    cv2.line(frame, (px - 15, py), (px + 15, py), (255, 255, 255), 1, cv2.LINE_AA)
    cv2.line(frame, (px, py - 15), (px, py + 15), (255, 255, 255), 1, cv2.LINE_AA)
    draw_text(frame, f"{source} MAX {value:.1f} C ({int(x)},{int(y)})", min(px + 14, frame.shape[1] - 220), max(22, py - 12), (80, 180, 255))


def run_deimv2_loop(
    state: LiveState,
    requests: queue.Queue[InferenceRequest],
    stop_event: threading.Event,
    config: str,
    weight: str,
    threshold: float,
    require_cuda: bool,
    lazy_load: bool = False,
    ir_config: str | None = None,
    ir_weight: str | None = None,
    rgb_config: str | None = None,
    rgb_weight: str | None = None,
) -> None:
    detectors: dict[str, Any] = {}
    configs = {
        "ir": ir_config or config,
        "rgb": rgb_config or config,
    }
    weights = {
        "ir": ir_weight or weight,
        "rgb": rgb_weight or weight,
    }

    def ensure_detector(stream: str) -> Any | None:
        stream = "ir" if stream == "ir" else "rgb"
        if stream in detectors:
            return detectors[stream]
        try:
            from deimv2_runtime import DEIMv2Detector
            with state.lock:
                if stream == "ir":
                    state.ir_detector_status = "DEIMv2 IR loading"
                else:
                    state.rgb_detector_status = "DEIMv2 RGB loading"
                state.detector_status = f"DEIMv2 {stream.upper()} loading"
            detector = DEIMv2Detector(
                Path(__file__).resolve().parents[1],
                configs[stream],
                weights[stream],
                threshold,
                require_cuda=require_cuda,
                use_fp16=True,
                class_names=DJI_DETECTION_CLASSES,
            )
            detectors[stream] = detector
            with state.lock:
                status = f"DEIMv2 {stream.upper()} ready ({detector.device.type})"
                if stream == "ir":
                    state.ir_detector_status = status
                else:
                    state.rgb_detector_status = status
                state.detector_status = status
                state.detector_device = str(detector.device)
            print(f"[deimv2-{stream}] ready device={detector.device} fp16={detector.use_fp16} threshold={threshold} weight={weights[stream]}", flush=True)
            return detector
        except Exception as exc:
            with state.lock:
                status = f"{stream} load failed: {exc}"
                if stream == "ir":
                    state.ir_detector_status = status
                else:
                    state.rgb_detector_status = status
                state.detector_status = status
                state.inference_inflight = False
                state.inference_inflight_by_stream[stream] = False
            print(f"[deimv2-{stream}] load failed: {exc}", flush=True)
            return None

    if lazy_load:
        with state.lock:
            state.detector_status = "DEIMv2 lazy; waiting for inference request"
            state.ir_detector_status = "DEIMv2 IR lazy"
            state.rgb_detector_status = "DEIMv2 RGB lazy"
            state.detector_device = "lazy"
        print("[deimv2] lazy load enabled; model will load on first inference request", flush=True)
    else:
        initial_mode = state.requested_inference_stream_mode
        initial_streams = ["ir", "rgb"] if initial_mode == "both" else [initial_mode]
        for stream in initial_streams:
            if ensure_detector(stream) is None:
                return

    while not stop_event.is_set():
        try:
            request = requests.get(timeout=0.2)
        except queue.Empty:
            continue
        stream = "ir" if request.stream == "ir" else "rgb"
        detector = ensure_detector(stream)
        if detector is None:
            continue
        try:
            boxes, latency_ms = detector.infer(request.frame, request.frame_time_ms)
        except Exception as exc:
            with state.lock:
                state.inference_inflight = False
                state.inference_inflight_by_stream[stream] = False
                status = f"{stream} inference failed: {exc}"
                if stream == "ir":
                    state.ir_detector_status = status
                else:
                    state.rgb_detector_status = status
                state.detector_status = status
            print(f"[deimv2-{stream}] inference failed: {exc}", flush=True)
            continue
        if request.crop_offset_xy != (0, 0):
            offset_x, offset_y = request.crop_offset_xy
            full_width, full_height = request.full_frame_size or (request.frame.shape[1], request.frame.shape[0])
            mapped_boxes: list[dict[str, Any]] = []
            for box in boxes:
                mapped = dict(box)
                mapped["x1"] = max(0, min(full_width - 1, int(box["x1"]) + offset_x))
                mapped["y1"] = max(0, min(full_height - 1, int(box["y1"]) + offset_y))
                mapped["x2"] = max(1, min(full_width, int(box["x2"]) + offset_x))
                mapped["y2"] = max(1, min(full_height, int(box["y2"]) + offset_y))
                mapped["crop_x1"] = offset_x
                mapped["crop_y1"] = offset_y
                mapped["hot_max_c"] = request.hot_max_c
                mapped_boxes.append(mapped)
            boxes = mapped_boxes
        mode = "hot-crop" if request.crop_offset_xy != (0, 0) else "full-frame"
        with state.lock:
            for box in boxes:
                box["stream"] = stream
            if stream == "ir":
                state.ir_detection_history.append((request.frame_time_ms, [dict(box) for box in boxes]))
                state.latest_ir_detection_boxes = [dict(box) for box in boxes]
                state.latest_ir_detection_frame_time_ms = request.frame_time_ms
                state.ir_detector_latency_ms = latency_ms
                state.ir_detector_fps = 1000.0 / max(1.0, latency_ms)
                state.ir_detector_count += 1
            else:
                state.rgb_detection_history.append((request.frame_time_ms, [dict(box) for box in boxes]))
                state.latest_rgb_detection_boxes = [dict(box) for box in boxes]
                state.latest_rgb_detection_frame_time_ms = request.frame_time_ms
                state.rgb_detector_latency_ms = latency_ms
                state.rgb_detector_fps = 1000.0 / max(1.0, latency_ms)
                state.rgb_detector_count += 1
            merged_boxes = nms_detections(state.latest_ir_detection_boxes + state.latest_rgb_detection_boxes)
            state.detection_history.append((request.frame_time_ms, [dict(box) for box in merged_boxes]))
            state.latest_detection_boxes = [dict(box) for box in merged_boxes]
            state.latest_detection_frame_time_ms = request.frame_time_ms
            state.latest_boxes = merged_boxes
            state.last_detection_time_ms = request.frame_time_ms
            state.inference_inflight = False
            state.inference_inflight_by_stream[stream] = False
            state.detector_count += 1
            state.detector_latency_ms = latency_ms
            state.detector_fps = state.ir_detector_fps + state.rgb_detector_fps if state.requested_inference_stream_mode == "both" else 1000.0 / max(1.0, latency_ms)
            state.detector_mode = mode
            suffix = f", hot max {request.hot_max_c:.1f} C" if request.hot_max_c is not None else ""
            stream_status = f"DEIMv2 {stream.upper()} {mode} {1000.0 / max(1.0, latency_ms):.1f} fps, {latency_ms:.0f} ms, {len(boxes)} objects{suffix}"
            if stream == "ir":
                state.ir_detector_status = stream_status
            else:
                state.rgb_detector_status = stream_status
            state.detector_status = f"{state.requested_inference_stream_mode.upper()} | IR: {state.ir_detector_status} | RGB: {state.rgb_detector_status}"


def submit_latest_inference(state: LiveState, requests: queue.Queue[InferenceRequest], request: InferenceRequest) -> bool:
    with state.lock:
        stream = "ir" if request.stream == "ir" else "rgb"
        if state.inference_inflight_by_stream.get(stream, False):
            return False
        last_submit_ms = int(state.last_detection_submit_by_stream.get(stream, 0))
        if last_submit_ms and request.frame_time_ms - last_submit_ms < state.min_inference_interval_ms:
            return False
        state.inference_inflight = True
        state.inference_inflight_by_stream[stream] = True
        state.last_detection_submit_ms = request.frame_time_ms
        state.last_detection_submit_by_stream[stream] = request.frame_time_ms
    try:
        requests.put_nowait(request)
        return True
    except queue.Full:
        pass
    try:
        old_request = requests.get_nowait()
        old_stream = "ir" if old_request.stream == "ir" else "rgb"
        with state.lock:
            state.inference_inflight_by_stream[old_stream] = False
    except queue.Empty:
        pass
    try:
        requests.put_nowait(request)
        return True
    except queue.Full:
        with state.lock:
            state.inference_inflight = False
            state.inference_inflight_by_stream[stream] = False
        return False


def can_submit_inference(state: LiveState, frame_time_ms: int, stream: str = "rgb") -> bool:
    with state.lock:
        stream = "ir" if stream == "ir" else "rgb"
        if state.inference_inflight_by_stream.get(stream, False):
            return False
        last_submit_ms = int(state.last_detection_submit_by_stream.get(stream, 0))
        if last_submit_ms and frame_time_ms - last_submit_ms < state.min_inference_interval_ms:
            return False
        return True


def latest_detection_for_overlay(state: LiveState, frame_time_ms: int, max_age_ms: int, stream: str | None = None) -> list[dict[str, Any]]:
    with state.lock:
        if stream == "ir":
            latest_time = state.latest_ir_detection_frame_time_ms
            latest_boxes = [dict(box) for box in state.latest_ir_detection_boxes]
            history = list(state.ir_detection_history)
        elif stream == "rgb":
            latest_time = state.latest_rgb_detection_frame_time_ms
            latest_boxes = [dict(box) for box in state.latest_rgb_detection_boxes]
            history = list(state.rgb_detection_history)
        else:
            latest_time = state.latest_detection_frame_time_ms
            latest_boxes = [dict(box) for box in state.latest_detection_boxes]
            history = list(state.detection_history)
    if latest_time and 0 <= frame_time_ms - latest_time <= max_age_ms:
        return latest_boxes
    if not history:
        return []
    detection_time, boxes = min(history, key=lambda item: abs(item[0] - frame_time_ms))
    if abs(detection_time - frame_time_ms) <= max_age_ms:
        return [dict(box) for box in boxes]
    return []


def make_waiting_frame(width: int = 1280, height: int = 720) -> np.ndarray:
    try:
        safe_width = min(max(320, int(width)), 640)
        safe_height = min(max(180, int(height)), 360)
        frame = np.zeros((safe_height, safe_width, 3), dtype=np.uint8)
        frame[:, :] = (32, 32, 32)
        draw_text(frame, "Waiting for video frames...", 24, safe_height // 2, (0, 255, 255))
        return frame
    except (MemoryError, SystemError):
        return np.empty((1, 1, 3), dtype=np.uint8)


def publish_buffered_pair(
    state: LiveState,
    arrival_ms: int,
    pair_jpeg: bytes,
    ir_thumbnail: np.ndarray | None,
) -> None:
    record = BufferedCompositeFrame(arrival_ms, pair_jpeg, ir_thumbnail)
    with state.lock:
        state.video_buffer.append(record)


def select_strict_global_for_frame(state: LiveState, frame_time_ms: int) -> dict[str, Any] | None:
    with state.lock:
        if not state.global_history:
            state.displayed_global_row = None
            state.sync_global_delta_ms = None
            return None
        # Pilot 2 OSD/logcat and RTMP have independent transport latency. Shift
        # temperature arrival time onto the video timeline before matching.
        row = min(
            state.global_history,
            key=lambda item: abs(float(item.get("pc_receive_time_ms") or 0) + state.temperature_video_offset_ms - frame_time_ms),
        )
        delta_ms = int(round(float(row.get("pc_receive_time_ms") or 0) + state.temperature_video_offset_ms - frame_time_ms))
        state.sync_global_delta_ms = delta_ms
        source = str(row.get("source") or "")
        transport_mode = str(row.get("transport_mode") or "")
        is_pilot2_osd = source.startswith("PILOT2_") or transport_mode.startswith("adb_logcat")
        max_delta_ms = state.max_temp_frame_delta_ms
        if abs(delta_ms) > max_delta_ms:
            if state.displayed_global_row is not None:
                held_age_ms = frame_time_ms - int(state.displayed_global_row.get("pc_receive_time_ms") or 0)
                hold_ms = 3000 if is_pilot2_osd else state.stable_temp_hold_ms
                if 0 <= held_age_ms <= hold_ms:
                    return dict(state.displayed_global_row)
            state.displayed_global_row = None
            return None
        selected = dict(row)
        state.displayed_global_row = selected
        return selected


def run_synchronized_playback_loop(state: LiveState, stop_event: threading.Event, output_fps: float = 30.0) -> None:
    period = 1.0 / output_fps
    next_tick = time.perf_counter()
    while not stop_event.is_set():
        selected = None
        matrix_row = None
        displayed_global = None
        boxes: list[dict[str, Any]] = []
        detector_status = "disabled"
        msdk_offset = (0.0, 0.0)
        with state.lock:
            if state.video_buffer:
                delay_ms = 0
                state.effective_playback_delay_ms = delay_ms
                target_ms = now_ms() - delay_ms if delay_ms > 0 else state.video_buffer[-1].arrival_ms
                eligible = [item for item in state.video_buffer if item.arrival_ms <= target_ms]
                selected = eligible[-1] if eligible else state.video_buffer[0]
                latest_matrix_age_ms = (
                    now_ms() - int(state.latest_matrix_row.get("pc_receive_time_ms") or now_ms())
                    if state.latest_matrix_row
                    else None
                )
                matrix_is_fresh = latest_matrix_age_ms is not None and latest_matrix_age_ms <= state.max_matrix_display_age_ms
                if matrix_is_fresh and state.matrix_matches:
                    match = min(state.matrix_matches, key=lambda item: abs(item.video_arrival_ms - selected.arrival_ms))
                    match_delta_ms = selected.arrival_ms - match.video_arrival_ms
                    if abs(match_delta_ms) <= 1500:
                        matrix_row = dict(match.row)
                        state.sync_video_temp_delta_ms = match_delta_ms
                        state.sync_visual_correlation = match.correlation
                    else:
                        # The selected video frame is intentionally the latest live
                        # frame. If the best visual matrix match belongs to an older
                        # frame, display the freshest matrix instead of making the
                        # temperature overlay look seconds behind the video.
                        matrix_row = dict(state.latest_matrix_row)
                        latest_match = state.matrix_matches[-1]
                        state.sync_video_temp_delta_ms = selected.arrival_ms - latest_match.video_arrival_ms
                        state.sync_visual_correlation = latest_match.correlation
                    state.displayed_matrix_row = matrix_row
                elif matrix_is_fresh and state.latest_matrix_row:
                    matrix_row = dict(state.latest_matrix_row)
                    state.displayed_matrix_row = matrix_row
                else:
                    state.displayed_matrix_row = None
                    state.sync_video_temp_delta_ms = None
                if state.detection_history:
                    detection_time, candidate_boxes = min(
                        state.detection_history,
                        key=lambda item: abs(item[0] - selected.arrival_ms),
                    )
                    if abs(detection_time - selected.arrival_ms) <= state.max_detection_age_ms:
                        boxes = [dict(box) for box in candidate_boxes]
                detector_status = state.detector_status
                msdk_offset = (state.msdk_hotspot_offset_x, state.msdk_hotspot_offset_y)
        if selected is not None:
            displayed_global = select_strict_global_for_frame(state, selected.arrival_ms)
        if selected is not None:
            pair = cv2.imdecode(np.frombuffer(selected.pair_jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
            if pair is not None and pair.shape[1] >= 2:
                split_x = pair.shape[1] // 2
                ir = np.ascontiguousarray(pair[:, :split_x])
                rgb = np.ascontiguousarray(pair[:, split_x:])
                temp_rows = update_box_temperatures(state, boxes, ir.shape[1], ir.shape[0], matrix_row)
                draw_hotspot(ir, matrix_row, displayed_global, msdk_offset)
                draw_text(ir, "H30T IR", 12, 26, (0, 255, 255))
                draw_boxes(ir, boxes, temp_rows)
                draw_text(rgb, "H30T RGB", 12, 26, (0, 255, 255))
                draw_boxes(rgb, boxes, temp_rows)
                draw_text(rgb, detector_status, 12, rgb.shape[0] - 14, (180, 255, 180))
                pair = hstack_frames(ir, rgb)
                output_jpeg = encode_jpeg(pair, 76) if pair is not None else None
                output_jpeg = output_jpeg if output_jpeg is not None else selected.pair_jpeg
            else:
                output_jpeg = selected.pair_jpeg
            with state.lock:
                state.latest_pair_jpeg = output_jpeg
                state.pair_sequence += 1
                state.pair_publish_times_ms.append(now_ms())
        next_tick += period
        sleep_seconds = next_tick - time.perf_counter()
        if sleep_seconds > 0:
            stop_event.wait(sleep_seconds)
        else:
            next_tick = time.perf_counter()


def capture_rgb_loop(state: LiveState, source: str, stop_event: threading.Event) -> None:
    if not source:
        with state.lock:
            state.rgb_status = "disabled"
        return
    parsed_source = parse_video_source(source)
    cap = open_video_capture(parsed_source, state, "rgb")
    print(f"[rgb] source={mask_stream_url(source)} status={state.rgb_status}", flush=True)
    reconnect_backoff_s = 0.2
    while not stop_event.is_set():
        ok, frame, error = read_capture_frame(cap, state, "rgb")
        if not ok or frame is None:
            release_capture(cap)
            cap = None
            if error in ("MemoryError", "SystemError"):
                gc.collect()
            stop_event.wait(reconnect_backoff_s)
            cap = open_video_capture(parsed_source, state, "rgb")
            reconnect_backoff_s = min(3.0, reconnect_backoff_s * 1.5) if not cap.isOpened() else 0.2
            continue
        reconnect_backoff_s = 0.2
        draw_text(frame, "H30T RGB", 12, 28, (0, 255, 255))
        jpeg_bytes = encode_jpeg(frame, 82)
        if jpeg_bytes is not None:
            ts = now_ms()
            with state.lock:
                state.latest_rgb_jpeg = jpeg_bytes
                state.latest_rgb_frame = frame.copy()
                state.latest_frame_time_ms = ts
                state.rgb_frame_count += 1
                state.rgb_status = "open"
                state.rgb_frame_time_ms = ts
        stop_event.wait(0.005)
    release_capture(cap)


def collect_alert_samples(
    state: LiveState,
    sample_count: int,
    sample_interval_ms: int,
    max_wait_s: float,
    stop_event: threading.Event,
) -> tuple[list[tuple[int, np.ndarray, np.ndarray | None]], list[tuple[dict[str, Any], np.ndarray]]]:
    frames: list[tuple[int, np.ndarray, np.ndarray | None]] = []
    matrices_by_seq: dict[str, tuple[dict[str, Any], np.ndarray]] = {}
    deadline = time.time() + max(0.2, max_wait_s)
    last_frame_time = 0
    while not stop_event.is_set() and time.time() <= deadline:
        with state.lock:
            frame_time = state.latest_frame_time_ms
            rgb = None if state.latest_rgb_frame is None else state.latest_rgb_frame.copy()
            ir = None if state.latest_ir_frame is None else state.latest_ir_frame.copy()
            for row, values in state.matrix_history:
                seq = str(row.get("seq") or row.get("pc_receive_time_ms") or len(matrices_by_seq))
                if seq not in matrices_by_seq:
                    matrices_by_seq[seq] = (dict(row), values.copy())
            if state.latest_matrix_row is not None and state.latest_matrix_values is not None:
                seq = str(state.latest_matrix_row.get("seq") or state.latest_matrix_row.get("pc_receive_time_ms") or "latest")
                matrices_by_seq.setdefault(seq, (dict(state.latest_matrix_row), state.latest_matrix_values.copy()))
        if rgb is not None and frame_time and frame_time != last_frame_time and len(frames) < sample_count:
            frames.append((frame_time, rgb, ir))
            last_frame_time = frame_time
        if len(frames) >= sample_count:
            break
        time.sleep(max(0.02, sample_interval_ms / 1000.0))
    return frames[:sample_count], list(matrices_by_seq.values())[-sample_count:]


def latest_matrix_seq(state: LiveState) -> str | None:
    with state.lock:
        if state.latest_matrix_row is None:
            return None
        return str(state.latest_matrix_row.get("seq") or state.latest_matrix_row.get("pc_receive_time_ms") or "")


def wait_for_new_matrix(
    state: LiveState,
    previous_seq: str | None,
    timeout_s: float,
    stop_event: threading.Event,
) -> list[tuple[dict[str, Any], np.ndarray]]:
    deadline = time.time() + max(0.5, timeout_s)
    while not stop_event.is_set() and time.time() <= deadline:
        with state.lock:
            if state.latest_matrix_row is not None and state.latest_matrix_values is not None:
                seq = str(state.latest_matrix_row.get("seq") or state.latest_matrix_row.get("pc_receive_time_ms") or "")
                if previous_seq is None or seq != previous_seq:
                    return [(dict(state.latest_matrix_row), state.latest_matrix_values.copy())]
        time.sleep(0.1)
    with state.lock:
        if state.latest_matrix_row is not None and state.latest_matrix_values is not None:
            return [(dict(state.latest_matrix_row), state.latest_matrix_values.copy())]
    return []


def default_adb_path() -> str:
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidate = Path(local_app_data) / "Android" / "Sdk" / "platform-tools" / "adb.exe"
    return str(candidate) if candidate.exists() else "adb"


def trigger_matrix_burst(
    adb_path: str,
    adb_serial: str,
    pc_ip: str,
    http_port: int,
    rtmp_url: str,
    interval_ms: int,
    burst_count: int,
    force_stop: bool,
) -> tuple[bool, str]:
    adb_exe = adb_path or default_adb_path()
    base_command = [adb_exe]
    if adb_serial:
        base_command.extend(["-s", adb_serial])
    if force_stop:
        stop_command = [*base_command, "shell", "am", "force-stop", "ca.ubc.kangnan.h30ttemp"]
        try:
            stop_result = subprocess.run(stop_command, capture_output=True, text=True, timeout=8)
            if stop_result.returncode != 0:
                return False, (stop_result.stderr or stop_result.stdout or f"adb force-stop exit {stop_result.returncode}").strip()
        except Exception as exc:
            return False, f"matrix burst force-stop failed: {exc}"
    command = [*base_command]
    command.extend(
        [
            "shell",
            "am",
            "start",
            "-n",
            "ca.ubc.kangnan.h30ttemp/dji.sampleV5.aircraft.AircraftTestingToolsActivity",
            "--es",
            "h30t_pc_ip",
            pc_ip,
            "--ei",
            "h30t_http_port",
            str(http_port),
            "--ez",
            "h30t_pilot2_compat",
            "true",
            "--ez",
            "h30t_pilot2_matrix_upload",
            "true",
            "--el",
            "h30t_matrix_interval_ms",
            str(interval_ms),
            "--el",
            "h30t_matrix_burst_count",
            str(burst_count),
            "--es",
            "h30t_rtmp_url",
            rtmp_url,
        ]
    )
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=12)
        if result.returncode == 0:
            return True, (result.stdout or result.stderr or "matrix burst requested").strip()
        return False, (result.stderr or result.stdout or f"adb exit {result.returncode}").strip()
    except Exception as exc:
        return False, f"matrix burst trigger failed: {exc}"


def build_alert_visuals(
    event_dir: Path,
    frame: np.ndarray,
    boxes: list[dict[str, Any]],
    box_rows: list[dict[str, Any]],
    ir_frame: np.ndarray | None,
) -> tuple[Path | None, Path | None, bytes | None, bytes | None]:
    ensure_dir(event_dir)
    annotated = frame.copy()
    draw_boxes(annotated, boxes, box_rows)
    draw_text(annotated, "H30T ALERT DETECTION FRAME", 12, 28, (0, 0, 255))
    detection_path = event_dir / "detection_frame.jpg"
    detection_jpeg = encode_jpeg(annotated, 88)
    if detection_jpeg is not None:
        detection_path.write_bytes(detection_jpeg)
    else:
        detection_path = None
    ir_path = event_dir / "ir_frame.jpg"
    ir_evidence = ir_frame.copy() if ir_frame is not None else make_waiting_frame(960, 540)
    draw_text(ir_evidence, "H30T ALERT IR FRAME", 12, 28, (0, 255, 255))
    ir_jpeg = encode_jpeg(ir_evidence, 88)
    if ir_jpeg is not None:
        ir_path.write_bytes(ir_jpeg)
    else:
        ir_path = None
    return detection_path, ir_path, detection_jpeg, ir_jpeg


def resize_for_alert_video(frame: np.ndarray, max_width: int = 960) -> np.ndarray:
    height, width = frame.shape[:2]
    if width <= max_width:
        return frame.copy()
    scale = max_width / max(1, width)
    return cv2.resize(frame, (max_width, max(1, int(round(height * scale)))), interpolation=cv2.INTER_AREA)


def append_alert_video_frame(
    state: LiveState,
    frame_time_ms: int,
    frame: np.ndarray,
    boxes: list[dict[str, Any]],
    max_fps: float = 12.0,
) -> None:
    interval_ms = int(round(1000.0 / max(1.0, max_fps)))
    with state.lock:
        if state.last_alert_video_store_ms and frame_time_ms - state.last_alert_video_store_ms < interval_ms:
            return
        state.last_alert_video_store_ms = frame_time_ms
    try:
        stored = resize_for_alert_video(frame)
    except (MemoryError, SystemError, cv2.error) as exc:
        print(f"[alert-video] frame store failed: {type(exc).__name__}: {exc}", flush=True)
        gc.collect()
        return
    source_height, source_width = frame.shape[:2]
    stored_height, stored_width = stored.shape[:2]
    scale_x = stored_width / max(1, source_width)
    scale_y = stored_height / max(1, source_height)
    stored_boxes: list[dict[str, Any]] = []
    for box in boxes:
        scaled = dict(box)
        scaled["x1"] = int(round(float(box.get("x1", 0)) * scale_x))
        scaled["x2"] = int(round(float(box.get("x2", 0)) * scale_x))
        scaled["y1"] = int(round(float(box.get("y1", 0)) * scale_y))
        scaled["y2"] = int(round(float(box.get("y2", 0)) * scale_y))
        stored_boxes.append(scaled)
    with state.lock:
        state.alert_video_frames.append(AlertVideoFrame(frame_time_ms, stored, stored_boxes))


def alert_video_crop_bounds(boxes: list[dict[str, Any]], width: int, height: int, padding_ratio: float = 0.25) -> tuple[int, int, int, int]:
    if not boxes:
        return 0, 0, width, height
    x1 = max(0, min(width - 1, min(int(box.get("x1", 0)) for box in boxes)))
    y1 = max(0, min(height - 1, min(int(box.get("y1", 0)) for box in boxes)))
    x2 = max(1, min(width, max(int(box.get("x2", width)) for box in boxes)))
    y2 = max(1, min(height, max(int(box.get("y2", height)) for box in boxes)))
    pad_x = int(round(max(40, (x2 - x1) * padding_ratio)))
    pad_y = int(round(max(40, (y2 - y1) * padding_ratio)))
    x1 = max(0, x1 - pad_x)
    y1 = max(0, y1 - pad_y)
    x2 = min(width, x2 + pad_x)
    y2 = min(height, y2 + pad_y)
    if x2 - x1 < 64 or y2 - y1 < 64:
        return 0, 0, width, height
    return x1, y1, x2, y2


def build_alert_video_clip(
    state: LiveState,
    event_dir: Path,
    event_time_ms: int,
    duration_s: float = 5.0,
    fps: float = 12.0,
) -> Path | None:
    with state.lock:
        frames = [
            AlertVideoFrame(
                item.frame_time_ms,
                item.frame.copy(),
                [dict(box) for box in item.boxes],
            )
            for item in state.alert_video_frames
        ]
    if not frames:
        return None
    window_ms = int(round(duration_s * 1000.0))
    selected = [
        item
        for item in frames
        if event_time_ms - window_ms <= item.frame_time_ms <= event_time_ms
    ]
    if len(selected) < 2:
        selected = frames[-max(2, min(len(frames), int(round(duration_s * fps)))):]
    if not selected:
        return None
    base_height, base_width = selected[-1].frame.shape[:2]
    x1, y1, x2, y2 = 0, 0, base_width, base_height
    clip_frames: list[np.ndarray] = []
    for item in selected:
        frame = item.frame
        frame_height, frame_width = frame.shape[:2]
        frame_boxes = [dict(box) for box in item.boxes]
        if frame.shape[:2] != (base_height, base_width):
            frame = cv2.resize(frame, (base_width, base_height), interpolation=cv2.INTER_AREA)
            scale_x = base_width / max(1, frame_width)
            scale_y = base_height / max(1, frame_height)
            for box in frame_boxes:
                box["x1"] = int(round(float(box.get("x1", 0)) * scale_x))
                box["x2"] = int(round(float(box.get("x2", 0)) * scale_x))
                box["y1"] = int(round(float(box.get("y1", 0)) * scale_y))
                box["y2"] = int(round(float(box.get("y2", 0)) * scale_y))
        crop = frame[y1:y2, x1:x2].copy()
        if crop.size == 0:
            continue
        local_boxes = []
        for box in frame_boxes:
            mapped = dict(box)
            mapped["x1"] = max(0, min(crop.shape[1] - 1, int(mapped["x1"]) - x1))
            mapped["y1"] = max(0, min(crop.shape[0] - 1, int(mapped["y1"]) - y1))
            mapped["x2"] = max(1, min(crop.shape[1], int(mapped["x2"]) - x1))
            mapped["y2"] = max(1, min(crop.shape[0], int(mapped["y2"]) - y1))
            if mapped["x2"] > mapped["x1"] and mapped["y2"] > mapped["y1"]:
                local_boxes.append(mapped)
        draw_boxes(crop, local_boxes, [])
        draw_text(crop, "H30T ALERT FULL FRAME VIDEO", 12, 28, (0, 0, 255))
        clip_frames.append(crop)
    if not clip_frames:
        return None
    out_height, out_width = clip_frames[0].shape[:2]
    if out_width % 2:
        out_width -= 1
    if out_height % 2:
        out_height -= 1
    if out_width < 64 or out_height < 64:
        return None
    path = event_dir / "alert_area_5s.mp4"
    output_fps = max(1.0, len(clip_frames) / max(0.1, duration_s))
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), output_fps, (out_width, out_height))
    if not writer.isOpened():
        return None
    try:
        for frame in clip_frames:
            frame = frame[:out_height, :out_width]
            writer.write(frame)
    finally:
        writer.release()
    return path if path.exists() and path.stat().st_size > 0 else None


def process_alert_event(
    state: LiveState,
    event_id: str,
    detector_name: str,
    detector: Any,
    sample_count: int,
    sample_interval_ms: int,
    sample_window_s: float,
    tile_size: int,
    overlap: int,
    critical_c: float,
    combustible_c: float,
    person_c: float,
    unknown_high_c: float,
    unknown_extreme_c: float,
    vehicle_extreme_c: float,
    stop_event: threading.Event,
    frames: list[tuple[int, np.ndarray, np.ndarray | None]] | None = None,
    matrices: list[tuple[dict[str, Any], np.ndarray]] | None = None,
    use_realtime_detections: bool = False,
    send_remote_alert: bool = True,
    matrix_burst_status: str = "",
) -> dict[str, Any]:
    if frames is None or matrices is None:
        frames, matrices = collect_alert_samples(state, sample_count, sample_interval_ms, sample_window_s, stop_event)
    if not frames:
        raise RuntimeError("no RGB frames available for alert sampling")

    all_boxes: list[dict[str, Any]] = []
    all_rows: list[dict[str, Any]] = []
    best_frame_time, best_frame, best_ir = frames[0]
    best_boxes: list[dict[str, Any]] = []
    best_rows: list[dict[str, Any]] = []
    matrices = []

    for frame_time, frame, ir_frame in frames:
        boxes = nearest_realtime_boxes(state, frame_time) if use_realtime_detections else infer_tiled(frame, frame_time, detector_name, detector, tile_size, overlap)
        rows: list[dict[str, Any]] = []
        all_boxes.extend(boxes)
        all_rows.extend(rows)
        if len(rows) > len(best_rows) or (not best_boxes and boxes):
            best_frame_time, best_frame, best_ir, best_boxes, best_rows = frame_time, frame, ir_frame, boxes, rows

    global_rows = global_samples_for_frames(state, [frame_time for frame_time, _frame, _ir in frames])
    global_max_candidates: list[float] = []
    global_avg_candidates: list[float] = []
    for global_row in global_rows:
        latest_max = as_float(global_row.get("max_c"))
        latest_avg = as_float(global_row.get("avg_c"))
        if latest_max is not None:
            global_max_candidates.append(latest_max)
        if latest_avg is not None:
            global_avg_candidates.append(latest_avg)
    global_max_c = max(global_max_candidates) if global_max_candidates else None
    global_avg_c = float(np.mean(global_avg_candidates)) if global_avg_candidates else None
    risk = classify_alert_risk(
        global_max_c,
        global_avg_c,
        all_rows,
        all_boxes,
        critical_c,
        combustible_c,
        person_c,
        unknown_high_c,
        unknown_extreme_c,
        vehicle_extreme_c,
    )

    event_dir = ensure_dir(state.output_dir / "alerts" / event_id)
    detection_path, ir_path, detection_jpeg, ir_jpeg = build_alert_visuals(
        event_dir,
        best_frame,
        best_boxes,
        best_rows,
        best_ir,
    )
    video_clip_path = build_alert_video_clip(
        state,
        event_dir,
        best_frame_time,
    )
    detections: list[dict[str, Any]] = []
    for idx, box in enumerate(all_boxes[:80]):
        row = all_rows[idx] if idx < len(all_rows) else {}
        detections.append(
            {
                "class_name": box.get("class_name", ""),
                "conf": float(box.get("conf", 0.0)),
                "x1": int(box.get("x1", 0)),
                "y1": int(box.get("y1", 0)),
                "x2": int(box.get("x2", 0)),
                "y2": int(box.get("y2", 0)),
                "box_max_c": as_float(row.get("box_max_c")),
                "box_avg_c": as_float(row.get("box_avg_c")),
            }
        )

    alert = {
        "event_id": event_id,
        "created_ms": now_ms(),
        "status": "complete",
        "frame_samples": len(frames),
        "matrix_samples": len(matrices),
        "best_frame_time_ms": best_frame_time,
        "detector": "realtime-reuse" if use_realtime_detections else detector_name,
        "tile_size": tile_size,
        "tile_overlap": overlap,
        "detection_count": len(all_boxes),
        "detections": detections,
        "detection_image": str(detection_path) if detection_path else "",
        "ir_image": str(ir_path) if ir_path else "",
        "video_clip": str(video_clip_path) if video_clip_path else "",
        "matrix_burst_status": matrix_burst_status,
        **risk,
    }
    alert["event_time"] = alert_event_time(alert)
    image_paths = [path for path in [detection_path, ir_path] if path is not None]
    if alert["ntfy_required"] and send_remote_alert:
        sent, message = send_alert_ntfy(alert)
        alert["ntfy_sent"] = sent
        alert["ntfy_send_status"] = message
    elif alert["ntfy_required"]:
        alert["ntfy_sent"] = False
        alert["ntfy_send_status"] = "suppressed by remote alert cooldown"
    else:
        alert["ntfy_sent"] = False
        alert["ntfy_send_status"] = "not required by rules"
    if alert["email_required"] and send_remote_alert and smtp_backup_enabled():
        sent, message = send_alert_email(alert, image_paths)
        alert["email_sent"] = sent
        alert["email_status"] = message
    elif alert["email_required"] and not send_remote_alert:
        alert["email_sent"] = False
        alert["email_status"] = "suppressed by remote alert cooldown"
    elif alert["email_required"]:
        alert["email_sent"] = False
        alert["email_status"] = "SMTP backup disabled by default; set H30T_ENABLE_SMTP=true to enable"
    else:
        alert["email_sent"] = False
        alert["email_status"] = "not required by rules"
    alert["evidence_dir"] = str(event_dir)
    summary_text = json.dumps(alert, indent=2, ensure_ascii=False)
    (event_dir / "summary.json").write_text(summary_text, encoding="utf-8")
    latest_dir = ensure_dir(state.output_dir / "alerts" / "latest")
    (latest_dir / "summary.json").write_text(summary_text, encoding="utf-8")
    if detection_jpeg is not None:
        (latest_dir / "detection_frame.jpg").write_bytes(detection_jpeg)
    if ir_jpeg is not None:
        (latest_dir / "ir_frame.jpg").write_bytes(ir_jpeg)
    if video_clip_path is not None:
        (latest_dir / "alert_area_5s.mp4").write_bytes(video_clip_path.read_bytes())
    append_alert_history(state.output_dir, alert)
    with state.lock:
        state.latest_alert = dict(alert)
        state.alert_history.append(dict(alert))
        state.latest_alert_detection_jpeg = detection_jpeg
        state.latest_alert_ir_jpeg = ir_jpeg
        state.latest_alert_video_path = str(video_clip_path) if video_clip_path else ""
    return alert


def run_alert_event_loop(
    state: LiveState,
    stop_event: threading.Event,
    detector_name: str,
    config: str,
    weight: str,
    threshold: float,
    require_cuda: bool,
    trigger_c: float,
    critical_c: float,
    combustible_c: float,
    person_c: float,
    unknown_high_c: float,
    unknown_extreme_c: float,
    vehicle_extreme_c: float,
    sample_count: int,
    sample_interval_ms: int,
    sample_window_s: float,
    cooldown_s: float,
    tile_size: int,
    overlap: int,
    use_realtime_detections: bool,
    matrix_burst_on_alert: bool,
    matrix_burst_adb: str,
    matrix_burst_adb_serial: str,
    matrix_burst_pc_ip: str,
    matrix_burst_http_port: int,
    matrix_burst_rtmp_url: str,
    matrix_burst_wait_s: float,
    matrix_burst_force_stop: bool,
) -> None:
    detector = None
    detector_error = ""
    if detector_name == "deimv2" and not use_realtime_detections:
        try:
            from deimv2_runtime import DEIMv2Detector
            detector = DEIMv2Detector(
                Path(__file__).resolve().parents[1],
                config,
                weight,
                threshold,
                require_cuda=require_cuda,
                use_fp16=True,
                class_names=DJI_DETECTION_CLASSES,
            )
            print(f"[alert] DEIMv2 event detector ready device={detector.device}", flush=True)
        except Exception as exc:
            detector_error = str(exc)
            print(f"[alert] DEIMv2 event detector load failed: {exc}", flush=True)
    elif detector_name == "none":
        print("[alert] alert events enabled without detector; temperature-only risk rules active", flush=True)
    elif use_realtime_detections:
        print("[alert] using realtime detections for background alert summaries", flush=True)

    def process_snapshot_job(
        job_event_id: str,
        job_current_max: float,
        job_frames: list[tuple[int, np.ndarray, np.ndarray | None]],
        job_matrices: list[tuple[dict[str, Any], np.ndarray]],
        job_send_remote_alert: bool,
        job_matrix_burst_status: str,
    ) -> None:
        with state.lock:
            state.alert_processing_count += 1
        try:
            if detector_name == "deimv2" and detector is None and not use_realtime_detections:
                raise RuntimeError(f"DEIMv2 unavailable: {detector_error}")
            alert = process_alert_event(
                state,
                job_event_id,
                detector_name,
                detector,
                sample_count,
                sample_interval_ms,
                sample_window_s,
                tile_size,
                overlap,
                critical_c,
                combustible_c,
                person_c,
                unknown_high_c,
                unknown_extreme_c,
                vehicle_extreme_c,
                stop_event,
                frames=job_frames,
                matrices=job_matrices,
                use_realtime_detections=use_realtime_detections,
                send_remote_alert=job_send_remote_alert,
                matrix_burst_status=job_matrix_burst_status,
            )
            if alert.get("ntfy_sent"):
                with state.lock:
                    state.last_alert_event_ms = now_ms()
                    state.last_alert_attempt_ms = now_ms()
            elif alert.get("ntfy_required"):
                with state.lock:
                    state.last_alert_attempt_ms = now_ms()
            print(f"[alert] {job_event_id} {alert['risk_type']} max={alert['global_max_c']} ntfy={alert['ntfy_send_status']}", flush=True)
        except Exception as exc:
            with state.lock:
                state.latest_alert = {
                    "event_id": job_event_id,
                    "created_ms": now_ms(),
                    "status": "failed",
                    "severity": "warning",
                    "risk_type": "event_failed",
                    "global_max_c": job_current_max,
                    "reasons": [str(exc)],
                    "ntfy_sent": False,
                    "ntfy_send_status": "not sent because event failed",
                    "email_sent": False,
                    "email_status": "not sent because event failed",
                }
            print(f"[alert] {job_event_id} failed: {exc}", flush=True)
        finally:
            with state.lock:
                state.alert_processing_count = max(0, state.alert_processing_count - 1)

    while not stop_event.is_set():
        time.sleep(0.2)
        with state.lock:
            if state.alert_active:
                continue
            frame_time_ms = state.latest_frame_time_ms
            latest_matrix_row = dict(state.latest_matrix_row) if state.latest_matrix_row else None
            last_event_ms = state.last_alert_event_ms
            last_attempt_ms = state.last_alert_attempt_ms
            last_evidence_ms = state.last_alert_evidence_ms
        latest_global = nearest_global_sample(state, frame_time_ms) if frame_time_ms else None
        if latest_global is None:
            with state.lock:
                latest_global = dict(state.latest_global) if state.latest_global else None
        max_values: list[float] = []
        if latest_global:
            value = as_float(latest_global.get("max_c"))
            if value is not None:
                max_values.append(value)
        if latest_matrix_row:
            value = as_float(latest_matrix_row.get("matrix_max_c"))
            if value is not None:
                max_values.append(value)
        current_max = max(max_values) if max_values else None
        realtime_boxes = nearest_realtime_boxes(
            state,
            frame_time_ms,
            max_age_ms=max(3000, state.max_detection_age_ms),
        ) if use_realtime_detections and frame_time_ms else []
        realtime_fire_boxes = fire_smoke_boxes(realtime_boxes)
        triggered_by_fire_smoke = bool(realtime_fire_boxes)
        if not triggered_by_fire_smoke and (current_max is None or current_max < trigger_c):
            continue
        current_time_ms = now_ms()
        alert_interval_ms = max(1000, int(round(cooldown_s * 1000)))
        if current_time_ms - last_evidence_ms < alert_interval_ms:
            continue
        if cooldown_s <= 0:
            send_remote_alert = True
        elif triggered_by_fire_smoke:
            send_remote_alert = current_time_ms - last_attempt_ms >= alert_interval_ms
        else:
            send_remote_alert = (
                current_time_ms - last_event_ms >= alert_interval_ms
                and current_time_ms - last_attempt_ms >= alert_interval_ms
            )
        event_temp_code = int((current_max if current_max is not None else 0.0) * 10)
        event_id = time.strftime("%Y%m%d_%H%M%S") + f"_{current_time_ms % 1000:03d}_{event_temp_code:04d}"
        trigger_reason = (
            f"Fire/smoke detected by realtime AI ({', '.join(sorted({str(box.get('class_name', '')).strip().lower() for box in realtime_fire_boxes}))}); sampling evidence for immediate alert"
            if triggered_by_fire_smoke
            else f"Temperature {current_max:.1f} C reached the {trigger_c:.1f} C trigger; sampling one frame for inference"
        )
        with state.lock:
            state.alert_active = True
            state.last_alert_evidence_ms = current_time_ms
            state.latest_alert = {
                "event_id": event_id,
                "created_ms": now_ms(),
                "event_time": alert_event_time({"created_ms": now_ms()}),
                "status": "running",
                "severity": "critical" if triggered_by_fire_smoke else "warning",
                "risk_type": "fire_smoke_sampling" if triggered_by_fire_smoke else "sampling",
                "global_max_c": current_max,
                "reasons": [trigger_reason],
            }
        try:
            with state.lock:
                if state.latest_alert and state.latest_alert.get("event_id") == event_id:
                    state.latest_alert["reasons"] = [trigger_reason]
                    state.latest_alert["remote_alert_pending"] = send_remote_alert
            previous_matrix_seq = latest_matrix_seq(state)
            frames, matrices = collect_alert_samples(state, sample_count, sample_interval_ms, sample_window_s, stop_event)
            matrix_burst_status = "disabled"
            if matrix_burst_on_alert:
                ok, message = trigger_matrix_burst(
                    matrix_burst_adb,
                    matrix_burst_adb_serial,
                    matrix_burst_pc_ip,
                    matrix_burst_http_port,
                    matrix_burst_rtmp_url,
                    3000,
                    1,
                    matrix_burst_force_stop,
                )
                with state.lock:
                    if state.latest_alert and state.latest_alert.get("event_id") == event_id:
                        state.latest_alert["matrix_burst_status"] = message if ok else f"failed: {message}"
                matrix_burst_status = message if ok else f"failed: {message}"
                burst_matrices = wait_for_new_matrix(state, previous_matrix_seq, matrix_burst_wait_s, stop_event) if ok else []
                if burst_matrices:
                    matrices = burst_matrices
                    matrix_burst_status = f"{matrix_burst_status}; received {len(burst_matrices)} matrix sample(s)"
                elif ok:
                    matrix_burst_status = f"{matrix_burst_status}; no new matrix received within {matrix_burst_wait_s:.1f}s"
            threading.Thread(
                target=process_snapshot_job,
                args=(event_id, current_max, frames, matrices, send_remote_alert, matrix_burst_status),
                daemon=True,
            ).start()
        except Exception as exc:
            with state.lock:
                state.latest_alert = {
                    "event_id": event_id,
                    "created_ms": now_ms(),
                    "status": "failed",
                    "severity": "warning",
                    "risk_type": "event_failed",
                    "global_max_c": current_max,
                    "reasons": [str(exc)],
                    "ntfy_sent": False,
                    "ntfy_send_status": "not sent because event failed",
                    "email_sent": False,
                    "email_status": "not sent because event failed",
                }
            print(f"[alert] {event_id} failed: {exc}", flush=True)
        finally:
            with state.lock:
                state.alert_active = False


def highgui_available() -> bool:
    try:
        cv2.namedWindow("__h30t_highgui_test__", cv2.WINDOW_NORMAL)
        cv2.destroyWindow("__h30t_highgui_test__")
        return True
    except cv2.error:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Live video + wireless H30T temperature overlay.")
    parser.add_argument("--udp-host", default="0.0.0.0")
    parser.add_argument("--udp-port", type=int, default=5005)
    parser.add_argument("--http-host", default="0.0.0.0")
    parser.add_argument("--http-port", type=int, default=8010)
    parser.add_argument("--video-source", default="rtmp://100.111.187.114:1935/live/m400")
    parser.add_argument("--rgb-video-source", default="")
    parser.add_argument("--split-composite", action="store_true", help="Split one left-IR/right-RGB source frame synchronously")
    parser.add_argument("--output-dir", default="outputs/wireless")
    parser.add_argument("--offset-c", type=float, default=275.0)
    parser.add_argument("--thermal-sdk-lib", default=None)
    parser.add_argument("--thermal-distance-m", type=float, default=5.0)
    parser.add_argument("--thermal-humidity-percent", type=float, default=70.0)
    parser.add_argument("--thermal-emissivity", type=float, default=0.95)
    parser.add_argument("--thermal-reflection-c", type=float, default=25.0)
    parser.add_argument("--detector", choices=["deimv2", "dummy", "none"], default="none")
    parser.add_argument("--disable-realtime-inference", action="store_true", help="Use detector only for high-temperature alert events")
    parser.add_argument("--deim-config", default="configs/deimv2/deimv2_dinov3_s_dji_10class.yml")
    parser.add_argument("--deim-weight", default="new_models/deimv2_dinov3_s_dji_rgb_50e_best_stg2.pth")
    parser.add_argument("--deim-rgb-config", default="configs/deimv2/deimv2_dinov3_s_dji_10class.yml")
    parser.add_argument("--deim-rgb-weight", default="new_models/deimv2_dinov3_s_dji_rgb_50e_best_stg2.pth")
    parser.add_argument("--deim-ir-config", default="configs/deimv2/deimv2_dinov3_s_dji_10class.yml")
    parser.add_argument("--deim-ir-weight", default="new_models/deimv2_dinov3_s_dji_ir_50e_best_stg2.pth")
    parser.add_argument("--deim-threshold", type=float, default=0.45)
    parser.add_argument("--allow-cpu-inference", action="store_true", help="Allow DEIMv2 to run without CUDA (disabled by default)")
    parser.add_argument("--lazy-load-deimv2", action="store_true", help="Load DEIMv2 only when the first inference request is submitted")
    parser.add_argument("--preload-deimv2-before-video", action="store_true", help="Wait for DEIMv2 to finish loading before opening the video source")
    parser.add_argument("--inference-stream", choices=["both", "rgb", "ir"], default="both", help="Run realtime AI on both streams, or infer one stream and mirror boxes to the other")
    parser.add_argument("--hot-ai-threshold-c", type=float, default=55.0)
    parser.add_argument("--hot-ai-crop-size", type=int, default=640)
    parser.add_argument(
        "--inference-region",
        choices=["full", "global-hot", "matrix-hot"],
        default="global-hot",
        help="global-hot uses fresh MSDK max_c as a cheap gate, then runs full-frame inference",
    )
    parser.add_argument("--max-temp-frame-delta-ms", type=int, default=700, help="Reject temperature samples farther from the compensated video timestamp")
    parser.add_argument("--temperature-video-offset-ms", type=int, default=1000, help="Add this delay to temperature arrival time before matching it to RTMP frames")
    parser.add_argument("--pilot2-mode", action="store_true", help="Compatibility mode only. Normal operation is MSDK-owned RTMP video and MSDK temperature.")
    parser.add_argument("--display", choices=["auto", "opencv", "web", "headless"], default="auto")
    parser.add_argument("--web-host", default="127.0.0.1")
    parser.add_argument("--web-port", type=int, default=8765)
    parser.add_argument("--web-output-fps", type=float, default=25.0, help="Limit JPEG/MJPEG output rate to reduce CPU and stabilize RTMP reading")
    parser.add_argument("--jpeg-quality", type=int, default=65, help="JPEG quality for web preview frames")
    parser.add_argument("--read-failures-before-reconnect", type=int, default=6, help="Reconnect only after this many consecutive empty/error reads")
    parser.add_argument("--min-inference-interval-ms", type=int, default=50, help="Minimum interval between realtime inference requests")
    parser.add_argument("--detection-hold-ms", type=int, default=3000, help="Keep drawing the latest AI result on newer video frames for this long")
    parser.add_argument("--disable-threaded-video-read", action="store_true", help="Debug only: read video in the render loop instead of a latest-frame reader thread")
    parser.add_argument("--enable-pair-preview", action="store_true", help="Also encode the combined IR/RGB pair preview stream")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--run-seconds", type=float, default=0.0)
    parser.add_argument("--snapshot-path", default="")
    parser.add_argument("--exit-after-snapshot", action="store_true")
    parser.add_argument("--disable-alert-events", action="store_true", help="Disable 55C high-temperature event sampling and risk alerts")
    parser.add_argument("--alert-trigger-c", type=float, default=55.0)
    parser.add_argument("--alert-critical-c", type=float, default=80.0)
    parser.add_argument("--alert-combustible-c", type=float, default=60.0)
    parser.add_argument("--alert-person-c", type=float, default=75.0)
    parser.add_argument("--alert-unknown-high-c", type=float, default=90.0)
    parser.add_argument("--alert-unknown-extreme-c", type=float, default=110.0)
    parser.add_argument("--alert-vehicle-extreme-c", type=float, default=110.0)
    parser.add_argument("--alert-samples", type=int, default=1)
    parser.add_argument("--alert-sample-interval-ms", type=int, default=1000)
    parser.add_argument("--alert-sample-window-s", type=float, default=4.0)
    parser.add_argument("--alert-cooldown-s", type=float, default=120.0)
    parser.add_argument("--alert-tile-size", type=int, default=640)
    parser.add_argument("--alert-tile-overlap", type=int, default=96)
    parser.add_argument("--alert-reuse-realtime-detections", action=argparse.BooleanOptionalAction, default=True, help="Reuse realtime detector boxes for alert summaries instead of running a second DEIMv2 pass")
    parser.add_argument("--matrix-burst-on-alert", action=argparse.BooleanOptionalAction, default=False, help="Deprecated: matrix capture interrupts Pilot 2 video and must remain disabled")
    parser.add_argument("--matrix-burst-adb", default="", help="ADB executable for on-demand matrix burst capture")
    parser.add_argument("--matrix-burst-adb-serial", default="", help="ADB serial for the DJI RC used for on-demand matrix burst capture")
    parser.add_argument("--matrix-burst-pc-ip", default="10.0.0.72", help="PC IP passed to the RC companion for matrix burst upload")
    parser.add_argument("--matrix-burst-http-port", type=int, default=8010, help="PC HTTP port receiving matrix burst uploads")
    parser.add_argument("--matrix-burst-rtmp-url", default="", help="RTMP URL passed to the RC companion during matrix burst capture")
    parser.add_argument("--matrix-burst-wait-s", type=float, default=18.0, help="Seconds to wait for the on-demand matrix after triggering the RC companion")
    parser.add_argument("--matrix-burst-force-stop", action=argparse.BooleanOptionalAction, default=True, help="Force-stop/restart the RC companion so matrix burst intent extras are applied")
    args = parser.parse_args()

    output_dir = ensure_dir(Path(args.output_dir))
    state = LiveState(output_dir=output_dir)
    state.max_temp_frame_delta_ms = max(0, args.max_temp_frame_delta_ms)
    state.temperature_video_offset_ms = args.temperature_video_offset_ms
    state.strict_sync_active = bool(args.split_composite)
    state.web_output_fps = max(1.0, float(args.web_output_fps))
    state.jpeg_quality = max(35, min(90, int(args.jpeg_quality)))
    state.min_inference_interval_ms = max(0, int(args.min_inference_interval_ms))
    state.max_detection_age_ms = max(100, int(args.detection_hold_ms))
    state.requested_inference_stream_mode = args.inference_stream
    state.inference_stream_mode = args.inference_stream
    stop_event = threading.Event()
    inference_requests: queue.Queue[InferenceRequest] = queue.Queue(maxsize=4)

    if not args.pilot2_mode:
        threading.Thread(target=run_synchronized_playback_loop, args=(state, stop_event), daemon=True).start()
    threading.Thread(target=run_udp_loop, args=(state, args.udp_host, args.udp_port, stop_event), daemon=True).start()
    measurement_params = MeasurementParams(
        distance_m=args.thermal_distance_m,
        humidity_percent=args.thermal_humidity_percent,
        emissivity=args.thermal_emissivity,
        reflection_c=args.thermal_reflection_c,
    )
    threading.Thread(
        target=run_http_server,
        args=(state, args.http_host, args.http_port, args.offset_c, stop_event, args.thermal_sdk_lib, measurement_params),
        daemon=True,
    ).start()
    if not args.split_composite:
        threading.Thread(target=capture_rgb_loop, args=(state, args.rgb_video_source, stop_event), daemon=True).start()
    detector_thread: threading.Thread | None = None
    if args.detector == "deimv2" and not args.disable_realtime_inference:
        detector_thread = threading.Thread(
            target=run_deimv2_loop,
            args=(
                state,
                inference_requests,
                stop_event,
                args.deim_config,
                args.deim_weight,
                args.deim_threshold,
                not args.allow_cpu_inference,
                args.lazy_load_deimv2,
                args.deim_ir_config,
                args.deim_ir_weight,
                args.deim_rgb_config,
                args.deim_rgb_weight,
            ),
            daemon=True,
        )
        detector_thread.start()
        if args.preload_deimv2_before_video and not args.lazy_load_deimv2:
            print("[deimv2] preloading before video open...", flush=True)
            preload_deadline = time.time() + 90.0
            while time.time() < preload_deadline and not stop_event.is_set():
                with state.lock:
                    status = state.detector_status
                    device = state.detector_device
                lowered = status.lower()
                if "ready" in lowered or "failed" in lowered or device not in {"disabled", "loading"}:
                    break
                time.sleep(0.1)
            with state.lock:
                status = state.detector_status
            print(f"[deimv2] preload status: {status}", flush=True)
    if not args.disable_alert_events:
        threading.Thread(
            target=run_alert_event_loop,
            args=(
                state,
                stop_event,
                args.detector,
                args.deim_config,
                args.deim_weight,
                args.deim_threshold,
                not args.allow_cpu_inference,
                args.alert_trigger_c,
                args.alert_critical_c,
                args.alert_combustible_c,
                args.alert_person_c,
                args.alert_unknown_high_c,
                args.alert_unknown_extreme_c,
                args.alert_vehicle_extreme_c,
                max(1, args.alert_samples),
                max(10, args.alert_sample_interval_ms),
                max(0.5, args.alert_sample_window_s),
                max(0.0, args.alert_cooldown_s),
                max(64, args.alert_tile_size),
                max(0, args.alert_tile_overlap),
                bool(args.alert_reuse_realtime_detections and args.detector == "deimv2" and not args.disable_realtime_inference),
                bool(args.matrix_burst_on_alert),
                args.matrix_burst_adb,
                args.matrix_burst_adb_serial,
                args.matrix_burst_pc_ip,
                args.matrix_burst_http_port,
                args.matrix_burst_rtmp_url or str(args.video_source),
                max(1.0, args.matrix_burst_wait_s),
                bool(args.matrix_burst_force_stop),
            ),
            daemon=True,
        ).start()

    parsed_video_source = parse_video_source(args.video_source)
    video_reader: LatestVideoReader | None = None
    cap: cv2.VideoCapture | None = None
    if args.disable_threaded_video_read:
        cap = open_video_capture(parsed_video_source, state, "video")
    else:
        video_reader = LatestVideoReader(parsed_video_source, state, stop_event, args.read_failures_before_reconnect)
        video_reader.start()
    with state.lock:
        video_status = state.video_status
    print(f"[video] source={mask_stream_url(args.video_source)} status={video_status}", flush=True)
    window = "H30T Wireless Live Temperature"
    display_mode = "headless" if args.headless else args.display
    if display_mode == "auto":
        display_mode = "opencv" if highgui_available() else "web"
    if display_mode == "opencv" and not highgui_available():
        print("[display] OpenCV HighGUI is not available; falling back to web viewer", flush=True)
        display_mode = "web"
    if display_mode == "web":
        threading.Thread(target=run_web_viewer, args=(state, args.web_host, args.web_port, stop_event), daemon=True).start()
        threading.Thread(target=run_web_encoder_loop, args=(state, stop_event), daemon=True).start()
    if display_mode == "opencv":
        cv2.namedWindow(window, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(window, 1280, 720)
    print(f"[display] mode={display_mode}", flush=True)

    last_time = time.perf_counter()
    fps = 0.0
    last_video_seq = 0
    last_web_publish_ms = 0
    web_publish_interval_ms = int(round(1000.0 / max(1.0, args.web_output_fps)))
    render_interval_s = 1.0 / max(1.0, args.web_output_fps)
    next_render_time = time.perf_counter()
    deadline = time.time() + args.run_seconds if args.run_seconds > 0 else None
    try:
        while True:
            if deadline and time.time() >= deadline:
                break

            now_perf = time.perf_counter()
            if now_perf < next_render_time:
                stop_event.wait(min(0.02, next_render_time - now_perf))
                continue
            next_render_time = max(now_perf, next_render_time) + render_interval_s

            if video_reader is not None:
                captured = video_reader.get_latest()
                if captured is None or captured.seq == last_video_seq:
                    with state.lock:
                        video_status = state.video_status
                    log_runtime_status(state)
                    continue
                last_video_seq = captured.seq
                frame = captured.frame
                frame_time = captured.arrival_ms
                source_frame_ok = True
                video_status = "open"
            else:
                ok, frame, read_error = read_capture_frame(cap, state, "video")
                source_frame_ok = ok and frame is not None
                if not ok or frame is None:
                    with state.lock:
                        state.video_status = f"read gap ({read_error or 'empty'})"
                        state.video_read_error_count += 1
                        video_status = state.video_status
                    log_runtime_status(state)
                    continue
                frame_time = now_ms()
                video_status = "open"
                with state.lock:
                    state.video_status = video_status

            rgb_frame = None
            if args.split_composite and source_frame_ok and frame.shape[1] >= 2:
                split_x = frame.shape[1] // 2
                rgb_frame = copy_frame(frame[:, split_x:], "rgb split")
                frame = copy_frame(frame[:, :split_x], "ir split")
                if rgb_frame is None or frame is None:
                    gc.collect()
                    continue

            height, width = frame.shape[:2]
            inference_frame = rgb_frame if rgb_frame is not None else frame
            inference_height, inference_width = inference_frame.shape[:2]
            displayed_global = select_strict_global_for_frame(state, frame_time)
            with state.lock:
                latest_matrix_for_gate = dict(state.latest_matrix_row) if state.latest_matrix_row else None
            matrix_gate_age_ms = (
                frame_time - int(latest_matrix_for_gate.get("pc_receive_time_ms") or 0)
                if latest_matrix_for_gate
                else None
            )
            matrix_gate_is_fresh = matrix_gate_age_ms is not None and 0 <= matrix_gate_age_ms <= state.max_matrix_display_age_ms
            ir_boxes = detect(frame, frame_time, args.detector) if args.detector != "deimv2" else []
            rgb_boxes: list[dict[str, Any]] = []
            if args.detector == "deimv2" and not args.disable_realtime_inference:
                with state.lock:
                    inference_mode = state.requested_inference_stream_mode
                streams = ["ir", "rgb"] if inference_mode == "both" else [inference_mode]
                global_max_c = as_float(displayed_global.get("max_c")) if displayed_global else None
                matrix_max_c = as_float(latest_matrix_for_gate.get("matrix_max_c")) if matrix_gate_is_fresh and latest_matrix_for_gate else None
                gate_max_c = global_max_c if global_max_c is not None else matrix_max_c

                def build_stream_request(stream_name: str, stream_frame: np.ndarray) -> InferenceRequest | None:
                    stream_height, stream_width = stream_frame.shape[:2]
                    if not can_submit_inference(state, frame_time, stream_name):
                        return None
                    if args.inference_region == "full":
                        request_frame = copy_frame(stream_frame, f"{stream_name} inference full")
                        return (
                            InferenceRequest(frame_time, request_frame, (0, 0), (stream_width, stream_height), None, stream_name)
                            if request_frame is not None
                            else None
                        )
                    if args.inference_region == "global-hot":
                        request_frame = copy_frame(stream_frame, f"{stream_name} inference gated") if gate_max_c is not None and gate_max_c > args.hot_ai_threshold_c else None
                        return (
                            InferenceRequest(frame_time, request_frame, (0, 0), (stream_width, stream_height), gate_max_c, stream_name)
                            if request_frame is not None
                            else None
                        )
                    request = build_hot_inference_request(
                        state,
                        frame_time,
                        stream_frame,
                        args.hot_ai_threshold_c,
                        args.hot_ai_crop_size,
                    )
                    if request is not None:
                        request.stream = stream_name
                    return request

                submitted_any = False
                for stream_name in streams:
                    stream_frame = frame if stream_name == "ir" else inference_frame
                    request = build_stream_request(stream_name, stream_frame)
                    if request is not None:
                        submitted_any = submit_latest_inference(state, inference_requests, request) or submitted_any
                if not submitted_any:
                    with state.lock:
                        if state.last_detection_time_ms and frame_time - state.last_detection_time_ms > state.max_detection_age_ms:
                            state.detection_history.clear()
                            state.ir_detection_history.clear()
                            state.rgb_detection_history.clear()
                            state.latest_ir_detection_boxes = []
                            state.latest_rgb_detection_boxes = []
                        state.latest_box_rows = []
                        state.detector_mode = "idle"
                        gate = "MSDK global/matrix fallback" if args.inference_region == "global-hot" else "matrix hot-region"
                        state.detector_status = f"DEIMv2 idle ({inference_mode}, {gate} max <= {args.hot_ai_threshold_c:.1f} C or stale)"
                ir_boxes = latest_detection_for_overlay(state, frame_time, state.max_detection_age_ms, "ir")
                rgb_boxes = latest_detection_for_overlay(state, frame_time, state.max_detection_age_ms, "rgb")
                if inference_mode == "rgb" and rgb_boxes and not ir_boxes:
                    ir_boxes = map_boxes_to_frame(rgb_boxes, (inference_width, inference_height), (width, height), "rgb")
                elif inference_mode == "ir" and ir_boxes and not rgb_boxes:
                    rgb_boxes = map_boxes_to_frame(ir_boxes, (width, height), (inference_width, inference_height), "ir")
            elif args.detector == "deimv2":
                with state.lock:
                    state.detector_mode = "alert-only"
                    state.detector_status = "DEIMv2 alert-only mode; realtime inference disabled"
            boxes = nms_detections(ir_boxes + rgb_boxes)
            should_publish_web = frame_time - last_web_publish_ms >= web_publish_interval_ms or not source_frame_ok
            if should_publish_web:
                last_web_publish_ms = frame_time

            temp_rows = update_box_temperatures(state, ir_boxes, width, height)
            with state.lock:
                if args.detector != "deimv2" or boxes:
                    state.latest_boxes = boxes
                state.latest_video_size = (width, height)
                if should_publish_web:
                    latest_ir_copy = copy_frame(frame, "latest IR")
                    latest_rgb_copy = copy_frame(inference_frame, "latest RGB")
                    if latest_ir_copy is not None:
                        state.latest_ir_frame = latest_ir_copy
                    if latest_rgb_copy is not None:
                        state.latest_rgb_frame = latest_rgb_copy
                state.latest_frame_time_ms = frame_time
                state.frame_count += 1
                state.source_frame_times_ms.append(frame_time)
                source_frame_count = state.frame_count
                if rgb_frame is not None:
                    state.rgb_frame_count += 1
                    state.rgb_status = "synchronized composite"
                    state.rgb_frame_time_ms = frame_time
            if source_frame_ok:
                append_alert_video_frame(state, frame_time, inference_frame, rgb_boxes)
            direct_ir = None
            direct_rgb = None
            if should_publish_web and source_frame_ok and rgb_frame is not None and args.pilot2_mode:
                displayed_global = select_strict_global_for_frame(state, frame_time)
                direct_ir = copy_frame(frame, "direct IR")
                direct_rgb = copy_frame(rgb_frame, "direct RGB")
                if direct_ir is None or direct_rgb is None:
                    gc.collect()
                    continue
                draw_hotspot(direct_ir, None, displayed_global)
                draw_text(direct_ir, "H30T IR", 12, 26, (0, 255, 255))
                draw_boxes(direct_ir, ir_boxes, temp_rows)
                draw_text(direct_rgb, "H30T RGB", 12, 26, (0, 255, 255))
                draw_boxes(direct_rgb, rgb_boxes, [])
                with state.lock:
                    detector_status = state.detector_status
                draw_text(direct_rgb, detector_status, 12, direct_rgb.shape[0] - 14, (180, 255, 180))
                if args.enable_pair_preview:
                    pair_frame = hstack_frames(direct_ir, direct_rgb)
                    pair_jpeg = encode_jpeg(pair_frame, state.jpeg_quality) if pair_frame is not None else None
                    if pair_jpeg is not None:
                        with state.lock:
                            state.latest_pair_jpeg = pair_jpeg
                            state.pair_sequence += 1
                            state.pair_publish_times_ms.append(frame_time)
            elif should_publish_web and source_frame_ok and rgb_frame is not None:
                if rgb_frame.shape[:2] != frame.shape[:2]:
                    rgb_frame = cv2.resize(rgb_frame, (frame.shape[1], frame.shape[0]))
                if args.enable_pair_preview:
                    pair_frame = hstack_frames(frame, rgb_frame)
                    pair_jpeg = encode_jpeg(pair_frame, state.jpeg_quality) if pair_frame is not None else None
                    if pair_jpeg is not None:
                        thumbnail = thermal_thumbnail(frame) if source_frame_count % 3 == 0 else None
                        publish_buffered_pair(state, frame_time, pair_jpeg, thumbnail)

            annotated_frame = frame
            publish_individual = should_publish_web if args.pilot2_mode else (should_publish_web and (source_frame_count % 3 == 0 or not source_frame_ok))
            if publish_individual:
                annotated_frame = direct_ir if direct_ir is not None else copy_frame(frame, "annotated")
                if annotated_frame is None:
                    gc.collect()
                    continue
                if direct_ir is None:
                    draw_boxes(annotated_frame, ir_boxes, temp_rows)
                    draw_overlay(annotated_frame, state, fps, video_status)
                rgb_labeled = None
                if rgb_frame is not None:
                    rgb_labeled = direct_rgb if direct_rgb is not None else copy_frame(rgb_frame, "rgb labeled")
                    if rgb_labeled is None:
                        gc.collect()
                        continue
                    if direct_rgb is None:
                        draw_text(rgb_labeled, "H30T RGB", 12, 28, (0, 255, 255))
                        draw_boxes(rgb_labeled, rgb_boxes, [])
                with state.lock:
                    state.latest_ir_frame = annotated_frame
                    if rgb_labeled is not None:
                        state.latest_rgb_frame = rgb_labeled

            perf_now = time.perf_counter()
            dt = max(1e-6, perf_now - last_time)
            fps = 0.9 * fps + 0.1 * (1.0 / dt) if fps > 0 else 1.0 / dt
            last_time = perf_now
            with state.lock:
                state.display_fps = fps
            log_runtime_status(state)

            if args.snapshot_path:
                with state.lock:
                    has_frame = state.latest_frame_time_ms > 0
                if has_frame:
                    snapshot_path = Path(args.snapshot_path)
                    ensure_dir(snapshot_path.parent)
                    cv2.imwrite(str(snapshot_path), annotated_frame)
                    print(f"[live] snapshot saved {snapshot_path}", flush=True)
                    if args.exit_after_snapshot:
                        break

            if display_mode == "opencv":
                cv2.imshow(window, annotated_frame)
                key = cv2.waitKey(1) & 0xFF
                if key in (27, ord("q")):
                    break
            elif not source_frame_ok:
                time.sleep(0.02)
    finally:
        stop_event.set()
        release_capture(cap)
        if video_reader is not None and video_reader.thread.is_alive():
            video_reader.thread.join(timeout=2.0)
        if display_mode == "opencv":
            cv2.destroyAllWindows()
        gc.collect()
        log_runtime_status(state, "live-final", force=True)
        print("[live] stopped", flush=True)


if __name__ == "__main__":
    main()
