import { mockAuthProvider } from "@/services/auth/mockAuthProvider";
import type { AuthProvider } from "@/services/auth/authProvider";

// Swap in a Supabase-backed provider here once confirmed on issue #3.
export const authProvider: AuthProvider = mockAuthProvider;

export { AuthProviderError } from "@/services/auth/authProvider";
export { USE_MOCK_AUTH } from "@/services/auth/config";
