import type { VoiceProfile } from "@/types";

export interface VoiceProfileApi {
  get(): Promise<VoiceProfile>;
  /** `samples` are the recorded reference clips (reference audio, never patient audio). */
  enroll(samples: Blob[]): Promise<VoiceProfile>;
  remove(): Promise<void>;
}
