import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Media from "./pages/Media";
import Live from "./pages/Live";
import MissionsPage from "./pages/Missions";
import { AlertToasts } from "./components/Alerts/AlertToasts";
import { AlertInboxProvider } from "./lib/alertInboxContext";

export default function App() {
  return (
    <Router>
      <AlertInboxProvider limit={100}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/media" element={<Media />} />
          <Route path="/live" element={<Live />} />
          <Route path="/missions" element={<MissionsPage />} />
        </Routes>
        <AlertToasts />
      </AlertInboxProvider>
    </Router>
  );
}
