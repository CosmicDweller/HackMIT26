import { useCallback, useRef, useState } from "react";
import { TranscribeApiError, runTranscription } from "@/services/transcriptionService";
import type { ErrorCode } from "@/types";

export interface TranscriptionError {
  message: string;
  code: ErrorCode;
}

export function useTranscription() {
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [error, setError] = useState<TranscriptionError | null>(null);
  const inFlightRef = useRef(false);

  const transcribe = useCallback(async (audio: Blob, fileName: string) => {
    if (inFlightRef.current) return; // guard against duplicate submissions
    inFlightRef.current = true;
    setTranscribing(true);
    setError(null);

    try {
      const result = await runTranscription(audio, fileName);
      setTranscript(result.text);
      setDurationSeconds(result.durationSeconds);
    } catch (err) {
      if (err instanceof TranscribeApiError) {
        setError({ message: err.message, code: err.code });
      } else {
        setError({
          message: "Something went wrong while transcribing.",
          code: "TRANSCRIPTION_FAILED",
        });
      }
    } finally {
      setTranscribing(false);
      inFlightRef.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    setTranscribing(false);
    setTranscript(null);
    setDurationSeconds(null);
    setError(null);
  }, []);

  return { transcribing, transcript, durationSeconds, error, transcribe, reset, setTranscript };
}
