import { Type } from "@google/genai";
import { SECTIONS } from "./templates.js";

// The prompts and response schemas for the two generation stages. The rules here are the product's clinical safety policy: the model
// documents what was said and nothing else. They are duplicated as deterministic checks in validate.js, because a prompt is a request,
// not a guarantee.

/** Rules that apply to BOTH stages. Written as prohibitions because that is what must not happen. */
const GROUNDING_RULES = `
You are a clinical documentation assistant. You transcribe a consultation into a SOAP note. You do NOT practise medicine, diagnose, or advise.

ABSOLUTE RULE: every clinical statement you write must be supported by a specific numbered transcript line (or a clinician-entered fact).
If something was not said, it does not go in the note. An incomplete note is correct; an invented one is dangerous.

You must NEVER invent, infer or "complete":
- symptoms, or the ABSENCE of symptoms (a denial is a clinical finding: write it only if the patient actually denied it)
- physical examination findings, including normal ones
- vital signs, measurements, laboratory or imaging results
- diagnoses, differential diagnoses, severity, staging, or ICD/CPT codes
- medications, doses, routes, frequencies, or durations
- treatments, procedures, referrals, follow-up intervals, counselling, or return precautions
- anything a "typical" note of this kind would contain

Specific traps, each of which has occurred:
- If the patient says bright light and loud noise make it worse, that is photophobia and phonophobia. It is NOT "denies phonophobia".
  Never turn a positive report into a denial, or a denial into a positive report.
- If the clinician says the neurological examination is normal, write exactly that. Do NOT expand it into itemised findings
  ("alert and oriented x4", "motor 5/5", "normal gait", "sensation intact", "negative Kernig", "normocephalic"), which were never stated.
- An examination being performed, or silence about a body system, is NOT evidence that it was normal. Write nothing.
- Do not add a follow-up interval, a medication route, a side-effect warning or an extra emergency symptom that nobody stated.

ATTRIBUTION: the clinician's own words are documented AS THEIRS. Write "Clinician assessment: ..." and "Clinician prescribed ...",
never your own conclusion. You must not agree, disagree, correct or extend the clinician's reasoning or plan.

UNCERTAINTY: if a speaker label is uncertain, or the transcript is unclear, or two statements conflict, document what is there and raise a
review flag. Do not resolve the ambiguity yourself, and do not attribute unlabelled speech to the clinician.

EMPTY SECTIONS: if nothing was documented for a section, return an EMPTY STRING for it and raise a "missing_documentation" flag.
Never fill a section to look complete.
`.trim();

/** Stage 1: pull clinical facts out of the transcript, each tied to the lines it came from. */
export function factSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      facts: {
        type: Type.ARRAY,
        description: "Every clinical fact documented in the transcript, in the order they appear.",
        items: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING, description: "The fact in clinical language, close to the source wording. One fact per entry." },
            category: {
              type: Type.STRING,
              enum: ["symptom", "history", "medication", "allergy", "vital", "exam", "assessment", "plan", "other"],
              description: "What kind of fact this is. 'assessment' and 'plan' are only for the CLINICIAN's own stated assessment or plan.",
            },
            speaker: { type: Type.STRING, enum: ["clinician", "patient", "other", "unknown"], description: "Who stated it, per the transcript's speaker labels." },
            sourceLines: { type: Type.ARRAY, items: { type: Type.INTEGER }, description: "The numbered transcript lines that state this fact. At least one. Never guess a number." },
            negated: { type: Type.BOOLEAN, description: "True only when the source explicitly DENIES it (for example 'no vomiting')." },
            uncertain: { type: Type.BOOLEAN, description: "True when the transcript is unclear, the speaker is uncertain, or the value is doubtful." },
          },
          required: ["text", "category", "speaker", "sourceLines", "negated", "uncertain"],
        },
      },
    },
    required: ["facts"],
  };
}

/** Stage 2: compose the four sections, plus a claim per statement and any review flags. */
export function noteSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      sections: {
        type: Type.OBJECT,
        description: "The four SOAP sections. An empty string when nothing was documented for that section.",
        properties: Object.fromEntries(SECTIONS.map((section) => [section, { type: Type.STRING }])),
        required: SECTIONS,
      },
      claims: {
        type: Type.ARRAY,
        description: "One entry per clinical statement you wrote, in the order they appear in the sections.",
        items: {
          type: Type.OBJECT,
          properties: {
            section: { type: Type.STRING, enum: SECTIONS },
            text: { type: Type.STRING, description: "The statement EXACTLY as it appears in the section text, so it can be located there." },
            sourceLines: { type: Type.ARRAY, items: { type: Type.INTEGER }, description: "The transcript lines supporting this statement." },
            sourceFactIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: "ONLY ids of CLINICIAN-ENTERED context, which all begin with 'manual_'. Leave this empty otherwise. Never put a 'fact_' id here: the extracted facts are not sources, their transcript lines are." },
            needsReview: { type: Type.BOOLEAN, description: "True when support is partial, the speaker was uncertain, or the wording had to be interpreted." },
          },
          required: ["section", "text", "sourceLines", "sourceFactIds", "needsReview"],
        },
      },
      reviewFlags: {
        type: Type.ARRAY,
        description: "Problems the clinician should look at. Raise one whenever a section is empty or anything was unclear.",
        items: {
          type: Type.OBJECT,
          properties: {
            type: {
              type: Type.STRING,
              enum: ["missing_documentation", "uncertain_speaker", "uncertain_transcript", "conflicting_facts", "unclear_medication", "unclear_dose", "other"],
            },
            severity: { type: Type.STRING, enum: ["info", "warning"] },
            section: { type: Type.STRING, enum: [...SECTIONS, "none"] },
            message: { type: Type.STRING, description: "One sentence, addressed to the clinician." },
          },
          required: ["type", "severity", "section", "message"],
        },
      },
    },
    required: ["sections", "claims", "reviewFlags"],
  };
}

/**
 * The transcript as numbered lines the model can cite. Returns { text, lines } where lines[n] maps a line number back to the real
 * segment id: the model never sees or invents our ids, it cites line numbers we then resolve ourselves.
 */
export function numberedTranscript(transcription) {
  const roleOf = new Map(transcription.speakers.map((speaker) => [speaker.id, speaker]));
  const lines = [];
  const rendered = transcription.segments.map((segment, index) => {
    const number = index + 1;
    lines.push({ number, segmentId: segment.id, speakerId: segment.speakerId, needsReview: segment.needsReview });
    const speaker = segment.speakerId ? roleOf.get(segment.speakerId) : null;
    // What the model is told about a speaker is exactly what we know: a CONFIRMED role, or an unlabelled speaker. A model
    // suggestion (identificationStatus) is deliberately NOT presented as a role.
    let who = "UNKNOWN SPEAKER";
    if (speaker) {
      const role = speaker.role;
      if (role === "doctor") who = "CLINICIAN";
      else if (role === "patient") who = "PATIENT";
      else if (role === "other") who = `OTHER (${speaker.label})`;
      // Not confirmed by the doctor. A voice match is a suggestion and is labelled as one, so the model can use it for attribution
      // while still being told it is unconfirmed: it must not silently promote the suggestion to a fact.
      else if (speaker.suggestedRole === "doctor" && speaker.identificationStatus === "matched") who = `PROBABLY THE CLINICIAN, UNCONFIRMED (${speaker.label})`;
      else who = `UNIDENTIFIED (${speaker.label})`;
    }
    const time = Number.isFinite(segment.startMs) ? ` @${Math.floor(segment.startMs / 1000)}s` : "";
    return `[${number}] ${who}${time}: ${segment.text}`;
  });
  return { text: rendered.join("\n"), lines };
}

export function extractionPrompt({ transcript, manualFacts, uncertainty }) {
  const system = `${GROUNDING_RULES}

STAGE 1 of 2. Extract the clinical facts. Do not write a note yet, do not summarise, do not merge different facts into one entry.
Cite the transcript line numbers ([1], [2], ...) that state each fact. Cite only line numbers that exist.`;

  const user = `${uncertainty}TRANSCRIPT (numbered lines):
${transcript}
${manualFacts}
Extract every documented clinical fact, with its source line numbers.`;
  return { system, user };
}

export function compositionPrompt({ transcript, facts, template, manualFacts, uncertainty }) {
  const system = `${GROUNDING_RULES}

STAGE 2 of 2. Write the SOAP note from the extracted facts and the transcript.

SECTIONS:
- Subjective: what the patient reported (history, symptoms, what they have taken, relevant history, allergies).
- Objective: measured or observed findings ONLY (vital signs, examination findings) as documented. Never infer a finding.
- Assessment: the CLINICIAN's stated assessment, attributed to them ("Clinician assessment: ..."). If they stated none, leave empty.
- Plan: the CLINICIAN's stated plan, attributed to them ("Clinician prescribed ...", "Clinician advised ..."). Never add to it.

STYLE (${template.name}): ${template.style}

For every clinical statement you write, return a claim whose \`text\` is that statement EXACTLY as it appears in your section text,
so the application can highlight it. Cite the supporting TRANSCRIPT LINE NUMBERS in \`sourceLines\` (the numbers in square brackets).
The extracted facts below are a working list, not sources: cite the transcript lines they point to, never a \`fact_\` id. Leave
\`sourceFactIds\` empty unless the statement rests on clinician-entered context, whose ids all begin with \`manual_\`.`;

  const user = `${uncertainty}TRANSCRIPT (numbered lines):
${transcript}

EXTRACTED FACTS (a working list from stage 1; cite the TRANSCRIPT LINES they name, not these fact ids):
${facts}
${manualFacts}
Write the SOAP note. Use only the facts and transcript above.`;
  return { system, user };
}

/** What the model is told about speaker-attribution uncertainty, so it does not silently treat it as reliable. */
export function uncertaintyNotice(transcription) {
  const notes = [];
  const unlabelled = transcription.segments.filter((segment) => segment.speakerId === null).length;
  const unconfirmed = transcription.speakers.filter((speaker) => speaker.role === "unassigned").length;
  const flagged = transcription.segments.filter((segment) => segment.needsReview).length;
  if (unconfirmed > 0) {
    const voiceMatched = transcription.speakers.filter((speaker) => speaker.role === "unassigned" && speaker.suggestedRole === "doctor" && speaker.identificationStatus === "matched").length;
    notes.push(`${unconfirmed} of ${transcription.speakers.length} speakers have NOT been confirmed by the clinician. `
      + (voiceMatched > 0
        ? "One is marked PROBABLY THE CLINICIAN, UNCONFIRMED: voice matching suggests it, but nobody has confirmed it. You may document their stated assessment and plan as the clinician's, and you MUST raise an uncertain_speaker flag saying the speaker was identified by voice matching and not confirmed. "
        : "They are marked UNIDENTIFIED. Do not assume an unidentified speaker is the clinician. Statements that would only belong in Assessment or Plan if a clinician said them must NOT be attributed to the clinician; raise an uncertain_speaker flag instead."));
  }
  if (unlabelled > 0) notes.push(`${unlabelled} transcript lines have no speaker at all (marked UNKNOWN SPEAKER). Treat their attribution as unknown.`);
  if (flagged > 0) notes.push(`${flagged} lines are flagged as possibly misheard. Facts resting on them are uncertain.`);
  return notes.length ? `SPEAKER AND TRANSCRIPT UNCERTAINTY (read first):\n- ${notes.join("\n- ")}\n\n` : "";
}

/** Clinician-entered context, rendered for the prompt. Never used for objective findings (MVP policy). */
export function manualFactsBlock(facts) {
  if (!facts?.length) return "";
  return `\nCLINICIAN-ENTERED CONTEXT (source = manual, NOT from the recording; cite these by id in sourceFactIds; these may NOT be used as objective measurements or examination findings):\n`
    + facts.map((fact) => `(${fact.id}) ${fact.text}`).join("\n") + "\n";
}

export { GROUNDING_RULES };
