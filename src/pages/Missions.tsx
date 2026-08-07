import Header from "../components/Header/Header";
import SideBar from "../components/SideBar/SideBar";
import Missions from "../components/Missions/Missions";

export default function MissionsPage() {
  return (
    <>
      <Header />
      <div className="main">
        <SideBar />
        <div className="main-content">
          <Missions />
        </div>
      </div>
    </>
  );
}
