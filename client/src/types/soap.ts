// --- SOAP notes (proposed, additive): see the SOAP coordination comment on issue #3. ---
// No backend support exists yet — everything here runs against a mock until agreed.

export type SoapTemplateId =
  | "primary-care-standard"
  | "primary-care-concise"
  | "primary-care-detailed";

export interface SoapTemplate {
  id: SoapTemplateId;
  name: string;
  description: string;
}

export interface SoapPreference {
  templateId: SoapTemplateId;
}

export type SoapNoteStatus = "processing" | "draft_ready" | "failed" | "approved";

/** Sub-stage while status is "processing". Never a fabricated percentage. */
export type SoapGenerationStage = "queued" | "extracting" | "drafting" | "validating" | null;

export type SoapSectionKey = "subjective" | "objective" | "assessment" | "plan";

export type SoapSections = Record<SoapSectionKey, string>;

export interface SoapClaim {
  id: string;
  section: SoapSectionKey;
  text: string;
  /** Stable transcript segment ids this statement is grounded in — never array positions. */
  sourceSegmentIds: string[];
  /** Ids of permitted manually-entered clinician facts, when the source isn't the transcript. */
  sourceFactIds: string[];
  /** Advisory: true when this statement's grounding is doubtful and needs clinician verification. */
  needsReview: boolean;
}

export interface SoapReviewFlag {
  code: string;
  message: string;
  section?: SoapSectionKey;
}

export interface SoapGenerationError {
  code: string;
  message: string;
}

export interface SoapNote {
  id: string;
  transcriptionId: string;
  templateId: SoapTemplateId;
  status: SoapNoteStatus;
  generationStage: SoapGenerationStage;
  revision: number;
  /** The Transcription.revision this note was generated from — used to detect a stale source. */
  sourceTranscriptRevision: number;
  sections: SoapSections;
  claims: SoapClaim[];
  reviewFlags: SoapReviewFlag[];
  approvedAt: string | null;
  /** Present when status is "failed". */
  error?: SoapGenerationError | null;
}
