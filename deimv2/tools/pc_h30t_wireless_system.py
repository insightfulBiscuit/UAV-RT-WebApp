from __future__ import annotations

import argparse
import json
import socket
import threading
import time
from collections import deque
from dataclasses import dataclass
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

from h30t_matrix_utils import MATRIX_HEIGHT, MATRIX_WIDTH, append_csv, ensure_dir, now_ms, percentile_sorted
from pc_receive_h30t_global_temp_udp import GLOBAL_FIELDS
from pc_receive_h30t_matrix_jpg_http import make_handler

BOX_TEMPERATURE_FIELDS = [
    "matrix_seq",
    "matrix_device_time_ms",
    "matrix_pc_receive_time_ms",
    "nearest_detection_frame_time_ms",
    "time_diff_ms",
    "track_id",
    "class_name",
    "conf",
    "x1_video",
    "y1_video",
    "x2_video",
    "y2_video",
    "x1_matrix",
    "y1_matrix",
    "x2_matrix",
    "y2_matrix",
    "box_avg_c",
    "box_min_c",
    "box_max_c",
    "box_p90_c",
    "box_p95_c",
    "hot_ratio_45",
    "hot_ratio_60",
    "hot_area_px_60",
]


@dataclass
class DetectionFrame:
    frame_time_ms: int
    video_width: int
    video_height: int
    boxes: list[dict[str, Any]]


class WirelessState:
    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.lock = threading.Lock()
        self.latest_global: dict[str, Any] | None = None
        self.latest_matrix: dict[str, Any] | None = None
        self.latest_box: dict[str, Any] | None = None
        self.udp_count = 0
        self.matrix_count = 0
        self.detection_count = 0
        self.started_ms = now_ms()
        self.detections: deque[DetectionFrame] = deque(maxlen=300)

    def add_detection(self, detection: DetectionFrame) -> None:
        with self.lock:
            self.detections.append(detection)
            self.detection_count += 1

    def nearest_detection(self, matrix_time_ms: int) -> DetectionFrame | None:
        with self.lock:
            if not self.detections:
                return None
            return min(self.detections, key=lambda item: abs(item.frame_time_ms - matrix_time_ms))

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            elapsed_s = max(0.001, (now_ms() - self.started_ms) / 1000.0)
            return {
                "latest_global": self.latest_global,
                "latest_matrix": self.latest_matrix,
                "latest_box": self.latest_box,
                "udp_fps": self.udp_count / elapsed_s,
                "matrix_fps": self.matrix_count / elapsed_s,
                "detection_fps": self.detection_count / elapsed_s,
            }


def parse_video_source(value: str) -> int | str:
    try:
        return int(value)
    except ValueError:
        return value


def detect(frame: Any, frame_time_ms: int, width: int, height: int) -> list[dict[str, Any]]:
    x1 = int(width * 0.35)
    y1 = int(height * 0.35)
    x2 = int(width * 0.65)
    y2 = int(height * 0.65)
    return [
        {
            "track_id": None,
            "class_name": "dummy_roi",
            "conf": 1.0,
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "frame_time_ms": frame_time_ms,
        }
    ]


def run_detection_loop(state: WirelessState, video_source: str, stop_event: threading.Event) -> None:
    try:
        import cv2  # type: ignore
    except Exception:
        cv2 = None

    if cv2 is None:
        print("[detect] OpenCV not available; using timed dummy detections at 10 FPS", flush=True)
        while not stop_event.is_set():
            frame_time = now_ms()
            state.add_detection(DetectionFrame(frame_time, MATRIX_WIDTH, MATRIX_HEIGHT, detect(None, frame_time, MATRIX_WIDTH, MATRIX_HEIGHT)))
            stop_event.wait(0.1)
        return

    source = parse_video_source(video_source)
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        print(f"[detect] cannot open video source {video_source}; using timed dummy detections at 10 FPS", flush=True)
        while not stop_event.is_set():
            frame_time = now_ms()
            state.add_detection(DetectionFrame(frame_time, MATRIX_WIDTH, MATRIX_HEIGHT, detect(None, frame_time, MATRIX_WIDTH, MATRIX_HEIGHT)))
            stop_event.wait(0.1)
        return

    print(f"[detect] opened video source {video_source}", flush=True)
    while not stop_event.is_set():
        ok, frame = cap.read()
        if not ok:
            stop_event.wait(0.05)
            continue
        frame_time = now_ms()
        height, width = frame.shape[:2]
        boxes = detect(frame, frame_time, width, height)
        state.add_detection(DetectionFrame(frame_time, width, height, boxes))
    cap.release()


def roi_values(values: list[float], x1: int, y1: int, x2: int, y2: int) -> list[float]:
    x1 = max(0, min(MATRIX_WIDTH - 1, x1))
    x2 = max(0, min(MATRIX_WIDTH, x2))
    y1 = max(0, min(MATRIX_HEIGHT - 1, y1))
    y2 = max(0, min(MATRIX_HEIGHT, y2))
    if x2 <= x1:
        x2 = min(MATRIX_WIDTH, x1 + 1)
    if y2 <= y1:
        y2 = min(MATRIX_HEIGHT, y1 + 1)
    out: list[float] = []
    for y in range(y1, y2):
        start = y * MATRIX_WIDTH + x1
        out.extend(values[start : start + (x2 - x1)])
    return out


def summarize_box(values: list[float]) -> dict[str, float]:
    total = 0.0
    min_v = values[0]
    max_v = values[0]
    hot45 = 0
    hot60 = 0
    for value in values:
        total += value
        if value < min_v:
            min_v = value
        if value > max_v:
            max_v = value
        if value >= 45.0:
            hot45 += 1
        if value >= 60.0:
            hot60 += 1
    sorted_values = sorted(values)
    count = len(values)
    return {
        "avg": total / count,
        "min": min_v,
        "max": max_v,
        "p90": percentile_sorted(sorted_values, 0.90),
        "p95": percentile_sorted(sorted_values, 0.95),
        "hot_ratio_45": hot45 / count,
        "hot_ratio_60": hot60 / count,
        "hot_area_px_60": float(hot60),
    }


def process_matrix_result(state: WirelessState, result: dict[str, Any]) -> None:
    row = result["row"]
    values = result["values"]
    matrix_time = int(row["device_time_ms"] or row["pc_receive_time_ms"])
    detection_frame = state.nearest_detection(matrix_time)
    with state.lock:
        state.matrix_count += 1
        state.latest_matrix = row

    if detection_frame is None:
        print(f"[fusion] matrix seq={row['seq']} has no detection frame yet", flush=True)
        return

    csv_path = state.output_dir / "box_temperature.csv"
    for box in detection_frame.boxes:
        x1_matrix = int(round(box["x1"] / detection_frame.video_width * MATRIX_WIDTH))
        y1_matrix = int(round(box["y1"] / detection_frame.video_height * MATRIX_HEIGHT))
        x2_matrix = int(round(box["x2"] / detection_frame.video_width * MATRIX_WIDTH))
        y2_matrix = int(round(box["y2"] / detection_frame.video_height * MATRIX_HEIGHT))
        box_values = roi_values(values, x1_matrix, y1_matrix, x2_matrix, y2_matrix)
        stats = summarize_box(box_values)
        out = {
            "matrix_seq": row["seq"],
            "matrix_device_time_ms": row["device_time_ms"],
            "matrix_pc_receive_time_ms": row["pc_receive_time_ms"],
            "nearest_detection_frame_time_ms": detection_frame.frame_time_ms,
            "time_diff_ms": abs(detection_frame.frame_time_ms - matrix_time),
            "track_id": "" if box.get("track_id") is None else box.get("track_id"),
            "class_name": box.get("class_name", ""),
            "conf": f"{float(box.get('conf', 0.0)):.6f}",
            "x1_video": box["x1"],
            "y1_video": box["y1"],
            "x2_video": box["x2"],
            "y2_video": box["y2"],
            "x1_matrix": x1_matrix,
            "y1_matrix": y1_matrix,
            "x2_matrix": x2_matrix,
            "y2_matrix": y2_matrix,
            "box_avg_c": f"{stats['avg']:.6f}",
            "box_min_c": f"{stats['min']:.6f}",
            "box_max_c": f"{stats['max']:.6f}",
            "box_p90_c": f"{stats['p90']:.6f}",
            "box_p95_c": f"{stats['p95']:.6f}",
            "hot_ratio_45": f"{stats['hot_ratio_45']:.6f}",
            "hot_ratio_60": f"{stats['hot_ratio_60']:.6f}",
            "hot_area_px_60": int(stats["hot_area_px_60"]),
        }
        append_csv(csv_path, BOX_TEMPERATURE_FIELDS, out)
        with state.lock:
            state.latest_box = out
        print(
            f"[fusion] matrix={row['seq']} box={out['class_name']} avg={out['box_avg_c']} min={out['box_min_c']} max={out['box_max_c']} p95={out['box_p95_c']} hot60={out['hot_ratio_60']}",
            flush=True,
        )


def run_udp_loop(state: WirelessState, host: str, port: int, stop_event: threading.Event) -> None:
    csv_path = state.output_dir / "global_temperature.csv"
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((host, port))
    sock.settimeout(0.5)
    print(f"[udp] listening on {host}:{port}, writing {csv_path}", flush=True)
    while not stop_event.is_set():
        try:
            data, addr = sock.recvfrom(65535)
        except socket.timeout:
            continue
        pc_time = now_ms()
        try:
            msg = json.loads(data.decode("utf-8"))
        except Exception as exc:
            print(f"[udp] bad packet: {exc}", flush=True)
            continue
        device_time = msg.get("device_time_ms")
        delay = pc_time - int(device_time) if isinstance(device_time, int) else ""
        out = {field: msg.get(field, "") for field in GLOBAL_FIELDS}
        out["pc_receive_time_ms"] = pc_time
        out["delay_ms"] = delay
        append_csv(csv_path, GLOBAL_FIELDS, out)
        with state.lock:
            state.latest_global = out
            state.udp_count += 1
        print(
            f"[udp] seq={msg.get('seq')} avg={msg.get('avg_c')} min={msg.get('min_c')} max={msg.get('max_c')} delay_ms={delay}",
            flush=True,
        )
    sock.close()


def run_http_server(state: WirelessState, host: str, port: int, offset_c: float, stop_event: threading.Event) -> ThreadingHTTPServer:
    handler = make_handler(state.output_dir, offset_c, callback=lambda result: process_matrix_result(state, result))
    server = ThreadingHTTPServer((host, port), handler)
    print(f"[http] listening on {host}:{port}, writing {state.output_dir}", flush=True)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
    thread.start()

    def shutdown_when_stopped() -> None:
        stop_event.wait()
        server.shutdown()

    threading.Thread(target=shutdown_when_stopped, daemon=True).start()
    return server


def print_status_loop(state: WirelessState, stop_event: threading.Event, interval_s: float) -> None:
    while not stop_event.wait(interval_s):
        snap = state.snapshot()
        latest_global = snap["latest_global"]
        latest_matrix = snap["latest_matrix"]
        latest_box = snap["latest_box"]
        global_text = "none"
        matrix_text = "none"
        box_text = "none"
        if latest_global:
            global_text = f"avg={latest_global.get('avg_c')} min={latest_global.get('min_c')} max={latest_global.get('max_c')}"
        if latest_matrix:
            matrix_text = (
                f"seq={latest_matrix.get('seq')} avg={latest_matrix.get('matrix_avg_c')} "
                f"min={latest_matrix.get('matrix_min_c')} max={latest_matrix.get('matrix_max_c')} extract_ms={latest_matrix.get('extract_ms')}"
            )
        if latest_box:
            box_text = (
                f"matrix={latest_box.get('matrix_seq')} avg={latest_box.get('box_avg_c')} "
                f"min={latest_box.get('box_min_c')} max={latest_box.get('box_max_c')} p95={latest_box.get('box_p95_c')}"
            )
        print(
            f"[status] global({global_text}) matrix({matrix_text}) box({box_text}) "
            f"fps udp={snap['udp_fps']:.2f} matrix={snap['matrix_fps']:.2f} detect={snap['detection_fps']:.2f}",
            flush=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the PC-side H30T wireless temperature system.")
    parser.add_argument("--udp-host", default="0.0.0.0")
    parser.add_argument("--udp-port", type=int, default=5005)
    parser.add_argument("--http-host", default="0.0.0.0")
    parser.add_argument("--http-port", type=int, default=8010)
    parser.add_argument("--video-source", default="rtmp://127.0.0.1:1935/live/thermal")
    parser.add_argument("--output-dir", default="outputs/wireless")
    parser.add_argument("--offset-c", type=float, default=273.15)
    parser.add_argument("--status-interval", type=float, default=2.0)
    parser.add_argument("--run-seconds", type=float, default=0.0)
    args = parser.parse_args()

    output_dir = ensure_dir(Path(args.output_dir))
    ensure_dir(output_dir / "h30t_jpg")
    ensure_dir(output_dir / "matrices")
    state = WirelessState(output_dir)
    stop_event = threading.Event()

    run_http_server(state, args.http_host, args.http_port, args.offset_c, stop_event)
    threads = [
        threading.Thread(target=run_udp_loop, args=(state, args.udp_host, args.udp_port, stop_event), daemon=True),
        threading.Thread(target=run_detection_loop, args=(state, args.video_source, stop_event), daemon=True),
        threading.Thread(target=print_status_loop, args=(state, stop_event, args.status_interval), daemon=True),
    ]
    for thread in threads:
        thread.start()

    print("[system] H30T wireless system is running. Press Ctrl+C to stop.", flush=True)
    try:
        if args.run_seconds > 0:
            deadline = time.time() + args.run_seconds
            while time.time() < deadline:
                time.sleep(0.2)
        else:
            while True:
                time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        time.sleep(0.5)
        print("[system] stopped", flush=True)


if __name__ == "__main__":
    main()
