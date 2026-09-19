import { AppError } from "../lib/errors.js";

/** Allow the configured frontend origin (default: the Vite dev server). */
export function cors(allowedOrigin) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigin === "*" || origin === allowedOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

/** Converts any error into the contract's { error, code } shape without leaking internals. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(error, _req, res, _next) {
  if (error instanceof AppError) {
    if (error.retryAfterSeconds) res.setHeader("Retry-After", String(error.retryAfterSeconds));
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error("unexpected error:", error);
  res.status(500).json({ error: "Transcription failed. Please try again.", code: "TRANSCRIPTION_FAILED" });
}
