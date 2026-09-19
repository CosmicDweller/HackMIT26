import type { SpeakerRole, Transcription, TranscriptionSummary } from "@/types";

export interface TranscriptionsApi {
  create(audio: Blob, fileName: string): Promise<Transcription>;
  list(): Promise<TranscriptionSummary[]>;
  get(id: string): Promise<Transcription>;
  remove(id: string): Promise<void>;
  updateSpeaker(id: string, speakerId: string, role: SpeakerRole): Promise<Transcription>;
  updateSegment(
    id: string,
    segmentId: string,
    patch: { text: string; speakerId: string | null },
  ): Promise<Transcription>;
}
