import { AlertTriangle, Mic, Pause, Play, Square } from "lucide-react";
import { LiveWaveform } from "@/components/LiveWaveform";
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
  stream: MediaStream | null;
  permissionDenied: boolean;
  interrupted: boolean;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
}

export function RecordPanel({
  status,
  elapsedSeconds,
  stream,
  permissionDenied,
  interrupted,
  error,
  onStart,
  onStop,
  onPause,
  onResume,
}: RecordPanelProps) {
  const isRecording = status === "recording";
  const isPaused = status === "paused";
  const isActive = isRecording || isPaused;
  const nearLimit = elapsedSeconds >= RECORDING_WARNING_THRESHOLD_SECONDS;

  return (
    <div className="flex flex-col items-center gap-5 py-6">
      {isActive && <LiveWaveform stream={stream} className="max-w-sm" />}

      {isActive ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={isPaused ? onResume : onPause}
            className="flex size-14 items-center justify-center rounded-full border border-border bg-card text-foreground transition-all hover:border-foreground/30"
            aria-label={isPaused ? "Resume recording" : "Pause recording"}
          >
            {isPaused ? <Play className="size-5" /> : <Pause className="size-5" />}
          </button>
          <button
            type="button"
            onClick={onStop}
            className="flex size-20 items-center justify-center rounded-full border border-destructive bg-destructive/10 text-destructive transition-all"
            aria-label="Stop recording"
          >
            <Square className="size-7 fill-current" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onStart}
          disabled={status === "requesting"}
          className="flex size-20 items-center justify-center rounded-full border border-border bg-card text-foreground transition-all hover:border-foreground/30"
          aria-label="Start recording"
        >
          <Mic className="size-8" />
        </button>
      )}

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
          : isPaused
            ? "Paused — tap play to resume."
            : isRecording
              ? "Recording — tap pause or stop."
              : "Tap the microphone to start recording."}
      </p>

      {isRecording && nearLimit && (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          Approaching the {formatClock(MAX_RECORDING_SECONDS)} limit — recording
          will stop automatically.
        </p>
      )}

      {isActive && (
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
