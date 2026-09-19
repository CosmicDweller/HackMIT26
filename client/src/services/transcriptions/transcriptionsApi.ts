import { apiRequest } from "@/services/transcriptions/apiClient";
import type { TranscriptionsApi } from "@/services/transcriptions/transcriptionsApiTypes";
import type { Transcription, TranscriptionSummary } from "@/types";

/** Real backend calls per the contract agreed on issue #3 (docs/API_CONTRACT.md v2). */

export const transcriptionsApi: TranscriptionsApi = {
  async create(audio, fileName, expectedSpeakers) {
    const formData = new FormData();
    formData.append("audio", audio, fileName);
    if (expectedSpeakers != null) {
      formData.append("expectedSpeakers", String(expectedSpeakers));
    }
    return apiRequest<Transcription>("/api/transcriptions", {
      method: "POST",
      body: formData,
    });
  },

  async list() {
    const payload = await apiRequest<{ transcriptions: TranscriptionSummary[] }>(
      "/api/transcriptions",
    );
    return payload.transcriptions;
  },

  get(id) {
    return apiRequest<Transcription>(`/api/transcriptions/${id}`);
  },

  async remove(id) {
    await apiRequest<undefined>(`/api/transcriptions/${id}`, { method: "DELETE" });
  },

  updateSpeaker(id, speakerId, role) {
    return apiRequest<Transcription>(`/api/transcriptions/${id}/speakers`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speakerId, role }),
    });
  },

  updateSegment(id, segmentId, patch) {
    return apiRequest<Transcription>(`/api/transcriptions/${id}/segments/${segmentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  },

  review(id) {
    return apiRequest<Transcription>(`/api/transcriptions/${id}/review`, { method: "POST" });
  },
};
