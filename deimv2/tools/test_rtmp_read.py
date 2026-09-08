from __future__ import annotations

import argparse
import time

import cv2


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="rtmp://24.71.108.251:1935/live/m400")
    parser.add_argument("--seconds", type=float, default=8.0)
    parser.add_argument("--max-frames", type=int, default=160)
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.url)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    print(f"opened={cap.isOpened()}")
    frames = 0
    first = None
    last = None
    shape = None
    deadline = time.time() + args.seconds
    while time.time() < deadline and frames < args.max_frames:
        ok, frame = cap.read() if cap.isOpened() else (False, None)
        if not ok or frame is None:
            time.sleep(0.02)
            continue
        now = time.time()
        if first is None:
            first = now
            shape = frame.shape
        last = now
        frames += 1
    cap.release()
    elapsed = max(1e-6, (last or time.time()) - (first or time.time()))
    fps = (frames - 1) / elapsed if frames > 1 else 0.0
    split = (shape[1] // 2, shape[0]) if shape else None
    print(f"frames={frames}")
    print(f"fps={fps:.2f}")
    print(f"shape={shape}")
    print(f"split_ir_rgb_size={split}")


if __name__ == "__main__":
    main()
