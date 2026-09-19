import { useCallback } from "react";
import { AudioPreview } from "@/components/AudioPreview";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Hero } from "@/components/Hero";
import { MockModeBadge } from "@/components/MockModeBadge";
import { ModeToggle } from "@/components/ModeToggle";
import { RecordPanel } from "@/components/RecordPanel";
import { TranscribingState } from "@/components/TranscribingState";
import { TranscriptResult } from "@/components/TranscriptResult";
import { Card, CardContent } from "@/components/ui/card";
import { UploadPanel } from "@/components/UploadPanel";
import { useAudioCapture } from "@/hooks/useAudioCapture";
import { useTranscription } from "@/hooks/useTranscription";
import { USE_MOCK_API } from "@/services/transcriptionService";
import type { AppState } from "@/types";

/** The original anonymous, single-speaker quick-transcribe experience. Preserved as-is. */
export function QuickTranscribePage() {
  const { mode, setMode, audio, recorder, handleAudioReady, discardAudio, isRecording } =
    useAudioCapture();
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
          : isRecording
            ? "recording"
            : "idle";

  const startOver = useCallback(() => {
    discardAudio();
    reset();
  }, [discardAudio, reset]);

  const runTranscribe = useCallback(() => {
    if (!audio) return;
    transcribe(audio.blob, audio.fileName);
  }, [audio, transcribe]);

  return (
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
  );
}
