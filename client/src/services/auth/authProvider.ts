import type { AuthUser } from "@/types";

export class AuthProviderError extends Error {}

/**
 * Some providers (Supabase, by default) require the user to click a
 * confirmation link before a session exists — sign-up succeeds but there's
 * no one signed in yet. Distinguishing this from an error lets the UI show
 * "check your email" as a neutral notice instead of a red error message.
 */
export type SignUpResult =
  | { status: "signed_in"; user: AuthUser }
  | { status: "confirmation_required" };

/**
 * Provider-agnostic auth interface. mockAuthProvider.ts and
 * supabaseAuthProvider.ts both implement this, so calling code (useAuth,
 * pages/auth/*) never changes when swapping providers.
 */
export interface AuthProvider {
  getSession(): Promise<AuthUser | null>;
  onAuthStateChange(callback: (user: AuthUser | null) => void): () => void;
  signUp(email: string, password: string): Promise<SignUpResult>;
  signIn(email: string, password: string): Promise<AuthUser>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  /** Bearer token to attach to authenticated /api/transcriptions* requests. */
  getAccessToken(): Promise<string | null>;
}
