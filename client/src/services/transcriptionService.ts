import { USE_MOCK_API } from "@/services/config";
import { mockTranscribeAudio } from "@/services/mockTranscribeApi";
import { transcribeAudio } from "@/services/transcribeApi";
import type { TranscribeSuccess } from "@/types";

export { TranscribeApiError } from "@/services/transcribeApi";
export { checkHealth } from "@/services/transcribeApi";
export { USE_MOCK_API } from "@/services/config";

export async function runTranscription(
  audio: Blob,
  fileName: string,
): Promise<TranscribeSuccess> {
  return USE_MOCK_API
    ? mockTranscribeAudio(audio)
    : transcribeAudio(audio, fileName);
}
