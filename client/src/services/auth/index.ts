import { USE_MOCK_AUTH } from "@/services/auth/config";
import { mockAuthProvider } from "@/services/auth/mockAuthProvider";
import { supabaseAuthProvider } from "@/services/auth/supabaseAuthProvider";
import type { AuthProvider } from "@/services/auth/authProvider";

export const authProvider: AuthProvider = USE_MOCK_AUTH ? mockAuthProvider : supabaseAuthProvider;

export { AuthProviderError } from "@/services/auth/authProvider";
export { USE_MOCK_AUTH } from "@/services/auth/config";
