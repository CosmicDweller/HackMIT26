import type { AuthProvider } from "@/services/auth/authProvider";
import { AuthProviderError } from "@/services/auth/authProvider";
import type { AuthUser } from "@/types";

/**
 * MOCK auth provider for frontend development before Supabase Auth (proposed
 * on issue #3) is wired up. Session lives in memory only — nothing is
 * persisted to localStorage, and "passwords" here are never stored anywhere
 * durable; this never stands in for real authentication. Disable by setting
 * VITE_USE_MOCK_AUTH=false once the real provider is ready.
 */

interface MockAccount {
  id: string;
  email: string;
  password: string;
}

const accounts = new Map<string, MockAccount>();
let currentUser: AuthUser | null = null;
const listeners = new Set<(user: AuthUser | null) => void>();

function delay<T>(value: T, ms = 500): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function notify() {
  for (const listener of listeners) listener(currentUser);
}

function toAuthUser(account: MockAccount): AuthUser {
  return { id: account.id, email: account.email };
}

export const mockAuthProvider: AuthProvider = {
  async getSession() {
    await delay(undefined, 300);
    return currentUser;
  },

  onAuthStateChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },

  async signUp(email, password) {
    await delay(undefined);
    if (accounts.has(email)) {
      throw new AuthProviderError("An account with that email already exists.");
    }
    if (password.length < 8) {
      throw new AuthProviderError("Password must be at least 8 characters.");
    }
    const account: MockAccount = { id: crypto.randomUUID(), email, password };
    accounts.set(email, account);
    currentUser = toAuthUser(account);
    notify();
    return { status: "signed_in", user: currentUser };
  },

  async signIn(email, password) {
    await delay(undefined);
    const account = accounts.get(email);
    if (!account || account.password !== password) {
      throw new AuthProviderError("Incorrect email or password.");
    }
    currentUser = toAuthUser(account);
    notify();
    return currentUser;
  },

  async signOut() {
    await delay(undefined, 200);
    currentUser = null;
    notify();
  },

  async requestPasswordReset(email) {
    await delay(undefined);
    // Mock: never reveals whether the account exists, matching real providers.
    void email;
  },

  async getAccessToken() {
    return currentUser ? `mock-token-${currentUser.id}` : null;
  },
};
