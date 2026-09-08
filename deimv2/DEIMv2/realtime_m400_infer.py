import argparse
import os
import shutil
import subprocess
import sys
import time

if "deimv2_rt" not in sys.executable.lower() and os.environ.get("DEIMV2_NO_AUTO_CONDA") != "1":
    conda = shutil.which("conda")
    if conda:
        env = os.environ.copy()
        env["DEIMV2_NO_AUTO_CONDA"] = "1"
        cmd = [conda, "run", "-n", "deimv2_rt", "python", os.path.abspath(__file__)] + sys.argv[1:]
        print("Re-running in conda env deimv2_rt...")
        raise SystemExit(subprocess.call(cmd, env=env))
    print("ERROR: This script needs the deimv2_rt conda environment, but conda was not found in PATH.")
    print("Run: conda run -n deimv2_rt python realtime_m400_infer.py")
    raise SystemExit(1)

import cv2
import numpy as np
import torch
import torch.nn as nn
import torchvision.transforms as T
from PIL import Image

sys.path.append(os.path.abspath(os.path.dirname(__file__)))
from engine.core import YAMLConfig
from engine.data.dataset import mscoco_category2name, mscoco_label2category


RTSP_URL = "rtsp://127.0.0.1:8554/live/m400"
RTMP_URL = "rtmp://127.0.0.1:1935/live/m400"
CONFIG_PATH = "configs/deimv2/deimv2_dinov3_s_coco.yml"
WEIGHT_PATH = "weight/deimv2_dinov3_s_coco.pth"
RESULT_PATH = "realtime_m400_result.jpg"

COCO_LABELS = {
    label: mscoco_category2name[category]
    for label, category in mscoco_label2category.items()
}


class DEIMRuntimeModel(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.model = cfg.model.deploy()
        self.postprocessor = cfg.postprocessor.deploy()

    def forward(self, images, orig_target_sizes):
        outputs = self.model(images)
        return self.postprocessor(outputs, orig_target_sizes)


def load_model(config_path, weight_path, device):
    cfg = YAMLConfig(config_path, resume=weight_path)
    if "HGNetv2" in cfg.yaml_cfg:
        cfg.yaml_cfg["HGNetv2"]["pretrained"] = False

    checkpoint = torch.load(weight_path, map_location="cpu")
    state = checkpoint["ema"]["module"] if "ema" in checkpoint else checkpoint["model"]
    cfg.model.load_state_dict(state)

    model = DEIMRuntimeModel(cfg).to(device)
    model.eval()
    img_size = tuple(cfg.yaml_cfg["eval_spatial_size"])
    vit_backbone = bool(cfg.yaml_cfg.get("DINOv3STAs", False))
    return model, img_size, vit_backbone


def open_stream_once():
    for url in (RTSP_URL, RTMP_URL):
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        ok, frame = cap.read()
        if ok and frame is not None:
            print(f"VIDEO_OPENED url={url}")
            return cap, url, frame
        cap.release()
        print(f"VIDEO_OPEN_FAILED url={url}")
    return None, "", None


def open_stream_wait(retry_seconds=2.0):
    while True:
        cap, url, frame = open_stream_once()
        if cap is not None:
            return cap, url, frame
        print(f"WAITING_FOR_STREAM retry_in={retry_seconds:.1f}s")
        time.sleep(retry_seconds)


def draw_detections(frame, labels, boxes, scores, threshold):
    keep = scores > threshold
    labels = labels[keep].detach().cpu().numpy()
    boxes = boxes[keep].detach().cpu().numpy()
    scores = scores[keep].detach().cpu().numpy()

    for label, box, score in zip(labels, boxes, scores):
        x1, y1, x2, y2 = [int(v) for v in box]
        name = COCO_LABELS.get(int(label), f"label_{int(label)}")
        text = f"{name} {score:.2f}"
        color = (0, 255, 0)
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.rectangle(frame, (x1, max(0, y1 - 22)), (x1 + 8 * len(text), y1), color, -1)
        cv2.putText(frame, text, (x1 + 2, max(15, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
    return len(scores)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=CONFIG_PATH)
    parser.add_argument("--weight", default=WEIGHT_PATH)
    parser.add_argument("--threshold", type=float, default=0.45)
    parser.add_argument("--max-frames", type=int, default=0, help="0 means run until q/ESC.")
    parser.add_argument("--display-ms", type=int, default=1)
    args = parser.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"DEVICE {device}")
    print(f"CONFIG {args.config}")
    print(f"WEIGHT {args.weight}")

    model, img_size, vit_backbone = load_model(args.config, args.weight, device)
    print("MODEL_LOADED True")

    transforms = T.Compose([
        T.Resize(img_size),
        T.ToTensor(),
        T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
        if vit_backbone else T.Lambda(lambda x: x),
    ])

    cap, stream_url, first_frame = open_stream_wait()
    frame = first_frame
    saved = False
    count = 0
    last = time.time()

    try:
        while True:
            if frame is None:
                ok, frame = cap.read()
                if not ok or frame is None:
                    print("FRAME_READ_FAILED reconnecting...")
                    cap.release()
                    cap, stream_url, frame = open_stream_wait()

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil = Image.fromarray(rgb)
            w, h = pil.size
            orig_size = torch.tensor([[w, h]], device=device)
            image_tensor = transforms(pil).unsqueeze(0).to(device)

            with torch.no_grad():
                labels, boxes, scores = model(image_tensor, orig_size)

            det_count = draw_detections(frame, labels[0], boxes[0], scores[0], args.threshold)
            count += 1
            now = time.time()
            fps = 1.0 / max(now - last, 1e-6)
            last = now
            cv2.putText(frame, f"{stream_url}  fps={fps:.1f} det={det_count}", (10, 24),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 255), 2)

            if not saved:
                cv2.imwrite(RESULT_PATH, frame)
                print(f"RESULT_SAVED {RESULT_PATH}")
                saved = True

            cv2.imshow("DEIMv2 M400/H30T Realtime", frame)
            key = cv2.waitKey(args.display_ms) & 0xFF
            if key in (ord("q"), 27):
                print("EXIT_BY_KEY")
                break

            if args.max_frames and count >= args.max_frames:
                print(f"EXIT_MAX_FRAMES {args.max_frames}")
                break

            frame = None
    finally:
        cap.release()
        cv2.destroyAllWindows()

    print(f"FRAMES_PROCESSED {count}")


if __name__ == "__main__":
    main()
