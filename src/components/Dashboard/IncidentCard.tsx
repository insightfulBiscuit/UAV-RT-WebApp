import "./IncidentCard.css";

export type BadgeVariant = "urgent" | "review" | "resolved";

interface IncidentCardProps {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  time: string;
  km: string;
  sensor: string;
  badge: string;
  badgeVariant: BadgeVariant;
}

export default function IncidentCard({
  icon,
  iconBg,
  title,
  time,
  km,
  sensor,
  badge,
  badgeVariant,
}: IncidentCardProps) {
  return (
    <div className="incident-card">
      <div className="incident-icon" style={{ backgroundColor: iconBg }}>
        {icon}
      </div>
      <div className="incident-info">
        <div className="incident-title">{title}</div>
        <div className="incident-meta">
          <span>{time}</span>
          <span className="dot">·</span>
          <span>{km}</span>
          <span className="dot">·</span>
          <span>{sensor}</span>
        </div>
      </div>
      <span className={`incident-badge ${badgeVariant}`}>{badge}</span>
      <button className="incident-view-btn">View →</button>
    </div>
  );
}
