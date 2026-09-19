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

  const markReviewed = useCallback(
    () => withSaving("review", () => transcriptions.review(id)),
    [id, withSaving],
  );

  const isSaving = useCallback((key: string) => savingIds.has(key), [savingIds]);

  return {
    transcription,
    loadError,
    saveError,
    isSaving,
    updateSpeakerRole,
    updateSegment,
    markReviewed,
    reload: load,
  };
}
