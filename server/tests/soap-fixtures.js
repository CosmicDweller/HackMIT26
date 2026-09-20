// The corrected headache consultation from the product brief, as a stored transcript: the shared grounding fixture for every SOAP
// test. Synthetic text, written for testing. Timestamps are those of the synthetic recording it stands for.
//
// It is the reference for what a correct note contains AND for what it must never contain: the clinician states a normal
// neurological examination without itemising it, the patient reports light and noise sensitivity (which must never become "denies
// phonophobia"), and no follow-up interval, route of administration or diagnostic code is ever mentioned.

const TURNS = [
  ["doctor", "What brings you in today?"],
  ["patient", "I've had a really bad headache for the past three days."],
  ["doctor", "Where do you feel the pain?"],
  ["patient", "Mostly on the right side, behind my eye and temple. It feels throbbing and pulsing."],
  ["doctor", "How severe is it?"],
  ["patient", "Around 7 or 8 out of 10. Bright light and loud noises make it worse. I had to leave work early because fluorescent lights made it intolerable."],
  ["doctor", "Any nausea, vomiting, or vision changes?"],
  ["patient", "I felt nauseous yesterday, but I didn't vomit. No spots, flashes, or other vision changes."],
  ["doctor", "Have you taken anything?"],
  ["patient", "I took ibuprofen 400 mg yesterday evening. It reduced the pain to about a 5, but it returned overnight."],
  ["doctor", "Have you had similar headaches before?"],
  ["patient", "Only occasional mild tension headaches, nothing this intense."],
  ["doctor", "Any chronic conditions, daily medications, or medication allergies?"],
  ["patient", "No chronic conditions. No regular daily medications. No known drug allergies."],
  ["doctor", "Your blood pressure is 122 over 78, heart rate is 72, temperature is 98.6 degrees Fahrenheit, and respiratory rate is 16."],
  ["doctor", "Cranial nerves II through XII are intact. Your neck is supple with full range of motion. There is no tenderness over the temporal arteries or sinus areas. Neurologically, everything looks normal."],
  ["patient", "What do you think it is?"],
  ["doctor", "This presents classic features of an acute migraine without aura."],
  ["doctor", "I am prescribing sumatriptan 50 mg at the onset of a migraine attack. If it does not resolve within two hours, you can take a second dose, up to a maximum of 200 mg in 24 hours."],
  ["doctor", "Rest in a quiet, dark room and stay well-hydrated."],
  ["doctor", "If pain worsens significantly or you develop new neurological symptoms such as weakness, numbness, or vision loss, seek urgent care or emergency evaluation immediately."],
  ["patient", "Thank you."],
];

/**
 * The fixture as arguments for store.createTranscription.
 *  roles: "confirmed" (the doctor has confirmed both speakers) or "unassigned" (speakers detected but not yet confirmed).
 */
export function headacheTranscript({ roles = "confirmed", speakerOverrides = {} } = {}) {
  const speakers = [
    { id: "speaker_0", label: "Speaker 1", role: roles === "confirmed" ? "doctor" : "unassigned", identificationStatus: "matched", suggestedRole: "doctor" },
    { id: "speaker_1", label: "Speaker 2", role: roles === "confirmed" ? "patient" : "unassigned", identificationStatus: "unknown", suggestedRole: null },
    ...(speakerOverrides.extra ?? []),
  ];
  let at = 1000;
  const segments = TURNS.map(([who, text], index) => {
    const startMs = at;
    const endMs = startMs + Math.max(1500, text.length * 55); // roughly speech-rate timing
    at = endMs + 700;
    return {
      id: `segment_${index + 1}`,
      startMs,
      endMs,
      text,
      speakerId: who === "doctor" ? "speaker_0" : "speaker_1",
      needsReview: false,
      providerSpeaker: who === "doctor" ? 0 : 1,
      confidence: 0.97,
      speakerConfidence: 0.95,
    };
  });
  return {
    durationSeconds: Math.round(at / 1000),
    diarizationStatus: "ok",
    diarizationResult: "completed",
    engine: "deepgram",
    speakerSource: "pyannote",
    voiceStatus: "completed",
    speakers,
    segments,
    warnings: [],
  };
}

/** Segment ids by what they contain, so tests can cite real sources without counting lines. */
export const SEGMENT = {
  headacheDuration: "segment_2",
  location: "segment_4",
  severityAndTriggers: "segment_6",
  nausea: "segment_8",
  ibuprofen: "segment_10",
  history: "segment_12",
  allergies: "segment_14",
  vitals: "segment_15",
  exam: "segment_16",
  assessment: "segment_18",
  prescription: "segment_19",
  restAdvice: "segment_20",
  redFlags: "segment_21",
};

/** A correct, fully grounded note for this consultation: what a good generation looks like. */
export function goodNote() {
  return {
    sections: {
      subjective: "Chief complaint: severe headache for three days. Right-sided retro-orbital and temporal headache, described as throbbing and pulsing. "
        + "Severity approximately 7-8/10. Aggravated by bright light and loud noises. Left work early because fluorescent lights worsened symptoms. "
        + "Associated nausea without vomiting. No spots, flashes or other vision changes. Ibuprofen 400 mg yesterday evening reduced the pain to about 5/10, but it returned overnight. "
        + "History of occasional mild tension headaches. No chronic conditions and no regular daily medications. No known drug allergies.",
      objective: "BP 122/78. HR 72. Temperature 98.6 F. Respiratory rate 16. Cranial nerves II through XII intact. Neck supple with full range of motion. "
        + "No tenderness over the temporal arteries or sinus areas. Clinician describes the neurological examination as normal.",
      assessment: "Clinician assessment: classic features of an acute migraine without aura.",
      plan: "Clinician prescribed sumatriptan 50 mg at the onset of a migraine attack. May repeat after two hours if it does not resolve, to a clinician-stated maximum of 200 mg in 24 hours. "
        + "Rest in a quiet, dark room and stay well-hydrated. Seek urgent care or emergency evaluation immediately for significantly worsening pain or new neurological symptoms such as weakness, numbness or vision loss.",
    },
    claims: [
      { section: "subjective", text: "Chief complaint: severe headache for three days.", sourceLines: [2], sourceFactIds: [], needsReview: false },
      { section: "subjective", text: "Right-sided retro-orbital and temporal headache, described as throbbing and pulsing.", sourceLines: [4], sourceFactIds: [], needsReview: false },
      { section: "subjective", text: "Severity approximately 7-8/10.", sourceLines: [6], sourceFactIds: [], needsReview: false },
      { section: "subjective", text: "Aggravated by bright light and loud noises.", sourceLines: [6], sourceFactIds: [], needsReview: false },
      { section: "subjective", text: "Left work early because fluorescent lights worsened symptoms.", sourceLines: [6], sourceFactIds: [], needsReview: false },
      { section: "subjective", text: "Associated nausea without vomiting.", sourceLines: [8], sourceFactIds: [], needsReview: false },
      { section: "subjective", text: "No spots, flashes or other vision changes.", sourceLines: [8], sourceFactIds: [], needsReview: false },
      // cites both lines: the dose and effect come from line 10, the 0-10 scale from line 6
      { section: "subjective", text: "Ibuprofen 400 mg yesterday evening reduced the pain to about 5/10, but it returned overnight.", sourceLines: [6, 10], sourceFactIds: [], needsReview: false },
      { section: "subjective", text: "History of occasional mild tension headaches.", sourceLines: [12], sourceFactIds: [], needsReview: false },
      { section: "subjective", text: "No chronic conditions and no regular daily medications.", sourceLines: [14], sourceFactIds: [], needsReview: false },
      { section: "subjective", text: "No known drug allergies.", sourceLines: [14], sourceFactIds: [], needsReview: false },
      { section: "objective", text: "BP 122/78.", sourceLines: [15], sourceFactIds: [], needsReview: false },
      { section: "objective", text: "HR 72.", sourceLines: [15], sourceFactIds: [], needsReview: false },
      { section: "objective", text: "Temperature 98.6 F.", sourceLines: [15], sourceFactIds: [], needsReview: false },
      { section: "objective", text: "Respiratory rate 16.", sourceLines: [15], sourceFactIds: [], needsReview: false },
      { section: "objective", text: "Cranial nerves II through XII intact.", sourceLines: [16], sourceFactIds: [], needsReview: false },
      { section: "objective", text: "Neck supple with full range of motion.", sourceLines: [16], sourceFactIds: [], needsReview: false },
      { section: "objective", text: "No tenderness over the temporal arteries or sinus areas.", sourceLines: [16], sourceFactIds: [], needsReview: false },
      { section: "objective", text: "Clinician describes the neurological examination as normal.", sourceLines: [16], sourceFactIds: [], needsReview: false },
      { section: "assessment", text: "Clinician assessment: classic features of an acute migraine without aura.", sourceLines: [18], sourceFactIds: [], needsReview: false },
      { section: "plan", text: "Clinician prescribed sumatriptan 50 mg at the onset of a migraine attack.", sourceLines: [19], sourceFactIds: [], needsReview: false },
      { section: "plan", text: "May repeat after two hours if it does not resolve, to a clinician-stated maximum of 200 mg in 24 hours.", sourceLines: [19], sourceFactIds: [], needsReview: false },
      { section: "plan", text: "Rest in a quiet, dark room and stay well-hydrated.", sourceLines: [20], sourceFactIds: [], needsReview: false },
      { section: "plan", text: "Seek urgent care or emergency evaluation immediately for significantly worsening pain or new neurological symptoms such as weakness, numbness or vision loss.", sourceLines: [21], sourceFactIds: [], needsReview: false },
    ],
    reviewFlags: [],
  };
}

/** Facts a correct stage 1 returns, for tests that drive stage 2 directly. */
export function goodFacts() {
  return {
    facts: [
      { text: "Headache for three days", category: "symptom", speaker: "patient", sourceLines: [2], negated: false, uncertain: false },
      { text: "Right-sided retro-orbital and temporal, throbbing and pulsing", category: "symptom", speaker: "patient", sourceLines: [4], negated: false, uncertain: false },
      { text: "Severity 7-8/10, worse with bright light and loud noise", category: "symptom", speaker: "patient", sourceLines: [6], negated: false, uncertain: false },
      { text: "Nausea yesterday", category: "symptom", speaker: "patient", sourceLines: [8], negated: false, uncertain: false },
      { text: "Vomiting", category: "symptom", speaker: "patient", sourceLines: [8], negated: true, uncertain: false },
      { text: "Ibuprofen 400 mg yesterday evening, pain reduced to 5/10", category: "medication", speaker: "patient", sourceLines: [10], negated: false, uncertain: false },
      { text: "BP 122/78, HR 72, temperature 98.6 F, respiratory rate 16", category: "vital", speaker: "clinician", sourceLines: [15], negated: false, uncertain: false },
      { text: "Cranial nerves II-XII intact; neck supple; no temporal artery or sinus tenderness; neurological examination described as normal", category: "exam", speaker: "clinician", sourceLines: [16], negated: false, uncertain: false },
      { text: "Classic features of acute migraine without aura", category: "assessment", speaker: "clinician", sourceLines: [18], negated: false, uncertain: false },
      { text: "Sumatriptan 50 mg at onset, may repeat after two hours, maximum 200 mg in 24 hours", category: "plan", speaker: "clinician", sourceLines: [19], negated: false, uncertain: false },
    ],
  };
}

/**
 * A scripted SOAP provider. `script` is a list of responses (one per generate call) or a function of the stage.
 * Records every call so tests can assert what was asked for, without ever contacting Gemini.
 */
export function fakeProvider(script, { model = "fake-model", usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, ms: 10 } } = {}) {
  const calls = [];
  let index = 0;
  return {
    calls,
    model,
    provider: "fake",
    configured: () => true,
    generate: async ({ system, user, stage, schema }) => {
      calls.push({ system, user, stage, schema });
      const next = typeof script === "function" ? script(stage, calls.length - 1) : script[Math.min(index++, script.length - 1)];
      if (next instanceof Error) throw next;
      return { data: typeof next === "function" ? next() : next, usage };
    },
  };
}
