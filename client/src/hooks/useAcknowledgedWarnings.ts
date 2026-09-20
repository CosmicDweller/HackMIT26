import { useCallback, useEffect, useState } from "react";

/**
 * Tracks which transcript-level warnings the doctor has acknowledged.
 *
 * These are DEVICE-LOCAL. The backend stores `warnings` as a write-once JSON column with
 * no per-warning id and no acknowledge endpoint (see the coordination note on issue #3),
 * so there is nothing server-side to record this against yet. Acknowledging therefore
 * only collapses the notice on this device — it never deletes it, and the collapsed
 * notice stays reachable, so no advisory can be permanently hidden. When the backend
 * grows a real endpoint this should move server-side, where an acknowledgement can be
 * attributed and audited.
 */
function storageKey(userId: string | undefined, transcriptionId: string): string {
  return `acknowledgedWarnings:${userId ?? "anon"}:${transcriptionId}`;
}

function read(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function write(key: string, codes: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...codes]));
  } catch {
    // Private browsing or blocked storage — acknowledgement just won't persist.
  }
}

export function useAcknowledgedWarnings(transcriptionId: string, userId: string | undefined) {
  const key = storageKey(userId, transcriptionId);
  const [codes, setCodes] = useState<Set<string>>(() => read(key));

  // Switching transcripts (or users) must not carry acknowledgements across.
  useEffect(() => setCodes(read(key)), [key]);

  const acknowledge = useCallback(
    (code: string) => {
      setCodes((prev) => {
        const next = new Set(prev).add(code);
        write(key, next);
        return next;
      });
    },
    [key],
  );

  const acknowledgeAll = useCallback(
    (allCodes: string[]) => {
      setCodes((prev) => {
        const next = new Set(prev);
        allCodes.forEach((c) => next.add(c));
        write(key, next);
        return next;
      });
    },
    [key],
  );

  const reopen = useCallback(() => {
    setCodes(() => {
      write(key, new Set());
      return new Set();
    });
  }, [key]);

  return { acknowledgedCodes: codes, acknowledge, acknowledgeAll, reopen };
}
