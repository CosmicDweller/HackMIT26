import type { TranscribeSuccess } from "@/types";
import { TranscribeApiError } from "@/services/transcribeApi";

/**
 * MOCK transcription backend for frontend development before whisper.cpp
 * is wired up. Clearly labeled so it is never mistaken for a real result —
 * see MOCK_TRANSCRIPT_PREFIX below, which stays in the returned text.
 * Disable by flipping USE_MOCK_API to false in services/config.ts.
 */

export const MOCK_TRANSCRIPT_PREFIX = "[MOCK TRANSCRIPT — backend not connected] ";

const MOCK_BODY =
  "This is placeholder text standing in for a real whisper.cpp transcription. " +
  "Once the backend's POST /api/transcribe is live, this mock is switched off " +
  "and real speech-to-text output will appear here instead.";

function randomDurationSeconds(): number {
  return Math.round((4 + Math.random() * 20) * 10) / 10;
}

export async function mockTranscribeAudio(
  audio: Blob,
): Promise<TranscribeSuccess> {
  await new Promise((resolve) => setTimeout(resolve, 1500));

  if (audio.size === 0) {
    throw new TranscribeApiError({
      error: "The recorded/uploaded audio is empty.",
      code: "INVALID_AUDIO",
    });
  }

  return {
    text: MOCK_TRANSCRIPT_PREFIX + MOCK_BODY,
    durationSeconds: randomDurationSeconds(),
  };
}
