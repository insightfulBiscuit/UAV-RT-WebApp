from __future__ import annotations

import argparse
import json
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Any


THERMAL_MAX_RE = re.compile(r'"thermal_global_temperature_max"\s*:\s*(-?\d+(?:\.\d+)?)')
THERMAL_MIN_RE = re.compile(r'"thermal_global_temperature_min"\s*:\s*(-?\d+(?:\.\d+)?)')
BID_RE = re.compile(r'"bid"\s*:\s*"([^"]+)"')


def now_ms() -> int:
    return int(time.time() * 1000)


def number(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def walk_dicts(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_dicts(child)


def normalize_from_cloud_message(message: dict[str, Any]) -> dict[str, Any] | None:
    thermal = None
    for item in walk_dicts(message.get("data", message)):
        if isinstance(item, dict) and (
            "thermal_global_temperature_max" in item or "thermal_global_temperature_min" in item
        ):
            thermal = item
            break
    if thermal is None:
        return None

    min_c = number(thermal.get("thermal_global_temperature_min"))
    max_c = number(thermal.get("thermal_global_temperature_max"))
    if min_c is None and max_c is None:
        return None
    avg_c = number(thermal.get("thermal_global_temperature_avg"))
    if avg_c is None and min_c is not None and max_c is not None:
        avg_c = (min_c + max_c) / 2.0

    timestamp = message.get("timestamp", now_ms())
    try:
        device_time_ms = int(timestamp)
        if device_time_ms < 10_000_000_000:
            device_time_ms *= 1000
    except (TypeError, ValueError):
        device_time_ms = now_ms()

    return {
        "type": "h30t_global_temp",
        "device_time_ms": device_time_ms,
        "seq": message.get("bid") or message.get("tid") or device_time_ms,
        "source": "PILOT2_LOGCAT_OSD",
        "transport_mode": "adb_logcat_bridge",
        "avg_c": avg_c if avg_c is not None else "",
        "min_c": min_c,
        "max_c": max_c,
        "min_point_x_raw": "",
        "min_point_y_raw": "",
        "max_point_x_raw": "",
        "max_point_y_raw": "",
        "width": 1280,
        "height": 1024,
    }


def normalize_from_line_regex(line: str) -> dict[str, Any] | None:
    max_match = THERMAL_MAX_RE.search(line)
    min_match = THERMAL_MIN_RE.search(line)
    if not max_match and not min_match:
        return None
    bid_match = BID_RE.search(line)
    min_c = float(min_match.group(1)) if min_match else None
    max_c = float(max_match.group(1)) if max_match else None
    avg_c = (min_c + max_c) / 2.0 if min_c is not None and max_c is not None else None
    return {
        "type": "h30t_global_temp",
        "device_time_ms": now_ms(),
        "seq": bid_match.group(1) if bid_match else now_ms(),
        "source": "PILOT2_LOGCAT_OSD",
        "transport_mode": "adb_logcat_bridge",
        "avg_c": avg_c if avg_c is not None else "",
        "min_c": min_c if min_c is not None else "",
        "max_c": max_c if max_c is not None else "",
        "min_point_x_raw": "",
        "min_point_y_raw": "",
        "max_point_x_raw": "",
        "max_point_y_raw": "",
        "width": 1280,
        "height": 1024,
    }


def parse_line(line: str) -> dict[str, Any] | None:
    if "thermal_global_temperature_" not in line:
        return None

    json_start = line.find("{")
    if json_start >= 0:
        decoder = json.JSONDecoder()
        try:
            message, _end = decoder.raw_decode(line[json_start:])
            if isinstance(message, dict):
                normalized = normalize_from_cloud_message(message)
                if normalized is not None:
                    return normalized
        except json.JSONDecodeError:
            pass

    return normalize_from_line_regex(line)


def post_json(url: str, payload: dict[str, Any], timeout_s: float) -> bool:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            response.read()
            return 200 <= response.status < 300
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"[adb-thermal] post failed: {exc}", flush=True)
        return False


def enqueue_output(stream: Any, output: "queue.Queue[str]") -> None:
    try:
        for line in stream:
            output.put(line)
    finally:
        try:
            stream.close()
        except Exception:
            pass


def adb_command(adb: str, serial: str, dump_existing: bool) -> list[str]:
    command = [adb]
    if serial:
        command += ["-s", serial]
    command += ["logcat", "-v", "time"]
    if dump_existing:
        command += ["-d"]
    else:
        command += ["-T", "1"]
    return command


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge Pilot2 thermal OSD from adb logcat into the H30T PC viewer.")
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", default="")
    parser.add_argument("--viewer-url", default="http://127.0.0.1:8010/upload_h30t_global")
    parser.add_argument("--post-timeout", type=float, default=2.0)
    parser.add_argument("--min-interval-ms", type=int, default=900)
    parser.add_argument("--heartbeat-ms", type=int, default=1000)
    parser.add_argument("--restart-delay-s", type=float, default=1.0)
    parser.add_argument("--dump-existing", action="store_true")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    command = adb_command(args.adb, args.serial, args.dump_existing)
    print(f"[adb-thermal] reading: {' '.join(command)}", flush=True)
    print(f"[adb-thermal] posting to: {args.viewer_url}", flush=True)

    last_post_ms = 0
    last_payload: dict[str, Any] | None = None
    posted = 0
    stop = False

    def handle_stop(_signum: int, _frame: Any) -> None:
        nonlocal stop
        stop = True

    def post_heartbeat_if_due(current_ms: int) -> None:
        nonlocal posted, last_post_ms
        if (
            last_payload is not None
            and not args.dump_existing
            and args.heartbeat_ms > 0
            and current_ms - last_post_ms >= args.heartbeat_ms
        ):
            payload = dict(last_payload)
            original_seq = payload.get("seq")
            payload["device_time_ms"] = current_ms
            payload["seq"] = f"{original_seq}:hold:{current_ms}"
            payload["transport_mode"] = "adb_logcat_bridge_hold"
            if post_json(args.viewer_url, payload, args.post_timeout):
                posted += 1
                last_post_ms = current_ms
                print(
                    f"[adb-thermal] heartbeat seq={payload.get('seq')} min={payload.get('min_c')} max={payload.get('max_c')}",
                    flush=True,
                )

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    while not stop:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

        assert process.stdout is not None
        lines: queue.Queue[str] = queue.Queue()
        threading.Thread(target=enqueue_output, args=(process.stdout, lines), daemon=True).start()
        try:
            while not stop:
                post_heartbeat_if_due(now_ms())
                try:
                    line = lines.get(timeout=0.05)
                except queue.Empty:
                    if process.poll() is not None and lines.empty():
                        break
                    continue
                payload = parse_line(line)
                if payload is None:
                    continue
                current_ms = now_ms()
                if current_ms - last_post_ms < args.min_interval_ms:
                    continue
                if post_json(args.viewer_url, payload, args.post_timeout):
                    posted += 1
                    last_post_ms = current_ms
                    last_payload = dict(payload)
                    print(
                        f"[adb-thermal] posted seq={payload.get('seq')} min={payload.get('min_c')} max={payload.get('max_c')}",
                        flush=True,
                    )
                    if args.once:
                        process.terminate()
                        return 0
                if stop:
                    break
        finally:
            if process.poll() is None:
                process.terminate()
        if args.dump_existing or args.once:
            break
        if not stop:
            print("[adb-thermal] adb logcat ended; restarting", flush=True)
            time.sleep(max(0.1, args.restart_delay_s))

    return 0 if posted > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
