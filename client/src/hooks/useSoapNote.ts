import { useCallback, useEffect, useRef, useState } from "react";
import { TranscribeApiError } from "@/services/transcribeApi";
import { soap } from "@/services/soap/soapService";
import type { SoapNote, SoapSections } from "@/types";

const POLL_INTERVAL_MS = 2000;

export type SaveState = "idle" | "saving" | "saved" | "error";

export function useSoapNote(transcriptionId: string) {
  const [note, setNote] = useState<SoapNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictNote, setConflictNote] = useState<SoapNote | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against starting a second generation/recovery — set once and never reset, so
  // React 18 StrictMode's dev-only double-invoke of effects can't cause a duplicate.
  const startedRef = useRef(false);
  // Whether the component is currently mounted right now — separate from startedRef.
  // StrictMode's synthetic mount -> cleanup -> remount cycle must not permanently block
  // the single in-flight fetch from ever applying its result (that fetch's own promise
  // survives the synthetic cleanup and resolves after the real remount).
  const mountedRef = useRef(false);

  const clearPoll = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);

  const poll = useCallback(() => {
    clearPoll();
    pollRef.current = setTimeout(async () => {
      try {
        const latest = await soap.get(transcriptionId);
        if (!mountedRef.current) return;
        if (latest) {
          setNote(latest);
          if (latest.status === "processing") poll();
        }
      } catch {
        if (mountedRef.current) poll(); // transient network hiccup — keep trying
      }
    }, POLL_INTERVAL_MS);
  }, [transcriptionId, clearPoll]);

  useEffect(() => {
    mountedRef.current = true;

    if (!startedRef.current) {
      startedRef.current = true;
      (async () => {
        setLoading(true);
        setLoadError(null);
        try {
          let current = await soap.get(transcriptionId);
          if (!current) current = await soap.create(transcriptionId); // idempotent recovery only
          if (!mountedRef.current) return;
          setNote(current);
          if (current.status === "processing") poll();
        } catch {
          if (mountedRef.current) setLoadError("Couldn't load the SOAP note for this consultation.");
        } finally {
          if (mountedRef.current) setLoading(false);
        }
      })();
    }

    return () => {
      mountedRef.current = false;
      clearPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptionId]);

  const save = useCallback(
    async (sections: SoapSections): Promise<boolean> => {
      if (!note) return false;
      setSaveState("saving");
      setSaveError(null);
      try {
        const updated = await soap.update(transcriptionId, { sections, revision: note.revision });
        setNote(updated);
        setSaveState("saved");
        return true;
      } catch (err) {
        if (err instanceof TranscribeApiError && err.code === "CONFLICT") {
          const latest = await soap.get(transcriptionId).catch(() => null);
          if (latest) setConflictNote(latest);
          setSaveError("This note was changed elsewhere — your edits weren't saved.");
        } else {
          setSaveError("Couldn't save. Try again.");
        }
        setSaveState("error");
        return false;
      }
    },
    [note, transcriptionId],
  );

  const approve = useCallback(async (): Promise<boolean> => {
    if (!note) return false;
    setApproving(true);
    setApproveError(null);
    try {
      const approved = await soap.approve(transcriptionId, note.revision);
      setNote(approved);
      return true;
    } catch (err) {
      if (err instanceof TranscribeApiError && err.code === "CONFLICT") {
        const latest = await soap.get(transcriptionId).catch(() => null);
        if (latest) setConflictNote(latest);
        setApproveError("This note was changed elsewhere — reload before approving.");
      } else if (err instanceof TranscribeApiError) {
        setApproveError(err.message);
      } else {
        setApproveError("Couldn't approve this note. Try again.");
      }
      return false;
    } finally {
      setApproving(false);
    }
  }, [note, transcriptionId]);

  /** Retries a save after a conflict, using the just-fetched conflictNote's revision
   * instead of the stale one — lets the doctor keep their local edits rather than
   * forcing a full discard-and-reload. */
  const retryAfterConflict = useCallback(
    async (sections: SoapSections): Promise<boolean> => {
      if (!conflictNote) return false;
      setSaveState("saving");
      setSaveError(null);
      try {
        const updated = await soap.update(transcriptionId, { sections, revision: conflictNote.revision });
        setNote(updated);
        setConflictNote(null);
        setSaveState("saved");
        return true;
      } catch (err) {
        if (err instanceof TranscribeApiError && err.code === "CONFLICT") {
          const latest = await soap.get(transcriptionId).catch(() => null);
          if (latest) setConflictNote(latest);
          setSaveError("Someone else changed this note again — your edits weren't saved.");
        } else {
          setSaveError("Couldn't save. Try again.");
        }
        setSaveState("error");
        return false;
      }
    },
    [conflictNote, transcriptionId],
  );

  const discardConflict = useCallback(() => {
    if (conflictNote) setNote(conflictNote);
    setConflictNote(null);
    setSaveError(null);
    setApproveError(null);
    setSaveState("idle");
  }, [conflictNote]);

  const refresh = useCallback(async () => {
    const latest = await soap.get(transcriptionId).catch(() => null);
    if (latest) setNote(latest);
  }, [transcriptionId]);

  return {
    note,
    loading,
    loadError,
    saveState,
    saveError,
    conflictNote,
    approving,
    approveError,
    save,
    retryAfterConflict,
    approve,
    discardConflict,
    refresh,
  };
}
