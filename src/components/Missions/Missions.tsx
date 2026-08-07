import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { LuRoute, LuMapPin } from "react-icons/lu";
import {
  fetchWaylines,
  fetchWaylineGeojson,
  type WaylineGeoJson,
  type WaylineSummary,
} from "../../lib/api";
import "./Missions.css";

function templateLabel(types?: string[]): string {
  if (!types || types.length === 0) return "—";
  return types
    .map((t) => t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(", ");
}

function formatDate(ms?: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function Missions() {
  const [waylines, setWaylines] = useState<WaylineSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [geojson, setGeojson] = useState<WaylineGeoJson | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mapRef = useRef<L.Map | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);

  // Callback ref: initialize Leaflet only when the container is truly mounted.
  const mapContainerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      mapRef.current?.remove();
      mapRef.current = null;
      routeLayerRef.current = null;
      return;
    }
    if (mapRef.current) return;
    const map = L.map(node, {
      center: [49.888, -119.4568], // Kelowna
      zoom: 12,
      zoomControl: true,
      attributionControl: true,
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // Leaflet: safety net for any late layout settle.
    window.setTimeout(() => map.invalidateSize(), 100);
  }, []);

  // Load waylines list
  useEffect(() => {
    const ctrl = new AbortController();
    fetchWaylines(ctrl.signal)
      .then((r) => {
        setWaylines(r.list);
        if (r.list[0] && !selectedId) setSelectedId(r.list[0].id);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => setLoadingList(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load geojson for the selected route
  useEffect(() => {
    if (!selectedId) return;
    const ctrl = new AbortController();
    setLoadingRoute(true);
    setError(null);
    fetchWaylineGeojson(selectedId, ctrl.signal)
      .then(setGeojson)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => setLoadingRoute(false));
    return () => ctrl.abort();
  }, [selectedId]);

  // Draw route + waypoints when geojson lands
  useEffect(() => {
    const map = mapRef.current;
    const group = routeLayerRef.current;
    if (!map || !group || !geojson) return;
    group.clearLayers();

    const line = geojson.features.find(
      (f) => f.geometry.type === "LineString"
    ) as GeoJSON.Feature<GeoJSON.LineString> | undefined;
    const points = geojson.features.filter(
      (f) => f.geometry.type === "Point"
    ) as GeoJSON.Feature<GeoJSON.Point>[];

    if (line) {
      const latlngs = line.geometry.coordinates.map(
        (c) => [c[1], c[0]] as L.LatLngTuple
      );
      L.polyline(latlngs, { color: "#1a5fad", weight: 3, opacity: 0.9 }).addTo(group);
    }
    for (const p of points) {
      const [lon, lat] = p.geometry.coordinates;
      const idx = (p.properties?.index as number | undefined) ?? 0;
      L.circleMarker([lat, lon], {
        radius: 6,
        fillColor: "#ffffff",
        color: "#1a5fad",
        weight: 2,
        fillOpacity: 1,
      })
        .bindTooltip(String(idx + 1), {
          permanent: false,
          direction: "top",
          offset: [0, -6],
        })
        .addTo(group);
    }

    if (geojson.bbox) {
      const [minLon, minLat, maxLon, maxLat] = geojson.bbox;
      map.invalidateSize();
      map.fitBounds([[minLat, minLon], [maxLat, maxLon]], {
        padding: [40, 40],
        maxZoom: 18,
        animate: true,
      });
      // Once the fitBounds animation ends, invalidate again so any tiles that
      // weren't queued at the initial container size get requested.
      const onEnd = () => {
        map.invalidateSize();
      };
      map.once("moveend", onEnd);
    }
  }, [geojson]);

  const selectedRow = useMemo(
    () => waylines.find((w) => w.id === selectedId),
    [waylines, selectedId]
  );

  return (
    <div className="missions">
      <div className="section-header">
        <h2 className="section-title">Missions</h2>
        <span className="section-meta">
          {loadingList
            ? "Loading…"
            : `${waylines.length} flight route${waylines.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {error && <div className="ml-error">{error}</div>}

      <div className="missions-table-wrap">
        <table className="missions-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Drone</th>
              <th>Sensor</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {waylines.length === 0 && !loadingList && (
              <tr>
                <td colSpan={5} className="missions-empty">
                  No flight routes in this project.
                </td>
              </tr>
            )}
            {waylines.map((w) => (
              <tr
                key={w.id}
                className={w.id === selectedId ? "selected" : undefined}
                onClick={() => setSelectedId(w.id)}
              >
                <td>
                  <span className="missions-name">
                    <LuRoute size={14} /> {w.name}
                  </span>
                </td>
                <td>{templateLabel(w.template_types)}</td>
                <td className="missions-mono">{w.device_model_key ?? "—"}</td>
                <td>
                  {w.payload_information
                    ?.map((p) => p.lens_type)
                    .filter(Boolean)
                    .join(", ") || "—"}
                </td>
                <td>{formatDate(w.update_time)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="missions-map-wrap">
        <div className="missions-map-header">
          <LuMapPin size={14} />
          <span>
            {selectedRow?.name ?? "Select a route"}
            {geojson && ` · ${geojson.meta.waypointCount} waypoints`}
          </span>
          {loadingRoute && <span className="missions-map-loading">Loading route…</span>}
        </div>
        <div ref={mapContainerRef} className="missions-map" />
      </div>
    </div>
  );
}
