import type { AuthUser } from "@/types";

export class AuthProviderError extends Error {}

/**
 * Provider-agnostic auth interface. mockAuthProvider.ts implements this today;
 * a Supabase-backed implementation swaps in once the provider is confirmed on
 * issue #3, without changing any calling code (useAuth, pages/auth/*).
 */
export interface AuthProvider {
  getSession(): Promise<AuthUser | null>;
  onAuthStateChange(callback: (user: AuthUser | null) => void): () => void;
  signUp(email: string, password: string): Promise<AuthUser>;
  signIn(email: string, password: string): Promise<AuthUser>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  /** Bearer token to attach to authenticated /api/transcriptions* requests. */
  getAccessToken(): Promise<string | null>;
}
