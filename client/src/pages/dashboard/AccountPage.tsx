import { AlertTriangle, Loader2, Mic } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { useVoiceProfile } from "@/hooks/useVoiceProfile";
import { formatDate } from "@/lib/format";

function VoiceProfileSection() {
  const { profile, loading, error, remove } = useVoiceProfile();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function handleDelete() {
    if (!window.confirm("Delete your voice profile? This disables automatic doctor voice matching for future consultations until you re-enroll.")) {
      return;
    }
    setRemoving(true);
    setRemoveError(null);
    try {
      await remove();
    } catch {
      setRemoveError("Couldn't delete your voice profile. Try again.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <Mic className="size-4" />
          Voice profile
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {!loading && !error && (!profile || profile.status === "not_enrolled") && (
          <>
            <p className="text-sm text-foreground">No voice profile has been created.</p>
            <Button size="sm" render={<Link to="/dashboard/voice-profile" />} nativeButton={false}>
              Create Voice Profile
            </Button>
          </>
        )}

        {!loading && !error && profile?.status === "enrolled" && (
          <>
            <p className="text-sm text-foreground">Voice profile active.</p>
            <p className="text-xs text-muted-foreground">
              {profile.enrolledAt && `Enrolled ${formatDate(profile.enrolledAt)}`}
              {profile.modelVersion && ` · Model ${profile.modelVersion}`}
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" render={<Link to="/dashboard/voice-profile" />} nativeButton={false}>
                Replace Voice Profile
              </Button>
              <Button size="sm" variant="destructive" onClick={handleDelete} disabled={removing}>
                {removing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Delete Voice Profile
              </Button>
            </div>
            {removeError && <p className="text-xs text-destructive">{removeError}</p>}
          </>
        )}

        {!loading && !error && profile?.status === "needs_reenrollment" && (
          <>
            <p className="flex items-center gap-2 text-sm text-foreground">
              <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />
              Your voice profile needs to be re-recorded.
            </p>
            <Button size="sm" render={<Link to="/dashboard/voice-profile" />} nativeButton={false}>
              Record New Samples
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function AccountPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate("/login", { replace: true });
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Account</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">Signed in as</CardTitle>
          <CardDescription className="text-base text-foreground">{user?.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={handleSignOut}>
            Sign out
          </Button>
        </CardContent>
      </Card>
      <VoiceProfileSection />
      <p className="text-xs text-muted-foreground">
        A doctor account identifies you as an application user; it does not verify a medical
        license. This app does not provide diagnosis, treatment recommendations, or automated
        clinical decision-making, and is not HIPAA-compliant. Use synthetic data for testing.
      </p>
    </div>
  );
}
