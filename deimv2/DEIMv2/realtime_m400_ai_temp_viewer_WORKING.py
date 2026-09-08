import argparse
import os
import queue
import re
import subprocess
import threading
import time
from dataclasses import dataclass

import cv2
import torch
import torchvision.transforms as T
from PIL import Image

from realtime_m400_infer import (
    CONFIG_PATH,
    RESULT_PATH,
    RTMP_URL,
    RTSP_URL,
    WEIGHT_PATH,
    draw_detections,
    load_model,
)


TEMP_RESULT_PATH = "realtime_m400_ai_temp_result.jpg"
REPORT_PATH = "realtime_m400_ai_temp_report.md"


@dataclass
class TempState:
    adb_found: bool = False
    adb_connected: bool = False
    parsed: bool = False
    timestamp: str = ""
    uav_sn: str = ""
    payload_index: str = ""
    max_c: str = ""
    min_c: str = ""
    error: str = ""


def find_adb():
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    adb = os.path.join(local_app_data, "Android", "Sdk", "platform-tools", "adb.exe")
    return adb if os.path.exists(adb) else None


def has_adb_device(adb):
    try:
        proc = subprocess.run([adb, "devices"], capture_output=True, text=True, timeout=10)
    except Exception:
        return False
    for line in proc.stdout.splitlines()[1:]:
        if re.search(r"\S+\s+device$", line):
            return True
    return False


def start_adb_temperature_reader(state, lock, stop_event):
    adb = find_adb()
    with lock:
        state.adb_found = adb is not None
        if not adb:
            state.error = r"adb.exe not found at %LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
            return

    connected = has_adb_device(adb)
    with lock:
        state.adb_connected = connected
        if not connected:
            state.error = "No adb device connected. Showing AI video without temperature."
            return

    subprocess.run([adb, "logcat", "-c"], capture_output=True, text=True)
    proc = subprocess.Popen(
        [adb, "logcat", "-v", "time"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        bufsize=1,
    )

    patterns = {
        "timestamp": re.compile(r'"timestamp"\s*:\s*([0-9]+)'),
        "uav": re.compile(r"thing/product/([^/]+)/osd"),
        "payload": re.compile(r'"payload_index"\s*:\s*"([^"]+)"'),
        "max": re.compile(r'"thermal_global_temperature_max"\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)'),
        "min": re.compile(r'"thermal_global_temperature_min"\s*:\s*(-?[0-9]+(?:\.[0-9]+)?)'),
    }

    try:
        while not stop_event.is_set():
            line = proc.stdout.readline() if proc.stdout else ""
            if not line:
                if proc.poll() is not None:
                    with lock:
                        state.error = "adb logcat exited."
                    break
                time.sleep(0.05)
                continue

            if "thermal_global_temperature_max" not in line:
                continue

            parsed = {k: p.search(line) for k, p in patterns.items()}
            if not (parsed["max"] and parsed["min"]):
                with lock:
                    state.error = "Found temperature line but could not parse Tmax/Tmin."
                continue

            with lock:
                state.parsed = True
                state.timestamp = parsed["timestamp"].group(1) if parsed["timestamp"] else ""
                state.uav_sn = parsed["uav"].group(1) if parsed["uav"] else ""
                state.payload_index = parsed["payload"].group(1) if parsed["payload"] else ""
                state.max_c = parsed["max"].group(1)
                state.min_c = parsed["min"].group(1)
                state.error = ""
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


def open_video_stream():
    for url in (RTSP_URL, RTMP_URL):
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        ok, frame = cap.read()
        if ok and frame is not None:
            return cap, url, frame
        cap.release()
    return None, "", None


def overlay_temperature(frame, temp):
    x, y = 12, 28
    line_h = 25

    if temp.parsed:
        lines = [
            f"Tmax: {float(temp.max_c):.1f} C",
            f"Tmin: {float(temp.min_c):.1f} C",
            f"Temp timestamp: {temp.timestamp}",
            f"UAV: {temp.uav_sn or '-'} payload: {temp.payload_index or '-'}",
        ]
        high = float(temp.max_c) > 60.0
    else:
        detail = temp.error if temp.error else "waiting for H30T temperature"
        lines = ["TEMP: unavailable", detail]
        high = False

    width = max(360, max(len(s) for s in lines) * 11)
    height = line_h * (len(lines) + (1 if high else 0)) + 14
    cv2.rectangle(frame, (6, 6), (6 + width, 6 + height), (0, 0, 0), -1)

    for i, line in enumerate(lines):
        color = (0, 255, 255) if temp.parsed else (0, 180, 255)
        cv2.putText(frame, line, (x, y + i * line_h), cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)

    if high:
        cv2.putText(frame, "HIGH TEMP", (x, y + len(lines) * line_h), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 3)


def write_report(status):
    lines = [
        "# M400/H30T AI + Temperature Viewer Report",
        "",
        f"- Video opened: {'success' if status.get('video_opened') else 'failed'}",
        f"- Video URL: `{status.get('video_url', '')}`",
        f"- Model loaded: {'success' if status.get('model_loaded') else 'failed'}",
        f"- ADB connected: {'success' if status.get('adb_connected') else 'failed'}",
        f"- Parsed Tmax/Tmin: {'success' if status.get('temp_parsed') else 'failed'}",
        f"- Displayed AI + temperature realtime view: {'success' if status.get('displayed') else 'failed'}",
        f"- Output screenshot: `{TEMP_RESULT_PATH}`",
    ]
    if status.get("failure_reason"):
        lines += ["", f"- Failure reason: {status['failure_reason']}"]
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=CONFIG_PATH)
    parser.add_argument("--weight", default=WEIGHT_PATH)
    parser.add_argument("--threshold", type=float, default=0.45)
    parser.add_argument("--max-frames", type=int, default=0, help="0 means run until q/ESC.")
    parser.add_argument("--display-ms", type=int, default=1)
    args = parser.parse_args()

    status = {
        "video_opened": False,
        "video_url": "",
        "model_loaded": False,
        "adb_connected": False,
        "temp_parsed": False,
        "displayed": False,
        "failure_reason": "",
    }

    temp = TempState()
    temp_lock = threading.Lock()
    stop_event = threading.Event()
    adb_thread = threading.Thread(
        target=start_adb_temperature_reader,
        args=(temp, temp_lock, stop_event),
        daemon=True,
    )
    adb_thread.start()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"DEVICE {device}")
    print(f"CONFIG {args.config}")
    print(f"WEIGHT {args.weight}")

    try:
        model, img_size, vit_backbone = load_model(args.config, args.weight, device)
        status["model_loaded"] = True
        print("MODEL_LOADED True")
    except Exception as exc:
        status["failure_reason"] = f"model load failed: {exc}"
        write_report(status)
        raise

    transforms = T.Compose([
        T.Resize(img_size),
        T.ToTensor(),
        T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
        if vit_backbone else T.Lambda(lambda x: x),
    ])

    cap, stream_url, frame = open_video_stream()
    if cap is None:
        status["failure_reason"] = "could not open RTSP or RTMP stream"
        write_report(status)
        raise RuntimeError(status["failure_reason"])

    status["video_opened"] = True
    status["video_url"] = stream_url
    print(f"VIDEO_OPENED url={stream_url}")

    saved = False
    frames = 0
    last_fps_time = time.time()

    try:
        while True:
            if frame is None:
                ok, frame = cap.read()
                if not ok or frame is None:
                    cap.release()
                    print("VIDEO_READ_FAILED reconnecting...")
                    time.sleep(0.5)
                    cap, stream_url, frame = open_video_stream()
                    if cap is None:
                        continue
                    status["video_url"] = stream_url

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil = Image.fromarray(rgb)
            w, h = pil.size
            orig_size = torch.tensor([[w, h]], device=device)
            image_tensor = transforms(pil).unsqueeze(0).to(device)

            with torch.no_grad():
                labels, boxes, scores = model(image_tensor, orig_size)

            det_count = draw_detections(frame, labels[0], boxes[0], scores[0], args.threshold)
            with temp_lock:
                temp_snapshot = TempState(**temp.__dict__)

            status["adb_connected"] = temp_snapshot.adb_connected
            status["temp_parsed"] = temp_snapshot.parsed
            overlay_temperature(frame, temp_snapshot)

            now = time.time()
            fps = 1.0 / max(now - last_fps_time, 1e-6)
            last_fps_time = now
            cv2.putText(frame, f"DEIMv2 cuda={torch.cuda.is_available()} fps={fps:.1f} det={det_count}",
                        (12, frame.shape[0] - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 255), 2)

            if not saved:
                cv2.imwrite(TEMP_RESULT_PATH, frame)
                print(f"RESULT_SAVED {TEMP_RESULT_PATH}")
                saved = True

            cv2.imshow("M400/H30T DEIMv2 AI + Temperature", frame)
            status["displayed"] = True
            frames += 1

            key = cv2.waitKey(args.display_ms) & 0xFF
            if key in (ord("q"), 27):
                print("EXIT_BY_KEY")
                break
            if args.max_frames and frames >= args.max_frames:
                print(f"EXIT_MAX_FRAMES {args.max_frames}")
                break

            frame = None
    finally:
        stop_event.set()
        if cap is not None:
            cap.release()
        cv2.destroyAllWindows()
        write_report(status)
        print(f"FRAMES_PROCESSED {frames}")
        print(f"REPORT_SAVED {REPORT_PATH}")


if __name__ == "__main__":
    main()
