import { LuFlame, LuUser } from "react-icons/lu";
import { GiFireworkRocket } from "react-icons/gi";
import StatCard from "./StatCard";
import IncidentCard from "./IncidentCard";
import TrailMap from "./TrailMap";
import NotificationsPanel from "./NotificationsPanel";
import "./Dashboard.css";

// Kelowna brand colours (mirrors kelowna-colors.css variables)
const K = {
  red:       "#C83228",
  redOrange: "#D44820",
  orange:    "#E87820",
  green:     "#4A9E35",
  blue:      "#1A5FAD",
  navy:      "#1B3878",
  teal:      "#1A8A96",
};

export default function Dashboard() {
  return (
    <div className="dashboard">
      {/* Today's summary */}
      <div className="section-header">
        <h2 className="section-title">Today's summary</h2>
        <span className="section-meta">Last flight: 47 min ago</span>
      </div>
      <div className="stat-grid">
        <StatCard label="Flights today"   value="4"   sub="8km trail route" />
        <StatCard label="Incidents found" value="3"   sub="2 unresolved" highlight />
        <StatCard label="Notified"        value="2"   sub="Emails sent" />
        <StatCard label="Coverage"        value="87%" sub="Area scanned" />
      </div>

      {/* Incidents */}
      <div className="section-header">
        <h2 className="section-title">Incidents</h2>
      </div>
      <div className="incidents-list">
        <IncidentCard
          iconBg={K.red}
          icon={<LuFlame size={18} color="#fff" />}
          title="Smoke detected — north ridge trail"
          time="2:14 PM"  km="km 3.2"  sensor="Thermal + RGB"
          badge="Urgent"  badgeVariant="urgent"
        />
        <IncidentCard
          iconBg={K.orange}
          icon={<LuUser size={18} color="#fff" />}
          title="Person detected — east fork camp area"
          time="11:50 AM"  km="km 6.7"  sensor="RGB video"
          badge="Needs review"  badgeVariant="review"
        />
        <IncidentCard
          iconBg={K.teal}
          icon={<GiFireworkRocket size={18} color="#fff" />}
          title="Fireworks — east fork camp area"
          time="9:05 AM"  km="km 1.1"  sensor="RGB"
          badge="Resolved"  badgeVariant="resolved"
        />
      </div>

      {/* Bottom row */}
      <div className="bottom-row">
        <TrailMap />
        <NotificationsPanel />
      </div>
    </div>
  );
}
