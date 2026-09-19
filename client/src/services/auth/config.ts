/**
 * Toggle for the isolated mock auth provider (see mockAuthProvider.ts).
 * Set VITE_USE_MOCK_AUTH=false in client/.env.local once Supabase Auth (or
 * whatever provider is agreed with the backend on issue #3) is wired up.
 */
export const USE_MOCK_AUTH = import.meta.env.VITE_USE_MOCK_AUTH !== "false";
