"""
DEIMv2/DINOv3 detector on CUDA. Requires PyTorch + CUDA and the DEIMv2
codebase reachable via DEIM_ROOT env. No mock fallback — the system runs
real or not at all.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

from config import CLASSES, CONF_MIN


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


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


class DeimV2Detector(BaseDetector):
    """
    Wraps the coworker's vendored deimv2_runtime.DEIMv2Detector. Threshold
    filtering + coordinate normalization live here; heavy lifting stays in
    their runtime (which handles model loading, tiling, and postprocessing).
    """

    def __init__(self, modality: str, weight_path: str, config_path: str) -> None:
        self.modality = modality
        from deimv2_runtime import DEIMv2Detector as _R  # type: ignore

        deim_root = Path(os.environ.get("DEIM_ROOT", "")).expanduser()
        if not deim_root.exists():
            raise RuntimeError(
                f"DEIM_ROOT={deim_root!s} not found. Set DEIM_ROOT to a directory "
                "containing DEIMv2/ (from the H30T delivery).",
            )
        # The config yml has relative paths like `./ckpts/vitt_distill.pt` that
        # are resolved against CWD. chdir into DEIMv2/ so they land.
        deim_pkg = deim_root / "DEIMv2"
        prev_cwd = os.getcwd()
        try:
            if deim_pkg.exists():
                os.chdir(str(deim_pkg))
            self._impl = _R(
                repo_root=deim_root,
                config=config_path,
                weight=weight_path,
                threshold=CONF_MIN,
                require_cuda=True,
                use_fp16=True,
                class_names=CLASSES,
            )
        finally:
            os.chdir(prev_cwd)
        _log(f"[deimv2] loaded modality={modality} device={self._impl.device} fp16={self._impl.use_fp16}")

    def infer(self, frame_bgr: np.ndarray) -> list[Detection]:
        # _impl.infer(bgr, frame_time_ms) -> (list[dict], latency_ms). Each dict
        # is {class_name, conf, x1, y1, x2, y2, ...} with pixel coords in the
        # input frame. We normalize to 0..1 so the browser can scale them.
        h, w = frame_bgr.shape[:2]
        frame_time_ms = int(time.time() * 1000)
        boxes, _latency_ms = self._impl.infer(frame_bgr, frame_time_ms)
        out: list[Detection] = []
        for b in boxes:
            conf = float(b.get("conf", 0.0))
            if conf < CONF_MIN:
                continue
            name = str(b.get("class_name", "unknown"))
            out.append(Detection(
                name, conf,
                x1=float(b["x1"]) / w, y1=float(b["y1"]) / h,
                x2=float(b["x2"]) / w, y2=float(b["y2"]) / h,
            ))
        return out


def build_detector(modality: str) -> BaseDetector:
    """
    Construct the DEIMv2 detector for the given modality. Raises if the
    DEIMv2 codebase, weights, or CUDA aren't ready — there is no fallback.

    Required env:
        DEIM_ROOT           — folder containing DEIMv2/ + new_models/
        DEIM_CONFIG_RGB     — default: configs/deimv2/deimv2_dinov3_s_dji_10class.yml
        DEIM_CONFIG_IR      — default: same as RGB
        DEIM_WEIGHT_RGB     — default: new_models/..._rgb_50e_best_stg2.pth
        DEIM_WEIGHT_IR      — default: new_models/..._ir_50e_best_stg2.pth
    """
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
