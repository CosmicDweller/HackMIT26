import { apiRequest, apiRequestBlob } from "@/services/transcriptions/apiClient";
import { TranscribeApiError } from "@/services/transcribeApi";
import type { SoapApi } from "@/services/soap/soapApiTypes";
import type { SoapNote, SoapPreference, SoapTemplate } from "@/types";

/**
 * Real backend calls for the proposed SOAP endpoints (posted to issue #3, not yet
 * implemented by the backend). Field names and response shape must be confirmed with
 * the backend agent before this is exercised for real — USE_MOCK_SOAP keeps the app
 * on the mock until then.
 */
export const soapApi: SoapApi = {
  async listTemplates() {
    const payload = await apiRequest<{ templates: SoapTemplate[] }>("/api/soap/templates");
    return payload.templates;
  },

  getPreference() {
    return apiRequest<SoapPreference>("/api/me/soap-preference");
  },

  setPreference(templateId) {
    return apiRequest<SoapPreference>("/api/me/soap-preference", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId }),
    });
  },

  async get(transcriptionId) {
    try {
      return await apiRequest<SoapNote>(`/api/transcriptions/${transcriptionId}/soap`);
    } catch (err) {
      if (err instanceof TranscribeApiError && err.code === "NOT_FOUND") return null;
      throw err;
    }
  },

  create(transcriptionId) {
    return apiRequest<SoapNote>(`/api/transcriptions/${transcriptionId}/soap`, { method: "POST" });
  },

  update(transcriptionId, patch) {
    return apiRequest<SoapNote>(`/api/transcriptions/${transcriptionId}/soap`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  },

  approve(transcriptionId, revision) {
    return apiRequest<SoapNote>(`/api/transcriptions/${transcriptionId}/soap/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    });
  },

  export(transcriptionId, format) {
    return apiRequestBlob(`/api/transcriptions/${transcriptionId}/soap/export?format=${format}`);
  },
};
