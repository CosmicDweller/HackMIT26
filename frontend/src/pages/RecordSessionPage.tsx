import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { uploadVisitRecording } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";

function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function RecordSessionPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const { status, elapsedMs, audioBlob, error, start, stop, reset } =
    useAudioRecorder();

  async function handleFinish() {
    if (!audioBlob) return;
    setSubmitting(true);
    try {
      await uploadVisitRecording("session-1", audioBlob);
      navigate("/transcript");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Record Patient Visit
            {status === "recording" && (
              <Badge variant="destructive" className="animate-pulse">
                REC
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Record the full conversation. We'll split it into a
            speaker-labeled, timestamped transcript afterward.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-10">
            <div className="text-4xl font-mono tabular-nums">
              {formatDuration(elapsedMs)}
            </div>
            {status !== "recording" ? (
              <Button
                size="lg"
                onClick={() => {
                  reset();
                  start();
                }}
              >
                {audioBlob ? "Record Again" : "Start Visit Recording"}
              </Button>
            ) : (
              <Button size="lg" variant="destructive" onClick={stop}>
                Stop Recording
              </Button>
            )}
            {audioBlob && status === "stopped" && (
              <audio
                controls
                src={URL.createObjectURL(audioBlob)}
                className="w-full"
              />
            )}
            {error && (
              <p className="text-sm text-destructive">
                {error} — check microphone permissions.
              </p>
            )}
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button disabled={!audioBlob || submitting} onClick={handleFinish}>
            {submitting ? "Uploading..." : "Finish & Generate Transcript"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
