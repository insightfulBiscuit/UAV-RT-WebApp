import './StatCard.css';

interface StatCardProps {
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}

export default function StatCard({ label, value, sub, highlight }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${highlight ? ' highlight' : ''}`}>{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}
