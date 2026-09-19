import { AlertTriangle, Mic, Square } from "lucide-react";
import {
  MAX_RECORDING_SECONDS,
  RECORDING_WARNING_THRESHOLD_SECONDS,
  type RecorderStatus,
} from "@/hooks/useAudioRecorder";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";

interface RecordPanelProps {
  status: RecorderStatus;
  elapsedSeconds: number;
  permissionDenied: boolean;
  interrupted: boolean;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
}

export function RecordPanel({
  status,
  elapsedSeconds,
  permissionDenied,
  interrupted,
  error,
  onStart,
  onStop,
}: RecordPanelProps) {
  const isRecording = status === "recording";
  const nearLimit = elapsedSeconds >= RECORDING_WARNING_THRESHOLD_SECONDS;

  return (
    <div className="flex flex-col items-center gap-5 py-6">
      <button
        type="button"
        onClick={isRecording ? onStop : onStart}
        disabled={status === "requesting"}
        className={cn(
          "flex size-20 items-center justify-center rounded-full border transition-all",
          isRecording
            ? "border-destructive bg-destructive/10 text-destructive"
            : "border-border bg-card text-foreground hover:border-foreground/30",
        )}
        aria-label={isRecording ? "Stop recording" : "Start recording"}
      >
        {isRecording ? (
          <Square className="size-7 fill-current" />
        ) : (
          <Mic className="size-8" />
        )}
      </button>

      <div
        className={cn(
          "font-mono text-2xl tabular-nums",
          nearLimit ? "text-destructive" : "text-foreground",
        )}
      >
        {formatClock(elapsedSeconds)}{" "}
        <span className="text-sm text-muted-foreground">
          / {formatClock(MAX_RECORDING_SECONDS)}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        {status === "requesting"
          ? "Requesting microphone access…"
          : isRecording
            ? "Recording — tap to stop."
            : "Tap the microphone to start recording."}
      </p>

      {isRecording && nearLimit && (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          Approaching the {formatClock(MAX_RECORDING_SECONDS)} limit — recording
          will stop automatically.
        </p>
      )}

      {isRecording && (
        <p className="max-w-sm text-center text-xs text-muted-foreground">
          Keep this tab open and your computer awake for the whole
          consultation — recording stops if the tab closes or the computer
          sleeps.
        </p>
      )}

      {permissionDenied && (
        <p className="max-w-sm text-center text-sm text-destructive">
          Microphone access was denied. Allow microphone permission for this
          site in your browser settings, then try again.
        </p>
      )}
      {interrupted && (
        <p className="max-w-sm text-center text-sm text-destructive">
          Recording was interrupted (microphone disconnected or permission
          revoked). What was captured before the interruption is preserved
          below — review it, or start over.
        </p>
      )}
      {error && (
        <p className="max-w-sm text-center text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
