import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { serviceUnavailable, unauthenticated } from "../lib/errors.js";

// Only asymmetric algorithms are accepted. This blocks "alg: none" and HMAC key-confusion attacks.
const ALLOWED_ALGORITHMS = ["ES256", "RS256", "EdDSA"];

/**
 * Verify a Supabase access token and return the doctor's identity. Throws AppError:
 * 401 for a bad/expired/foreign token, 503 when the signing keys cannot be reached.
 */
export async function verifyAccessToken(token, { issuer, keys }) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, { issuer, audience: "authenticated", algorithms: ALLOWED_ALGORITHMS }));
  } catch (error) {
    // Bad, expired or foreign tokens are the caller's problem (401). Anything else, such as
    // being unable to fetch the signing keys, is ours (503). Tokens are never logged.
    if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) {
      throw unauthenticated("Your session is invalid or has expired. Sign in again.");
    }
    console.error("token verification unavailable:", error?.code ?? error?.name);
    throw serviceUnavailable("Sign-in is temporarily unavailable.");
  }

  if (typeof payload.sub !== "string" || !payload.sub || payload.role !== "authenticated" || payload.is_anonymous === true) {
    throw unauthenticated("Your session is invalid or has expired. Sign in again.");
  }
  const meta = payload.user_metadata ?? {};
  return {
    id: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    displayName: [meta.display_name, meta.full_name, meta.name].find((value) => typeof value === "string" && value) ?? null,
    expiresAt: typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null,
  };
}

/** The signing keys and issuer for a Supabase project URL (null keys when it is not configured). */
export function supabaseKeys(supabaseUrl, jwks) {
  const baseUrl = supabaseUrl.replace(/\/+$/, "");
  const issuer = `${baseUrl}/auth/v1`;
  return { issuer, keys: jwks ?? (baseUrl ? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)) : null) };
}

/**
 * Express middleware: verifies the Bearer token on every request and puts the doctor's identity on
 * req.user. The id comes ONLY from the verified token's `sub`; nothing the client sends in a body,
 * query or header is used as an owner id. `jwks` can be injected for tests (a local key set).
 * Accounts are self-registered: nothing here says the person is a verified medical professional.
 */
export function createAuthenticator(config, { jwks, store } = {}) {
  const { issuer, keys } = supabaseKeys(config.supabaseUrl, jwks);

  return async function authenticate(req, _res, next) {
    try {
      const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.headers.authorization ?? "");
      if (!match) throw unauthenticated();
      if (!keys) {
        console.error("authentication is not configured (SUPABASE_URL is empty)");
        throw serviceUnavailable("Sign-in is not available on the server.");
      }
      const { expiresAt: _expiresAt, ...user } = await verifyAccessToken(match[1], { issuer, keys });
      req.user = user;
      store?.upsertDoctor(user);
      next();
    } catch (error) {
      next(error);
    }
  };
}
