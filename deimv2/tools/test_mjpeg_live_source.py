from __future__ import annotations

import argparse
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np


def make_frame(index: int, width: int, height: int) -> np.ndarray:
    frame = np.zeros((height, width, 3), np.uint8)
    split_x = width // 2
    frame[:, :split_x] = (42, 42, 42)
    frame[:, split_x:] = (30, 90, 145)
    x = 40 + (index * 7) % max(1, split_x - 180)
    y = 80 + (index * 4) % max(1, height - 200)
    cv2.rectangle(frame, (x, y), (x + 130, y + 90), (0, 240, 255), -1)
    rx = split_x + 100 + (index * 9) % max(1, split_x - 220)
    ry = 120 + (index * 5) % max(1, height - 240)
    cv2.circle(frame, (rx, ry), 55, (0, 0, 255), -1)
    cv2.putText(frame, f"live {index}", (24, 52), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
    return frame


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9100)
    parser.add_argument("--fps", type=float, default=25.0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    args = parser.parse_args()
    interval = 1.0 / max(1.0, args.fps)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args_obj: object) -> None:
            return

        def do_GET(self) -> None:
            if self.path not in {"/", "/stream.mjpg"}:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            index = 0
            next_time = time.perf_counter()
            while True:
                frame = make_frame(index, args.width, args.height)
                ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                if not ok:
                    return
                data = encoded.tobytes()
                try:
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ")
                    self.wfile.write(str(len(data)).encode("ascii"))
                    self.wfile.write(b"\r\n\r\n")
                    self.wfile.write(data)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                index += 1
                next_time += interval
                delay = next_time - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"mjpeg live source http://{args.host}:{args.port}/stream.mjpg fps={args.fps}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
