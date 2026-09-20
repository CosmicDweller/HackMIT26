import { TranscribeApiError } from "@/services/transcribeApi";
import { requireUserId } from "@/services/transcriptions/mockTranscriptionsStore";
import {
  currentTranscriptRevision,
  getPreferenceFor,
  notes,
  preferences,
  recoverOrCreateNote,
  requireOwnedNote,
  toPublicNote,
} from "@/services/soap/mockSoapStore";
import { buildSimplePdf } from "@/lib/simplePdf";
import { formatSoapNoteAsText, SOAP_SECTION_ORDER } from "@/lib/soapExport";
import { SOAP_TEMPLATES } from "@/lib/soapFixtures";
import type { SoapApi } from "@/services/soap/soapApiTypes";

function delay<T>(value: T, ms = 300): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** MOCK SOAP backend. Disable via VITE_USE_MOCK_SOAP=false once the real endpoints exist. */
export const mockSoapApi: SoapApi = {
  async listTemplates() {
    await delay(undefined, 200);
    return SOAP_TEMPLATES;
  },

  async getPreference() {
    const ownerId = await requireUserId();
    await delay(undefined, 150);
    return { templateId: getPreferenceFor(ownerId) };
  },

  async setPreference(templateId) {
    const ownerId = await requireUserId();
    await delay(undefined, 150);
    preferences.set(ownerId, templateId);
    return { templateId };
  },

  async get(transcriptionId) {
    const ownerId = await requireUserId();
    await delay(undefined, 250);
    const note = notes.get(transcriptionId);
    if (!note || note.ownerId !== ownerId) return null;
    return toPublicNote(note);
  },

  async create(transcriptionId) {
    const ownerId = await requireUserId();
    await delay(undefined, 200);
    return toPublicNote(recoverOrCreateNote(transcriptionId, ownerId));
  },

  async update(transcriptionId, patch) {
    const ownerId = await requireUserId();
    const note = requireOwnedNote(transcriptionId, ownerId);
    await delay(undefined, 400);
    if (patch.revision !== note.revision) {
      throw new TranscribeApiError({
        error: "This note was changed elsewhere. Reload to see the latest version.",
        code: "CONFLICT",
      });
    }
    // Editing a section invalidates its existing citations — flag its claims for
    // re-verification rather than pretending they still apply to the new text.
    for (const { key, heading } of SOAP_SECTION_ORDER) {
      if (patch.sections[key] !== note.sections[key]) {
        for (const claim of note.claims) {
          if (claim.section === key) claim.needsReview = true;
        }
        if (!note.reviewFlags.some((f) => f.code === "SECTION_EDITED" && f.section === key)) {
          note.reviewFlags.push({
            code: "SECTION_EDITED",
            message: `${heading} was edited — verify its citations below.`,
            section: key,
          });
        }
      }
    }
    note.sections = { ...patch.sections };
    note.revision += 1;
    return toPublicNote(note);
  },

  async approve(transcriptionId, revision) {
    const ownerId = await requireUserId();
    const note = requireOwnedNote(transcriptionId, ownerId);
    await delay(undefined, 400);
    if (note.status === "approved") return toPublicNote(note); // idempotent
    if (revision !== note.revision) {
      throw new TranscribeApiError({
        error: "This note was changed elsewhere. Reload to see the latest version.",
        code: "CONFLICT",
      });
    }
    if (note.status !== "draft_ready") {
      throw new TranscribeApiError({ error: "This note isn't ready to approve yet.", code: "INVALID_REQUEST" });
    }
    const liveRevision = currentTranscriptRevision(transcriptionId);
    if (liveRevision != null && liveRevision !== note.sourceTranscriptRevision) {
      throw new TranscribeApiError({
        error: "The source transcript has changed since this note was generated. Reconcile the changes before approving.",
        code: "INVALID_REQUEST",
      });
    }
    note.status = "approved";
    note.approvedAt = new Date().toISOString();
    return toPublicNote(note);
  },

  async export(transcriptionId, format) {
    const ownerId = await requireUserId();
    const note = requireOwnedNote(transcriptionId, ownerId);
    await delay(undefined, 400);
    if (note.status !== "approved") {
      throw new TranscribeApiError({ error: "Only an approved note can be exported.", code: "INVALID_REQUEST" });
    }
    if (format === "txt") {
      return new Blob([formatSoapNoteAsText(note.sections)], { type: "text/plain" });
    }
    return buildSimplePdf(
      "SOAP Note",
      SOAP_SECTION_ORDER.map(({ key, heading }) => ({ heading, body: note.sections[key] })),
    );
  },
};
