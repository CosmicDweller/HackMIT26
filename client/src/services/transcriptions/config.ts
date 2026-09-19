/**
 * Toggle for the isolated mock transcriptions backend (see
 * mockTranscriptionsApi.ts). The real /api/transcriptions* endpoints are
 * proposed on issue #3 and not built yet. Set VITE_USE_MOCK_TRANSCRIPTIONS=false
 * once they exist.
 */
export const USE_MOCK_TRANSCRIPTIONS =
  import.meta.env.VITE_USE_MOCK_TRANSCRIPTIONS !== "false";
