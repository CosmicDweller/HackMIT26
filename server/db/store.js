import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { invalidRequest, notFound } from "../lib/errors.js";

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
      `INSERT INTO transcriptions (id, owner_id, created_at, duration_seconds, text, diarization_status, speaker_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertSpeaker: db.prepare("INSERT INTO speakers (transcription_id, id, label, role) VALUES (?, ?, ?, ?)"),
    insertSegment: db.prepare(
      `INSERT INTO segments (transcription_id, id, seq, speaker_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    // Every read/write below is scoped by owner_id. Never query by id alone.
    owned: db.prepare("SELECT * FROM transcriptions WHERE id = ? AND owner_id = ?"),
    list: db.prepare(
      `SELECT id, created_at, duration_seconds, review_status FROM transcriptions
       WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
    ),
    speakers: db.prepare("SELECT id, label, role FROM speakers WHERE transcription_id = ? ORDER BY rowid"),
    segments: db.prepare(
      "SELECT id, start_ms, end_ms, text, speaker_id FROM segments WHERE transcription_id = ? ORDER BY seq",
    ),
    remove: db.prepare("DELETE FROM transcriptions WHERE id = ? AND owner_id = ?"),
    setRole: db.prepare("UPDATE speakers SET role = ? WHERE transcription_id = ? AND id = ?"),
    speakerExists: db.prepare("SELECT 1 AS ok FROM speakers WHERE transcription_id = ? AND id = ?"),
    segmentExists: db.prepare("SELECT 1 AS ok FROM segments WHERE transcription_id = ? AND id = ?"),
    setSegmentText: db.prepare("UPDATE segments SET text = ? WHERE transcription_id = ? AND id = ?"),
    setSegmentSpeaker: db.prepare("UPDATE segments SET speaker_id = ? WHERE transcription_id = ? AND id = ?"),
    setText: db.prepare("UPDATE transcriptions SET text = ? WHERE id = ? AND owner_id = ?"),
    setReview: db.prepare("UPDATE transcriptions SET review_status = ? WHERE id = ? AND owner_id = ?"),
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
      text: row.text,
      durationSeconds: row.duration_seconds,
      createdAt: row.created_at,
      reviewStatus: row.review_status,
      diarization: { status: row.diarization_status, speakerCount: row.speaker_count },
      speakers: q.speakers.all(row.id).map(({ id: speakerId, label, role }) => ({ id: speakerId, label, role })),
      segments: q.segments.all(row.id).map((segment) => ({
        id: segment.id,
        startMs: segment.start_ms,
        endMs: segment.end_ms,
        text: segment.text,
        speakerId: segment.speaker_id,
      })),
    };
  }

  const joinText = (segments) => segments.map((segment) => segment.text).join(" ");

  return {
    close: () => db.close(),

    upsertDoctor({ id, email, displayName }) {
      q.upsertDoctor.run(id, email ?? null, displayName ?? null, new Date().toISOString());
    },

    createTranscription(ownerId, { durationSeconds, diarizationStatus, speakers, segments }) {
      const id = `tr_${randomUUID()}`;
      transaction(() => {
        q.insertTranscription.run(
          id, ownerId, new Date().toISOString(), durationSeconds ?? null, joinText(segments), diarizationStatus, speakers.length,
        );
        for (const speaker of speakers) q.insertSpeaker.run(id, speaker.id, speaker.label, speaker.role);
        segments.forEach((segment, index) =>
          q.insertSegment.run(id, segment.id, index, segment.speakerId, segment.startMs, segment.endMs, segment.text),
        );
      });
      return load(ownerId, id);
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
        return load(ownerId, id);
      });
    },

    /** Explicit review confirmation. Not exposed via HTTP until the frontend agrees on it. */
    setReviewStatus(ownerId, id, status) {
      load(ownerId, id);
      q.setReview.run(status, id, ownerId);
      return load(ownerId, id);
    },
  };
}
