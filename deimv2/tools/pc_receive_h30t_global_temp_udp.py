from __future__ import annotations

import argparse
import json
import socket
from pathlib import Path

from h30t_matrix_utils import append_csv, ensure_dir, now_ms

GLOBAL_FIELDS = [
    "pc_receive_time_ms",
    "delay_ms",
    "type",
    "device_time_ms",
    "seq",
    "source",
    "avg_c",
    "min_c",
    "max_c",
    "min_point_x_raw",
    "min_point_y_raw",
    "max_point_x_raw",
    "max_point_y_raw",
    "min_point_x_px",
    "min_point_y_px",
    "max_point_x_px",
    "max_point_y_px",
    "width",
    "height",
]


def run_udp_receiver(host: str, port: int, output_dir: Path) -> None:
    ensure_dir(output_dir)
    csv_path = output_dir / "global_temperature.csv"
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((host, port))
    print(f"[udp] listening on {host}:{port}, writing {csv_path}", flush=True)
    while True:
        data, addr = sock.recvfrom(65535)
        pc_time = now_ms()
        try:
            msg = json.loads(data.decode("utf-8"))
        except Exception as exc:
            print(f"[udp] bad packet from {addr}: {exc}", flush=True)
            continue
        device_time = msg.get("device_time_ms")
        delay = pc_time - int(device_time) if isinstance(device_time, int) else ""
        row = {field: msg.get(field, "") for field in GLOBAL_FIELDS}
        row["pc_receive_time_ms"] = pc_time
        row["delay_ms"] = delay
        append_csv(csv_path, GLOBAL_FIELDS, row)
        print(
            f"[udp] seq={msg.get('seq')} avg={msg.get('avg_c')} min={msg.get('min_c')} max={msg.get('max_c')} delay_ms={delay}",
            flush=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Receive H30T global temperature JSON over UDP.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5005)
    parser.add_argument("--output-dir", default="outputs/wireless")
    args = parser.parse_args()
    run_udp_receiver(args.host, args.port, Path(args.output_dir))


if __name__ == "__main__":
    main()
