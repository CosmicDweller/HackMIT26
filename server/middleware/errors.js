import { AppError } from "../lib/errors.js";

/** Allow the configured frontend origin (default: the Vite dev server). */
export function cors(allowedOrigin) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigin === "*" || origin === allowedOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    return res.status(error.status).json({ error: error.message, code: error.code });
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
