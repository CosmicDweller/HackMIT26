import type { VoiceProfile } from "@/types";

export interface VoiceProfileApi {
  get(): Promise<VoiceProfile>;
  /** `samples` are the recorded reference clips (reference audio, never patient audio).
   * `consentVersion` must be the `consent.version` returned by the preceding get(). */
  enroll(samples: Blob[], consentVersion: string): Promise<VoiceProfile>;
  remove(): Promise<void>;
}
