/**
 * Toggle for the isolated mock voice-profile backend (see mockVoiceProfileApi.ts). The
 * real /api/me/voice-profile* endpoints are proposed on issue #3 and not built yet — this
 * stays mock-only (default true) until the backend implements them and the field names
 * are confirmed, then set VITE_USE_MOCK_VOICE_PROFILE=false.
 */
export const USE_MOCK_VOICE_PROFILE =
  import.meta.env.VITE_USE_MOCK_VOICE_PROFILE !== "false";
