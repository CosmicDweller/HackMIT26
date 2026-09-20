import { readFileSync } from "node:fs";

/** The decision thresholds, measured on synthetic audio (voice/calibration.json). Re-measure with real speakers before real use. */
export const calibration = JSON.parse(readFileSync(new URL("../../voice/calibration.json", import.meta.url), "utf8"));

export const CONSENT_VERSION = "voice-enrollment-v1";
export const CONSENT_TEXT =
  "I agree that this application may create and store a voiceprint (a numerical representation of my voice) from the three recordings I am providing, " +
  "only to recognize my own voice in my consultation transcripts. It is stored encrypted on this server, is never shared or used to log me in, " +
  "and I can delete it at any time.";
