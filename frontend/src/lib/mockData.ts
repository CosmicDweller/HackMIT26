import type { SoapNote, TranscriptChunk } from "@/types";

export const mockTranscript: TranscriptChunk[] = [
  {
    id: "c1",
    speaker: "doctor",
    startMs: 0,
    endMs: 4200,
    text: "Good morning, what brings you in today?",
  },
  {
    id: "c2",
    speaker: "patient",
    startMs: 4200,
    endMs: 11800,
    text: "I've had a dull headache for about three days, mostly on the right side.",
  },
  {
    id: "c3",
    speaker: "doctor",
    startMs: 11800,
    endMs: 17300,
    text: "Any nausea, sensitivity to light, or blurred vision along with it?",
  },
  {
    id: "c4",
    speaker: "patient",
    startMs: 17300,
    endMs: 24000,
    text: "A little light sensitivity, no nausea. It's worse in the afternoon.",
  },
  {
    id: "c5",
    speaker: "doctor",
    startMs: 24000,
    endMs: 31500,
    text: "Blood pressure looks normal today, 118 over 76. No fever.",
  },
];

export const mockSoapNote: SoapNote = {
  id: "note-1",
  sessionId: "session-1",
  generatedAt: new Date().toISOString(),
  sections: [
    {
      id: "subjective",
      title: "Subjective",
      claims: [
        {
          id: "s1",
          text: "Patient reports a dull right-sided headache for 3 days, worse in the afternoon.",
          transcriptChunkIds: ["c2", "c4"],
        },
        {
          id: "s2",
          text: "Mild photosensitivity present; denies nausea.",
          transcriptChunkIds: ["c4"],
        },
      ],
    },
    {
      id: "objective",
      title: "Objective",
      claims: [
        {
          id: "o1",
          text: "Blood pressure 118/76, afebrile.",
          transcriptChunkIds: ["c5"],
        },
      ],
    },
    {
      id: "assessment",
      title: "Assessment",
      claims: [
        {
          id: "a1",
          text: "Likely tension-type headache; migraine not excluded given photosensitivity.",
          transcriptChunkIds: ["c2", "c4"],
        },
      ],
    },
    {
      id: "plan",
      title: "Plan",
      claims: [
        {
          id: "p1",
          text: "Trial OTC analgesic, hydration, follow up in one week if unresolved.",
          transcriptChunkIds: [],
        },
      ],
    },
  ],
};
