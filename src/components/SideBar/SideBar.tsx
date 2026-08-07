import { NavLink } from "react-router-dom";
import { LuLayoutDashboard, LuRadio, LuFolder, LuRoute } from "react-icons/lu";
import "./SideBar.css";

type Item = { to: string; label: string; icon: React.ReactNode };

const OPERATIONS: Item[] = [
  { to: "/", label: "Overview", icon: <LuLayoutDashboard size={16} /> },
  { to: "/live", label: "Live view", icon: <LuRadio size={16} /> },
  { to: "/missions", label: "Missions", icon: <LuRoute size={16} /> },
  { to: "/media", label: "Footage", icon: <LuFolder size={16} /> },
];

function SideItem({ item }: { item: Item }) {
  return (
    <NavLink
      to={item.to}
      end
      className={({ isActive }) => `side-item${isActive ? " active" : ""}`}
    >
      <span className="side-item-icon">{item.icon}</span>
      <span className="side-item-label">{item.label}</span>
    </NavLink>
  );
}

export default function SideBar() {
  return (
    <aside className="sidebar">
      <div className="side-section">
        <div className="side-section-label">Operations</div>
        {OPERATIONS.map((item) => (
          <SideItem key={item.to} item={item} />
        ))}
      </div>
    </aside>
  );
}
