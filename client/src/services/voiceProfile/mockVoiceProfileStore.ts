import type { VoiceProfile } from "@/types";

/**
 * In-memory store backing the mock voice-profile API. Also read (read-only) by the mock
 * transcriptions store so a demo transcript's speaker-identification fields reflect
 * whether the signed-in doctor has actually enrolled — nothing here is persisted or sent
 * anywhere; it resets on page reload.
 *
 * Consent text/version mirror the real backend's (server/services/voice/calibration.js)
 * so the enrollment wizard shows accurate copy even while running against the mock.
 */
export const profiles = new Map<string, VoiceProfile>();

export const CONSENT_VERSION = "voice-enrollment-v1";
export const CONSENT_TEXT =
  "I agree that this application may create and store a voiceprint (a numerical representation of my voice) from the three recordings I am providing, " +
  "only to recognize my own voice in my consultation transcripts. It is stored encrypted on this server, is never shared or used to log me in, " +
  "and I can delete it at any time.";
export const REQUIRED_SAMPLES = 3;

export function notEnrolled(): VoiceProfile {
  return {
    status: "not_enrolled",
    requiredSamples: REQUIRED_SAMPLES,
    consent: { version: CONSENT_VERSION, text: CONSENT_TEXT },
  };
}

export function isEnrolled(ownerId: string): boolean {
  return profiles.get(ownerId)?.status === "enrolled";
}
