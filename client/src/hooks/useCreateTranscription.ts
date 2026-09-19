import { useCallback, useRef, useState } from "react";
import { TranscribeApiError } from "@/services/transcribeApi";
import { transcriptions } from "@/services/transcriptions/transcriptionsService";
import type { ErrorCode, Transcription } from "@/types";

export interface CreateTranscriptionError {
  message: string;
  code: ErrorCode;
}

export function useCreateTranscription() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<CreateTranscriptionError | null>(null);
  const inFlightRef = useRef(false);

  const create = useCallback(
    async (audio: Blob, fileName: string): Promise<Transcription | null> => {
      if (inFlightRef.current) return null; // guard against duplicate submissions
      inFlightRef.current = true;
      setCreating(true);
      setError(null);

      try {
        return await transcriptions.create(audio, fileName);
      } catch (err) {
        if (err instanceof TranscribeApiError) {
          setError({ message: err.message, code: err.code });
        } else {
          setError({
            message: "Something went wrong while transcribing.",
            code: "TRANSCRIPTION_FAILED",
          });
        }
        return null;
      } finally {
        setCreating(false);
        inFlightRef.current = false;
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setCreating(false);
    setError(null);
  }, []);

  return { creating, error, create, reset };
}
