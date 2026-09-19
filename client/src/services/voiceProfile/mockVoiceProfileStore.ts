import type { VoiceProfile } from "@/types";

/**
 * In-memory store backing the mock voice-profile API. Also read (read-only) by the mock
 * transcriptions store so a demo transcript's speaker-identification fields reflect
 * whether the signed-in doctor has actually enrolled — nothing here is persisted or sent
 * anywhere; it resets on page reload.
 */
export const profiles = new Map<string, VoiceProfile>();

export const NOT_ENROLLED: VoiceProfile = {
  status: "not_enrolled",
  enrolledAt: null,
  sampleCount: 0,
  modelVersion: null,
};

export function isEnrolled(ownerId: string): boolean {
  return profiles.get(ownerId)?.status === "enrolled";
}
