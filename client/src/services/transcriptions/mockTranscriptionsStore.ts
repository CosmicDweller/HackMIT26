import { authProvider } from "@/services/auth";
import { TranscribeApiError } from "@/services/transcribeApi";
import { isEnrolled } from "@/services/voiceProfile/mockVoiceProfileStore";
import {
  FIXTURE_SEGMENTS,
  FIXTURE_SPEAKERS,
  fixtureFullText,
} from "@/lib/transcriptionFixtures";
import type { Transcription } from "@/types";

/**
 * Shared in-memory store backing both the mock transcriptions API and the
 * mock jobs API, so a mock job's "completion" and the synchronous mock
 * create() produce transcripts that behave identically. Nothing here is
 * written to localStorage; it resets on page reload.
 */

export interface StoredTranscription extends Transcription {
  ownerId: string;
}

export const store = new Map<string, StoredTranscription>();

export function delay<T>(value: T, ms = 900): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export async function requireUserId(): Promise<string> {
  const session = await authProvider.getSession();
  if (!session) {
    throw new TranscribeApiError({
      error: "You must be signed in.",
      code: "UNAUTHENTICATED",
    });
  }
  return session.id;
}

export function toPublic(record: StoredTranscription): Transcription {
  const { ownerId: _ownerId, ...rest } = record;
  return structuredClone(rest);
}

export async function requireOwned(id: string, userId: string): Promise<StoredTranscription> {
  const record = store.get(id);
  if (!record || record.ownerId !== userId) {
    throw new TranscribeApiError({
      error: "Transcript not found.",
      code: "NOT_FOUND",
    });
  }
  return record;
}

/**
 * Creates and stores a new synthetic transcription for the given owner.
 * Never analyzes the actual uploaded audio — always the same clearly-labeled
 * fixture, so it can never be mistaken for a real diarization result.
 * Includes a MINOR_SPEAKER_DETECTED warning on the third speaker's segments,
 * mirroring what the backend actually observed on a real 2-hour recording.
 */
export function createMockTranscription(ownerId: string): Transcription {
  const id = crypto.randomUUID();
  const segments = structuredClone(FIXTURE_SEGMENTS);
  const minorSpeaker = segments.find((s) => s.speakerId === "speaker_3");
  if (minorSpeaker) minorSpeaker.needsReview = true;

  const speakers = structuredClone(FIXTURE_SPEAKERS);
  // Only suggest a voice match when the doctor has actually enrolled a profile — the
  // suggestion is advisory (identificationStatus), never auto-assigned to `role`.
  const enrolled = isEnrolled(ownerId);
  if (enrolled) {
    speakers[0].identificationStatus = "matched";
    for (let i = 1; i < speakers.length; i++) speakers[i].identificationStatus = "unknown";
  }

  // reviewStatus only ever changes via the explicit review action — never
  // derived from speaker/segment edits, matching the real backend.
  const transcription: Transcription = {
    id,
    text: fixtureFullText(),
    durationSeconds: 38.5,
    reviewStatus: "needs_review",
    createdAt: new Date().toISOString(),
    engine: "local",
    speakers,
    segments,
    diarization: { status: "ok", speakerCount: FIXTURE_SPEAKERS.length },
    status: "completed",
    diarizationStatus: "completed",
    voiceIdentificationStatus: enrolled ? "completed" : "unavailable",
    warnings: minorSpeaker
      ? [
          {
            code: "MINOR_SPEAKER_DETECTED",
            message: "Speaker 3 owns a small fraction of the speech — likely a detection artefact.",
          },
        ]
      : [],
  };
  store.set(id, { ...transcription, ownerId });
  return toPublic(store.get(id)!);
}
