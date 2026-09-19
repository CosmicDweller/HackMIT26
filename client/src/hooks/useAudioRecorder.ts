import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderStatus = "idle" | "requesting" | "recording" | "paused" | "stopped";

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
  /** The live mic stream while recording or paused — exposed for a live audio-level display. */
  const [stream, setStream] = useState<MediaStream | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Elapsed ms accumulated across previous recording segments (before the current pause/resume). */
  const accumulatedMsRef = useRef(0);
  /** When the current (un-paused) recording segment started. */
  const segmentStartRef = useRef(0);
  const mimeTypeRef = useRef<string>("audio/webm");

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    streamRef.current = null;
    setStream(null);
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

  const startTimer = useCallback(() => {
    clearTimer();
    timerRef.current = setInterval(() => {
      const seconds = Math.floor(
        (accumulatedMsRef.current + (Date.now() - segmentStartRef.current)) / 1000,
      );
      setElapsedSeconds(seconds);
      if (seconds >= MAX_RECORDING_SECONDS) {
        stop();
      }
    }, 250);
  }, [clearTimer, stop]);

  const pause = useCallback(() => {
    if (mediaRecorderRef.current?.state !== "recording") return;
    mediaRecorderRef.current.pause();
    clearTimer();
    accumulatedMsRef.current += Date.now() - segmentStartRef.current;
    setStatus("paused");
  }, [clearTimer]);

  const resume = useCallback(() => {
    if (mediaRecorderRef.current?.state !== "paused") return;
    mediaRecorderRef.current.resume();
    segmentStartRef.current = Date.now();
    startTimer();
    setStatus("recording");
  }, [startTimer]);

  const start = useCallback(async () => {
    setError(null);
    setPermissionDenied(false);
    setInterrupted(false);
    setRecordedAudio(null);
    chunksRef.current = [];
    setStatus("requesting");

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = mediaStream;
      setStream(mediaStream);

      const mimeType = pickSupportedMimeType();
      mimeTypeRef.current = mimeType ?? "audio/webm";
      const recorder = mimeType
        ? new MediaRecorder(mediaStream, { mimeType })
        : new MediaRecorder(mediaStream);
      mediaRecorderRef.current = recorder;

      // Device unplugged, OS revoked the mic, or the browser killed the track — stop
      // gracefully so whatever was already captured (via ondataavailable) is preserved.
      mediaStream.getAudioTracks().forEach((track) => {
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
      accumulatedMsRef.current = 0;
      segmentStartRef.current = Date.now();
      setElapsedSeconds(0);
      startTimer();

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
  }, [cleanupStream, stop, startTimer]);

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
    stream,
    start,
    stop,
    pause,
    resume,
    reset,
  };
}
