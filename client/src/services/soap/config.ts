/**
 * Toggle for the isolated mock SOAP backend (see mockSoapApi.ts). The real
 * /api/soap*, /api/transcriptions/:id/soap* and /api/me/soap-preference endpoints are
 * proposed on issue #3 and not built yet — this stays mock-only (default true) until
 * the backend implements them, then set VITE_USE_MOCK_SOAP=false.
 */
export const USE_MOCK_SOAP = import.meta.env.VITE_USE_MOCK_SOAP !== "false";
