import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { AudioPreview } from "@/components/AudioPreview";
import { ErrorBanner } from "@/components/ErrorBanner";
import { ModeToggle } from "@/components/ModeToggle";
import { RecordPanel } from "@/components/RecordPanel";
import { TranscribingState } from "@/components/TranscribingState";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UploadPanel } from "@/components/UploadPanel";
import { useAudioCapture } from "@/hooks/useAudioCapture";
import { useCreateTranscription } from "@/hooks/useCreateTranscription";
import { USE_MOCK_TRANSCRIPTIONS } from "@/services/transcriptions/transcriptionsService";
import type { AppState } from "@/types";

export function NewTranscriptionPage() {
  const navigate = useNavigate();
  const { mode, setMode, audio, recorder, handleAudioReady, discardAudio, isRecording } =
    useAudioCapture();
  const { creating, error, create, reset } = useCreateTranscription();

  const appState: AppState = error
    ? "error"
    : creating
      ? "transcribing"
      : audio
        ? "audio-ready"
        : isRecording
          ? "recording"
          : "idle";

  const startOver = useCallback(() => {
    discardAudio();
    reset();
  }, [discardAudio, reset]);

  const runTranscribe = useCallback(async () => {
    if (!audio) return;
    // A consultation is doctor + patient by default; helps the backend's speaker counting.
    const result = await create(audio.blob, audio.fileName, 2);
    if (result) navigate(`/dashboard/transcripts/${result.id}`);
  }, [audio, create, navigate]);

  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>New transcription</CardTitle>
          <CardDescription>
            Record or upload the consultation. We'll separate it by speaker so you can
            confirm who's who.
            {USE_MOCK_TRANSCRIPTIONS && (
              <span className="mt-1 block text-amber-600 dark:text-amber-500">
                Mock mode — diarization backend not connected. A synthetic sample
                transcript is used instead of your actual audio.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            Reminder: make sure you have the patient's consent to record. This reminder
            doesn't by itself satisfy your institution's or jurisdiction's recording
            requirements — that's on you to confirm. Audio may be processed by an
            external speech-recognition provider depending on backend configuration
            (shown on each transcript as "processed locally" or "processed by
            Deepgram"); this app is not HIPAA-compliant.
          </p>

          {appState === "error" && error && (
            <ErrorBanner
              code={error.code}
              message={error.message}
              onRetry={runTranscribe}
              onStartOver={startOver}
            />
          )}

          {appState === "transcribing" && <TranscribingState />}

          {appState === "audio-ready" && audio && (
            <AudioPreview audio={audio} onTranscribe={runTranscribe} onDiscard={discardAudio} />
          )}

          {(appState === "idle" || appState === "recording") && (
            <>
              <div className="flex justify-center pt-2">
                <ModeToggle mode={mode} onChange={setMode} disabled={appState === "recording"} />
              </div>
              {mode === "recording" ? (
                <RecordPanel
                  status={recorder.status}
                  elapsedSeconds={recorder.elapsedSeconds}
                  permissionDenied={recorder.permissionDenied}
                  interrupted={recorder.interrupted}
                  error={recorder.error}
                  onStart={recorder.start}
                  onStop={recorder.stop}
                />
              ) : (
                <UploadPanel onSelected={handleAudioReady} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
