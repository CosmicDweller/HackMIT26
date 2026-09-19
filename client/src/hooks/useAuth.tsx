import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AuthProviderError, authProvider } from "@/services/auth";
import type { AuthStatus, AuthUser } from "@/types";

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    authProvider.getSession().then((session) => {
      if (cancelled) return;
      setUser(session);
      setStatus(session ? "authenticated" : "unauthenticated");
    });
    const unsubscribe = authProvider.onAuthStateChange((nextUser) => {
      setUser(nextUser);
      setStatus(nextUser ? "authenticated" : "unauthenticated");
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      await authProvider.signIn(email, password);
    } catch (err) {
      setError(err instanceof AuthProviderError ? err.message : "Sign in failed.");
      throw err;
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      await authProvider.signUp(email, password);
    } catch (err) {
      setError(err instanceof AuthProviderError ? err.message : "Sign up failed.");
      throw err;
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    await authProvider.signOut();
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    setError(null);
    try {
      await authProvider.requestPasswordReset(email);
    } catch (err) {
      setError(err instanceof AuthProviderError ? err.message : "Could not send reset email.");
      throw err;
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo(
    () => ({ status, user, error, signIn, signUp, signOut, requestPasswordReset, clearError }),
    [status, user, error, signIn, signUp, signOut, requestPasswordReset, clearError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
