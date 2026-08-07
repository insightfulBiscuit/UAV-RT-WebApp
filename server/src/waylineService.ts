import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { Fh2Config, fh2Get } from "./fh2Client.js";

export type WaylineSummary = {
  id: string;
  name: string;
  size?: number;
  template_types?: string[];
  device_model_key?: string;
  payload_information?: Array<{ domain?: string; type?: string; lens_type?: string }>;
  update_time?: number;
};

export type WaylineDetails = WaylineSummary & {
  download_url: string;
};

export async function listWaylines(cfg: Fh2Config): Promise<WaylineSummary[]> {
  const data = await fh2Get<{ list: WaylineSummary[] }>(cfg, "/wayline");
  return data.list ?? [];
}

export async function getWaylineDetails(cfg: Fh2Config, id: string): Promise<WaylineDetails> {
  return fh2Get<WaylineDetails>(cfg, `/wayline/${encodeURIComponent(id)}`);
}

type WaypointFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number, number?] };
  properties: {
    index: number;
    height?: number;
    speed?: number;
    heading?: number;
    actions?: string[];
  };
};

type LineFeature = {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number, number?][] };
  properties: { name: string };
};

export type WaylineGeoJson = {
  type: "FeatureCollection";
  features: (WaypointFeature | LineFeature)[];
  bbox?: [number, number, number, number];
  meta: {
    id: string;
    name: string;
    waypointCount: number;
    hasAltitude: boolean;
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: true,
  parseTagValue: true,
  isArray: (name) => name === "Placemark" || name === "wpml:action",
});

function collect<T>(x: T | T[] | undefined): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function parsePlacemarks(xmlText: string) {
  const parsed = xmlParser.parse(xmlText);
  // Both template.kml and waylines.wpml wrap in <kml><Document>… with either
  // wpml:Folder or Folder holding Placemarks.
  const kml = parsed?.kml ?? parsed;
  const doc = kml?.Document ?? kml;
  const folders = collect(doc?.Folder).concat(collect(doc?.["wpml:Folder"]));

  const placemarks: any[] = [];
  for (const folder of folders) {
    placemarks.push(...collect(folder?.Placemark));
  }
  if (placemarks.length === 0) placemarks.push(...collect(doc?.Placemark));
  return placemarks;
}

function parseCoord(text: string | undefined): [number, number, number?] | null {
  if (!text) return null;
  const parts = String(text).trim().split(/[,\s]+/).map(Number);
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  return parts.length >= 3 && !Number.isNaN(parts[2])
    ? [parts[0], parts[1], parts[2]]
    : [parts[0], parts[1]];
}

export async function fetchWaylineGeoJson(cfg: Fh2Config, id: string): Promise<WaylineGeoJson> {
  const details = await getWaylineDetails(cfg, id);
  if (!details.download_url) throw new Error("No download_url in wayline details");

  const kmzRes = await fetch(details.download_url);
  if (!kmzRes.ok) throw new Error(`KMZ download failed: HTTP ${kmzRes.status}`);
  const buf = Buffer.from(await kmzRes.arrayBuffer());
  const zip = await JSZip.loadAsync(buf);

  // Prefer waylines.wpml (execution route with real waypoints); fall back to template.kml.
  const preferredEntry =
    zip.file(/waylines\.wpml$/i)[0] ??
    zip.file(/template\.kml$/i)[0] ??
    zip.file(/\.kml$/i)[0] ??
    zip.file(/\.wpml$/i)[0];
  if (!preferredEntry) throw new Error("No KML/WPML file inside KMZ");

  const xmlText = await preferredEntry.async("string");
  const placemarks = parsePlacemarks(xmlText);

  const waypoints: WaypointFeature[] = [];
  for (let i = 0; i < placemarks.length; i++) {
    const p = placemarks[i];
    const coordText = p?.Point?.coordinates;
    const coord = parseCoord(typeof coordText === "string" ? coordText : coordText?.["#text"]);
    if (!coord) continue;

    const heightRaw = p?.["wpml:height"] ?? p?.["wpml:executeHeight"] ?? p?.["wpml:ellipsoidHeight"];
    const speedRaw = p?.["wpml:waypointSpeed"];
    const headingRaw = p?.["wpml:waypointHeadingParam"]?.["wpml:waypointHeadingAngle"];
    const actionsGroup = p?.["wpml:actionGroup"];
    const actions: string[] = [];
    for (const grp of collect(actionsGroup)) {
      for (const act of collect(grp?.["wpml:action"])) {
        const fn = act?.["wpml:actionActuatorFunc"];
        if (fn) actions.push(String(fn));
      }
    }

    waypoints.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: coord },
      properties: {
        index: waypoints.length,
        height: heightRaw !== undefined ? Number(heightRaw) : undefined,
        speed: speedRaw !== undefined ? Number(speedRaw) : undefined,
        heading: headingRaw !== undefined ? Number(headingRaw) : undefined,
        actions: actions.length ? actions : undefined,
      },
    });
  }

  const line: LineFeature = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: waypoints.map((w) => w.geometry.coordinates) },
    properties: { name: details.name },
  };

  let bbox: [number, number, number, number] | undefined;
  if (waypoints.length > 0) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const w of waypoints) {
      const [lon, lat] = w.geometry.coordinates;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    bbox = [minLon, minLat, maxLon, maxLat];
  }

  return {
    type: "FeatureCollection",
    features: [line, ...waypoints],
    bbox,
    meta: {
      id: details.id,
      name: details.name,
      waypointCount: waypoints.length,
      hasAltitude: waypoints.some((w) => w.geometry.coordinates.length === 3),
    },
  };
}
