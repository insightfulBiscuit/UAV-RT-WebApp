import { LuMail } from "react-icons/lu";
import "./NotificationsPanel.css";

interface NotifItemProps {
  title: string;
  meta: string;
  variant: "fire" | "person";
}

function NotifItem({ title, meta, variant }: NotifItemProps) {
  return (
    <div className="notif-item">
      <div className={`notif-icon ${variant}`}>
        <LuMail size={16} color="#fff" />
      </div>
      <div>
        <div className="notif-title">{title}</div>
        <div className="notif-meta">{meta}</div>
      </div>
    </div>
  );
}

export default function NotificationsPanel() {
  return (
    <div className="notifications-card">
      <div className="notifications-title">Notifications sent</div>
      <div className="notif-list">
        <NotifItem
          variant="fire"
          title="Fire alert → Campus safety team"
          meta="Sent 2:15 PM · 3 recipients"
        />
        <NotifItem
          variant="person"
          title="Person detected → Outreach coordinator"
          meta="Sent 11:52 AM · 1 recipient"
        />
      </div>
    </div>
  );
}
