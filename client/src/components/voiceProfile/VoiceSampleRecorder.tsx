import { Mic, Pause, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { LiveWaveform } from "@/components/LiveWaveform";
import { Button } from "@/components/ui/button";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Matches the real backend's enrollment thresholds (server/voice/calibration.json):
 * minVoicedSeconds 6 (we suggest 10 for margin), maxSampleSeconds 60. */
const TARGET_MAX_SECONDS = 60;
const TARGET_MIN_SECONDS = 10;

interface VoiceSampleRecorderProps {
  index: number;
  phrase: string;
  blob: Blob | null;
  onRecorded: (blob: Blob) => void;
  onClear: () => void;
}

export function VoiceSampleRecorder({ index, phrase, blob, onRecorded, onClear }: VoiceSampleRecorderProps) {
  const recorder = useAudioRecorder();

  useEffect(() => {
    if (recorder.status === "recording" && recorder.elapsedSeconds >= TARGET_MAX_SECONDS) {
      recorder.stop();
    }
  }, [recorder]);

  useEffect(() => {
    if (recorder.recordedAudio) onRecorded(recorder.recordedAudio.blob);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.recordedAudio]);

  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  function handleRerecord() {
    onClear();
    recorder.reset();
    recorder.start();
  }

  const isRecording = recorder.status === "recording";
  const isPaused = recorder.status === "paused";
  const isActive = isRecording || isPaused;
  const tooShort = recorder.status === "stopped" && recorder.elapsedSeconds < TARGET_MIN_SECONDS;

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Sample {index}</p>
        {blob && (
          <span className="text-xs text-muted-foreground">{formatClock(recorder.elapsedSeconds)}</span>
        )}
      </div>
      <p className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">"{phrase}"</p>

      {!blob ? (
        <div className="flex flex-col items-center gap-3 py-2">
          {isActive && <LiveWaveform stream={recorder.stream} className="max-w-xs" />}
          <div className="flex items-center gap-2">
            {isActive && (
              <button
                type="button"
                onClick={isPaused ? recorder.resume : recorder.pause}
                className="flex size-10 items-center justify-center rounded-full border border-border bg-card text-foreground transition-all hover:border-foreground/30"
                aria-label={isPaused ? "Resume recording" : "Pause recording"}
              >
                {isPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
              </button>
            )}
            <button
              type="button"
              onClick={isActive ? recorder.stop : recorder.start}
              disabled={recorder.status === "requesting"}
              className={cn(
                "flex size-14 items-center justify-center rounded-full border transition-all",
                isActive
                  ? "border-destructive bg-destructive/10 text-destructive"
                  : "border-border bg-card text-foreground hover:border-foreground/30",
              )}
              aria-label={isActive ? "Stop recording" : "Start recording this sample"}
            >
              {isActive ? <Square className="size-5 fill-current" /> : <Mic className="size-6" />}
            </button>
          </div>
          <p className="font-mono text-sm tabular-nums text-muted-foreground">
            {formatClock(recorder.elapsedSeconds)} / {formatClock(TARGET_MAX_SECONDS)}
            {isPaused && " · Paused"}
          </p>
          {recorder.permissionDenied && (
            <p className="max-w-xs text-center text-xs text-destructive">
              Microphone access was denied. Allow microphone permission for this site, then try again.
            </p>
          )}
          {recorder.error && <p className="max-w-xs text-center text-xs text-destructive">{recorder.error}</p>}
        </div>
      ) : (
        <div className="space-y-2">
          <audio controls src={url ?? undefined} className="w-full" />
          {tooShort && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              That was shorter than {TARGET_MIN_SECONDS}s — consider re-recording for a cleaner sample.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={handleRerecord}>
              <RotateCcw className="size-3.5" />
              Re-record
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onClear();
                recorder.reset();
              }}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
