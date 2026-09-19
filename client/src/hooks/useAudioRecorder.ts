import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderStatus = "idle" | "requesting" | "recording" | "stopped";

/** 2 hours — consultations can run long. Backend limits may still be lower; see docs/API_CONTRACT.md. */
export const MAX_RECORDING_SECONDS = 7200;

/** Show a "running out of time" warning in the last 5 minutes. */
export const RECORDING_WARNING_THRESHOLD_SECONDS = MAX_RECORDING_SECONDS - 300;

const CANDIDATE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

function pickSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

export interface RecordedAudio {
  blob: Blob;
  mimeType: string;
}

export function useAudioRecorder() {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recordedAudio, setRecordedAudio] = useState<RecordedAudio | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the mic/track was lost mid-recording (device unplugged, OS revoked permission, etc). */
  const [interrupted, setInterrupted] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const mimeTypeRef = useRef<string>("audio/webm");

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    streamRef.current = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearTimer();
    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current?.stop();
    }
  }, [clearTimer]);

  const start = useCallback(async () => {
    setError(null);
    setPermissionDenied(false);
    setInterrupted(false);
    setRecordedAudio(null);
    chunksRef.current = [];
    setStatus("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = pickSupportedMimeType();
      mimeTypeRef.current = mimeType ?? "audio/webm";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      // Device unplugged, OS revoked the mic, or the browser killed the track — stop
      // gracefully so whatever was already captured (via ondataavailable) is preserved.
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          setInterrupted(true);
          stop();
        };
      });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        setRecordedAudio({
          blob: new Blob(chunksRef.current, { type: mimeTypeRef.current }),
          mimeType: mimeTypeRef.current,
        });
        cleanupStream();
        setStatus("stopped");
      };

      recorder.start();
      startedAtRef.current = Date.now();
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
        setElapsedSeconds(seconds);
        if (seconds >= MAX_RECORDING_SECONDS) {
          stop();
        }
      }, 250);

      setStatus("recording");
    } catch (err) {
      cleanupStream();
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setPermissionDenied(true);
      } else {
        setError(
          err instanceof Error ? err.message : "Could not access microphone.",
        );
      }
      setStatus("idle");
    }
  }, [cleanupStream, stop]);

  const reset = useCallback(() => {
    clearTimer();
    cleanupStream();
    setStatus("idle");
    setElapsedSeconds(0);
    setRecordedAudio(null);
    setError(null);
    setPermissionDenied(false);
    setInterrupted(false);
  }, [clearTimer, cleanupStream]);

  useEffect(() => {
    return () => {
      clearTimer();
      cleanupStream();
    };
  }, [clearTimer, cleanupStream]);

  return {
    status,
    elapsedSeconds,
    recordedAudio,
    permissionDenied,
    interrupted,
    error,
    start,
    stop,
    reset,
  };
}
