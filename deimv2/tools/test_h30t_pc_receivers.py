from __future__ import annotations

import argparse
import json
import socket
import struct
import time
import urllib.error
import urllib.request
from pathlib import Path

MATRIX_WIDTH = 1280
MATRIX_HEIGHT = 1024
MATRIX_BYTES = MATRIX_WIDTH * MATRIX_HEIGHT * 2


def now_ms() -> int:
    return int(time.time() * 1000)


def file_size(path: Path) -> int:
    return path.stat().st_size if path.exists() else 0


def wait_for_growth(path: Path, before_size: int, timeout_s: float) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if file_size(path) > before_size:
            return True
        time.sleep(0.2)
    return file_size(path) > before_size


def make_test_h30t_jpeg(raw_value: int = 19000) -> bytes:
    payload = struct.pack("<H", raw_value) * (MATRIX_WIDTH * MATRIX_HEIGHT)
    chunks = []
    max_app_data = 65533
    for start in range(0, len(payload), max_app_data):
        chunk = payload[start : start + max_app_data]
        seg_len = len(chunk) + 2
        chunks.append(b"\xff\xe3" + seg_len.to_bytes(2, "big") + chunk)
    return b"\xff\xd8" + b"".join(chunks) + b"\xff\xd9"


def send_udp(host: str, port: int) -> None:
    msg = {
        "type": "h30t_global_temp",
        "device_time_ms": now_ms(),
        "seq": 999001,
        "source": "MSDK_REGION_GLOBAL_SMOKE",
        "avg_c": 24.5,
        "min_c": 23.0,
        "max_c": 28.0,
        "min_point_x_raw": 0.1,
        "min_point_y_raw": 0.2,
        "max_point_x_raw": 0.7,
        "max_point_y_raw": 0.8,
        "min_point_x_px": 128,
        "min_point_y_px": 205,
        "max_point_x_px": 896,
        "max_point_y_px": 819,
        "width": MATRIX_WIDTH,
        "height": MATRIX_HEIGHT,
    }
    data = json.dumps(msg).encode("utf-8")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.sendto(data, (host, port))
    finally:
        sock.close()


def post_jpeg(url: str) -> tuple[int, str]:
    boundary = f"----h30t-smoke-{now_ms()}"
    jpg = make_test_h30t_jpeg()
    fields = {
        "device_time_ms": str(now_ms()),
        "seq": "999001",
        "camera_source": "INFRARED_CAMERA_SMOKE",
        "width": str(MATRIX_WIDTH),
        "height": str(MATRIX_HEIGHT),
    }
    body = bytearray()
    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        body.extend(f"{value}\r\n".encode("utf-8"))
    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(b'Content-Disposition: form-data; name="file"; filename="h30t_smoke_app3.jpg"\r\n')
    body.extend(b"Content-Type: image/jpeg\r\n\r\n")
    body.extend(jpg)
    body.extend(f"\r\n--{boundary}--\r\n".encode("utf-8"))

    req = urllib.request.Request(
        url,
        data=bytes(body),
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test local H30T PC UDP and HTTP receivers.")
    parser.add_argument("--udp-host", default="127.0.0.1")
    parser.add_argument("--udp-port", type=int, default=5005)
    parser.add_argument("--http-url", default="http://127.0.0.1:8010/upload_h30t_jpg")
    parser.add_argument("--output-dir", default="outputs/wireless")
    parser.add_argument("--timeout", type=float, default=8.0)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    global_csv = output_dir / "global_temperature.csv"
    matrix_csv = output_dir / "matrix_summary.csv"
    box_csv = output_dir / "box_temperature.csv"
    before_global = file_size(global_csv)
    before_matrix = file_size(matrix_csv)
    before_box = file_size(box_csv)

    print(f"[smoke] sending UDP JSON to {args.udp_host}:{args.udp_port}", flush=True)
    send_udp(args.udp_host, args.udp_port)
    udp_ok = wait_for_growth(global_csv, before_global, args.timeout)

    print(f"[smoke] posting APP3 test JPG to {args.http_url}", flush=True)
    try:
        status, body = post_jpeg(args.http_url)
        http_status_ok = 200 <= status < 300
        print(f"[smoke] HTTP status={status} body={body[:200]}", flush=True)
    except Exception as exc:
        http_status_ok = False
        print(f"[smoke] HTTP request failed: {exc}", flush=True)

    matrix_ok = wait_for_growth(matrix_csv, before_matrix, args.timeout)
    box_ok = wait_for_growth(box_csv, before_box, 2.0)

    print(f"[smoke] UDP CSV growth: {'PASS' if udp_ok else 'FAIL'}", flush=True)
    print(f"[smoke] HTTP response: {'PASS' if http_status_ok else 'FAIL'}", flush=True)
    print(f"[smoke] matrix_summary.csv growth: {'PASS' if matrix_ok else 'FAIL'}", flush=True)
    print(f"[smoke] box_temperature.csv growth: {'PASS' if box_ok else 'WARN'}", flush=True)

    if udp_ok and http_status_ok and matrix_ok:
        print("PASS", flush=True)
        return 0
    print("FAIL", flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
