import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { EnrollVoicePage } from "@/pages/EnrollVoicePage";
import { RecordSessionPage } from "@/pages/RecordSessionPage";
import { SoapNotePage } from "@/pages/SoapNotePage";
import { TranscriptPage } from "@/pages/TranscriptPage";

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/enroll" replace />} />
        <Route path="/enroll" element={<EnrollVoicePage />} />
        <Route path="/record" element={<RecordSessionPage />} />
        <Route path="/transcript" element={<TranscriptPage />} />
        <Route path="/soap-note" element={<SoapNotePage />} />
      </Route>
    </Routes>
  );
}

export default App;
