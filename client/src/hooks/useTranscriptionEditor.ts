import { useCallback, useEffect, useState } from "react";
import { transcriptions } from "@/services/transcriptions/transcriptionsService";
import type { SpeakerRole, Transcription } from "@/types";

export function useTranscriptionEditor(id: string) {
  const [transcription, setTranscription] = useState<Transcription | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await transcriptions.get(id);
      setTranscription(result);
    } catch {
      setLoadError("Couldn't load this transcript.");
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const withSaving = useCallback(async (key: string, fn: () => Promise<Transcription>) => {
    setSavingIds((prev) => new Set(prev).add(key));
    setSaveError(null);
    try {
      const updated = await fn();
      setTranscription(updated);
    } catch {
      setSaveError("Couldn't save that change. Try again.");
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const updateSpeakerRole = useCallback(
    (speakerId: string, role: SpeakerRole) =>
      withSaving(`speaker:${speakerId}`, () => transcriptions.updateSpeaker(id, speakerId, role)),
    [id, withSaving],
  );

  const updateSegment = useCallback(
    (segmentId: string, patch: { text: string; speakerId: string | null }) =>
      withSaving(`segment:${segmentId}`, () => transcriptions.updateSegment(id, segmentId, patch)),
    [id, withSaving],
  );

  /** Clears one segment's advisory needsReview flag. Re-saving the segment unchanged is
   * how the backend records "a human looked at this" (db/store.js clears needs_review on
   * any segment write), so this is the same path an edit takes — minus the edit. */
  const acknowledgeSegment = useCallback(
    (segmentId: string) => {
      const segment = transcription?.segments.find((s) => s.id === segmentId);
      if (!segment) return Promise.resolve();
      return withSaving(`segment:${segmentId}`, () =>
        transcriptions.updateSegment(id, segmentId, {
          text: segment.text,
          speakerId: segment.speakerId,
        }),
      );
    },
    [id, transcription, withSaving],
  );

  /** Clears every outstanding segment flag, then marks the transcript reviewed. Order
   * matters: the backend resets reviewStatus to needs_review on each segment write, so
   * the review call has to come last or it would be immediately undone. */
  const markAllReviewed = useCallback(async () => {
    const flagged = transcription?.segments.filter((s) => s.needsReview) ?? [];
    await withSaving("review", async () => {
      for (const segment of flagged) {
        await transcriptions.updateSegment(id, segment.id, {
          text: segment.text,
          speakerId: segment.speakerId,
        });
      }
      return transcriptions.review(id);
    });
  }, [id, transcription, withSaving]);

  const isSaving = useCallback((key: string) => savingIds.has(key), [savingIds]);

  return {
    transcription,
    loadError,
    saveError,
    isSaving,
    updateSpeakerRole,
    updateSegment,
    acknowledgeSegment,
    markAllReviewed,
    reload: load,
  };
}
