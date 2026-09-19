/** Error whose message is safe to send to the client. */
export class AppError extends Error {
  constructor(code, status, message, { retryAfterSeconds, extra } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.extra = extra; // additional public fields for the JSON body (for example a jobId)
  }
}

export const invalidAudio = (message = "The audio file could not be read.") =>
  new AppError("INVALID_AUDIO", 400, message);

export const fileTooLarge = (maxBytes) =>
  new AppError(
    "FILE_TOO_LARGE",
    413,
    `The audio file is too large. The maximum size is ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
  );

export const transcriptionFailed = (message = "Transcription failed. Please try again.", status = 500) =>
  new AppError("TRANSCRIPTION_FAILED", status, message);

export const serviceUnavailable = (message = "Transcription is temporarily unavailable.", options) =>
  new AppError("SERVICE_UNAVAILABLE", 503, message, options);

/** The client disconnected before we finished. No response is sent; this only unwinds the job. */
export const requestCancelled = () => new AppError("TRANSCRIPTION_FAILED", 499, "Request cancelled.");

export const unauthenticated = (message = "Sign in to continue.") => new AppError("UNAUTHENTICATED", 401, message);

/** Also returned for another doctor's data, so ids cannot be probed for existence. */
export const notFound = (message = "Not found.") => new AppError("NOT_FOUND", 404, message);

export const invalidRequest = (message = "The request is not valid.") => new AppError("INVALID_REQUEST", 400, message);
