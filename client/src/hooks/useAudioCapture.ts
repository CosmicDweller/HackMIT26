import { useCallback, useEffect, useState } from "react";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";
import type { AudioAsset, AudioSource } from "@/types";

/** Shared record-or-upload state, used by both the quick transcribe page and the dashboard's new-transcription flow. */
export function useAudioCapture() {
  const [mode, setMode] = useState<AudioSource>("recording");
  const [audio, setAudio] = useState<AudioAsset | null>(null);
  const recorder = useAudioRecorder();

  const handleAudioReady = useCallback((asset: AudioAsset) => {
    setAudio((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return asset;
    });
  }, []);

  useEffect(() => {
    if (!recorder.recordedAudio) return;
    handleAudioReady({
      blob: recorder.recordedAudio.blob,
      source: "recording",
      fileName: `recording-${Date.now()}.webm`,
      mimeType: recorder.recordedAudio.mimeType,
      url: URL.createObjectURL(recorder.recordedAudio.blob),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.recordedAudio]);

  const discardAudio = useCallback(() => {
    setAudio((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    recorder.reset();
  }, [recorder]);

  const isRecording = recorder.status === "recording";

  return { mode, setMode, audio, recorder, handleAudioReady, discardAudio, isRecording };
}
