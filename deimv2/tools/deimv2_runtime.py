from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np


class DEIMv2Detector:
    """Lazy DEIMv2 runtime kept outside the video capture thread."""

    def __init__(
        self,
        repo_root: Path,
        config: str,
        weight: str,
        threshold: float,
        require_cuda: bool = False,
        use_fp16: bool = True,
        class_names: list[str] | None = None,
    ) -> None:
        deim_root = repo_root / "DEIMv2"
        if str(deim_root) not in sys.path:
            sys.path.insert(0, str(deim_root))

        import torch
        import torch.nn as nn
        from engine.core import YAMLConfig
        from engine.data.dataset import mscoco_category2name, mscoco_label2category

        class RuntimeModel(nn.Module):
            def __init__(self, cfg: Any) -> None:
                super().__init__()
                self.model = cfg.model.deploy()
                self.postprocessor = cfg.postprocessor.deploy()

            def forward(self, images: Any, orig_target_sizes: Any) -> Any:
                return self.postprocessor(self.model(images), orig_target_sizes)

        config_path = Path(config)
        weight_path = Path(weight)
        if not config_path.is_absolute():
            root_config_path = repo_root / config_path
            config_path = root_config_path if root_config_path.exists() else deim_root / config_path
        if not weight_path.is_absolute():
            root_weight_path = repo_root / weight_path
            weight_path = root_weight_path if root_weight_path.exists() else deim_root / weight_path

        self.torch = torch
        try:
            torch.set_num_threads(1)
        except Exception:
            pass
        try:
            torch.set_num_interop_threads(1)
        except Exception:
            pass
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if require_cuda and self.device.type != "cuda":
            raise RuntimeError("CUDA is required, but torch.cuda.is_available() is false")
        cfg = YAMLConfig(str(config_path), resume=str(weight_path))
        if "HGNetv2" in cfg.yaml_cfg:
            cfg.yaml_cfg["HGNetv2"]["pretrained"] = False
        try:
            checkpoint = torch.load(str(weight_path), map_location="cpu", weights_only=False)
        except TypeError:
            checkpoint = torch.load(str(weight_path), map_location="cpu")
        state = checkpoint["ema"]["module"] if "ema" in checkpoint else checkpoint["model"]
        cfg.model.load_state_dict(state)
        self.model = RuntimeModel(cfg).to(self.device).eval()
        self.image_size = tuple(cfg.yaml_cfg["eval_spatial_size"])
        vit_backbone = bool(cfg.yaml_cfg.get("DINOv3STAs", False))
        self.normalize = vit_backbone
        self.use_fp16 = bool(use_fp16 and self.device.type == "cuda")
        self.input_dtype = torch.float16 if self.use_fp16 else torch.float32
        self.mean = torch.tensor([0.485, 0.456, 0.406], device=self.device, dtype=self.input_dtype).view(1, 3, 1, 1)
        self.std = torch.tensor([0.229, 0.224, 0.225], device=self.device, dtype=self.input_dtype).view(1, 3, 1, 1)
        if class_names:
            self.labels = {idx: name for idx, name in enumerate(class_names)}
        else:
            self.labels = {
                label: mscoco_category2name[category]
                for label, category in mscoco_label2category.items()
            }
        self.threshold = threshold

        if self.device.type == "cuda":
            torch.backends.cudnn.benchmark = True
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
            torch.set_float32_matmul_precision("high")

    def _preprocess(self, bgr: np.ndarray) -> Any:
        # Keep preprocessing in OpenCV/torch and avoid a PIL + torchvision copy per frame.
        target_h, target_w = self.image_size
        resized = cv2.resize(bgr, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
        tensor = self.torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0)
        tensor = tensor.to(self.device, dtype=self.input_dtype, non_blocking=True).div_(255.0)
        if self.normalize:
            tensor.sub_(self.mean).div_(self.std)
        return tensor

    def infer(self, bgr: np.ndarray, frame_time_ms: int) -> tuple[list[dict[str, Any]], float]:
        started = time.perf_counter()
        height, width = bgr.shape[:2]
        tensor = self._preprocess(bgr)
        original_size = self.torch.tensor([[width, height]], device=self.device)
        with self.torch.inference_mode():
            with self.torch.autocast(device_type=self.device.type, dtype=self.torch.float16, enabled=self.use_fp16):
                labels, boxes, scores = self.model(tensor, original_size)

        keep = scores[0] > self.threshold
        kept_labels = labels[0][keep].detach().cpu().numpy()
        kept_boxes = boxes[0][keep].detach().cpu().numpy()
        kept_scores = scores[0][keep].detach().cpu().numpy()
        detections: list[dict[str, Any]] = []
        for label, box, score in zip(kept_labels, kept_boxes, kept_scores):
            x1, y1, x2, y2 = [int(round(float(value))) for value in box]
            detections.append(
                {
                    "track_id": None,
                    "class_name": self.labels.get(int(label), f"label_{int(label)}"),
                    "conf": float(score),
                    "x1": max(0, min(width - 1, x1)),
                    "y1": max(0, min(height - 1, y1)),
                    "x2": max(1, min(width, x2)),
                    "y2": max(1, min(height, y2)),
                    "frame_time_ms": frame_time_ms,
                }
            )
        return detections, (time.perf_counter() - started) * 1000.0
