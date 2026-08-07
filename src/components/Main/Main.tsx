import SideBar from '../SideBar/SideBar';
import Dashboard from '../Dashboard/Dashboard';
import './Main.css';

export default function Main() {
  return (
    <div className="main">
      <SideBar />
      <div className="main-content">
        <Dashboard />
      </div>
    </div>
  );
}
