import { LuBell, LuMoon, LuSun, LuPlane } from "react-icons/lu";
import { useTheme } from "../../lib/theme";
import "./Header.css";

export default function Header() {
  const [theme, , toggle] = useTheme();
  return (
    <header className="header">
      <div className="header-brand">
        <span className="header-logo-mark" aria-hidden>
          <LuPlane size={16} />
        </span>
        <span className="header-logo-text">UAV-RT</span>
        <span className="header-logo-sub">Kelowna</span>
      </div>

      <div className="header-actions">
        <button
          className="header-icon-btn"
          onClick={toggle}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <LuSun size={16} /> : <LuMoon size={16} />}
        </button>
        <button className="header-icon-btn" aria-label="Notifications">
          <LuBell size={16} />
        </button>
        <div className="header-avatar" aria-label="Signed-in user">JR</div>
      </div>
    </header>
  );
}
