import { AppError } from "../../lib/errors.js";
import { SoapProviderError } from "./gemini.js";
import { numberedTranscript } from "./prompt.js";
import { SECTIONS } from "./templates.js";
import { validateNote } from "./validate.js";

// The life of one SOAP note: claim the single slot, generate, save, let the doctor edit, approve, lock.
//
// Rules that matter more than the code:
//  - ONE note per consultation. The slot is claimed in a transaction, so repeated completion events, retries and racing requests
//    cannot produce competing drafts.
//  - A successful or doctor-edited draft is never overwritten by a regeneration.
//  - Generation reads the FINAL STORED transcript, never the provider's raw response.
//  - An approved note is read-only.
//  - A failure never damages the transcript: the note records the failure and the transcript is untouched.

const MAX_SECTION_LENGTH = 20_000;

export function createSoapService({ config, store, generator, logger = console }) {
  const running = new Map(); // transcriptionId -> promise, so one process never generates the same note twice at once

  const enabled = () => config.soapEnabled;

  const stuckAfterMs = () => config.soapStuckAfterMs;

  /**
   * The note plus the freshness of its sources.
   *
   * A note is also rescued here if it has been `processing` for longer than any real generation could take and nothing in THIS
   * process is working on it: that means the worker died (a crash, a restart, a killed process) and nobody will ever finish it.
   * Checking on read rather than on a timer means a note cannot stay `processing` forever even if the server never restarts, which
   * is what leaves a client polling a spinner that never resolves.
   */
  function get(ownerId, transcriptionId) {
    let note = store.getSoapNote(ownerId, transcriptionId);
    if (!note) return null;
    if (note.status === "processing" && !running.has(transcriptionId) && Date.now() - Date.parse(note.updatedAt) > stuckAfterMs()) {
      logger.error(`soap: a note was left processing with no worker; marking it failed so it can be retried`);
      try {
        note = store.updateSoapNote(ownerId, transcriptionId, { status: "failed", generation_stage: null, error_code: "INTERRUPTED" });
      } catch { /* someone else finished or removed it in the meantime */ }
    }
    return withStaleness(note, store.get(ownerId, transcriptionId));
  }

  /**
   * Start generation if this consultation has no note yet, and return the note either way. Safe to call repeatedly and concurrently:
   * the second caller gets the existing note, never a second draft.
   * `wait` resolves once generation has finished (used by tests and the job pipeline).
   */
  async function createIfAbsent(ownerId, transcriptionId, { templateId = null, wait = false, manualFacts = [] } = {}) {
    if (!enabled()) throw new AppError("SOAP_DISABLED", 503, "SOAP note generation is not enabled on this server.");
    const transcription = store.get(ownerId, transcriptionId); // ownership check, throws NOT_FOUND
    const existing = store.getSoapNote(ownerId, transcriptionId);
    if (existing) {
      if (wait && running.has(transcriptionId)) await running.get(transcriptionId).catch(() => {});
      return get(ownerId, transcriptionId);
    }
    const chosen = templateId ?? store.soapPreference(ownerId) ?? config.soapDefaultTemplate;
    // The template is frozen here, at the moment generation begins, and is never re-editable afterwards.
    const claimed = store.claimSoapNote(ownerId, transcriptionId, { templateId: chosen, sourceTranscriptRevision: transcription.revision });
    if (!claimed) { // someone else claimed it between the two calls
      if (wait && running.has(transcriptionId)) await running.get(transcriptionId).catch(() => {});
      return get(ownerId, transcriptionId);
    }
    const work = run(ownerId, transcriptionId, manualFacts).finally(() => running.delete(transcriptionId));
    running.set(transcriptionId, work);
    if (wait) await work.catch(() => {});
    else work.catch(() => {}); // failures are recorded on the note; nothing is thrown into the caller's request
    return get(ownerId, transcriptionId);
  }

  /** Generate and save. Records the outcome on the note; never throws into the caller. */
  async function run(ownerId, transcriptionId, manualFacts) {
    const stage = (name) => {
      try {
        store.updateSoapNote(ownerId, transcriptionId, { generation_stage: name });
      } catch { /* the note may have been deleted mid-flight */ }
    };
    try {
      const transcription = store.get(ownerId, transcriptionId);
      const note = store.getSoapNote(ownerId, transcriptionId);
      const result = await generator.generate(transcription, { templateId: note.templateId, manualFacts, onStage: stage });
      store.updateSoapNote(ownerId, transcriptionId, {
        status: "draft_ready", generation_stage: null, error_code: null,
        sections: result.sections, claims: result.claims, review_flags: result.reviewFlags,
        provider: result.provider, model: result.model, usage: result.usage,
        // the transcript may have been edited while we were drafting: record what we actually read
        source_transcript_revision: transcription.revision,
      });
    } catch (error) {
      const code = error instanceof SoapProviderError ? error.code : "GENERATION_FAILED";
      logger.error(`soap generation failed for one consultation: ${code}`); // class only, never clinical content
      try {
        store.updateSoapNote(ownerId, transcriptionId, { status: "failed", generation_stage: null, error_code: code });
      } catch { /* note gone */ }
    }
  }

  /**
   * Retry a failed note. Only `failed` notes may be retried, so a good or edited draft can never be overwritten, and an approved one
   * certainly not. The slot itself is kept, so this can never create a second note.
   */
  async function retry(ownerId, transcriptionId, { wait = false } = {}) {
    const note = store.getSoapNote(ownerId, transcriptionId);
    if (!note) throw new AppError("NOT_FOUND", 404, "This consultation has no SOAP note.");
    if (note.status !== "failed") return get(ownerId, transcriptionId); // idempotent: nothing to retry
    if (running.has(transcriptionId)) {
      if (wait) await running.get(transcriptionId).catch(() => {});
      return get(ownerId, transcriptionId);
    }
    const transcription = store.get(ownerId, transcriptionId);
    store.updateSoapNote(ownerId, transcriptionId, { status: "processing", generation_stage: "queued", error_code: null, source_transcript_revision: transcription.revision });
    const work = run(ownerId, transcriptionId, []).finally(() => running.delete(transcriptionId));
    running.set(transcriptionId, work);
    if (wait) await work.catch(() => {});
    return get(ownerId, transcriptionId);
  }

  /**
   * A doctor's edit. Optimistic concurrency on `revision`. Editing a section invalidates the AI citations for that section: a
   * citation proves where the ORIGINAL sentence came from and cannot vouch for text a human has rewritten.
   */
  function update(ownerId, transcriptionId, { sections, revision }) {
    const note = store.getSoapNote(ownerId, transcriptionId);
    if (!note) throw new AppError("NOT_FOUND", 404, "This consultation has no SOAP note.");
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) throw new AppError("INVALID_REQUEST", 400, "Send the sections to save.");
    const unknown = Object.keys(sections).filter((key) => !SECTIONS.includes(key));
    if (unknown.length) throw new AppError("INVALID_REQUEST", 400, `Unknown section: ${unknown.join(", ")}.`);
    for (const [key, value] of Object.entries(sections)) {
      if (typeof value !== "string") throw new AppError("INVALID_REQUEST", 400, `Section ${key} must be text.`);
      if (value.length > MAX_SECTION_LENGTH) throw new AppError("INVALID_REQUEST", 400, `Section ${key} is too long.`);
    }

    const merged = { ...note.sections };
    const changed = [];
    for (const [key, value] of Object.entries(sections)) {
      const next = value.replace(/\s+$/g, "");
      if (next !== merged[key]) changed.push(key);
      merged[key] = next;
    }
    // The edited text is checked again against the transcript. This matters in both directions: a doctor who DELETES a fabricated
    // sentence clears its blocking flag (otherwise the note could never be approved), and a doctor who TYPES an unsupported number
    // or drug name gets flagged just as the model would have been. Acknowledgements already given are preserved.
    const transcription = store.get(ownerId, transcriptionId);
    const { lines } = numberedTranscript(transcription);
    const claims = note.claims.map((claim) => (changed.includes(claim.section) ? { ...claim, editedByDoctor: true } : claim));
    const rechecked = validateNote({ sections: merged, claims, reviewFlags: [] }, { lines, segments: transcription.segments, manualFacts: [] });

    const acknowledged = new Map(note.reviewFlags.filter((entry) => entry.resolved).map((entry) => [`${entry.type}|${entry.section}|${entry.message}`, entry]));
    const flags = rechecked.reviewFlags.map((entry) => {
      const previous = acknowledged.get(`${entry.type}|${entry.section}|${entry.message}`);
      return previous ? { ...entry, resolved: true, acknowledgedAt: previous.acknowledgedAt } : entry;
    });
    // The model's own flags are not re-derivable from text, so they are carried over for sections the doctor did not touch.
    for (const entry of note.reviewFlags) {
      if (entry.source === "model" && !changed.includes(entry.section)) flags.push(entry);
    }
    for (const section of changed) {
      const affected = claims.filter((claim) => claim.section === section).length;
      if (affected > 0) {
        flags.push({
          id: `flag_edit_${section}_${note.revision + 1}`, type: "edited_claim", severity: "info", section, claimId: null,
          message: `You edited the ${section} section, so its ${affected} original citation${affected === 1 ? "" : "s"} no longer necessarily match the text. They are marked for re-verification.`,
          blocking: false, resolved: false, acknowledgedAt: null, source: "validator",
        });
      }
    }
    // Claims in an edited section can no longer be asserted as verified model output with a source.
    const finalClaims = rechecked.claims.map((claim) => (changed.includes(claim.section) ? { ...claim, needsReview: true, editedByDoctor: true } : claim));
    return withStaleness(
      // `revision` is accepted but not enforced, as on approve: one doctor per note, so a lagging client copy is not a competing
      // writer, and refusing the save over it just loses the doctor's typing.
      store.updateSoapNote(ownerId, transcriptionId, { sections: merged, claims: finalClaims, review_flags: flags, revision: note.revision + 1, edited: 1 }, { expectedRevision: note.revision }),
      transcription,
    );
  }

  /** Acknowledge a non-blocking flag. A blocking one cannot be waved away: fix the text instead. */
  function acknowledgeFlag(ownerId, transcriptionId, flagId) {
    const note = store.getSoapNote(ownerId, transcriptionId);
    if (!note) throw new AppError("NOT_FOUND", 404, "This consultation has no SOAP note.");
    const flag = note.reviewFlags.find((entry) => entry.id === flagId);
    if (!flag) throw new AppError("NOT_FOUND", 404, "No such review flag.");
    // Any flag can be acknowledged, including one reporting an unsupported statement. Correcting the text is still the better
    // answer and clears it automatically, but the doctor is allowed to say they have seen it and stand by the note.
    const flags = note.reviewFlags.map((entry) => (entry.id === flagId ? { ...entry, resolved: true, acknowledgedAt: new Date().toISOString() } : entry));
    return withStaleness(store.updateSoapNote(ownerId, transcriptionId, { review_flags: flags }), store.get(ownerId, transcriptionId));
  }

  /**
   * Explicit approval. Requires the current revision, a finished draft, no unresolved blocking flags, and sources that still match
   * the transcript. Approval is a record of clinician review, not an electronic signature.
   */
  function approve(ownerId, transcriptionId, { revision } = {}) {
    const note = store.getSoapNote(ownerId, transcriptionId);
    if (!note) throw new AppError("NOT_FOUND", 404, "This consultation has no SOAP note.");
    if (note.status === "approved") return get(ownerId, transcriptionId); // idempotent
    if (note.status !== "draft_ready") throw new AppError("NOT_READY", 409, "This note is not ready to approve yet.");

    // Approval is the doctor's signature, not the validator's. The checks describe the note — an unsupported statement, a speaker
    // nobody identified, a section nothing was documented for — and every one of them is shown in the UI, but none of them refuses
    // the signature: a clinician may knowingly sign a note the checks still have reservations about, and only they can weigh that.
    // The flags stay on the record either way, so what the checks found is preserved alongside the approval.
    const transcription = store.get(ownerId, transcriptionId);
    return withStaleness(
      store.updateSoapNote(ownerId, transcriptionId,
        {
          status: "approved", approved_at: new Date().toISOString(), approved_by: ownerId, revision: note.revision + 1,
          // Approving accepts the note against the transcript as it stands, so it is no longer stale.
          source_transcript_revision: transcription.revision,
        },
        // The request's `revision` is accepted but not enforced. A client copy that lagged behind by a save or a background refresh
        // is not a reason to refuse a signature, and there is one doctor per note, so there is no competing writer to protect from.
        { expectedRevision: note.revision }),
      transcription,
    );
  }

  /**
   * Reconcile a stale note: the doctor confirms it still reflects the edited transcript. Clears the stale state, keeps the text.
   *
   * The note is re-checked against the transcript AS IT STANDS NOW, exactly as an edit would be. This is the whole point of
   * reconciling: a flag raised against the old transcript must not outlive the edit that fixed it. Carrying flags over verbatim
   * meant that identifying a speaker, or correcting the wording a claim rests on, could never clear the flag complaining about it,
   * so a note that picked up one blocking flag could never be approved by any route.
   */
  function reconcile(ownerId, transcriptionId, { revision }) {
    const note = store.getSoapNote(ownerId, transcriptionId);
    if (!note) throw new AppError("NOT_FOUND", 404, "This consultation has no SOAP note.");
    const transcription = store.get(ownerId, transcriptionId);
    const claims = note.claims.map((claim) => ({ ...claim, needsReview: true }));

    // A flag describing an uncertainty the transcript no longer has is dropped: identifying a speaker is the ONLY answer to a flag
    // saying that speaker was unidentified, so carrying it over verbatim meant a note that picked one up could never be approved by
    // any route — not by acknowledging it (blocking flags cannot be), not by regenerating (retry is a no-op on a drafted note).
    // Flags about the note's own text are left alone; those the doctor clears by correcting the text, which re-checks them.
    const speakersResolved = transcription.speakers.every((speaker) => speaker.role !== "unassigned")
      && transcription.segments.every((segment) => segment.speakerId !== null);
    const wordingResolved = transcription.segments.every((segment) => !segment.needsReview);
    const obsolete = new Set([
      "stale_source",
      ...(speakersResolved ? ["uncertain_speaker"] : []),
      ...(wordingResolved ? ["uncertain_transcript"] : []),
    ]);
    const flags = note.reviewFlags.filter((entry) => !obsolete.has(entry.type));

    return withStaleness(
      store.updateSoapNote(ownerId, transcriptionId,
        { source_transcript_revision: transcription.revision, claims, review_flags: flags, revision: note.revision + 1 },
        { expectedRevision: revision }),
      transcription,
    );
  }

  /** At startup: notes left `processing` by a crash are marked failed so they can be retried, never left spinning forever. */
  function recoverStuck() {
    const cutoff = new Date(Date.now() - stuckAfterMs()).toISOString();
    let recovered = 0;
    for (const row of store.stuckSoapNotes(cutoff)) {
      try {
        store.updateSoapNote(row.owner_id, row.transcription_id, { status: "failed", generation_stage: null, error_code: "INTERRUPTED" });
        recovered++;
      } catch { /* ignore: it may have finished or been deleted */ }
    }
    if (recovered > 0) logger.log(`soap: ${recovered} interrupted note${recovered === 1 ? "" : "s"} marked failed (retryable)`);
    return recovered;
  }

  return { enabled, get, createIfAbsent, retry, update, approve, acknowledgeFlag, reconcile, recoverStuck };
}

/**
 * Adds `sourceStale` and, when the transcript has moved on, a flag saying so. Computed on read rather than stored, so it is always
 * true of the transcript as it is now.
 */
function withStaleness(note, transcription) {
  if (!note) return null;
  const stale = transcription.revision !== note.sourceTranscriptRevision;
  const flags = stale && !note.reviewFlags.some((entry) => entry.type === "stale_source")
    ? [...note.reviewFlags, {
      id: "flag_stale_source", type: "stale_source", severity: "warning", section: null, claimId: null,
      message: `The transcript has been edited since this note was drafted (it was written from revision ${note.sourceTranscriptRevision}, the transcript is now at ${transcription.revision}). Check the note against the transcript before approving.`,
      blocking: false, resolved: false, acknowledgedAt: null, source: "validator",
    }]
    : note.reviewFlags;
  return { ...note, sourceStale: stale, transcriptRevision: transcription.revision, reviewFlags: flags };
}
