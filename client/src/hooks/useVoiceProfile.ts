import { useCallback, useEffect, useState } from "react";
import { TranscribeApiError } from "@/services/transcribeApi";
import { voiceProfile as voiceProfileApi } from "@/services/voiceProfile/voiceProfileService";
import type { VoiceProfile } from "@/types";

export function useVoiceProfile() {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProfile(await voiceProfileApi.get());
    } catch (err) {
      setError(err instanceof TranscribeApiError ? err.message : "Couldn't load your voice profile.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enroll = useCallback(async (samples: Blob[], consentVersion: string) => {
    const updated = await voiceProfileApi.enroll(samples, consentVersion);
    // The enroll response carries only the profile's own fields — `consent` and
    // `requiredSamples` come from GET and are absent here (verified against the real
    // backend). Merge so those stay populated; replacing outright would leave them
    // undefined despite the type saying otherwise, crashing anything reading
    // profile.consent.text after an enrollment.
    setProfile((prev) => (prev ? { ...prev, ...updated } : updated));
    return updated;
  }, []);

  const remove = useCallback(async () => {
    await voiceProfileApi.remove();
    setProfile(null);
    await refresh();
  }, [refresh]);

  return { profile, loading, error, enroll, remove, refresh };
}
