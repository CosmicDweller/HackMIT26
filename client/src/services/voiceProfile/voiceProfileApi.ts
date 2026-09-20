import { apiRequest } from "@/services/transcriptions/apiClient";
import type { VoiceProfileApi } from "@/services/voiceProfile/voiceProfileApiTypes";
import type { VoiceProfile } from "@/types";

/** Real backend calls per docs/API_CONTRACT.md "Contract v4" (implemented on branch lz). */
export const voiceProfileApi: VoiceProfileApi = {
  get() {
    return apiRequest<VoiceProfile>("/api/me/voice-profile");
  },

  enroll(samples, consentVersion) {
    const formData = new FormData();
    samples.forEach((sample, i) => formData.append("samples", sample, `sample-${i + 1}.webm`));
    formData.append("consent", "true");
    formData.append("consentVersion", consentVersion);
    return apiRequest<VoiceProfile>("/api/me/voice-profile/enroll", {
      method: "POST",
      body: formData,
    });
  },

  async remove() {
    // Deleting a biometric profile requires this explicit confirmation header.
    await apiRequest<undefined>("/api/me/voice-profile", {
      method: "DELETE",
      headers: { "X-Confirm": "delete-voice-profile" },
    });
  },
};
