/**
 * Toggle for the isolated development mock (see mockTranscribeApi.ts).
 * Set VITE_USE_MOCK_API=false in client/.env.local (or flip the fallback
 * below) once the real POST /api/transcribe backend is ready.
 */
export const USE_MOCK_API =
  import.meta.env.VITE_USE_MOCK_API !== "false";
