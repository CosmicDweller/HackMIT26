import type { Speaker, TranscriptSegment } from "@/types";

/**
 * Synthetic medical-consultation fixture used by the mock transcriptions
 * service. Never real patient data. Speaker roles start "unassigned" — the
 * UI must not guess which speaker is the doctor.
 *
 * This is the same consultation used by the SOAP-note fixture
 * (lib/soapFixtures.ts) — every SOAP claim's `sourceSegmentIds` cites one of
 * these segments, so clicking a claim scrolls to text that actually
 * supports it, end to end in the mock demo.
 */

export const FIXTURE_SPEAKERS: Speaker[] = [
  { id: "speaker_1", label: "Speaker 1", role: "unassigned" },
  { id: "speaker_2", label: "Speaker 2", role: "unassigned" },
  { id: "speaker_3", label: "Speaker 3", role: "unassigned" },
];

// A nurse briefly steps in to take vitals (segment_15) — demonstrates that speaker
// display/editing has no hardcoded two-speaker assumption, and doubles as the
// minor-speaker warning demo (1 of 18 segments, same as the real 2-hour recording
// the backend observed: a small, honestly-flagged fraction of the speech).
export const FIXTURE_SEGMENTS: TranscriptSegment[] = [
  { id: "segment_1", startMs: 0, endMs: 3000, text: "What brings you in today?", speakerId: "speaker_1" },
  { id: "segment_2", startMs: 3500, endMs: 8000, text: "I've had a severe headache for the past three days.", speakerId: "speaker_2" },
  { id: "segment_3", startMs: 8500, endMs: 12000, text: "Can you describe the pain and where it's located?", speakerId: "speaker_1" },
  { id: "segment_4", startMs: 12500, endMs: 19000, text: "It's on the right side, kind of behind my eye and into my temple. It's a throbbing pain, about a 7 or 8 out of 10.", speakerId: "speaker_2" },
  { id: "segment_5", startMs: 19500, endMs: 22000, text: "Does anything make it worse?", speakerId: "speaker_1" },
  { id: "segment_6", startMs: 22500, endMs: 26000, text: "Bright light and loud noises definitely make it worse.", speakerId: "speaker_2" },
  { id: "segment_7", startMs: 26500, endMs: 30000, text: "Any nausea, vomiting, or changes in your vision?", speakerId: "speaker_1" },
  { id: "segment_8", startMs: 30500, endMs: 36000, text: "I've felt nauseous but haven't thrown up. No spots or flashes or anything like that.", speakerId: "speaker_2" },
  { id: "segment_9", startMs: 36500, endMs: 39000, text: "Have you taken anything for it?", speakerId: "speaker_1" },
  { id: "segment_10", startMs: 39500, endMs: 46000, text: "I took 400 milligrams of ibuprofen, and it helped a little — brought it down to maybe a 5 out of 10.", speakerId: "speaker_2" },
  { id: "segment_11", startMs: 46500, endMs: 49500, text: "Have you had headaches like this before?", speakerId: "speaker_1" },
  { id: "segment_12", startMs: 50000, endMs: 55000, text: "Occasionally, but usually just mild tension headaches, nothing like this.", speakerId: "speaker_2" },
  { id: "segment_13", startMs: 55500, endMs: 60000, text: "Any other medical conditions, medications you take regularly, or allergies?", speakerId: "speaker_1" },
  { id: "segment_14", startMs: 60500, endMs: 63000, text: "No, nothing like that.", speakerId: "speaker_2" },
  { id: "segment_15", startMs: 63500, endMs: 70000, text: "I'll get your vitals — blood pressure is 122 over 78, heart rate 72, temperature 98.6, respiratory rate 16.", speakerId: "speaker_3" },
  { id: "segment_16", startMs: 70500, endMs: 82000, text: "I'm going to check your cranial nerves and your neck... everything there looks normal, and your neck is supple with full range of motion, no tenderness over the temples or sinuses. Your neurological exam is otherwise normal.", speakerId: "speaker_1" },
  { id: "segment_17", startMs: 82500, endMs: 88000, text: "Based on what you're describing, this looks like a classic migraine without aura.", speakerId: "speaker_1" },
  { id: "segment_18", startMs: 88500, endMs: 100000, text: "I'm going to prescribe sumatriptan, 50 milligrams, to take at the onset of a migraine. You can repeat it after two hours if it hasn't resolved, but don't take more than 200 milligrams in 24 hours. Rest in a quiet, dark room, and make sure you're staying hydrated. If the pain gets significantly worse, or you notice new weakness, numbness, or vision loss, go to urgent care or the ER right away.", speakerId: "speaker_1" },
];

export function fixtureFullText(): string {
  return FIXTURE_SEGMENTS.map((segment) => segment.text).join(" ");
}
