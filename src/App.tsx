import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Media from "./pages/Media";
import Live from "./pages/Live";
import MissionsPage from "./pages/Missions";

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/media" element={<Media />} />
        <Route path="/live" element={<Live />} />
        <Route path="/missions" element={<MissionsPage />} />
      </Routes>
    </Router>
  );
}
