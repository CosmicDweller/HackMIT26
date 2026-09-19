import { authProvider } from "@/services/auth";
import { TranscribeApiError } from "@/services/transcribeApi";
import type { TranscriptionsApi } from "@/services/transcriptions/transcriptionsApiTypes";
import {
  FIXTURE_SEGMENTS,
  FIXTURE_SPEAKERS,
  fixtureFullText,
} from "@/lib/transcriptionFixtures";
import type { Transcription } from "@/types";

/**
 * MOCK transcriptions backend, matching the agreed contract (docs/API_CONTRACT.md
 * v2 on branch lz). Never analyzes the actual uploaded audio; every transcript
 * is the same clearly-labeled synthetic fixture, so this can never be mistaken
 * for a real diarization result. In-memory only — nothing is written to
 * localStorage, and it resets on page reload. Disable via
 * VITE_USE_MOCK_TRANSCRIPTIONS=false.
 */

interface StoredTranscription extends Transcription {
  ownerId: string;
}

const store = new Map<string, StoredTranscription>();

function delay<T>(value: T, ms = 900): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function requireUserId(): Promise<string> {
  const session = await authProvider.getSession();
  if (!session) {
    throw new TranscribeApiError({
      error: "You must be signed in.",
      code: "UNAUTHENTICATED",
    });
  }
  return session.id;
}

function toPublic(record: StoredTranscription): Transcription {
  const { ownerId: _ownerId, ...rest } = record;
  return structuredClone(rest);
}

async function requireOwned(id: string, userId: string): Promise<StoredTranscription> {
  const record = store.get(id);
  if (!record || record.ownerId !== userId) {
    throw new TranscribeApiError({
      error: "Transcript not found.",
      code: "NOT_FOUND",
    });
  }
  return record;
}

export const mockTranscriptionsApi: TranscriptionsApi = {
  async create(audio) {
    const ownerId = await requireUserId();
    if (audio.size === 0) {
      throw new TranscribeApiError({ error: "The audio is empty.", code: "INVALID_AUDIO" });
    }
    await delay(undefined, 1800);

    const id = crypto.randomUUID();
    // reviewStatus only ever changes via the explicit review() action below —
    // never derived from speaker/segment edits, matching the real backend.
    const base: Transcription = {
      id,
      text: fixtureFullText(),
      durationSeconds: 38.5,
      reviewStatus: "needs_review",
      createdAt: new Date().toISOString(),
      speakers: structuredClone(FIXTURE_SPEAKERS),
      segments: structuredClone(FIXTURE_SEGMENTS),
      diarization: { status: "ok", speakerCount: FIXTURE_SPEAKERS.length },
    };
    store.set(id, { ...base, ownerId });
    return toPublic(store.get(id)!);
  },

  async list() {
    const ownerId = await requireUserId();
    await delay(undefined, 400);
    return [...store.values()]
      .filter((t) => t.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ id, createdAt, durationSeconds, reviewStatus }) => ({
        id,
        createdAt,
        durationSeconds,
        reviewStatus,
      }));
  },

  async get(id) {
    const ownerId = await requireUserId();
    await delay(undefined, 300);
    return toPublic(await requireOwned(id, ownerId));
  },

  async remove(id) {
    const ownerId = await requireUserId();
    await requireOwned(id, ownerId);
    await delay(undefined, 300);
    store.delete(id);
  },

  async updateSpeaker(id, speakerId, role) {
    const ownerId = await requireUserId();
    const record = await requireOwned(id, ownerId);
    await delay(undefined, 400);
    const speaker = record.speakers.find((s) => s.id === speakerId);
    if (!speaker) {
      throw new TranscribeApiError({ error: "Speaker not found.", code: "NOT_FOUND" });
    }
    speaker.role = role;
    return toPublic(record);
  },

  async updateSegment(id, segmentId, patch) {
    const ownerId = await requireUserId();
    const record = await requireOwned(id, ownerId);
    await delay(undefined, 400);
    const segment = record.segments.find((s) => s.id === segmentId);
    if (!segment) {
      throw new TranscribeApiError({ error: "Segment not found.", code: "NOT_FOUND" });
    }
    segment.text = patch.text;
    segment.speakerId = patch.speakerId;
    record.text = record.segments.map((s) => s.text).join(" ");
    return toPublic(record);
  },

  async review(id) {
    const ownerId = await requireUserId();
    const record = await requireOwned(id, ownerId);
    await delay(undefined, 300);
    record.reviewStatus = "reviewed";
    return toPublic(record);
  },
};
