import Header from "../components/Header/Header";
import SideBar from "../components/SideBar/SideBar";
import Livestream from "../components/Livestream/Livestream";

export default function Live() {
  return (
    <>
      <Header />
      <div className="main">
        <SideBar />
        <div className="main-content">
          <Livestream />
        </div>
      </div>
    </>
  );
}
