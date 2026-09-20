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
  /** The statement exactly as it appears in `sections[section]`, so it can be anchored. */
  text: string;
  /** Stable transcript segment ids this statement is grounded in — never array positions.
   * Empty means unsupported: check `reviewFlags`. */
  sourceSegmentIds: string[];
  /** Ids of permitted manually-entered clinician facts, when the source isn't the transcript. */
  sourceFactIds: string[];
  /** Advisory: support is partial, the speaker was uncertain, or the section was edited. */
  needsReview: boolean;
  /** True once the doctor rewrote the section: the citation no longer vouches for the text. */
  editedByDoctor?: boolean;
}

export type SoapFlagSeverity = "info" | "warning" | "error";

export interface SoapReviewFlag {
  id: string;
  type: string;
  severity: SoapFlagSeverity;
  section: SoapSectionKey | null;
  claimId: string | null;
  message: string;
  /** Blocks approval and CANNOT be acknowledged — the statement must be corrected or
   * removed. Non-blocking flags are advisory and can be acknowledged. */
  blocking: boolean;
  resolved: boolean;
  acknowledgedAt: string | null;
  /** `validator` (deterministic check) or `model` (the model's own doubt). */
  source: string;
}

export interface SoapNote {
  id: string;
  transcriptionId: string;
  templateId: SoapTemplateId;
  status: SoapNoteStatus;
  generationStage: SoapGenerationStage;
  /** Set when status is "failed" (PROVIDER_QUOTA_EXCEEDED, PROVIDER_TIMEOUT, ...). */
  errorCode: string | null;
  revision: number;
  /** The transcript revision this note was written from. */
  sourceTranscriptRevision: number;
  /** The transcript's revision now. */
  transcriptRevision: number;
  /** True when those differ: the transcript was edited after drafting. The draft is kept,
   * but approval is refused until POST .../soap/reconcile. */
  sourceStale: boolean;
  /** True once a doctor has saved a change. */
  edited: boolean;
  sections: SoapSections;
  claims: SoapClaim[];
  reviewFlags: SoapReviewFlag[];
  provider?: string | null;
  model?: string | null;
  createdAt?: string;
  updatedAt?: string;
  approvedAt: string | null;
  approvedBy?: string | null;
}
