import { authProvider } from "@/services/auth";
import { TranscribeApiError } from "@/services/transcribeApi";
import type { TranscriptionsApi } from "@/services/transcriptions/transcriptionsApiTypes";
import type { Transcription, TranscriptionSummary } from "@/types";

/** Real backend calls per the contract proposed on issue #3 (not yet built). */

async function authHeaders(): Promise<HeadersInit> {
  const token = await authProvider.getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || "error" in payload) {
    throw new TranscribeApiError(
      payload ?? { error: "Request failed.", code: "TRANSCRIPTION_FAILED" },
    );
  }
  return payload as T;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { ...(await authHeaders()), ...init.headers },
    });
  } catch {
    throw new TranscribeApiError({
      error: "Could not reach the server.",
      code: "NETWORK_ERROR",
    });
  }
  return parseJsonOrThrow<T>(response);
}

export const transcriptionsApi: TranscriptionsApi = {
  async create(audio, fileName) {
    const formData = new FormData();
    formData.append("audio", audio, fileName);
    return request<Transcription>("/api/transcriptions", {
      method: "POST",
      body: formData,
    });
  },

  list() {
    return request<TranscriptionSummary[]>("/api/transcriptions");
  },

  get(id) {
    return request<Transcription>(`/api/transcriptions/${id}`);
  },

  async remove(id) {
    await request<unknown>(`/api/transcriptions/${id}`, { method: "DELETE" });
  },

  updateSpeaker(id, speakerId, role) {
    return request<Transcription>(`/api/transcriptions/${id}/speakers`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speakerId, role }),
    });
  },

  updateSegment(id, segmentId, patch) {
    return request<Transcription>(`/api/transcriptions/${id}/segments/${segmentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  },
};
