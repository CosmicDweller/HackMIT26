import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError, invalidRequest, notFound } from "../lib/errors.js";

export const ROLES = ["doctor", "patient", "other", "unassigned"];
export const MAX_SEGMENT_TEXT_LENGTH = 10_000;

// Schema migrations, applied in order. `PRAGMA user_version` records how many have run.
// Ownership model: transcriptions.owner_id -> doctors.id (the verified auth user id). Speakers and
// segments belong to a transcription and are removed with it (ON DELETE CASCADE). No credentials or
// raw audio are stored here.
const MIGRATIONS = [
  `
  CREATE TABLE doctors (
    id           TEXT PRIMARY KEY,
    email        TEXT,
    display_name TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE transcriptions (
    id                 TEXT PRIMARY KEY,
    owner_id           TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
    created_at         TEXT NOT NULL,
    duration_seconds   REAL,
    text               TEXT NOT NULL,
    review_status      TEXT NOT NULL DEFAULT 'needs_review' CHECK (review_status IN ('needs_review', 'reviewed')),
    diarization_status TEXT NOT NULL CHECK (diarization_status IN ('ok', 'failed', 'unavailable')),
    speaker_count      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX transcriptions_owner ON transcriptions (owner_id, created_at DESC);
  CREATE TABLE speakers (
    transcription_id TEXT NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
    id               TEXT NOT NULL,
    label            TEXT NOT NULL,
    role             TEXT NOT NULL DEFAULT 'unassigned' CHECK (role IN ('doctor', 'patient', 'other', 'unassigned')),
    PRIMARY KEY (transcription_id, id)
  );
  CREATE TABLE segments (
    transcription_id TEXT NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
    id               TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    speaker_id       TEXT,
    start_ms         INTEGER NOT NULL,
    end_ms           INTEGER NOT NULL,
    text             TEXT NOT NULL,
    PRIMARY KEY (transcription_id, id),
    FOREIGN KEY (transcription_id, speaker_id) REFERENCES speakers (transcription_id, id)
  );
  `,
  // 2: record which speech engine produced each transcript (auditability: did audio leave the machine?)
  `ALTER TABLE transcriptions ADD COLUMN engine TEXT NOT NULL DEFAULT 'local' CHECK (engine IN ('local', 'deepgram'));`,
  // 3: provider-backed transcripts and the durable job queue.
  //  - diarization_result: completed | partial | failed (the contract's diarizationStatus)
  //  - provider_meta: INTERNAL JSON (request id, model, diarizer version, processing time). Never returned by the API.
  //  - warnings: JSON array of notices for the doctor (for example a fallback model was used)
  //  - segments: needs_review flag, the provider's own speaker index, and confidence values
  //  - transcription_jobs: persistent job state; audio_path is a file-backed upload kept until the job
  //    completes (or its retention deadline passes) so failed jobs can be retried without re-uploading.
  `
  ALTER TABLE transcriptions ADD COLUMN diarization_result TEXT CHECK (diarization_result IN ('completed', 'partial', 'failed'));
  ALTER TABLE transcriptions ADD COLUMN provider_meta TEXT;
  ALTER TABLE transcriptions ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE segments ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE segments ADD COLUMN provider_speaker INTEGER;
  ALTER TABLE segments ADD COLUMN confidence REAL;
  ALTER TABLE segments ADD COLUMN speaker_confidence REAL;
  CREATE TABLE transcription_jobs (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
    status              TEXT NOT NULL CHECK (status IN ('queued', 'uploading', 'preparing', 'transcribing', 'completed', 'failed')),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    audio_path          TEXT,
    audio_bytes         INTEGER,
    expected_speakers   INTEGER,
    duration_seconds    REAL,
    mode                TEXT CHECK (mode IN ('sync', 'callback', 'local')),
    provider_request_id TEXT,
    callback_secret_hash TEXT,
    transcription_id    TEXT REFERENCES transcriptions(id) ON DELETE SET NULL,
    error_code          TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    submitted_at        TEXT,
    expires_at          TEXT
  );
  CREATE INDEX transcription_jobs_owner ON transcription_jobs (owner_id, created_at DESC);
  CREATE INDEX transcription_jobs_status ON transcription_jobs (status);
  `,
  // 4: doctor voice profiles and voice-identification results.
  //  - voice_profiles: ONE profile per doctor (the primary key is the verified owner id). `ciphertext` is the
  //    AES-256-GCM encrypted reference embeddings (biometric data); nothing else about the voice is stored, and raw
  //    enrollment audio is never kept.
  //  - transcriptions.speaker_source: which analysis produced the speaker labels (deepgram | independent);
  //    transcriptions.voice_status: whether/why the doctor's voice was identified.
  //  - speakers: model-generated identification (never a confirmed role) kept apart from the doctor's `role`.
  `
  CREATE TABLE voice_profiles (
    owner_id            TEXT PRIMARY KEY REFERENCES doctors(id) ON DELETE CASCADE,
    status              TEXT NOT NULL CHECK (status IN ('enrolled')),
    model_name          TEXT NOT NULL,
    model_version       TEXT NOT NULL,
    embedding_version   TEXT NOT NULL,
    sample_count        INTEGER NOT NULL,
    consent_recorded_at TEXT NOT NULL,
    consent_version     TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    ciphertext          BLOB NOT NULL
  );
  ALTER TABLE transcriptions ADD COLUMN speaker_source TEXT;
  ALTER TABLE transcriptions ADD COLUMN voice_status TEXT;
  ALTER TABLE speakers ADD COLUMN identification_status TEXT;
  ALTER TABLE speakers ADD COLUMN suggested_role TEXT;
  `,
  // 5. SOAP notes.
  //  - transcriptions.revision counts every edit to the transcript (segment text, segment speaker, speaker role). A note records the
  //    revision it was generated from, so "the transcript changed after this note was written" is detectable instead of assumed.
  //  - One note per transcription (PRIMARY KEY), so repeated completion events or retries can never create competing drafts.
  //  - sections/claims/review_flags are JSON documents; the prompt and the provider's raw response are deliberately NOT stored.
  `
  ALTER TABLE transcriptions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE doctors ADD COLUMN soap_template_id TEXT;
  CREATE TABLE soap_notes (
    transcription_id            TEXT PRIMARY KEY REFERENCES transcriptions(id) ON DELETE CASCADE,
    owner_id                    TEXT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
    template_id                 TEXT NOT NULL,
    status                      TEXT NOT NULL CHECK (status IN ('processing', 'draft_ready', 'failed', 'approved')),
    generation_stage            TEXT,
    error_code                  TEXT,
    source_transcript_revision  INTEGER NOT NULL,
    sections                    TEXT NOT NULL,
    claims                      TEXT NOT NULL,
    review_flags                TEXT NOT NULL,
    revision                    INTEGER NOT NULL DEFAULT 1,
    edited                      INTEGER NOT NULL DEFAULT 0,
    provider                    TEXT,
    model                       TEXT,
    usage                       TEXT,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    approved_at                 TEXT,
    approved_by                 TEXT
  );
  CREATE INDEX soap_notes_owner ON soap_notes(owner_id);
  `,
];

export function openStore(dbPath) {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  if (dbPath !== ":memory:") {
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // best effort
    }
  }

  const version = db.prepare("PRAGMA user_version").get().user_version;
  for (let index = version; index < MIGRATIONS.length; index++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const q = {
    upsertDoctor: db.prepare(
      `INSERT INTO doctors (id, email, display_name, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name`,
    ),
    insertTranscription: db.prepare(
      `INSERT INTO transcriptions (id, owner_id, created_at, duration_seconds, text, diarization_status, speaker_count, engine,
                                   diarization_result, provider_meta, warnings, speaker_source, voice_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertSpeaker: db.prepare(
      "INSERT INTO speakers (transcription_id, id, label, role, identification_status, suggested_role) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    voiceGet: db.prepare("SELECT * FROM voice_profiles WHERE owner_id = ?"),
    voicePut: db.prepare(
      `INSERT INTO voice_profiles (owner_id, status, model_name, model_version, embedding_version, sample_count, consent_recorded_at, consent_version, created_at, updated_at, ciphertext)
       VALUES (?, 'enrolled', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id) DO UPDATE SET model_name = excluded.model_name, model_version = excluded.model_version,
         embedding_version = excluded.embedding_version, sample_count = excluded.sample_count, consent_recorded_at = excluded.consent_recorded_at,
         consent_version = excluded.consent_version, updated_at = excluded.updated_at, ciphertext = excluded.ciphertext`,
    ),
    voiceDelete: db.prepare("DELETE FROM voice_profiles WHERE owner_id = ?"),
    insertSegment: db.prepare(
      `INSERT INTO segments (transcription_id, id, seq, speaker_id, start_ms, end_ms, text,
                            needs_review, provider_speaker, confidence, speaker_confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // Jobs. Owner-scoped variants are used by the API; the unscoped ones only by the worker/callback.
    insertJob: db.prepare(
      `INSERT INTO transcription_jobs (id, owner_id, status, created_at, updated_at, audio_path, audio_bytes, expected_speakers, expires_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    ),
    jobOwned: db.prepare("SELECT * FROM transcription_jobs WHERE id = ? AND owner_id = ?"),
    jobById: db.prepare("SELECT * FROM transcription_jobs WHERE id = ?"),
    jobList: db.prepare("SELECT * FROM transcription_jobs WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 50"),
    jobsByStatus: db.prepare("SELECT * FROM transcription_jobs WHERE status IN (SELECT value FROM json_each(?))"),
    jobDelete: db.prepare("DELETE FROM transcription_jobs WHERE id = ? AND owner_id = ?"),
    jobFinish: db.prepare(
      `UPDATE transcription_jobs SET status = 'completed', transcription_id = ?, audio_path = NULL, error_code = NULL, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
    ),
    jobsExpired: db.prepare("SELECT * FROM transcription_jobs WHERE expires_at IS NOT NULL AND expires_at < ?"),
    // Every read/write below is scoped by owner_id. Never query by id alone.
    owned: db.prepare("SELECT * FROM transcriptions WHERE id = ? AND owner_id = ?"),
    list: db.prepare(
      `SELECT id, created_at, duration_seconds, review_status FROM transcriptions
       WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
    ),
    speakers: db.prepare("SELECT id, label, role, identification_status, suggested_role FROM speakers WHERE transcription_id = ? ORDER BY rowid"),
    segments: db.prepare(
      "SELECT id, start_ms, end_ms, text, speaker_id, needs_review FROM segments WHERE transcription_id = ? ORDER BY seq",
    ),
    remove: db.prepare("DELETE FROM transcriptions WHERE id = ? AND owner_id = ?"),
    setRole: db.prepare("UPDATE speakers SET role = ? WHERE transcription_id = ? AND id = ?"),
    speakerExists: db.prepare("SELECT 1 AS ok FROM speakers WHERE transcription_id = ? AND id = ?"),
    segmentExists: db.prepare("SELECT 1 AS ok FROM segments WHERE transcription_id = ? AND id = ?"),
    // Editing a segment is a human review of it, so its needs_review flag is cleared.
    setSegmentText: db.prepare("UPDATE segments SET text = ?, needs_review = 0 WHERE transcription_id = ? AND id = ?"),
    setSegmentSpeaker: db.prepare("UPDATE segments SET speaker_id = ?, needs_review = 0 WHERE transcription_id = ? AND id = ?"),
    setText: db.prepare("UPDATE transcriptions SET text = ? WHERE id = ? AND owner_id = ?"),
    setReview: db.prepare("UPDATE transcriptions SET review_status = ? WHERE id = ? AND owner_id = ?"),
    // Every edit to a transcript bumps its revision, so a SOAP note can tell whether its sources still say what they said.
    bumpRevision: db.prepare("UPDATE transcriptions SET revision = revision + 1 WHERE id = ? AND owner_id = ?"),
    // SOAP notes. Owner-scoped everywhere; the transcription's own ownership is checked first by load().
    soapGet: db.prepare("SELECT * FROM soap_notes WHERE transcription_id = ? AND owner_id = ?"),
    soapInsert: db.prepare(
      `INSERT INTO soap_notes (transcription_id, owner_id, template_id, status, generation_stage, source_transcript_revision,
                               sections, claims, review_flags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    soapList: db.prepare("SELECT transcription_id, status FROM soap_notes WHERE owner_id = ?"),
    soapStuck: db.prepare("SELECT * FROM soap_notes WHERE status = 'processing' AND updated_at < ?"),
    prefGet: db.prepare("SELECT soap_template_id FROM doctors WHERE id = ?"),
    prefSet: db.prepare("UPDATE doctors SET soap_template_id = ? WHERE id = ?"),
  };

  const transaction = (work) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  /** The full resource, or throws NOT_FOUND when the transcription is missing or owned by someone else. */
  function load(ownerId, id) {
    const row = q.owned.get(String(id), ownerId);
    if (!row) throw notFound();
    return {
      id: row.id,
      status: "completed", // a transcription resource exists only once processing has finished
      text: row.text,
      durationSeconds: row.duration_seconds,
      createdAt: row.created_at,
      reviewStatus: row.review_status,
      // Counts every edit to this transcript. A SOAP note stores the revision it was written from, so a client (and the
      // backend) can tell that the sources moved underneath it. Starts at 1; never decreases.
      revision: row.revision ?? 1,
      engine: row.engine,
      // diarization.status is the original field (kept for existing clients); diarizationStatus is the
      // provider-neutral one: completed | partial | failed.
      diarizationStatus: row.diarization_result ?? { ok: "completed", failed: "failed", unavailable: "failed" }[row.diarization_status],
      diarization: { status: row.diarization_status, speakerCount: row.speaker_count },
      warnings: JSON.parse(row.warnings ?? "[]"),
      // Which analysis produced the speaker labels, and whether the doctor's enrolled voice was identified.
      speakerSource: row.speaker_source ?? (row.engine === "deepgram" ? "deepgram" : "local"),
      // which system produced the speaker labels, by name (pyannote Community-1, Deepgram's own diarizer, the older sherpa-onnx + ECAPA check, or the local engine)
      diarizationProvider: { pyannote: "pyannote-community-1", deepgram: "deepgram", independent: "sherpa-onnx+ecapa", local: "sherpa-onnx" }[row.speaker_source ?? (row.engine === "deepgram" ? "deepgram" : "local")] ?? null,
      voiceIdentificationStatus: row.voice_status ?? "not_enrolled",
      speakers: q.speakers.all(row.id).map((sp) => ({
        id: sp.id, label: sp.label, role: sp.role, // role = what the DOCTOR confirmed
        identificationStatus: sp.identification_status ?? "unavailable", // matched | unknown | uncertain | unavailable (model output)
        suggestedRole: sp.suggested_role ?? null, // a model suggestion, never a confirmed assignment
      })),
      segments: q.segments.all(row.id).map((segment) => ({
        id: segment.id,
        startMs: segment.start_ms,
        endMs: segment.end_ms,
        text: segment.text,
        speakerId: segment.speaker_id,
        needsReview: Boolean(segment.needs_review),
      })),
    };
  }

  const joinText = (segments) => segments.map((segment) => segment.text).join(" ");

  /** Insert a transcription with its speakers and segments. Call inside a transaction. Returns its id. */
  function insertTranscription(
    ownerId,
    { durationSeconds, diarizationStatus, diarizationResult = null, speakers, segments, engine = "local", providerMeta = null, warnings = [], speakerSource = null, voiceStatus = null },
  ) {
    const id = `tr_${randomUUID()}`;
    q.insertTranscription.run(
      id, ownerId, new Date().toISOString(), durationSeconds ?? null, joinText(segments), diarizationStatus, speakers.length, engine,
      diarizationResult, providerMeta ? JSON.stringify(providerMeta) : null, JSON.stringify(warnings), speakerSource, voiceStatus,
    );
    for (const speaker of speakers) q.insertSpeaker.run(id, speaker.id, speaker.label, speaker.role, speaker.identificationStatus ?? null, speaker.suggestedRole ?? null);
    segments.forEach((segment, index) =>
      q.insertSegment.run(
        id, segment.id, index, segment.speakerId, segment.startMs, segment.endMs, segment.text,
        segment.needsReview ? 1 : 0, segment.providerSpeaker ?? null, segment.confidence ?? null, segment.speakerConfidence ?? null,
      ),
    );
    return id;
  }

  return {
    close: () => db.close(),

    upsertDoctor({ id, email, displayName }) {
      q.upsertDoctor.run(id, email ?? null, displayName ?? null, new Date().toISOString());
    },

    createTranscription(ownerId, data) {
      return transaction(() => load(ownerId, insertTranscription(ownerId, data)));
    },

    /** The internal provider metadata (request id, model, diarizer version). Never sent to clients. */
    providerMeta(ownerId, id) {
      load(ownerId, id); // ownership check
      return JSON.parse(q.owned.get(String(id), ownerId).provider_meta ?? "null");
    },

    // ---- doctor voice profiles (biometric; every call is scoped to the verified owner) -------------
    /** Safe metadata only. The encrypted embeddings are returned separately and never leave the server. */
    voiceProfileMeta(ownerId) {
      const row = q.voiceGet.get(ownerId);
      return row && {
        enrolledAt: row.created_at, updatedAt: row.updated_at, sampleCount: row.sample_count, modelName: row.model_name,
        modelVersion: row.model_version, embeddingVersion: row.embedding_version, consentRecordedAt: row.consent_recorded_at, consentVersion: row.consent_version,
      };
    },
    voiceProfileCiphertext: (ownerId) => {
      const blob = q.voiceGet.get(ownerId)?.ciphertext;
      return blob ? Buffer.from(blob) : null; // node:sqlite returns a Uint8Array
    },
    /** Create or REPLACE the caller's profile atomically (one profile per doctor). */
    saveVoiceProfile(ownerId, { modelName, modelVersion, embeddingVersion, sampleCount, consentVersion, ciphertext }) {
      const now = new Date().toISOString();
      const existing = q.voiceGet.get(ownerId);
      q.voicePut.run(ownerId, modelName, modelVersion, embeddingVersion, sampleCount, now, consentVersion, existing?.created_at ?? now, now, ciphertext);
    },
    deleteVoiceProfile: (ownerId) => q.voiceDelete.run(ownerId).changes > 0,

    // ---- jobs ------------------------------------------------------------------------------
    createJob(ownerId, { audioPath, audioBytes, expectedSpeakers = null, expiresAt }) {
      const id = `job_${randomUUID()}`;
      const now = new Date().toISOString();
      q.insertJob.run(id, ownerId, now, now, audioPath, audioBytes, expectedSpeakers, expiresAt ?? null);
      return q.jobById.get(id);
    },
    getJob(ownerId, id) {
      const job = q.jobOwned.get(String(id), ownerId);
      if (!job) throw notFound();
      return job;
    },
    listJobs: (ownerId) => q.jobList.all(ownerId),
    /** Worker/callback use only: no owner scoping. */
    jobById: (id) => q.jobById.get(String(id)) ?? null,
    jobsInStatus: (statuses) => q.jobsByStatus.all(JSON.stringify(statuses)),
    expiredJobs: (nowIso) => q.jobsExpired.all(nowIso),
    updateJob(id, fields) {
      const columns = Object.keys(fields);
      const allowed = ["status", "audio_path", "duration_seconds", "mode", "provider_request_id", "callback_secret_hash",
        "transcription_id", "error_code", "attempts", "submitted_at", "expires_at"];
      if (columns.length === 0 || columns.some((column) => !allowed.includes(column))) throw new Error("invalid job update");
      db.prepare(`UPDATE transcription_jobs SET ${columns.map((column) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...columns.map((column) => fields[column]), new Date().toISOString(), String(id));
      return q.jobById.get(String(id));
    },
    deleteJob(ownerId, id) {
      if (q.jobDelete.run(String(id), ownerId).changes === 0) throw notFound();
    },
    /** Save the transcript and finish its job in one transaction (so a crash cannot leave one without the other). */
    completeJob(ownerId, jobId, data) {
      return transaction(() => {
        const transcriptionId = insertTranscription(ownerId, data);
        q.jobFinish.run(transcriptionId, new Date().toISOString(), String(jobId), ownerId);
        return load(ownerId, transcriptionId);
      });
    },

    list(ownerId) {
      return q.list.all(ownerId).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        durationSeconds: row.duration_seconds,
        reviewStatus: row.review_status,
      }));
    },

    get: load,

    delete(ownerId, id) {
      if (q.remove.run(String(id), ownerId).changes === 0) throw notFound();
    },

    setSpeakerRole(ownerId, id, speakerId, role) {
      if (!ROLES.includes(role)) throw invalidRequest(`role must be one of: ${ROLES.join(", ")}.`);
      return transaction(() => {
        load(ownerId, id); // ownership check
        if (!q.speakerExists.get(id, String(speakerId))) throw invalidRequest("That speaker does not belong to this transcription.");
        q.setRole.run(role, id, String(speakerId));
        q.setReview.run("needs_review", id, ownerId); // changed after review => review again
        q.bumpRevision.run(id, ownerId); // a SOAP note generated from the old revision is now stale
        return load(ownerId, id);
      });
    },

    updateSegment(ownerId, id, segmentId, changes) {
      const hasText = Object.hasOwn(changes, "text");
      const hasSpeaker = Object.hasOwn(changes, "speakerId");
      if (!hasText && !hasSpeaker) throw invalidRequest("Provide text, speakerId, or both.");
      if (hasText && (typeof changes.text !== "string" || !changes.text.trim() || changes.text.length > MAX_SEGMENT_TEXT_LENGTH)) {
        throw invalidRequest(`text must be a non-empty string of at most ${MAX_SEGMENT_TEXT_LENGTH} characters.`);
      }
      if (hasSpeaker && changes.speakerId !== null && typeof changes.speakerId !== "string") {
        throw invalidRequest("speakerId must be a speaker id or null.");
      }
      return transaction(() => {
        load(ownerId, id); // ownership check
        if (!q.segmentExists.get(id, String(segmentId))) throw notFound();
        if (hasSpeaker && changes.speakerId !== null && !q.speakerExists.get(id, changes.speakerId)) {
          throw invalidRequest("That speaker does not belong to this transcription.");
        }
        if (hasText) q.setSegmentText.run(changes.text.trim(), id, String(segmentId));
        if (hasSpeaker) q.setSegmentSpeaker.run(changes.speakerId, id, String(segmentId));
        // Keep the full text consistent with its segments. Audio is never re-transcribed.
        q.setText.run(joinText(q.segments.all(id)), id, ownerId);
        q.setReview.run("needs_review", id, ownerId); // changed after review => review again
        q.bumpRevision.run(id, ownerId); // a SOAP note generated from the old revision is now stale
        return load(ownerId, id);
      });
    },

    /**
     * Explicit review confirmation (POST /api/transcriptions/:id/review). Nothing else ever sets
     * "reviewed"; any later edit puts the transcript back to "needs_review". Idempotent.
     */
    markReviewed(ownerId, id) {
      return transaction(() => {
        load(ownerId, id); // ownership check
        q.setReview.run("reviewed", id, ownerId);
        return load(ownerId, id);
      });
    },

    // ---- SOAP notes -----------------------------------------------------------------------------
    // One note per transcription. Everything is scoped to the verified owner, and the parent transcription's ownership is
    // checked first, so doctor B can never see or touch doctor A's note even with a guessed id.

    /** The note for a transcription, or null. Throws NOT_FOUND when the transcription is not the caller's. */
    getSoapNote(ownerId, id) {
      load(ownerId, id); // ownership of the parent transcription
      return toSoapNote(q.soapGet.get(String(id), ownerId));
    },

    /**
     * Claim the single note slot for this transcription, atomically. Returns the new `processing` note, or null when one
     * already exists (a concurrent or repeated completion event: the caller must not start a second generation).
     */
    claimSoapNote(ownerId, id, { templateId, sourceTranscriptRevision }) {
      return transaction(() => {
        load(ownerId, id);
        if (q.soapGet.get(String(id), ownerId)) return null; // already claimed: never a competing draft
        const now = new Date().toISOString();
        q.soapInsert.run(String(id), ownerId, templateId, "processing", "queued", sourceTranscriptRevision,
          JSON.stringify(EMPTY_SECTIONS), "[]", "[]", now, now);
        return toSoapNote(q.soapGet.get(String(id), ownerId));
      });
    },

    /**
     * Update a note's own fields. `expectedRevision` (for doctor edits) makes the write conditional: it throws CONFLICT when
     * someone else saved first, so a slow tab cannot overwrite newer edits. Approved notes are read-only.
     */
    updateSoapNote(ownerId, id, changes, { expectedRevision = null, allowApproved = false } = {}) {
      return transaction(() => {
        load(ownerId, id);
        const row = q.soapGet.get(String(id), ownerId);
        if (!row) throw notFound();
        if (row.status === "approved" && !allowApproved) throw new AppError("NOTE_APPROVED", 409, "This note has been approved and can no longer be changed.");
        if (expectedRevision !== null && row.revision !== expectedRevision) {
          throw new AppError("CONFLICT", 409, `This note was changed elsewhere (it is now revision ${row.revision}). Reload it and re-apply your edit.`, { extra: { currentRevision: row.revision } });
        }
        const columns = { ...changes };
        if (columns.sections) columns.sections = JSON.stringify(columns.sections);
        if (columns.claims) columns.claims = JSON.stringify(columns.claims);
        if (columns.review_flags) columns.review_flags = JSON.stringify(columns.review_flags);
        if (columns.usage) columns.usage = JSON.stringify(columns.usage);
        const allowed = ["status", "generation_stage", "error_code", "sections", "claims", "review_flags", "revision", "edited",
          "provider", "model", "usage", "approved_at", "approved_by", "source_transcript_revision", "template_id"];
        const keys = Object.keys(columns);
        if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) throw new Error("invalid soap note update");
        db.prepare(`UPDATE soap_notes SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE transcription_id = ? AND owner_id = ?`)
          .run(...keys.map((key) => columns[key]), new Date().toISOString(), String(id), ownerId);
        return toSoapNote(q.soapGet.get(String(id), ownerId));
      });
    },

    deleteSoapNote(ownerId, id) {
      return transaction(() => {
        load(ownerId, id);
        return db.prepare("DELETE FROM soap_notes WHERE transcription_id = ? AND owner_id = ?").run(String(id), ownerId).changes > 0;
      });
    },

    /** Notes stuck in `processing` (a crash or restart mid-generation), for recovery at startup. No owner scoping: worker use only. */
    stuckSoapNotes: (olderThanIso) => q.soapStuck.all(olderThanIso),

    /** The doctor's chosen SOAP template, or null when they have never chosen one. */
    soapPreference: (ownerId) => q.prefGet.get(ownerId)?.soap_template_id ?? null,
    setSoapPreference(ownerId, templateId) {
      q.prefSet.run(templateId, ownerId);
      return templateId;
    },
  };
}

const EMPTY_SECTIONS = { subjective: "", objective: "", assessment: "", plan: "" };

/** A stored row as the API resource. Never exposes the provider's raw response (none is stored) or internal columns. */
function toSoapNote(row) {
  if (!row) return null;
  return {
    id: `soap_${row.transcription_id}`,
    transcriptionId: row.transcription_id,
    templateId: row.template_id,
    status: row.status,
    generationStage: row.generation_stage,
    errorCode: row.error_code,
    revision: row.revision,
    sourceTranscriptRevision: row.source_transcript_revision,
    sections: JSON.parse(row.sections),
    claims: JSON.parse(row.claims),
    reviewFlags: JSON.parse(row.review_flags),
    edited: Boolean(row.edited),
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
  };
}
