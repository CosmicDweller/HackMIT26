import { requireUserId, delay } from "@/services/transcriptions/mockTranscriptionsStore";
import { TranscribeApiError } from "@/services/transcribeApi";
import {
  CONSENT_VERSION,
  isEnrolled,
  notEnrolled,
  profiles,
  REQUIRED_SAMPLES,
} from "@/services/voiceProfile/mockVoiceProfileStore";
import type { VoiceProfileApi } from "@/services/voiceProfile/voiceProfileApiTypes";

/** MOCK voice-profile backend, matching Contract v4. Disable via VITE_USE_MOCK_VOICE_PROFILE=false
 * once the real backend (now merged on `main`) is available to test against. */
export const mockVoiceProfileApi: VoiceProfileApi = {
  async get() {
    const ownerId = await requireUserId();
    await delay(undefined, 300);
    return profiles.get(ownerId) ?? notEnrolled();
  },

  async enroll(samples, consentVersion) {
    const ownerId = await requireUserId();
    if (consentVersion !== CONSENT_VERSION) {
      throw new TranscribeApiError({
        error: "Explicit voice-enrollment consent is required.",
        code: "CONSENT_REQUIRED",
      });
    }
    if (samples.length !== REQUIRED_SAMPLES || samples.some((s) => s.size === 0)) {
      throw new TranscribeApiError({
        error: `Send exactly ${REQUIRED_SAMPLES} voice samples.`,
        code: "INVALID_REQUEST",
      });
    }
    await delay(undefined, 1500);
    const now = new Date().toISOString();
    const existing = profiles.get(ownerId);
    const profile = {
      status: "enrolled" as const,
      requiredSamples: REQUIRED_SAMPLES,
      consent: notEnrolled().consent,
      enrolledAt: existing?.enrolledAt ?? now,
      updatedAt: now,
      sampleCount: samples.length,
      modelVersion: "mock-ecapa-v1",
      consentRecordedAt: now,
    };
    profiles.set(ownerId, profile);
    return profile;
  },

  async remove() {
    const ownerId = await requireUserId();
    await delay(undefined, 300);
    if (!isEnrolled(ownerId)) {
      throw new TranscribeApiError({ error: "You have no voice profile.", code: "NOT_FOUND" });
    }
    profiles.delete(ownerId);
  },
};
