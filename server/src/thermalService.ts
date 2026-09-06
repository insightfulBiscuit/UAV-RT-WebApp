import { mqttHub } from "./mqttClient.js";

/**
 * Real-time thermal spot metering on M4TD / M3T via DJI Cloud API MQTT.
 *
 * The drone continuously publishes its OSD stream on
 * `thing/product/{aircraftSn}/osd`, and each payload includes:
 *   data.host.cameras[0].ir_metering_point.{x, y, temperature}
 *
 * To measure at a user-clicked point:
 *   1. Publish a property_set to the DOCK's `thing/product/{dockSn}/property/set`
 *      moving `ir_metering_point` to the clicked (x, y).
 *   2. Poll the aircraft's cached OSD for up to ~3s until a new payload
 *      arrives whose ir_metering_point matches (approximately) our target.
 *   3. Return that temperature.
 */

export type ThermalReading = {
  temp: number;
  x: number;
  y: number;
  actualX: number;
  actualY: number;
  globalMin?: number;
  globalMax?: number;
  source: string;
  osdAgeMs: number;
};

type MeasureParams = {
  dockSn: string;       // dock SN — the MQTT gateway
  aircraftSn?: string;  // if known, we watch the aircraft's OSD; else derive from OSD contents
  cameraIndex: string;  // e.g. "99-0-0"
  x: number;            // 0..1 relative to video width
  y: number;            // 0..1 relative to video height
};

type IrPoint = { x?: number; y?: number; temperature?: number };
type CameraOsd = { payload_index?: string; ir_metering_point?: IrPoint };
type OsdPayload = {
  data?: {
    host?: {
      cameras?: CameraOsd[];
      [payloadIdx: string]:
        | {
            thermal_global_temperature_min?: number;
            thermal_global_temperature_max?: number;
          }
        | unknown;
    };
    sn?: string;
  };
};

const APPROX_TOLERANCE = 0.05; // 5% of frame; DJI often snaps to nearby target

function findAircraftSn(dockSn: string): string | undefined {
  // The dock SN is different from the aircraft SN. Iterate cached OSDs to
  // find one that isn't the dock (has a `cameras` array with ir_metering_point).
  for (const [sn, entry] of osdEntries()) {
    if (sn === dockSn) continue;
    const p = entry.payload as OsdPayload;
    const cams = p?.data?.host?.cameras;
    if (Array.isArray(cams) && cams.some((c) => c.ir_metering_point)) return sn;
  }
  return undefined;
}

function osdEntries(): Iterable<[string, { ts: number; payload: unknown }]> {
  // Access private map via a tiny surface exposed on the hub.
  const arr: Array<[string, { ts: number; payload: unknown }]> = [];
  const anyHub = mqttHub as unknown as {
    latestOsd?: Map<string, { ts: number; payload: unknown }>;
  };
  if (anyHub.latestOsd instanceof Map) {
    for (const [k, v] of anyHub.latestOsd) arr.push([k, v]);
  }
  return arr;
}

function extractIrPoint(payload: unknown, cameraIndex: string): {
  ir?: IrPoint;
  globalMin?: number;
  globalMax?: number;
} {
  const p = payload as OsdPayload;
  const host = p?.data?.host;
  const cams = host?.cameras;
  const cam = Array.isArray(cams)
    ? cams.find((c) => c.payload_index === cameraIndex) ?? cams[0]
    : undefined;
  const ir = cam?.ir_metering_point;
  const idxBlock = host?.[cameraIndex] as
    | { thermal_global_temperature_min?: number; thermal_global_temperature_max?: number }
    | undefined;
  return {
    ir,
    globalMin: idxBlock?.thermal_global_temperature_min,
    globalMax: idxBlock?.thermal_global_temperature_max,
  };
}

async function pollForUpdatedPoint(
  aircraftSn: string,
  cameraIndex: string,
  targetX: number,
  targetY: number,
  startTs: number,
  timeoutMs: number
): Promise<{ ir: IrPoint; ts: number } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = mqttHub.osd(aircraftSn);
    if (entry && entry.ts >= startTs) {
      const { ir } = extractIrPoint(entry.payload, cameraIndex);
      if (
        ir &&
        typeof ir.temperature === "number" &&
        typeof ir.x === "number" &&
        typeof ir.y === "number"
      ) {
        // Accept once we see a fresh reading; DJI may snap the point,
        // so we accept anything reasonably close.
        const dx = Math.abs((ir.x ?? -9) - targetX);
        const dy = Math.abs((ir.y ?? -9) - targetY);
        if (dx <= APPROX_TOLERANCE && dy <= APPROX_TOLERANCE) {
          return { ir, ts: entry.ts };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

export async function measureThermalPoint(params: MeasureParams): Promise<ThermalReading> {
  const { dockSn, cameraIndex, x, y } = params;
  const aircraftSn = params.aircraftSn ?? findAircraftSn(dockSn);
  if (!aircraftSn) {
    throw new Error(
      "No aircraft OSD seen yet. Ensure the drone is powered on and its telemetry is flowing on MQTT."
    );
  }

  // 1) Publish property_set to move the IR metering point.
  //    The dock forwards this over OcuSync to the aircraft.
  const setStart = Date.now();
  try {
    await mqttHub.propertySet(
      dockSn,
      {
        [cameraIndex]: {
          ir_metering_mode: 1, // 1 = point mode
          ir_metering_point: { x, y },
        },
      },
      3000
    );
  } catch (err) {
    // Don't fail hard — some firmware acks slowly or on a different topic.
    console.warn(`property_set warning: ${(err as Error).message}`);
  }

  // 2) Poll aircraft OSD for a matching update.
  const updated = await pollForUpdatedPoint(aircraftSn, cameraIndex, x, y, setStart, 4000);

  // 3) Fallback: if no matching update, use the latest OSD reading regardless.
  const entry = mqttHub.osd(aircraftSn);
  const finalIr = updated?.ir ?? extractIrPoint(entry?.payload, cameraIndex).ir;
  const globals = extractIrPoint(entry?.payload, cameraIndex);
  if (!finalIr || typeof finalIr.temperature !== "number") {
    throw new Error(
      "OSD has no ir_metering_point.temperature — the M4TD thermal camera may not be active."
    );
  }
  return {
    temp: finalIr.temperature,
    x,
    y,
    actualX: finalIr.x ?? x,
    actualY: finalIr.y ?? y,
    globalMin: globals.globalMin,
    globalMax: globals.globalMax,
    source: updated ? "osd_updated" : "osd_stale",
    osdAgeMs: entry ? Date.now() - entry.ts : -1,
  };
}

export async function subscribeDock(dockSn: string): Promise<void> {
  await mqttHub.subscribeDock(dockSn);
}
