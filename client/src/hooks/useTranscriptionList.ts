import { useCallback, useEffect, useState } from "react";
import { transcriptions } from "@/services/transcriptions/transcriptionsService";
import type { TranscriptionSummary } from "@/types";

export function useTranscriptionList() {
  const [items, setItems] = useState<TranscriptionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const list = await transcriptions.list();
      setItems(list);
    } catch {
      setError("Couldn't load your transcripts.");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const remove = useCallback(async (id: string) => {
    await transcriptions.remove(id);
    setItems((prev) => prev?.filter((t) => t.id !== id) ?? null);
  }, []);

  return { items, error, reload, remove };
}
