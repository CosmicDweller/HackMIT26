export type AppState =
  | "idle"
  | "recording"
  | "audio-ready"
  | "transcribing"
  | "success"
  | "error";

export type AudioSource = "recording" | "upload";

export interface AudioAsset {
  blob: Blob;
  source: AudioSource;
  fileName: string;
  mimeType: string;
  url: string;
}

export interface TranscribeSuccess {
  text: string;
  durationSeconds: number | null;
}

export type ApiErrorCode =
  | "INVALID_AUDIO"
  | "FILE_TOO_LARGE"
  | "TRANSCRIPTION_FAILED"
  | "SERVICE_UNAVAILABLE";

/** Client-only error codes for failures that never reach the API. */
export type ClientErrorCode = "NETWORK_ERROR" | "UNSUPPORTED_FILE";

export type ErrorCode = ApiErrorCode | ClientErrorCode;

export interface TranscribeError {
  error: string;
  code: ErrorCode;
}
