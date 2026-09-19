export interface AuthUser {
  id: string;
  email: string;
}

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthError {
  message: string;
}
