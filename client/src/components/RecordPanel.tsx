import { Mic, Square } from "lucide-react";
import { MAX_RECORDING_SECONDS, type RecorderStatus } from "@/hooks/useAudioRecorder";
import { formatSeconds } from "@/lib/format";
import { cn } from "@/lib/utils";

interface RecordPanelProps {
  status: RecorderStatus;
  elapsedSeconds: number;
  permissionDenied: boolean;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
}

export function RecordPanel({
  status,
  elapsedSeconds,
  permissionDenied,
  error,
  onStart,
  onStop,
}: RecordPanelProps) {
  const isRecording = status === "recording";
  const nearLimit = elapsedSeconds >= MAX_RECORDING_SECONDS - 10;

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
        {formatSeconds(elapsedSeconds)}{" "}
        <span className="text-sm text-muted-foreground">
          / {formatSeconds(MAX_RECORDING_SECONDS)}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">
        {status === "requesting"
          ? "Requesting microphone access…"
          : isRecording
            ? "Recording — tap to stop."
            : "Tap the microphone to start recording."}
      </p>

      {permissionDenied && (
        <p className="max-w-sm text-center text-sm text-destructive">
          Microphone access was denied. Allow microphone permission for this
          site in your browser settings, then try again.
        </p>
      )}
      {error && (
        <p className="max-w-sm text-center text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
