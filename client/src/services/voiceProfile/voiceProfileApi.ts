import { apiRequest } from "@/services/transcriptions/apiClient";
import type { VoiceProfileApi } from "@/services/voiceProfile/voiceProfileApiTypes";
import type { VoiceProfile } from "@/types";

/**
 * Real backend calls for the proposed voice-enrollment endpoints (posted to issue #3,
 * not yet implemented by the backend — see docs/API_CONTRACT.md coordination comment).
 * Field names and response shape must be confirmed with the backend agent before this
 * is exercised for real; until then USE_MOCK_VOICE_PROFILE keeps the app on the mock.
 */
export const voiceProfileApi: VoiceProfileApi = {
  get() {
    return apiRequest<VoiceProfile>("/api/me/voice-profile");
  },

  enroll(samples) {
    const formData = new FormData();
    samples.forEach((sample, i) => formData.append("samples", sample, `sample-${i + 1}.webm`));
    return apiRequest<VoiceProfile>("/api/me/voice-profile/enroll", {
      method: "POST",
      body: formData,
    });
  },

  async remove() {
    await apiRequest<undefined>("/api/me/voice-profile", { method: "DELETE" });
  },
};
