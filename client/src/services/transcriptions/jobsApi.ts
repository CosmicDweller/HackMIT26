import { apiRequest } from "@/services/transcriptions/apiClient";
import type { JobsApi } from "@/services/transcriptions/jobsApiTypes";
import type { TranscriptionJob } from "@/types";

/** Real backend calls per docs/API_CONTRACT.md "Contract v3" (/api/transcription-jobs*). */

export const jobsApi: JobsApi = {
  async create(audio, fileName, expectedSpeakers) {
    const formData = new FormData();
    formData.append("audio", audio, fileName);
    if (expectedSpeakers != null) {
      formData.append("expectedSpeakers", String(expectedSpeakers));
    }
    return apiRequest<TranscriptionJob>("/api/transcription-jobs", {
      method: "POST",
      body: formData,
    });
  },

  get(jobId) {
    return apiRequest<TranscriptionJob>(`/api/transcription-jobs/${jobId}`);
  },

  async list() {
    const payload = await apiRequest<{ jobs: TranscriptionJob[] }>("/api/transcription-jobs");
    return payload.jobs;
  },

  retry(jobId) {
    return apiRequest<TranscriptionJob>(`/api/transcription-jobs/${jobId}/retry`, {
      method: "POST",
    });
  },

  async remove(jobId) {
    await apiRequest<undefined>(`/api/transcription-jobs/${jobId}`, { method: "DELETE" });
  },
};
