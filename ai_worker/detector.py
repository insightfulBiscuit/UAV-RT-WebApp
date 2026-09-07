"""
Two detectors behind one interface:

  DeimV2Detector  — real DEIMv2/DINOv3 on CUDA. Requires PyTorch + CUDA
                    and the DEIMv2 codebase reachable via DEIM_ROOT env.
  MockDetector    — random-ish boxes for pipeline scaffolding on macOS /
                    CPU / any environment without CUDA.

The runtime picks one at startup based on availability + AI_MODE env.
"""
from __future__ import annotations

import os
import random
import time
from pathlib import Path
from typing import Any

import numpy as np

from config import CLASSES, CONF_MIN


class Detection:
    __slots__ = ("cls", "conf", "x1", "y1", "x2", "y2")

    def __init__(self, cls: str, conf: float, x1: float, y1: float, x2: float, y2: float):
        self.cls, self.conf = cls, conf
        self.x1, self.y1, self.x2, self.y2 = x1, y1, x2, y2

    def to_dict(self) -> dict[str, Any]:
        return {
            "class": self.cls,
            "conf": round(self.conf, 3),
            "box": [round(self.x1, 4), round(self.y1, 4),
                    round(self.x2, 4), round(self.y2, 4)],
        }


class BaseDetector:
    modality: str  # "rgb" or "ir"

    def infer(self, frame_bgr: np.ndarray) -> list[Detection]:
        raise NotImplementedError


# ---------------------------------------------------------------------------
# DEIMv2 (real) — requires torch, CUDA, DEIMv2 code on disk
# ---------------------------------------------------------------------------

class DeimV2Detector(BaseDetector):
    """
    Wraps the coworker's vendored deimv2_runtime.DEIMv2Detector. Threshold
    filtering + coordinate normalization live here; heavy lifting stays in
    their runtime (which handles model loading, tiling, and postprocessing).
    """

    def __init__(self, modality: str, weight_path: str, config_path: str) -> None:
        self.modality = modality
        # Delayed import so `MockDetector` can run without torch.
        from deimv2_runtime import DEIMv2Detector as _R  # type: ignore

        deim_root = Path(os.environ.get("DEIM_ROOT", "")).expanduser()
        if not deim_root.exists():
            raise RuntimeError(
                f"DEIM_ROOT={deim_root!s} not found. Set DEIM_ROOT to a directory "
                "containing DEIMv2/ (from the H30T delivery).",
            )
        self._impl = _R(
            repo_root=deim_root,
            config=config_path,
            weight=weight_path,
            threshold=CONF_MIN,
            require_cuda=True,
            use_fp16=True,
            class_names=CLASSES,
        )

    def infer(self, frame_bgr: np.ndarray) -> list[Detection]:
        # `_impl.infer` is coworker-code and returns (label_ids, scores, boxes).
        # Boxes are pixel coords in the input frame; we convert to normalized
        # 0..1 relative to frame dimensions so the browser can scale them.
        labels, scores, boxes = self._impl.infer(frame_bgr)
        h, w = frame_bgr.shape[:2]
        out: list[Detection] = []
        for lab, score, (x1, y1, x2, y2) in zip(labels, scores, boxes):
            if score < CONF_MIN:
                continue
            name = CLASSES[int(lab)] if 0 <= int(lab) < len(CLASSES) else "unknown"
            out.append(Detection(
                name, float(score),
                x1=float(x1) / w, y1=float(y1) / h,
                x2=float(x2) / w, y2=float(y2) / h,
            ))
        return out


# ---------------------------------------------------------------------------
# Mock — random plausible boxes, used when CUDA / weights aren't available
# ---------------------------------------------------------------------------

class MockDetector(BaseDetector):
    """
    Emits 0-3 random detections per frame, cycled across the class list.
    Boxes are stable-ish across time (drift slowly) so the browser overlay
    tracks a "moving object" instead of flickering all over the frame.
    """

    def __init__(self, modality: str = "rgb") -> None:
        self.modality = modality
        self._rng = random.Random(42)
        self._tracks: list[dict[str, Any]] = []
        self._frame = 0
        self._boot = time.time()

    def infer(self, frame_bgr: np.ndarray) -> list[Detection]:
        self._frame += 1
        # Occasionally spawn a new mock "object", drift the existing ones.
        if len(self._tracks) < 2 and self._rng.random() < 0.03:
            self._tracks.append({
                "cls": self._rng.choice(["person", "vehicle", "fire", "tree"]),
                "cx": self._rng.uniform(0.15, 0.85),
                "cy": self._rng.uniform(0.2, 0.8),
                "w": self._rng.uniform(0.08, 0.25),
                "h": self._rng.uniform(0.12, 0.35),
                "conf": self._rng.uniform(0.5, 0.95),
                "age": 0,
            })
        for t in self._tracks:
            t["cx"] += (self._rng.random() - 0.5) * 0.008
            t["cy"] += (self._rng.random() - 0.5) * 0.008
            t["age"] += 1
        # Age out tracks
        self._tracks = [t for t in self._tracks if t["age"] < 200]

        out: list[Detection] = []
        for t in self._tracks:
            x1 = max(0.0, t["cx"] - t["w"] / 2)
            y1 = max(0.0, t["cy"] - t["h"] / 2)
            x2 = min(1.0, t["cx"] + t["w"] / 2)
            y2 = min(1.0, t["cy"] + t["h"] / 2)
            out.append(Detection(t["cls"], float(t["conf"]), x1, y1, x2, y2))
        return out


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def build_detector(modality: str) -> BaseDetector:
    """
    Picks a detector based on env:
        AI_MODE=real    → DeimV2Detector (fails hard if CUDA / weights missing)
        AI_MODE=mock    → MockDetector unconditionally
        AI_MODE=auto    → real if possible, else mock (default)

    Weights + config paths for real mode come from these env vars:
        DEIM_ROOT           — DEIMv2/ checkout root
        DEIM_CONFIG_RGB     — default: configs/deimv2/deimv2_dinov3_s_dji_10class.yml
        DEIM_CONFIG_IR      — default: same as RGB
        DEIM_WEIGHT_RGB     — default: new_models/..._rgb_50e_best_stg2.pth
        DEIM_WEIGHT_IR      — default: new_models/..._ir_50e_best_stg2.pth
    """
    mode = os.environ.get("AI_MODE", "auto").lower()
    if mode == "mock":
        return MockDetector(modality)
    if mode not in ("real", "auto"):
        raise RuntimeError(f"AI_MODE={mode!r} not one of real / mock / auto")

    try:
        cfg_env = "DEIM_CONFIG_IR" if modality == "ir" else "DEIM_CONFIG_RGB"
        wt_env  = "DEIM_WEIGHT_IR"  if modality == "ir" else "DEIM_WEIGHT_RGB"
        cfg = os.environ.get(cfg_env, "configs/deimv2/deimv2_dinov3_s_dji_10class.yml")
        wt_default = (
            "new_models/deimv2_dinov3_s_dji_ir_50e_best_stg2.pth"
            if modality == "ir"
            else "new_models/deimv2_dinov3_s_dji_rgb_50e_best_stg2.pth"
        )
        wt = os.environ.get(wt_env, wt_default)
        return DeimV2Detector(modality, wt, cfg)
    except Exception as exc:  # noqa: BLE001
        if mode == "real":
            raise
        print(f"[ai] real detector unavailable ({exc}); falling back to mock.", flush=True)
        return MockDetector(modality)
