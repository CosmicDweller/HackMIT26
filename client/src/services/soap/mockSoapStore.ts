import { TranscribeApiError } from "@/services/transcribeApi";
import { store as transcriptionsStore } from "@/services/transcriptions/mockTranscriptionsStore";
import { FIXTURE_SOAP_CLAIMS, FIXTURE_SOAP_SECTIONS } from "@/lib/soapFixtures";
import type { SoapGenerationStage, SoapNote, SoapTemplateId } from "@/types";

/**
 * In-memory store backing the mock SOAP service. One note per transcriptionId, matching
 * "one SOAP note per consultation, one generation per consultation." Nothing here is
 * persisted; it resets on page reload, same as the other mock stores.
 *
 * Never analyzes the actual transcript content — like the rest of this mock system, it
 * always returns the same clearly-synthetic, clearly-labeled fixture (see
 * lib/soapFixtures.ts), so it's never mistaken for a real AI generation result.
 */

export interface StoredSoapNote extends SoapNote {
  ownerId: string;
}

export const notes = new Map<string, StoredSoapNote>();
export const preferences = new Map<string, SoapTemplateId>();

const DEFAULT_TEMPLATE: SoapTemplateId = "primary-care-standard";

export function getPreferenceFor(ownerId: string): SoapTemplateId {
  return preferences.get(ownerId) ?? DEFAULT_TEMPLATE;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toPublicNote(note: StoredSoapNote): SoapNote {
  const { ownerId: _ownerId, ...rest } = note;
  return structuredClone(rest);
}

export function requireOwnedNote(transcriptionId: string, ownerId: string): StoredSoapNote {
  const note = notes.get(transcriptionId);
  if (!note || note.ownerId !== ownerId) {
    throw new TranscribeApiError({ error: "SOAP note not found.", code: "NOT_FOUND" });
  }
  return note;
}

async function runGeneration(note: StoredSoapNote) {
  const stages: { stage: SoapGenerationStage; ms: number }[] = [
    { stage: "queued", ms: 400 },
    { stage: "extracting", ms: 700 },
    { stage: "drafting", ms: 1100 },
    { stage: "validating", ms: 500 },
  ];
  for (const { stage, ms } of stages) {
    await delay(ms);
    if (notes.get(note.transcriptionId) !== note) return; // deleted/replaced mid-flight
    note.generationStage = stage;
  }
  await delay(300);
  if (notes.get(note.transcriptionId) !== note) return;

  note.status = "draft_ready";
  note.generationStage = null;
  note.sections = structuredClone(FIXTURE_SOAP_SECTIONS);
  note.claims = structuredClone(FIXTURE_SOAP_CLAIMS);
  note.reviewFlags = note.claims
    .filter((c) => c.needsReview)
    .map((c) => ({
      code: "CLAIM_NEEDS_REVIEW",
      message: `A statement in ${c.section} needs clinician verification: "${c.text}"`,
      section: c.section,
    }));
}

function newNote(transcriptionId: string, ownerId: string, templateId: SoapTemplateId, sourceTranscriptRevision: number): StoredSoapNote {
  return {
    id: `soap_${crypto.randomUUID()}`,
    transcriptionId,
    ownerId,
    templateId,
    status: "processing",
    generationStage: "queued",
    revision: 1,
    sourceTranscriptRevision,
    sections: { subjective: "", objective: "", assessment: "", plan: "" },
    claims: [],
    reviewFlags: [],
    approvedAt: null,
    error: null,
  };
}

/** Mirrors "the backend automatically starts SOAP generation" once a transcription
 * completes. Called from the mock transcriptions/jobs create paths, never from the UI. */
export function autoStartSoapGeneration(transcriptionId: string, ownerId: string): void {
  if (notes.has(transcriptionId)) return; // one generation per consultation
  const transcription = transcriptionsStore.get(transcriptionId);
  const note = newNote(transcriptionId, ownerId, getPreferenceFor(ownerId), transcription?.revision ?? 1);
  notes.set(transcriptionId, note);
  runGeneration(note);
}

/** Idempotent recovery: only creates a note if one doesn't already exist. */
export function recoverOrCreateNote(transcriptionId: string, ownerId: string): StoredSoapNote {
  const existing = notes.get(transcriptionId);
  if (existing) {
    if (existing.ownerId !== ownerId) {
      throw new TranscribeApiError({ error: "Transcript not found.", code: "NOT_FOUND" });
    }
    return existing;
  }
  // The transcript is only visible here when transcriptions are ALSO mocked. With
  // VITE_USE_MOCK_TRANSCRIPTIONS=false (real transcripts) this store is empty, so a
  // missing record means "can't check", not "not yours" — treating it as not-found made
  // the SOAP editor fail on every real transcript. Ownership is still enforced: the note
  // is created for the verified caller and every later read checks note.ownerId.
  const transcription = transcriptionsStore.get(transcriptionId);
  if (transcription && transcription.ownerId !== ownerId) {
    throw new TranscribeApiError({ error: "Transcript not found.", code: "NOT_FOUND" });
  }
  const note = newNote(transcriptionId, ownerId, getPreferenceFor(ownerId), transcription?.revision ?? 1);
  notes.set(transcriptionId, note);
  runGeneration(note);
  return note;
}

export function currentTranscriptRevision(transcriptionId: string): number | null {
  return transcriptionsStore.get(transcriptionId)?.revision ?? null;
}

export { DEFAULT_TEMPLATE };
