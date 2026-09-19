import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { enrollVoiceProfile } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";

function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function EnrollVoicePage() {
  const navigate = useNavigate();
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { status, elapsedMs, audioBlob, error, start, stop, reset } =
    useAudioRecorder();

  const canSubmit = label.trim().length > 0 && audioBlob && !submitting;

  async function handleSubmit() {
    if (!audioBlob) return;
    setSubmitting(true);
    try {
      await enrollVoiceProfile(label.trim(), audioBlob);
      navigate("/record");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>Voice Enrollment</CardTitle>
          <CardDescription>
            Record a short sample so we can tell this speaker apart from
            others during the visit.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="speaker-label">Speaker name / role</Label>
            <Input
              id="speaker-label"
              placeholder="e.g. Dr. Patel or Patient"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={status === "recording"}
            />
          </div>

          <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-8">
            <div className="text-3xl font-mono tabular-nums">
              {formatDuration(elapsedMs)}
            </div>
            {status !== "recording" ? (
              <Button
                onClick={() => {
                  reset();
                  start();
                }}
              >
                {audioBlob ? "Record Again" : "Start Recording"}
              </Button>
            ) : (
              <Button variant="destructive" onClick={stop}>
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
          <Button disabled={!canSubmit} onClick={handleSubmit}>
            {submitting ? "Saving profile..." : "Save Voice Profile"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
