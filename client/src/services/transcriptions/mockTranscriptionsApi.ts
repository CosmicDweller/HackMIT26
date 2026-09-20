import { TranscribeApiError } from "@/services/transcribeApi";
import type { TranscriptionsApi } from "@/services/transcriptions/transcriptionsApiTypes";
import {
  bumpRevision,
  createMockTranscription,
  delay,
  requireOwned,
  requireUserId,
  store,
  toPublic,
} from "@/services/transcriptions/mockTranscriptionsStore";
import { autoStartSoapGeneration } from "@/services/soap/mockSoapStore";

/**
 * MOCK transcriptions backend, matching the agreed contract (docs/API_CONTRACT.md
 * v2/v3 on branch lz). Disable via VITE_USE_MOCK_TRANSCRIPTIONS=false.
 */

export const mockTranscriptionsApi: TranscriptionsApi = {
  async create(audio) {
    const ownerId = await requireUserId();
    if (audio.size === 0) {
      throw new TranscribeApiError({ error: "The audio is empty.", code: "INVALID_AUDIO" });
    }
    await delay(undefined, 1800);
    const transcription = createMockTranscription(ownerId);
    autoStartSoapGeneration(transcription.id, ownerId);
    return transcription;
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
    bumpRevision(record);
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
    segment.needsReview = false;
    record.text = record.segments.map((s) => s.text).join(" ");
    bumpRevision(record);
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
