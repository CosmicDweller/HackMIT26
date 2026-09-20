export type SpeakerRole = "doctor" | "patient" | "other" | "unassigned";

export interface Speaker {
  id: string;
  label: string;
  role: SpeakerRole;
  /**
   * Voice-enrollment match against the signed-in doctor's voice profile (proposed,
   * additive — see docs/API_CONTRACT.md coordination comment on issue #3). Advisory
   * only: "matched" is a suggestion, never proof of identity, and never sets `role`
   * automatically. Absent when voice identification wasn't attempted.
   */
  identificationStatus?: "matched" | "unknown";
}

export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** null when the model could not confidently attribute this segment to a speaker. */
  speakerId: string | null;
  /**
   * Advisory only (v3): true when the text or speaker is doubtful (unknown
   * speaker, a low-confidence word, bad timing). Never a guarantee — a
   * confident-looking segment can still be wrong. Clears when the segment
   * is edited.
   */
  needsReview?: boolean;
}

export type ReviewStatus = "needs_review" | "reviewed";

/** v2 diarization summary — kept unchanged alongside v3's diarizationStatus. */
export type DiarizationStatus = "ok" | "failed" | "unavailable";

export interface DiarizationInfo {
  status: DiarizationStatus;
  speakerCount: number;
}

/** v3: whether the diarizer labelled every word (completed), some (partial), or didn't run (failed). */
export type DiarizationStatusV3 = "completed" | "partial" | "failed";

/** Which speech engine produced the transcript — lets the UI show where audio went. */
export type TranscriptionEngine = "local" | "deepgram";

export interface TranscriptionWarning {
  code: string;
  message: string;
}

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
  /** Always "completed" on a transcription resource — in-progress work is a job, not a transcription. */
  status?: "completed";
  diarizationStatus?: DiarizationStatusV3;
  /** Advisory notices, e.g. a likely spurious extra speaker. Never implies a guarantee either way. */
  warnings?: TranscriptionWarning[];
  /**
   * Whether voice-profile matching ran against this recording (proposed, additive).
   * Absent when the backend doesn't support voice identification yet.
   */
  voiceIdentificationStatus?: "completed" | "unavailable" | "failed";
  /**
   * Increments on every segment/speaker edit (proposed, additive — see the SOAP
   * coordination comment on issue #3). Lets a SOAP note detect that its source
   * transcript has changed since generation via `sourceTranscriptRevision`.
   * Absent when the backend doesn't support this yet; treated as always-fresh.
   */
  revision?: number;
}

/** Metadata-only shape returned by the list endpoint. */
export interface TranscriptionSummary {
  id: string;
  createdAt: string;
  durationSeconds: number | null;
  reviewStatus: ReviewStatus;
}

// --- Jobs (v3): async processing for recordings that can't complete in one request/response. ---

export type JobStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "transcribing"
  | "completed"
  | "failed";

export interface JobError {
  code: string;
  message: string;
}

export interface TranscriptionJob {
  jobId: string;
  status: JobStatus;
  /** Always null — there is no real progress source, and the backend doesn't fake one. */
  progressPercent: number | null;
  transcriptionId: string | null;
  error: JobError | null;
  createdAt?: string;
}

// --- Voice enrollment (proposed, additive): see docs/API_CONTRACT.md coordination comment on issue #3. ---

export type VoiceProfileStatus = "not_enrolled" | "enrolling" | "enrolled" | "needs_reenrollment";

export interface VoiceProfile {
  status: VoiceProfileStatus;
  enrolledAt: string | null;
  sampleCount: number;
  modelVersion: string | null;
}
