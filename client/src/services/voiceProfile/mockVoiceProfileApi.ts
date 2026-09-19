import { requireUserId, delay } from "@/services/transcriptions/mockTranscriptionsStore";
import { TranscribeApiError } from "@/services/transcribeApi";
import { NOT_ENROLLED, profiles } from "@/services/voiceProfile/mockVoiceProfileStore";
import type { VoiceProfileApi } from "@/services/voiceProfile/voiceProfileApiTypes";

const MIN_SAMPLES = 3;

/** MOCK voice-profile backend. Disable via VITE_USE_MOCK_VOICE_PROFILE=false once the real endpoints exist. */
export const mockVoiceProfileApi: VoiceProfileApi = {
  async get() {
    const ownerId = await requireUserId();
    await delay(undefined, 300);
    return profiles.get(ownerId) ?? NOT_ENROLLED;
  },

  async enroll(samples) {
    const ownerId = await requireUserId();
    if (samples.length < MIN_SAMPLES || samples.some((s) => s.size === 0)) {
      throw new TranscribeApiError({
        error: "Please record all three voice samples before submitting.",
        code: "INVALID_REQUEST",
      });
    }
    await delay(undefined, 1500);
    const profile = {
      status: "enrolled" as const,
      enrolledAt: new Date().toISOString(),
      sampleCount: samples.length,
      modelVersion: "mock-voice-v1",
    };
    profiles.set(ownerId, profile);
    return profile;
  },

  async remove() {
    const ownerId = await requireUserId();
    await delay(undefined, 300);
    profiles.delete(ownerId);
  },
};
