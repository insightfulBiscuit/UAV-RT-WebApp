"""
Shared config for the AI inference worker.

Class list mirrors DEIMv2's 10-class DJI head — see
new_models/model_settings_and_detection_targets.md. Alert thresholds are
copied verbatim from H30T's config/product_config.json.
"""
from __future__ import annotations

import json
import os
import sys

CLASSES = [
    "vehicle",
    "tree",
    "metal_fixture",
    "green_grass",
    "dry_grass",
    "person",
    "tent_tarp",
    "plastic_waste",
    "fire",
    "smoke",
]

# Per-class hex colors for the browser overlay. Warm palette for hazards,
# cool for benign/vegetation.
CLASS_COLORS = {
    "vehicle":       "#4c9aff",
    "tree":          "#3a7a3a",
    "metal_fixture": "#a1a5b7",
    "green_grass":   "#66c266",
    "dry_grass":     "#c9a464",
    "person":        "#ffbf47",
    "tent_tarp":     "#c78bff",
    "plastic_waste": "#ee6666",
    "fire":          "#ff3d3d",
    "smoke":         "#dddddd",
}

# Copied verbatim from H30T's product_config.json — same thresholds so
# behavior matches your coworker's rig on the same drone.
_DEFAULT_ALERT_THRESHOLDS = {
    "triggerC":         55,   # generic "warm" trigger
    "criticalC":        80,   # generic "very hot" escalation
    "combustibleC":     60,   # tree, tent_tarp, plastic_waste, dry_grass
    "personC":          75,   # person body-surface anomaly
    "unknownHighC":     90,   # unknown-class hot spot
    "unknownExtremeC":  110,  # unknown-class extreme
    "vehicleExtremeC":  110,  # vehicle "engine on fire" territory
    "cooldownS":        5.1,  # re-alert cooldown per (class, box) key
}


def _load_thresholds() -> dict:
    """Merge user overrides from AI_THRESHOLDS env (JSON) on top of defaults.

    The Node backend serializes the effective thresholds (defaults +
    server/config/thresholds.json) and passes them here so we don't need to
    read the file from Python.
    """
    values = dict(_DEFAULT_ALERT_THRESHOLDS)
    raw = os.environ.get("AI_THRESHOLDS")
    if not raw:
        return values
    try:
        overrides = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        print(f"[ai] failed to parse AI_THRESHOLDS: {exc}", file=sys.stderr, flush=True)
        return values
    if isinstance(overrides, dict):
        for k, v in overrides.items():
            if k in values and isinstance(v, (int, float)):
                values[k] = v
    return values


ALERT_THRESHOLDS = _load_thresholds()

# Which classes get flagged as combustible (uses combustibleC threshold).
COMBUSTIBLES = {"tree", "tent_tarp", "plastic_waste", "dry_grass"}

# Detection confidence floor. Anything below this is dropped before it
# reaches the alert engine or the browser.
CONF_MIN = 0.35

# Persistence window: a detection must appear in this many recent frames
# before it "counts" as a stable track. Suppresses one-frame false positives.
DETECTION_HOLD_FRAMES = 3
