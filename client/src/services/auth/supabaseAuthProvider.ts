import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { AuthProvider } from "@/services/auth/authProvider";
import { AuthProviderError } from "@/services/auth/authProvider";
import type { AuthUser } from "@/types";

/**
 * Real auth provider, agreed with the backend on issue #3: Supabase Auth.
 * The backend verifies the JWT itself against Supabase's published signing
 * keys — this client only signs users in/out and reads the access token to
 * attach as `Authorization: Bearer <token>` (done in the transcriptions API
 * client). Requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (the anon
 * key is safe to expose client-side; never put a service-role key here).
 */

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new AuthProviderError(
      "Supabase isn't configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY " +
        "in client/.env.local, or set VITE_USE_MOCK_AUTH=true to use the mock instead.",
    );
  }

  client = createClient(url, anonKey);
  return client;
}

function toAuthUser(user: User): AuthUser {
  return { id: user.id, email: user.email ?? "" };
}

function toAuthUserFromSession(session: Session | null): AuthUser | null {
  return session ? toAuthUser(session.user) : null;
}

export const supabaseAuthProvider: AuthProvider = {
  async getSession() {
    const { data, error } = await getClient().auth.getSession();
    if (error) throw new AuthProviderError(error.message);
    return toAuthUserFromSession(data.session);
  },

  onAuthStateChange(callback) {
    const {
      data: { subscription },
    } = getClient().auth.onAuthStateChange((_event, session) => {
      callback(toAuthUserFromSession(session));
    });
    return () => subscription.unsubscribe();
  },

  async signUp(email, password) {
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (error) throw new AuthProviderError(error.message);
    if (!data.session) {
      // Project requires email confirmation — the user exists but isn't signed in yet.
      return { status: "confirmation_required" };
    }
    return { status: "signed_in", user: toAuthUser(data.user!) };
  },

  async signIn(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) throw new AuthProviderError(error.message);
    return toAuthUser(data.user);
  },

  async signOut() {
    const { error } = await getClient().auth.signOut();
    if (error) throw new AuthProviderError(error.message);
  },

  async requestPasswordReset(email) {
    const { error } = await getClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    });
    if (error) throw new AuthProviderError(error.message);
  },

  async getAccessToken() {
    const { data } = await getClient().auth.getSession();
    return data.session?.access_token ?? null;
  },
};
