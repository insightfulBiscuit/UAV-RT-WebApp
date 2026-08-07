import { LuNavigation } from "react-icons/lu";
import "./TrailMap.css";

export default function TrailMap() {
  return (
    <div className="trail-map-card">
      <div className="trail-map-title">Trail map</div>
      <div className="trail-map-placeholder">
        <LuNavigation size={36} color="#555" />
        <span className="trail-map-label">8km trail route</span>
      </div>
      <div className="trail-legend">
        <span className="legend-dot fire" />Fire / smoke
        <span className="legend-dot person" />Person
        <span className="legend-dot clear" />Clear
      </div>
    </div>
  );
}
