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

  const enroll = useCallback(async (samples: Blob[]) => {
    const updated = await voiceProfileApi.enroll(samples);
    setProfile(updated);
    return updated;
  }, []);

  const remove = useCallback(async () => {
    await voiceProfileApi.remove();
    setProfile(null);
    await refresh();
  }, [refresh]);

  return { profile, loading, error, enroll, remove, refresh };
}
