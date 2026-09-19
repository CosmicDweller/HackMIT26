import type { TranscriptionJob } from "@/types";

export interface JobsApi {
  create(audio: Blob, fileName: string, expectedSpeakers?: number): Promise<TranscriptionJob>;
  get(jobId: string): Promise<TranscriptionJob>;
  list(): Promise<TranscriptionJob[]>;
  retry(jobId: string): Promise<TranscriptionJob>;
  remove(jobId: string): Promise<void>;
}
