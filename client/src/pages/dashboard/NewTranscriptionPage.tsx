import { useCallback, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AudioPreview } from "@/components/AudioPreview";
import { ErrorBanner } from "@/components/ErrorBanner";
import { JobProgress } from "@/components/JobProgress";
import { ModeToggle } from "@/components/ModeToggle";
import { RecordPanel } from "@/components/RecordPanel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UploadPanel } from "@/components/UploadPanel";
import { useAudioCapture } from "@/hooks/useAudioCapture";
import { useTranscriptionJob } from "@/hooks/useTranscriptionJob";
import { useVoiceProfile } from "@/hooks/useVoiceProfile";
import { MAX_JOB_UPLOAD_BYTES } from "@/lib/limits";
import { USE_MOCK_TRANSCRIPTIONS } from "@/services/transcriptions/transcriptionsService";
import type { AppState } from "@/types";

export function NewTranscriptionPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resumeJobId = searchParams.get("jobId");
  const { mode, setMode, audio, recorder, handleAudioReady, discardAudio, isRecording } =
    useAudioCapture();
  const { job, uploading, error, start, retry, resume, reset } = useTranscriptionJob();
  const { profile: voiceProfile, loading: voiceProfileLoading } = useVoiceProfile();

  // Reopening an in-progress job from the dashboard, rather than starting a new recording.
  useEffect(() => {
    if (resumeJobId) resume(resumeJobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeJobId]);

  useEffect(() => {
    if (job?.status === "completed" && job.transcriptionId) {
      navigate(`/dashboard/transcripts/${job.transcriptionId}`);
    }
  }, [job, navigate]);

  const processing = uploading || (job != null && job.status !== "failed");

  const appState: AppState = error || job?.status === "failed"
    ? "error"
    : processing
      ? "transcribing"
      : audio
        ? "audio-ready"
        : isRecording
          ? "recording"
          : "idle";

  const startOver = useCallback(() => {
    discardAudio();
    reset();
    if (resumeJobId) navigate("/dashboard/new", { replace: true });
  }, [discardAudio, reset, resumeJobId, navigate]);

  const runTranscribe = useCallback(() => {
    if (!audio) return;
    // A consultation is doctor + patient by default; helps the backend's speaker counting.
    start(audio.blob, audio.fileName, 2);
  }, [audio, start]);

  const handleRetry = useCallback(() => {
    if (job?.status === "failed") retry();
    else runTranscribe();
  }, [job, retry, runTranscribe]);

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

          {!voiceProfileLoading && (
            <p className="mb-4 text-xs text-muted-foreground">
              {voiceProfile?.status === "enrolled" ? (
                "Doctor voice matching is available for this recording."
              ) : (
                <>
                  Automatic doctor voice identification is unavailable until a voice
                  profile is created.{" "}
                  <Link to="/dashboard/voice-profile" className="underline underline-offset-2">
                    Set up now
                  </Link>
                  .
                </>
              )}
            </p>
          )}

          {appState === "error" && (
            <ErrorBanner
              code={job?.error?.code ?? error?.code ?? "SERVER_ERROR"}
              message={job?.error?.message ?? error?.message ?? "Something went wrong."}
              onRetry={handleRetry}
              onStartOver={startOver}
            />
          )}

          {appState === "transcribing" && <JobProgress uploading={uploading} job={job} />}

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
                <UploadPanel onSelected={handleAudioReady} maxFileBytes={MAX_JOB_UPLOAD_BYTES} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
