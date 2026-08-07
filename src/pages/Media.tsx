import Header from "../components/Header/Header";
import SideBar from "../components/SideBar/SideBar";
import MediaLibrary from "../components/MediaLibrary/MediaLibrary";

export default function Media() {
  return (
    <>
      <Header />
      <div className="main">
        <SideBar />
        <div className="main-content">
          <MediaLibrary />
        </div>
      </div>
    </>
  );
}
