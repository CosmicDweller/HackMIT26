import type { Speaker, TranscriptSegment } from "@/types";

/**
 * Synthetic medical-consultation fixture used by the mock transcriptions
 * service. Never real patient data. Speaker roles start "unassigned" — the
 * UI must not guess which speaker is the doctor.
 */

export const FIXTURE_SPEAKERS: Speaker[] = [
  { id: "speaker_1", label: "Speaker 1", role: "unassigned" },
  { id: "speaker_2", label: "Speaker 2", role: "unassigned" },
  { id: "speaker_3", label: "Speaker 3", role: "unassigned" },
];

// A third speaker (e.g. a nurse) steps in briefly — demonstrates that speaker
// display/editing has no hardcoded two-speaker assumption, not just the
// typical doctor+patient case.
export const FIXTURE_SEGMENTS: TranscriptSegment[] = [
  { id: "segment_1", startMs: 1000, endMs: 3500, text: "Are you eating regularly?", speakerId: "speaker_1" },
  { id: "segment_2", startMs: 4000, endMs: 8500, text: "I eat two meals per day.", speakerId: "speaker_2" },
  { id: "segment_3", startMs: 9000, endMs: 13200, text: "And how has your sleep been over the last couple of weeks?", speakerId: "speaker_1" },
  { id: "segment_4", startMs: 13700, endMs: 19000, text: "Not great, honestly. I've been waking up around 3am most nights.", speakerId: "speaker_2" },
  { id: "segment_5", startMs: 19500, endMs: 24000, text: "Any pain, or is it more that your mind is racing?", speakerId: "speaker_1" },
  { id: "segment_6", startMs: 24500, endMs: 30000, text: "Mostly my mind racing. No real pain.", speakerId: "speaker_2" },
  { id: "segment_7", startMs: 30500, endMs: 34000, text: "I can take your blood pressure now if you're ready.", speakerId: "speaker_3" },
  { id: "segment_8", startMs: 34500, endMs: 36000, text: "Okay. Let's check your blood pressure and go from there.", speakerId: "speaker_1" },
  { id: "segment_9", startMs: 36500, endMs: 38000, text: "Sounds good.", speakerId: null },
];

export function fixtureFullText(): string {
  return FIXTURE_SEGMENTS.map((segment) => segment.text).join(" ");
}
