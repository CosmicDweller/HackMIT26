// The deterministic grounding checks. No model, no network: these verify what the backend can PROVE about a generated note.
// Most of these are negative tests, because the dangerous failure is a plausible sentence nobody said.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { numberedTranscript, uncertaintyNotice } from "../services/soap/prompt.js";
import { validateFacts, validateNote } from "../services/soap/validate.js";
import { goodNote, headacheTranscript } from "./soap-fixtures.js";

// The fixture as a loaded transcription (what the store would return).
const transcript = () => {
  const data = headacheTranscript();
  return { ...data, id: "tr_test", createdAt: new Date().toISOString(), revision: 1 };
};
const context = () => {
  const transcription = transcript();
  const { lines } = numberedTranscript(transcription);
  return { lines, segments: transcription.segments, manualFacts: [] };
};

/** A note built from the good one with a section rewritten, so each test changes exactly one thing. */
function noteWith(section, text, claims = null) {
  const base = goodNote();
  base.sections[section] = text;
  if (claims) base.claims = claims;
  else base.claims = base.claims.filter((claim) => claim.section !== section);
  return base;
}
const flagsOf = (result, type) => result.reviewFlags.filter((flag) => flag.type === type);
const messages = (result) => result.reviewFlags.map((flag) => flag.message).join(" | ");

describe("a correct note passes", () => {
  test("the fully grounded fixture note has no blocking problem and every claim keeps its sources", () => {
    const result = validateNote(goodNote(), context());
    assert.equal(result.blocking, 0, messages(result));
    assert.equal(result.claims.length, 24);
    assert.ok(result.claims.every((claim) => claim.sourceSegmentIds.length > 0), "every claim cites a real segment");
    assert.ok(result.claims.every((claim) => !claim.needsReview), "nothing is flagged for review without cause");
  });

  test("claims resolve line numbers to the real segment ids the frontend will highlight", () => {
    const result = validateNote(goodNote(), context());
    const vitals = result.claims.find((claim) => claim.text.startsWith("BP 122/78"));
    assert.deepEqual(vitals.sourceSegmentIds, ["segment_15"]);
    const complaint = result.claims.find((claim) => claim.text.startsWith("Chief complaint"));
    assert.deepEqual(complaint.sourceSegmentIds, ["segment_2"]);
  });

  test("every claim's text really appears in the section, so the UI can anchor it", () => {
    const note = goodNote();
    const result = validateNote(note, context());
    for (const claim of result.claims) {
      assert.ok(note.sections[claim.section].includes(claim.text), `not anchorable: ${claim.text}`);
    }
  });
});

describe("invented examination findings are caught", () => {
  // Each of these is a real fabrication from the brief's forbidden list.
  for (const [label, sentence] of [
    ["orientation", "Alert and oriented x4."],
    ["head exam", "Normocephalic, atraumatic."],
    ["gait", "Normal gait."],
    ["motor strength", "Motor strength 5/5 throughout."],
    ["sensation", "Sensation intact."],
    ["Kernig", "Negative Kernig sign."],
    ["Brudzinski", "Negative Brudzinski sign."],
    ["HEENT", "HEENT examination unremarkable."],
  ]) {
    test(`"${sentence}" (${label}) is flagged as unsupported and blocks approval`, () => {
      const note = noteWith("objective", `BP 122/78. ${sentence}`, [
        { section: "objective", text: "BP 122/78.", sourceLines: [15], sourceFactIds: [], needsReview: false },
      ]);
      const result = validateNote(note, context());
      assert.ok(result.blocking > 0, `not flagged: ${sentence}`);
      assert.ok(flagsOf(result, "unsupported_claim").length > 0, messages(result));
    });
  }

  test("expanding a stated normal exam into itemised findings is caught, but the stated sentence itself is fine", () => {
    const stated = validateNote(
      noteWith("objective", "Clinician describes the neurological examination as normal.", [
        { section: "objective", text: "Clinician describes the neurological examination as normal.", sourceLines: [16], sourceFactIds: [], needsReview: false },
      ]),
      context(),
    );
    assert.equal(stated.blocking, 0, messages(stated));
    const expanded = validateNote(noteWith("objective", "Neurological examination normal: alert and oriented x4, motor 5/5, normal gait, sensation intact."), context());
    assert.ok(expanded.blocking >= 3, `expected several fabrications, got ${expanded.blocking}: ${messages(expanded)}`);
  });
});

describe("a positive report must never become a denial", () => {
  test('the patient reported light and noise sensitivity: "denies phonophobia" is flagged', () => {
    const note = noteWith("subjective", "Headache for three days. Denies phonophobia.", [
      { section: "subjective", text: "Headache for three days.", sourceLines: [2], sourceFactIds: [], needsReview: false },
    ]);
    const result = validateNote(note, context());
    assert.ok(result.blocking > 0);
    assert.ok(/denial|denies/i.test(messages(result)), messages(result));
  });

  test("a denial the patient really made is accepted", () => {
    // "I didn't vomit" and "No spots, flashes" are in the transcript.
    const note = noteWith("subjective", "No vomiting. No spots, flashes or other vision changes.", [
      { section: "subjective", text: "No vomiting.", sourceLines: [8], sourceFactIds: [], needsReview: false },
      { section: "subjective", text: "No spots, flashes or other vision changes.", sourceLines: [8], sourceFactIds: [], needsReview: false },
    ]);
    const result = validateNote(note, context());
    assert.equal(flagsOf(result, "conflicting_facts").length, 0, messages(result));
  });
});

describe("numbers and medications must come from the transcript", () => {
  test("a dose nobody stated is flagged", () => {
    const note = noteWith("plan", "Clinician prescribed sumatriptan 100 mg at onset.", [
      { section: "plan", text: "Clinician prescribed sumatriptan 100 mg at onset.", sourceLines: [19], sourceFactIds: [], needsReview: false },
    ]);
    const result = validateNote(note, context());
    assert.ok(result.blocking > 0);
    assert.ok(/100/.test(messages(result)), messages(result));
  });

  test("a vital sign nobody measured is flagged", () => {
    const note = noteWith("objective", "BP 122/78. Oxygen saturation 98 percent on room air.", [
      { section: "objective", text: "BP 122/78.", sourceLines: [15], sourceFactIds: [], needsReview: false },
      { section: "objective", text: "Oxygen saturation 98 percent on room air.", sourceLines: [15], sourceFactIds: [], needsReview: false },
    ]);
    const result = validateNote(note, context());
    assert.ok(result.blocking > 0, messages(result));
  });

  test("a medication nobody mentioned is flagged", () => {
    const note = noteWith("plan", "Clinician prescribed amitriptyline for prophylaxis.", [
      { section: "plan", text: "Clinician prescribed amitriptyline for prophylaxis.", sourceLines: [19], sourceFactIds: [], needsReview: false },
    ]);
    const result = validateNote(note, context());
    assert.ok(flagsOf(result, "unclear_medication").length > 0, messages(result));
    assert.ok(result.blocking > 0);
  });

  test("the real doses and vitals pass", () => {
    const result = validateNote(goodNote(), context());
    assert.equal(flagsOf(result, "unclear_medication").length, 0, messages(result));
    assert.equal(flagsOf(result, "unsupported_claim").length, 0, messages(result));
  });
});

describe("other forbidden additions", () => {
  for (const [label, section, sentence] of [
    ["a follow-up interval", "plan", "Follow-up in two weeks."],
    ["a medication route", "plan", "Sumatriptan 50 mg orally at onset."],
    ["side-effect counselling", "plan", "Counselled on side effects."],
    ["a headache diary", "plan", "Advised to keep a headache diary."],
    ["a differential diagnosis", "assessment", "Differential diagnosis includes tension headache."],
    ["a diagnostic code", "assessment", "Acute migraine without aura, ICD-10 code G43.009."],
  ]) {
    test(`${label} is flagged`, () => {
      const result = validateNote(noteWith(section, sentence, []), context());
      assert.ok(result.blocking > 0, `not flagged: ${sentence} -> ${messages(result)}`);
    });
  }
});

describe("citations must be real", () => {
  test("a claim citing a line that does not exist is flagged and loses the citation", () => {
    const note = noteWith("subjective", "Headache for three days.", [
      { section: "subjective", text: "Headache for three days.", sourceLines: [999], sourceFactIds: [], needsReview: false },
    ]);
    const result = validateNote(note, context());
    assert.ok(flagsOf(result, "invalid_source").length > 0, messages(result));
    assert.deepEqual(result.claims[0].sourceSegmentIds, []);
    assert.equal(result.claims[0].needsReview, true);
  });

  test("a claim with no citation at all is flagged", () => {
    const note = noteWith("subjective", "Headache for three days.", [
      { section: "subjective", text: "Headache for three days.", sourceLines: [], sourceFactIds: [], needsReview: false },
    ]);
    const result = validateNote(note, context());
    assert.ok(flagsOf(result, "missing_source").length > 0, messages(result));
    assert.ok(result.blocking > 0);
  });

  test("a claim citing a REAL but unrelated line still loses its numbers check", () => {
    // Citing the allergies line for a blood pressure: the number is not in the cited text.
    const note = noteWith("objective", "BP 122/78.", [
      { section: "objective", text: "BP 122/78.", sourceLines: [14], sourceFactIds: [], needsReview: false },
    ]);
    const result = validateNote(note, context());
    assert.equal(result.claims[0].needsReview, true, "a weak citation is marked for verification");
    assert.ok(/not in the cited lines/i.test(messages(result)), messages(result));
  });

  test("a clinician-entered fact can be cited, and an invented fact id cannot", () => {
    const manualFacts = [{ id: "manual_1", text: "Patient reports a family history of migraine." }];
    const ctx = { ...context(), manualFacts };
    const ok = validateNote(noteWith("subjective", "Family history of migraine.", [
      { section: "subjective", text: "Family history of migraine.", sourceLines: [], sourceFactIds: ["manual_1"], needsReview: false },
    ]), ctx);
    assert.deepEqual(ok.claims[0].sourceFactIds, ["manual_1"]);
    assert.equal(flagsOf(ok, "missing_source").length, 0, messages(ok));
    const bad = validateNote(noteWith("subjective", "Family history of migraine.", [
      { section: "subjective", text: "Family history of migraine.", sourceLines: [], sourceFactIds: ["manual_99"], needsReview: false },
    ]), ctx);
    assert.ok(flagsOf(bad, "invalid_source").length > 0);
  });

  test("statements in a section that no claim covers are flagged for verification", () => {
    const note = noteWith("assessment", "Clinician assessment: acute migraine without aura. The patient also appears anxious about work.", [
      { section: "assessment", text: "Clinician assessment: acute migraine without aura.", sourceLines: [18], sourceFactIds: [], needsReview: false },
    ]);
    const result = validateNote(note, context());
    assert.ok(/no source citation/i.test(messages(result)), messages(result));
  });

  test("a claim whose wording is not in the section text is marked unverifiable (the UI could not highlight it)", () => {
    const note = noteWith("subjective", "Headache for three days.", [
      { section: "subjective", text: "Patient has a migraine history spanning years.", sourceLines: [12], sourceFactIds: [], needsReview: false },
    ]);
    const result = validateNote(note, context());
    assert.equal(result.claims[0].needsReview, true);
    assert.ok(/does not appear in the note text/i.test(messages(result)), messages(result));
  });
});

describe("empty sections and uncertainty", () => {
  test("an empty section is allowed but reported, never filled in", () => {
    const note = noteWith("assessment", "", []);
    const result = validateNote(note, context());
    assert.equal(result.sections.assessment, "");
    assert.ok(flagsOf(result, "missing_documentation").some((flag) => flag.section === "assessment"));
    assert.equal(flagsOf(result, "missing_documentation").find((flag) => flag.section === "assessment").blocking, false,
      "a missing section is advisory, not a blocker");
  });

  test("a claim resting on a segment with an uncertain speaker inherits that uncertainty", () => {
    const transcription = transcript();
    transcription.segments[1].speakerId = null; // the headache-duration line has no speaker
    const { lines } = numberedTranscript(transcription);
    const result = validateNote(goodNote(), { lines, segments: transcription.segments, manualFacts: [] });
    const claim = result.claims.find((entry) => entry.text.startsWith("Chief complaint"));
    assert.equal(claim.needsReview, true);
    assert.ok(/uncertain speaker/i.test(messages(result)));
  });

  test("the model's own review flags are kept, marked as coming from the model", () => {
    const note = goodNote();
    note.reviewFlags = [{ type: "unclear_dose", severity: "warning", section: "plan", message: "The maximum daily dose was stated quickly." }];
    const result = validateNote(note, context());
    const kept = result.reviewFlags.find((flag) => flag.type === "unclear_dose");
    assert.ok(kept);
    assert.equal(kept.source, "model");
    assert.equal(kept.blocking, true);
  });
});

describe("structurally unusable responses are rejected outright", () => {
  for (const [label, response] of [
    ["not an object", "nope"],
    ["no sections", { claims: [] }],
    ["a missing section", { sections: { subjective: "a", objective: "b", assessment: "c" }, claims: [] }],
    ["a section that is not text", { sections: { subjective: 1, objective: "", assessment: "", plan: "" }, claims: [] }],
    ["an extra section", { sections: { subjective: "", objective: "", assessment: "", plan: "", extra: "x" }, claims: [] }],
    ["no claims array", { sections: { subjective: "", objective: "", assessment: "", plan: "" } }],
  ]) {
    test(`${label} throws rather than being saved`, () => {
      assert.throws(() => validateNote(response, context()));
    });
  }
});

describe("stage 1 fact validation", () => {
  test("facts keep their resolved segment ids; facts citing nothing real are dropped, not trusted", () => {
    const ctx = context();
    const { facts, dropped } = validateFacts({
      facts: [
        { text: "Headache for three days", category: "symptom", speaker: "patient", sourceLines: [2], negated: false, uncertain: false },
        { text: "Invented fact", category: "symptom", speaker: "patient", sourceLines: [999], negated: false, uncertain: false },
        { text: "No line at all", category: "symptom", speaker: "patient", sourceLines: [], negated: false, uncertain: false },
      ],
    }, ctx);
    assert.equal(facts.length, 1);
    assert.equal(dropped, 2);
    assert.deepEqual(facts[0].sourceSegmentIds, ["segment_2"]);
  });

  test("a fact resting on an unlabelled speaker is marked uncertain even when the model said otherwise", () => {
    const transcription = transcript();
    transcription.segments[5].speakerId = null;
    const { lines } = numberedTranscript(transcription);
    const { facts } = validateFacts({
      facts: [{ text: "Severity 7-8/10", category: "symptom", speaker: "patient", sourceLines: [6], negated: false, uncertain: false }],
    }, { lines });
    assert.equal(facts[0].uncertain, true);
  });

  test("a response with no facts array throws", () => {
    assert.throws(() => validateFacts({}, context()));
  });
});

describe("what the model is told", () => {
  test("an unconfirmed speaker with NO voice match is UNIDENTIFIED, never presented as the clinician", () => {
    const data = headacheTranscript({ roles: "unassigned" });
    // no voice identification at all (the doctor never enrolled, or the model could not decide)
    data.speakers = data.speakers.map((speaker) => ({ ...speaker, identificationStatus: "unavailable", suggestedRole: null }));
    const { text } = numberedTranscript({ ...transcript(), ...data });
    assert.ok(text.includes("UNIDENTIFIED"), text.slice(0, 200));
    assert.ok(!text.includes("CLINICIAN"), "an unidentified speaker must not be presented as the clinician");
    const notice = uncertaintyNotice({ ...transcript(), ...data });
    assert.match(notice, /Do not assume an unidentified speaker is the clinician/);
  });

  test("an unconfirmed speaker the VOICE MATCHED is offered as a suggestion, marked unconfirmed, with an explicit instruction to flag it", () => {
    const data = headacheTranscript({ roles: "unassigned" }); // speaker_0 is identificationStatus "matched", suggestedRole "doctor"
    const transcription = { ...transcript(), ...data };
    const { text } = numberedTranscript(transcription);
    assert.ok(text.includes("PROBABLY THE CLINICIAN, UNCONFIRMED"), text.slice(0, 200));
    assert.ok(!/^\[\d+\] CLINICIAN:/m.test(text), "it is never shown as a plain confirmed CLINICIAN");
    const notice = uncertaintyNotice(transcription);
    assert.match(notice, /voice matching suggests it, but nobody has confirmed it/);
    assert.match(notice, /MUST raise an uncertain_speaker flag/);
  });

  test("confirmed roles are shown, and a segment with no speaker is UNKNOWN SPEAKER", () => {
    const transcription = transcript();
    transcription.segments[0].speakerId = null;
    const { text } = numberedTranscript(transcription);
    assert.ok(text.includes("UNKNOWN SPEAKER"));
    assert.ok(text.includes("CLINICIAN"));
    assert.ok(text.includes("PATIENT"));
  });

  test("line numbers are 1-based and map to segment ids", () => {
    const { text, lines } = numberedTranscript(transcript());
    assert.ok(text.startsWith("[1] CLINICIAN"));
    assert.equal(lines[0].segmentId, "segment_1");
    assert.equal(lines[14].segmentId, "segment_15");
  });
});
