import { FilePlus2, Loader2, Mic, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ReviewStatusBadge } from "@/components/dashboard/ReviewStatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useActiveJobs } from "@/hooks/useActiveJobs";
import { useAuth } from "@/hooks/useAuth";
import { useTranscriptionList } from "@/hooks/useTranscriptionList";
import { useVoiceProfile } from "@/hooks/useVoiceProfile";
import { formatDate, formatSeconds } from "@/lib/format";

function voiceOnboardingDismissKey(userId: string) {
  return `voiceProfileOnboardingDismissed:${userId}`;
}

function VoiceProfileOnboardingBanner({ userId }: { userId: string }) {
  const { profile, loading } = useVoiceProfile();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(voiceOnboardingDismissKey(userId)) === "1";
    } catch {
      return false;
    }
  });

  if (loading || dismissed || profile?.status !== "not_enrolled") return null;

  function handleSkip() {
    try {
      localStorage.setItem(voiceOnboardingDismissKey(userId), "1");
    } catch {
      // localStorage unavailable (private browsing, etc.) — just dismiss for this render.
    }
    setDismissed(true);
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <Mic className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Set Up Your Voice Profile</p>
            <p className="text-xs text-muted-foreground">
              Record a short sample of your voice to help identify your speech in future
              consultations.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleSkip}>
            <X className="size-3.5" />
            Skip for Now
          </Button>
          <Button size="sm" render={<Link to="/dashboard/voice-profile" />} nativeButton={false}>
            Set Up Voice Profile
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function DashboardHomePage() {
  const { user } = useAuth();
  const { items, error } = useTranscriptionList();
  const activeJobs = useActiveJobs();
  const recent = items?.slice(0, 5) ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome{user ? `, ${user.email}` : ""}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Record or upload a consultation to get a speaker-separated transcript.
          </p>
        </div>
        <Button render={<Link to="/dashboard/new" />} nativeButton={false}>
          <FilePlus2 className="size-4" />
          New transcription
        </Button>
      </div>

      {user && <VoiceProfileOnboardingBanner userId={user.id} />}

      {activeJobs != null && activeJobs.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">Processing</h2>
          <div className="space-y-2">
            {activeJobs.map((job) => (
              <Link key={job.jobId} to={`/dashboard/new?jobId=${job.jobId}`}>
                <Card className="transition-colors hover:bg-muted/50">
                  <CardContent className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      <p className="text-sm font-medium">
                        {job.createdAt ? formatDate(job.createdAt) : "New recording"}
                      </p>
                    </div>
                    <span className="text-xs capitalize text-muted-foreground">{job.status}</span>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Recent transcripts</h2>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {items === null && !error && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {items?.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No transcripts yet. Start your first one above.
            </CardContent>
          </Card>
        )}
        <div className="space-y-2">
          {recent.map((t) => (
            <Link key={t.id} to={`/dashboard/transcripts/${t.id}`}>
              <Card className="transition-colors hover:bg-muted/50">
                <CardContent className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{formatDate(t.createdAt)}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.durationSeconds != null ? formatSeconds(t.durationSeconds) : "Unknown length"}
                    </p>
                  </div>
                  <ReviewStatusBadge status={t.reviewStatus} />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
