import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Alert threshold overrides. The Python worker reads defaults from
 * ai_worker/config.py::ALERT_THRESHOLDS. Whatever ends up in this JSON file
 * is merged on top and passed to the worker via the AI_THRESHOLDS env var.
 *
 * "Reset to defaults" from the UI just deletes this file so the config-py
 * defaults become the effective values again.
 */

export type ThresholdOverrides = Partial<{
  triggerC: number;
  criticalC: number;
  combustibleC: number;
  personC: number;
  unknownHighC: number;
  unknownExtremeC: number;
  vehicleExtremeC: number;
  cooldownS: number;
}>;

// Kept in sync with ai_worker/config.py so the API can report both what the
// user has overridden and what the "reset" default would land on.
export const DEFAULT_THRESHOLDS: Required<ThresholdOverrides> = {
  triggerC:         55,
  criticalC:        80,
  combustibleC:     60,
  personC:          75,
  unknownHighC:     90,
  unknownExtremeC: 110,
  vehicleExtremeC: 110,
  cooldownS:        5.1,
};

const CONFIG_PATH = process.env.THRESHOLDS_CONFIG
  ?? join(process.cwd(), "config", "thresholds.json");

const NUMERIC_FIELDS = Object.keys(DEFAULT_THRESHOLDS) as Array<keyof ThresholdOverrides>;

function readOverrides(): ThresholdOverrides {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ThresholdOverrides = {};
    for (const k of NUMERIC_FIELDS) {
      const v = parsed[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch (err) {
    console.warn(`[thresholds] failed to read ${CONFIG_PATH}: ${(err as Error).message}`);
    return {};
  }
}

function writeOverrides(overrides: ThresholdOverrides): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(overrides, null, 2), "utf8");
}

export function getEffectiveThresholds(): Required<ThresholdOverrides> {
  return { ...DEFAULT_THRESHOLDS, ...readOverrides() };
}

export function getOverrides(): ThresholdOverrides {
  return readOverrides();
}

export function setOverrides(patch: Record<string, unknown>): ThresholdOverrides {
  const existing = readOverrides();
  const next: ThresholdOverrides = { ...existing };
  for (const k of NUMERIC_FIELDS) {
    const v = patch[k];
    if (v === null || v === undefined || v === "") {
      delete next[k];
    } else if (typeof v === "number" && Number.isFinite(v)) {
      next[k] = v;
    } else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      next[k] = Number(v);
    }
  }
  writeOverrides(next);
  return next;
}

export function resetOverrides(): void {
  if (existsSync(CONFIG_PATH)) {
    try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  }
}

/** Encoded for the AI_THRESHOLDS env var handed to the Python worker. */
export function serializeForWorker(): string {
  return JSON.stringify(getEffectiveThresholds());
}
