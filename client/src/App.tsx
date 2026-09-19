import { Navigate, Route, Routes } from "react-router-dom";
import { DashboardLayout } from "@/components/dashboard/DashboardLayout";
import { Header } from "@/components/Header";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AccountPage } from "@/pages/dashboard/AccountPage";
import { DashboardHomePage } from "@/pages/dashboard/DashboardHomePage";
import { NewTranscriptionPage } from "@/pages/dashboard/NewTranscriptionPage";
import { TranscriptHistoryPage } from "@/pages/dashboard/TranscriptHistoryPage";
import { TranscriptViewerPage } from "@/pages/dashboard/TranscriptViewerPage";
import { VoiceProfilePage } from "@/pages/dashboard/VoiceProfilePage";
import { LoginPage } from "@/pages/auth/LoginPage";
import { ResetPasswordPage } from "@/pages/auth/ResetPasswordPage";
import { SignupPage } from "@/pages/auth/SignupPage";
import { QuickTranscribePage } from "@/pages/QuickTranscribePage";

function QuickTranscribeRoute() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <Header />
      <QuickTranscribePage />
    </div>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<QuickTranscribeRoute />} />

      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<DashboardLayout />}>
          <Route path="/dashboard" element={<DashboardHomePage />} />
          <Route path="/dashboard/new" element={<NewTranscriptionPage />} />
          <Route path="/dashboard/history" element={<TranscriptHistoryPage />} />
          <Route path="/dashboard/transcripts/:id" element={<TranscriptViewerPage />} />
          <Route path="/dashboard/account" element={<AccountPage />} />
          <Route path="/dashboard/voice-profile" element={<VoiceProfilePage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
