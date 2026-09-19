import { useCallback, useEffect, useState } from "react";
import { AudioPreview } from "@/components/AudioPreview";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { MockModeBadge } from "@/components/MockModeBadge";
import { ModeToggle } from "@/components/ModeToggle";
import { RecordPanel } from "@/components/RecordPanel";
import { TranscribingState } from "@/components/TranscribingState";
import { TranscriptResult } from "@/components/TranscriptResult";
import { Card, CardContent } from "@/components/ui/card";
import { UploadPanel } from "@/components/UploadPanel";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { useTranscription } from "@/hooks/useTranscription";
import { USE_MOCK_API } from "@/services/transcriptionService";
import type { AppState, AudioAsset, AudioSource } from "@/types";

function App() {
  const [mode, setMode] = useState<AudioSource>("recording");
  const [audio, setAudio] = useState<AudioAsset | null>(null);
  const recorder = useAudioRecorder();
  const { transcribing, transcript, durationSeconds, error, transcribe, reset, setTranscript } =
    useTranscription();

  const appState: AppState = error
    ? "error"
    : transcribing
      ? "transcribing"
      : transcript != null
        ? "success"
        : audio
          ? "audio-ready"
          : recorder.status === "recording"
            ? "recording"
            : "idle";

  const handleAudioReady = useCallback((asset: AudioAsset) => {
    setAudio((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return asset;
    });
  }, []);

  useEffect(() => {
    if (!recorder.recordedAudio) return;
    handleAudioReady({
      blob: recorder.recordedAudio.blob,
      source: "recording",
      fileName: `recording-${Date.now()}.webm`,
      mimeType: recorder.recordedAudio.mimeType,
      url: URL.createObjectURL(recorder.recordedAudio.blob),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.recordedAudio]);

  const discardAudio = useCallback(() => {
    setAudio((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    recorder.reset();
  }, [recorder]);

  const startOver = useCallback(() => {
    discardAudio();
    reset();
  }, [discardAudio, reset]);

  const runTranscribe = useCallback(() => {
    if (!audio) return;
    transcribe(audio.blob, audio.fileName);
  }, [audio, transcribe]);

  return (
    <div className="min-h-svh bg-background text-foreground">
      <Header />
      <main className="pb-16">
        <Hero />

        <div className="mx-auto max-w-lg px-6">
          {USE_MOCK_API && (
            <div className="mb-4 flex justify-center">
              <MockModeBadge />
            </div>
          )}

          <Card>
            <CardContent>
              {appState === "error" && error && (
                <ErrorBanner
                  code={error.code}
                  message={error.message}
                  onRetry={runTranscribe}
                  onStartOver={startOver}
                />
              )}

              {appState === "transcribing" && <TranscribingState />}

              {appState === "success" && transcript != null && (
                <TranscriptResult
                  transcript={transcript}
                  durationSeconds={durationSeconds}
                  onChange={setTranscript}
                  onNewTranscription={startOver}
                />
              )}

              {appState === "audio-ready" && audio && (
                <AudioPreview
                  audio={audio}
                  onTranscribe={runTranscribe}
                  onDiscard={discardAudio}
                />
              )}

              {(appState === "idle" || appState === "recording") && (
                <>
                  <div className="flex justify-center pt-2">
                    <ModeToggle
                      mode={mode}
                      onChange={setMode}
                      disabled={appState === "recording"}
                    />
                  </div>
                  {mode === "recording" ? (
                    <RecordPanel
                      status={recorder.status}
                      elapsedSeconds={recorder.elapsedSeconds}
                      permissionDenied={recorder.permissionDenied}
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
      </main>
    </div>
  );
}

export default App;
