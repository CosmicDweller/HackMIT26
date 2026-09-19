import { authProvider } from "@/services/auth";
import { TranscribeApiError } from "@/services/transcribeApi";
import type { TranscriptionsApi } from "@/services/transcriptions/transcriptionsApiTypes";
import type { Transcription, TranscriptionSummary } from "@/types";

/** Real backend calls per the contract agreed on issue #3 (docs/API_CONTRACT.md v2). */

async function authHeaders(): Promise<HeadersInit> {
  const token = await authProvider.getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  // DELETE (and any other 204) never has a body — don't try to parse one.
  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || "error" in payload) {
    const errorPayload = payload ?? { error: "Request failed.", code: "SERVER_ERROR" };
    if (errorPayload.code === "UNAUTHENTICATED") {
      // Session is no longer valid server-side — clear it so ProtectedRoute redirects to /login.
      await authProvider.signOut();
    }
    throw new TranscribeApiError(errorPayload);
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
  async create(audio, fileName, expectedSpeakers) {
    const formData = new FormData();
    formData.append("audio", audio, fileName);
    if (expectedSpeakers != null) {
      formData.append("expectedSpeakers", String(expectedSpeakers));
    }
    return request<Transcription>("/api/transcriptions", {
      method: "POST",
      body: formData,
    });
  },

  async list() {
    const payload = await request<{ transcriptions: TranscriptionSummary[] }>(
      "/api/transcriptions",
    );
    return payload.transcriptions;
  },

  get(id) {
    return request<Transcription>(`/api/transcriptions/${id}`);
  },

  async remove(id) {
    await request<undefined>(`/api/transcriptions/${id}`, { method: "DELETE" });
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

  review(id) {
    return request<Transcription>(`/api/transcriptions/${id}/review`, { method: "POST" });
  },
};
