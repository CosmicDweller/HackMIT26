/** Error whose message is safe to send to the client. */
export class AppError extends Error {
  constructor(code, status, message, { retryAfterSeconds } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
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
