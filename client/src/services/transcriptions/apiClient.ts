import { apiUrl } from "@/services/apiUrl";
import { authProvider } from "@/services/auth";
import { TranscribeApiError } from "@/services/transcribeApi";

/** Shared authenticated HTTP client for /api/transcriptions* and /api/transcription-jobs*. */

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

  // The HTTP status is the source of truth for success/failure — NOT the presence
  // of an "error" key, which a *successful* job response also legitimately has
  // (job.error is null when nothing failed). Checking "error" in payload here
  // previously misfired on every successful job creation.
  if (!response.ok) {
    const errorPayload =
      payload && typeof payload.error === "string" && typeof payload.code === "string"
        ? payload
        : { error: "Request failed.", code: "SERVER_ERROR" };
    if (errorPayload.code === "UNAUTHENTICATED") {
      // Session is no longer valid server-side — clear it so ProtectedRoute redirects to /login.
      await authProvider.signOut();
    }
    throw new TranscribeApiError(errorPayload);
  }

  if (!payload) {
    throw new TranscribeApiError({ error: "Empty response from the server.", code: "SERVER_ERROR" });
  }
  return payload as T;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
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

/** Like apiRequest, but for binary responses (e.g. PDF export) instead of JSON. */
export async function apiRequestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers: { ...(await authHeaders()), ...init.headers },
    });
  } catch {
    throw new TranscribeApiError({
      error: "Could not reach the server.",
      code: "NETWORK_ERROR",
    });
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const errorPayload =
      payload && typeof payload.error === "string" && typeof payload.code === "string"
        ? payload
        : { error: "Request failed.", code: "SERVER_ERROR" };
    if (errorPayload.code === "UNAUTHENTICATED") {
      await authProvider.signOut();
    }
    throw new TranscribeApiError(errorPayload);
  }
  return response.blob();
}
