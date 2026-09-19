import { useCallback, useEffect, useRef, useState } from "react";
import { TranscribeApiError } from "@/services/transcribeApi";
import { jobs as jobsApi } from "@/services/transcriptions/jobsService";
import type { ErrorCode, TranscriptionJob } from "@/types";

const POLL_INTERVAL_MS = 1500;

export interface RequestError {
  message: string;
  code: ErrorCode;
}

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export function useTranscriptionJob() {
  const [job, setJob] = useState<TranscriptionJob | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Holds the latest `poll` so the recursive setTimeout callback below can call
  // it without reading `poll` from inside its own initializer.
  const pollRef = useRef<(jobId: string) => void>(() => {});

  const clearPoll = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const poll = useCallback(
    (jobId: string) => {
      clearPoll();
      timeoutRef.current = setTimeout(async () => {
        try {
          const latest = await jobsApi.get(jobId);
          setJob(latest);
          if (!TERMINAL_STATUSES.has(latest.status)) pollRef.current(jobId);
        } catch {
          // Transient network hiccup mid-poll — keep trying rather than giving up silently.
          pollRef.current(jobId);
        }
      }, POLL_INTERVAL_MS);
    },
    [clearPoll],
  );

  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  const start = useCallback(
    async (audio: Blob, fileName: string, expectedSpeakers?: number) => {
      setError(null);
      setJob(null);
      setUploading(true);
      try {
        const created = await jobsApi.create(audio, fileName, expectedSpeakers);
        setJob(created);
        if (!TERMINAL_STATUSES.has(created.status)) poll(created.jobId);
      } catch (err) {
        setError(
          err instanceof TranscribeApiError
            ? { message: err.message, code: err.code }
            : { message: "Something went wrong submitting the recording.", code: "SERVER_ERROR" },
        );
      } finally {
        setUploading(false);
      }
    },
    [poll],
  );

  const retry = useCallback(async () => {
    if (!job) return;
    setError(null);
    try {
      const retried = await jobsApi.retry(job.jobId);
      setJob(retried);
      if (!TERMINAL_STATUSES.has(retried.status)) poll(retried.jobId);
    } catch (err) {
      setError(
        err instanceof TranscribeApiError
          ? { message: err.message, code: err.code }
          : { message: "Couldn't retry this job.", code: "SERVER_ERROR" },
      );
    }
  }, [job, poll]);

  /** Reopen an in-progress job (e.g. after navigating back from the dashboard). */
  const resume = useCallback(
    async (jobId: string) => {
      setError(null);
      try {
        const latest = await jobsApi.get(jobId);
        setJob(latest);
        if (!TERMINAL_STATUSES.has(latest.status)) poll(jobId);
      } catch (err) {
        setError(
          err instanceof TranscribeApiError
            ? { message: err.message, code: err.code }
            : { message: "Couldn't load this job.", code: "SERVER_ERROR" },
        );
      }
    },
    [poll],
  );

  const reset = useCallback(() => {
    clearPoll();
    setJob(null);
    setUploading(false);
    setError(null);
  }, [clearPoll]);

  useEffect(() => () => clearPoll(), [clearPoll]);

  return { job, uploading, error, start, retry, resume, reset };
}
