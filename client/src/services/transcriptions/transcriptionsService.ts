import { USE_MOCK_TRANSCRIPTIONS } from "@/services/transcriptions/config";
import { mockTranscriptionsApi } from "@/services/transcriptions/mockTranscriptionsApi";
import { transcriptionsApi } from "@/services/transcriptions/transcriptionsApi";
import type { TranscriptionsApi } from "@/services/transcriptions/transcriptionsApiTypes";

export const transcriptions: TranscriptionsApi = USE_MOCK_TRANSCRIPTIONS
  ? mockTranscriptionsApi
  : transcriptionsApi;

export { USE_MOCK_TRANSCRIPTIONS } from "@/services/transcriptions/config";
