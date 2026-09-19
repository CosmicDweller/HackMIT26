export type SpeakerRole = "doctor" | "patient" | "other" | "unassigned";

export interface Speaker {
  id: string;
  label: string;
  role: SpeakerRole;
}

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** null when the model could not confidently attribute this segment to a speaker. */
  speakerId: string | null;
}

export type ReviewStatus = "needs_review" | "reviewed";

export type DiarizationStatus = "ok" | "failed" | "unavailable";

export interface DiarizationInfo {
  status: DiarizationStatus;
  speakerCount: number;
}

/** Which speech engine produced the transcript — lets the UI show where audio went. */
export type TranscriptionEngine = "local" | "deepgram";

export interface Transcription {
  id: string;
  text: string;
  durationSeconds: number | null;
  reviewStatus: ReviewStatus;
  createdAt: string;
  engine: TranscriptionEngine;
  speakers: Speaker[];
  segments: TranscriptSegment[];
  diarization: DiarizationInfo;
}

/** Metadata-only shape returned by the list endpoint. */
export interface TranscriptionSummary {
  id: string;
  createdAt: string;
  durationSeconds: number | null;
  reviewStatus: ReviewStatus;
}
