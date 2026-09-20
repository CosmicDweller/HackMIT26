import type { TranscribeError, TranscribeSuccess, VoiceEnrollmentProblem } from "@/types";

export class TranscribeApiError extends Error {
  code: TranscribeError["code"];
  /** Present only for 422 ENROLLMENT_REJECTED from POST /api/me/voice-profile/enroll. */
  problems?: VoiceEnrollmentProblem[];

  constructor(payload: TranscribeError & { problems?: VoiceEnrollmentProblem[] }) {
    super(payload.error);
    this.code = payload.code;
    this.problems = payload.problems;
  }
}

/** Real backend call per the documented contract: POST /api/transcribe (multipart, field "audio"). */
export async function transcribeAudio(
  audio: Blob,
  fileName: string,
): Promise<TranscribeSuccess> {
  const formData = new FormData();
  formData.append("audio", audio, fileName);

  let response: Response;
  try {
    // Do not set Content-Type manually — the browser sets the multipart boundary.
    response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });
  } catch {
    throw new TranscribeApiError({
      error: "Could not reach the transcription service.",
      code: "NETWORK_ERROR",
    });
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload || "error" in payload) {
    throw new TranscribeApiError(
      payload ?? {
        error: "Transcription failed.",
        code: "TRANSCRIPTION_FAILED",
      },
    );
  }

  return payload as TranscribeSuccess;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.status === "ok";
  } catch {
    return false;
  }
}
