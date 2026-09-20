import type { SoapClaim, SoapSections, SoapTemplate } from "@/types";

/**
 * Synthetic SOAP note fixture used by the mock SOAP service — the "corrected reference
 * example" (grounded only in what was actually said; no invented exam findings, no
 * differentials, no ICD codes, no undiscussed medications). Every claim's
 * `sourceSegmentIds` cites a real segment id from lib/transcriptionFixtures.ts, so
 * clicking a statement scrolls to text that genuinely supports it.
 *
 * This is a formatting/grounding fixture for building and demoing the UI — not
 * independently validated clinical advice, and never real patient data.
 */

export const SOAP_TEMPLATES: SoapTemplate[] = [
  {
    id: "primary-care-standard",
    name: "Primary Care — Standard",
    description: "Balanced detail across all four sections. The default template.",
  },
  {
    id: "primary-care-concise",
    name: "Primary Care — Concise",
    description: "Shorter, bullet-style phrasing for a quick note.",
  },
  {
    id: "primary-care-detailed",
    name: "Primary Care — Detailed",
    description: "More verbose section organization for a thorough note.",
  },
];

export const FIXTURE_SOAP_SECTIONS: SoapSections = {
  subjective: [
    "Chief complaint: Severe headache for three days.",
    "Patient reports right-sided retro-orbital and temporal throbbing headache rated 7–8/10.",
    "Bright light and loud noises worsen symptoms.",
    "Associated nausea without vomiting.",
    "No visual changes such as spots or flashes.",
    "Ibuprofen 400 mg provided temporary relief, reducing pain to approximately 5/10.",
    "History of occasional mild tension headaches.",
    "No chronic conditions, regular daily medications, or known drug allergies reported.",
  ].join("\n\n"),
  objective: [
    "BP 122/78.",
    "HR 72 bpm.",
    "Temperature 98.6°F.",
    "Respiratory rate 16 breaths/min.",
    "Cranial nerves II–XII intact.",
    "Neck supple with full range of motion.",
    "No temporal artery or sinus tenderness.",
    "Clinician described neurological examination as normal without further component findings.",
  ].join("\n\n"),
  assessment: [
    "Clinician assessed the presentation as having classic features of acute migraine without aura.",
  ].join("\n\n"),
  plan: [
    "Clinician prescribed sumatriptan 50 mg at migraine onset.",
    "May repeat after two hours if symptoms do not resolve, with stated maximum 200 mg in 24 hours.",
    "Rest in a quiet, dark room.",
    "Maintain hydration.",
    "Seek immediate urgent care or emergency evaluation if pain worsens significantly or new weakness, numbness, or vision loss occurs.",
  ].join("\n\n"),
};

export const FIXTURE_SOAP_CLAIMS: SoapClaim[] = [
  { id: "claim-1", section: "subjective", text: "Chief complaint: Severe headache for three days.", sourceSegmentIds: ["segment_2"], sourceFactIds: [], needsReview: false },
  { id: "claim-2", section: "subjective", text: "Patient reports right-sided retro-orbital and temporal throbbing headache rated 7–8/10.", sourceSegmentIds: ["segment_4"], sourceFactIds: [], needsReview: false },
  { id: "claim-3", section: "subjective", text: "Bright light and loud noises worsen symptoms.", sourceSegmentIds: ["segment_6"], sourceFactIds: [], needsReview: false },
  { id: "claim-4", section: "subjective", text: "Associated nausea without vomiting.", sourceSegmentIds: ["segment_8"], sourceFactIds: [], needsReview: false },
  { id: "claim-5", section: "subjective", text: "No visual changes such as spots or flashes.", sourceSegmentIds: ["segment_8"], sourceFactIds: [], needsReview: false },
  { id: "claim-6", section: "subjective", text: "Ibuprofen 400 mg provided temporary relief, reducing pain to approximately 5/10.", sourceSegmentIds: ["segment_10"], sourceFactIds: [], needsReview: false },
  { id: "claim-7", section: "subjective", text: "History of occasional mild tension headaches.", sourceSegmentIds: ["segment_12"], sourceFactIds: [], needsReview: false },
  { id: "claim-8", section: "subjective", text: "No chronic conditions, regular daily medications, or known drug allergies reported.", sourceSegmentIds: ["segment_14"], sourceFactIds: [], needsReview: false },

  { id: "claim-9", section: "objective", text: "BP 122/78.", sourceSegmentIds: ["segment_15"], sourceFactIds: [], needsReview: false },
  { id: "claim-10", section: "objective", text: "HR 72 bpm.", sourceSegmentIds: ["segment_15"], sourceFactIds: [], needsReview: false },
  { id: "claim-11", section: "objective", text: "Temperature 98.6°F.", sourceSegmentIds: ["segment_15"], sourceFactIds: [], needsReview: false },
  { id: "claim-12", section: "objective", text: "Respiratory rate 16 breaths/min.", sourceSegmentIds: ["segment_15"], sourceFactIds: [], needsReview: false },
  { id: "claim-13", section: "objective", text: "Cranial nerves II–XII intact.", sourceSegmentIds: ["segment_16"], sourceFactIds: [], needsReview: false },
  { id: "claim-14", section: "objective", text: "Neck supple with full range of motion.", sourceSegmentIds: ["segment_16"], sourceFactIds: [], needsReview: false },
  { id: "claim-15", section: "objective", text: "No temporal artery or sinus tenderness.", sourceSegmentIds: ["segment_16"], sourceFactIds: [], needsReview: false },
  {
    id: "claim-16",
    section: "objective",
    text: "Clinician described neurological examination as normal without further component findings.",
    sourceSegmentIds: ["segment_16"],
    sourceFactIds: [],
    // Deliberately flagged: a blanket "normal exam" statement without itemized findings
    // (gait, strength, sensation, etc. were never individually documented) — a doctor
    // should verify this summary rather than take it as a itemized exam.
    needsReview: true,
  },

  { id: "claim-17", section: "assessment", text: "Clinician assessed the presentation as having classic features of acute migraine without aura.", sourceSegmentIds: ["segment_17"], sourceFactIds: [], needsReview: false },

  { id: "claim-18", section: "plan", text: "Clinician prescribed sumatriptan 50 mg at migraine onset.", sourceSegmentIds: ["segment_18"], sourceFactIds: [], needsReview: false },
  { id: "claim-19", section: "plan", text: "May repeat after two hours if symptoms do not resolve, with stated maximum 200 mg in 24 hours.", sourceSegmentIds: ["segment_18"], sourceFactIds: [], needsReview: false },
  { id: "claim-20", section: "plan", text: "Rest in a quiet, dark room.", sourceSegmentIds: ["segment_18"], sourceFactIds: [], needsReview: false },
  { id: "claim-21", section: "plan", text: "Maintain hydration.", sourceSegmentIds: ["segment_18"], sourceFactIds: [], needsReview: false },
  { id: "claim-22", section: "plan", text: "Seek immediate urgent care or emergency evaluation if pain worsens significantly or new weakness, numbness, or vision loss occurs.", sourceSegmentIds: ["segment_18"], sourceFactIds: [], needsReview: false },
];
