export type SpeakerRole = "doctor" | "patient" | "other" | "unassigned";

export interface Speaker {
  id: string;
  label: string;
  role: SpeakerRole;
  /**
   * Voice-enrollment match against the signed-in doctor's voice profile (Contract v4,
   * additive). `matched`: very likely the enrolled doctor. `unknown`: reliably does not
   * sound like the doctor (never means "the patient"). `uncertain`: not enough speech,
   * or not clear enough, to say either way. `unavailable`: no profile, or the analysis
   * didn't run. Always advisory — never proof of identity, never sets `role` automatically.
   * Absent on transcripts predating this feature.
   */
  identificationStatus?: "matched" | "unknown" | "uncertain" | "unavailable";
  /** "doctor" only when identificationStatus is "matched", else null. Never "patient"/"other". */
  suggestedRole?: "doctor" | null;
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
   * Whether voice-profile matching ran against this recording (Contract v4, additive).
   * `not_enrolled`: no profile existed (the default, and what every earlier transcript
   * shows). `completed`: the doctor's profile was compared against every speaker.
   * `unavailable`: a profile exists but the comparison couldn't run.
   */
  voiceIdentificationStatus?: "not_enrolled" | "completed" | "unavailable";
  /**
   * Where the speaker labels came from (Contract v4, additive): `deepgram` (its own
   * labels), `independent` (Deepgram found at most one speaker and independent voice
   * analysis separated the voices), or absent/null on older transcripts and the local engine.
   */
  speakerSource?: "deepgram" | "independent" | null;
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

// --- Voice enrollment (Contract v4 — docs/API_CONTRACT.md, implemented on branch lz). ---

export type VoiceProfileStatus = "not_enrolled" | "enrolling" | "enrolled" | "needs_reenrollment";

export interface VoiceProfileConsent {
  /** Must be echoed back verbatim as `consentVersion` when enrolling. */
  version: string;
  /** Show this exact text next to the consent checkbox — never paraphrase it. */
  text: string;
}

export interface VoiceProfile {
  status: VoiceProfileStatus;
  /** Always present: how many samples POST /enroll expects (currently 3). */
  requiredSamples: number;
  consent: VoiceProfileConsent;
  /** Present only once `status` is "enrolled" or "needs_reenrollment". */
  enrolledAt?: string | null;
  updatedAt?: string | null;
  sampleCount?: number;
  modelVersion?: string | null;
  consentRecordedAt?: string | null;
}

/** One rejected sample from a 422 ENROLLMENT_REJECTED response. `sample` is null for a
 * problem spanning all samples (e.g. they don't sound like the same person). */
export interface VoiceEnrollmentProblem {
  sample: number | null;
  code: string;
  message: string;
}
