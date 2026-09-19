import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { VoiceSampleRecorder } from "@/components/voiceProfile/VoiceSampleRecorder";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useVoiceProfile } from "@/hooks/useVoiceProfile";

const SAMPLE_PHRASES = [
  "Hello, my name is Doctor Smith. I am testing my voice profile for the transcription system.",
  "Please describe how you have been feeling, including any changes in your usual routine.",
  "I would like to understand your symptoms and make sure I have recorded everything correctly.",
];

type Step = "intro" | "record" | "submitting" | "success";

export function VoiceProfilePage() {
  const navigate = useNavigate();
  const { enroll } = useVoiceProfile();
  const [step, setStep] = useState<Step>("intro");
  const [consented, setConsented] = useState(false);
  const [samples, setSamples] = useState<(Blob | null)[]>([null, null, null]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const allRecorded = useMemo(() => samples.every((s) => s != null), [samples]);

  function setSample(index: number, blob: Blob | null) {
    setSamples((prev) => prev.map((s, i) => (i === index ? blob : s)));
  }

  async function handleSubmit() {
    if (!allRecorded) return;
    setSubmitError(null);
    setStep("submitting");
    try {
      await enroll(samples.filter((s): s is Blob => s != null));
      setStep("success");
    } catch {
      setSubmitError("Couldn't create your voice profile. Check your connection and try again.");
      setStep("record");
    }
  }

  if (step === "success") {
    return (
      <div className="mx-auto max-w-md space-y-6 text-center">
        <CheckCircle2 className="mx-auto size-10 text-emerald-600 dark:text-emerald-500" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Voice profile created.</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You can now use voice identification in future consultations. During a
            consultation, speech that matches your profile may be suggested as "Doctor" —
            you'll always confirm it yourself before it's applied.
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <Button variant="outline" onClick={() => navigate("/dashboard/account")}>
            Manage Voice Profile
          </Button>
          <Button onClick={() => navigate("/dashboard")}>Go to Dashboard</Button>
        </div>
      </div>
    );
  }

  if (step === "submitting") {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Creating your voice profile…</p>
      </div>
    );
  }

  if (step === "intro") {
    return (
      <div className="mx-auto max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>Set up your voice profile</CardTitle>
            <CardDescription>
              A one-time recording that helps the transcription system recognize your voice
              in future consultations.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                We'll ask you to read three short phrases aloud. A mathematical
                representation of your voice (not the audio itself, once processed) is
                stored so future recordings can be compared against it.
              </p>
              <p>
                Voice recognition can make mistakes — it never proves who is speaking on
                its own, and any match is something you confirm yourself before it's
                applied to a transcript. It is not used to sign in to your account.
              </p>
              <p>
                You can replace or delete your voice profile at any time from Account
                settings. Deleting it disables automatic doctor voice matching for future
                recordings.
              </p>
            </div>

            <Label className="items-start gap-3 rounded-md border border-border p-3">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
                className="mt-0.5 size-4"
              />
              <span className="font-normal text-foreground">
                I consent to recording my voice to create a voice profile for speech
                identification, as described above.
              </span>
            </Label>

            <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Before recording: use a quiet room, speak naturally, avoid background
              voices, keep the microphone near your mouth, use your normal speaking
              voice, and avoid music or overlapping speech.
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" render={<Link to="/dashboard" />} nativeButton={false}>
                Skip for Now
              </Button>
              <Button disabled={!consented} onClick={() => setStep("record")}>
                Set Up Voice Profile
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // step === "record"
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Record your voice samples</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read each phrase aloud (about 10-20 seconds). These are generic phrases — not
          your real name, and not a password.
        </p>
      </div>

      <div className="space-y-4">
        {SAMPLE_PHRASES.map((phrase, i) => (
          <VoiceSampleRecorder
            key={i}
            index={i + 1}
            phrase={phrase}
            blob={samples[i]}
            onRecorded={(blob) => setSample(i, blob)}
            onClear={() => setSample(i, null)}
          />
        ))}
      </div>

      {submitError && (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          {submitError}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" />
          Nothing is uploaded until you submit.
        </p>
        <Button disabled={!allRecorded} onClick={handleSubmit}>
          Submit enrollment
        </Button>
      </div>
    </div>
  );
}
