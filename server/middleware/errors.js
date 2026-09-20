import { AppError } from "../lib/errors.js";

/**
 * Allow the configured frontend origin(s) (default: the Vite dev server).
 *
 * CORS_ORIGIN takes a comma-separated list, because a deployed client and the local dev server are both legitimate callers of the
 * same backend and a single value forced a choice between them. Each entry is matched exactly; "*" allows any origin.
 */
export function cors(allowedOrigin) {
  const allowed = new Set(String(allowedOrigin ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowed.has("*") || allowed.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      // X-Confirm carries the explicit confirmation for destructive calls (deleting a voice profile). It only reaches here on a
      // cross-origin deployment — behind the dev proxy the request is same-origin and never preflighted — so omitting it made
      // profile deletion fail in production only.
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Confirm");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

/** Converts any error into the contract's { error, code } shape without leaking internals. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, req, res, _next) {
  if (error instanceof AppError) {
    if (error.retryAfterSeconds) res.setHeader("Retry-After", String(error.retryAfterSeconds));
    return res.status(error.status).json({ error: error.message, code: error.code, ...error.extra });
  }
  // Malformed JSON or an oversized body from express.json()
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "The request body is not valid JSON.", code: "INVALID_REQUEST" });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "The request body is too large.", code: "INVALID_REQUEST" });
  }
  console.error("unexpected error:", error?.name, error?.code);
  // Unexpected failure (for example a database error) on a transcript-management route.
  if (req.baseUrl === "/api/transcriptions" && req.method !== "POST") {
    return res.status(500).json({ error: "Something went wrong. Please try again.", code: "SERVER_ERROR" });
  }
  res.status(500).json({ error: "Transcription failed. Please try again.", code: "TRANSCRIPTION_FAILED" });
}
