import { SECTIONS } from "./templates.js";

// Deterministic checks on what the model returned. A structured response is not a trustworthy one: everything here is verified against
// the transcript itself, without asking a model whether the model was right.
//
// What these checks CAN do: prove a claim's citation exists, prove a number or a drug name in the note also occurs in the cited
// source, prove a claim's text is really present in the section, catch a known fabrication pattern, catch a flipped negation.
// What they CANNOT do: judge clinical meaning. Anything that cannot be checked mechanically becomes a review flag for the
// clinician, never a silent pass. This is not hallucination detection; it is a floor under it.

/** Findings that must never appear unless the source says so: each has burned a real note. */
const FABRICATION_PATTERNS = [
  { pattern: /\balert and orient(ed|ation)\b|\ba&ox?\s*[0-4]\b|\baaox\s*[0-4]\b/i, label: "orientation/alertness finding" },
  { pattern: /\bnormocephalic\b|\batraumatic\b|\bncat\b/i, label: "head examination finding" },
  { pattern: /\bgait\b/i, label: "gait finding" },
  { pattern: /\b(motor|strength)\b[^.]{0,20}\b5\s*\/\s*5\b|\b5\s*\/\s*5\b/i, label: "motor strength finding" },
  { pattern: /\bsensation (is |was )?(intact|normal)\b|\bsensory exam\b/i, label: "sensory finding" },
  { pattern: /\bkernig\b|\bbrudzinski\b|\bnuchal rigidity\b|\bmeningeal sign/i, label: "meningeal sign" },
  { pattern: /\bheent\b|\bfundoscop|\bpapilledema\b|\btympanic\b/i, label: "HEENT finding" },
  { pattern: /\bdenies\b|\bdenied\b|\bno reported\b/i, label: "denial" },
  { pattern: /\bicd-?\s?10\b|\b[A-TV-Z][0-9][0-9AB](?:\.[0-9A-Z]{1,4})?\s*(?:code)?\b(?=.*code)/i, label: "diagnostic code" },
  { pattern: /\bfollow[- ]?up in\b|\breturn in\b|\brecheck in\b/i, label: "follow-up interval" },
  { pattern: /\bheadache diary\b|\bsymptom diary\b/i, label: "diary instruction" },
  { pattern: /\bside effects?\b|\badverse (effects?|reactions?)\b/i, label: "side-effect counselling" },
  { pattern: /\b(orally|by mouth|po|intramuscular|subcutaneous|intravenous|iv|im|sublingual|intranasal)\b/i, label: "medication route" },
  { pattern: /\bdifferential (diagnosis|diagnoses)\b|\brule out\b|\br\/o\b/i, label: "differential diagnosis" },
];

const NUMBER = /\d+(?:\.\d+)?/g;
const norm = (text) => String(text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9./'%-]+/g, " ").replace(/\s+/g, " ").trim();
const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/** Numbers that are part of clinical data, ignoring pure list numbering. Returns a set of strings. */
function numbersIn(text) {
  return new Set(String(text ?? "").match(NUMBER) ?? []);
}

// Distinctive pharmaceutical stems only. Loose suffixes like "-an" or "-ol" match ordinary words ("clinician", "protocol") and would
// flag a correct note, which is worse than missing an exotic drug name: a false alarm on every note teaches doctors to ignore them.
const DRUG_SUFFIX = /\b[a-z]{5,}(?:pril|sartan|statin|vastatin|mycin|micin|cillin|triptan|profen|azole|prazole|dipine|olol|afil|caine|parin|semide|tidine|idine|ixaban|gliptin|floxacin|oxacin|cycline|codone|morphone|oxetine|iptyline|azine|epine|olone|asone|ridone|apine|tadine|zepam|zolam|barbital|mab|nib)\b/gi;

/** Words that look like a medication name. Conservative on purpose: a miss is caught by the doctor's review, a false alarm is noise. */
function drugLikeTokens(text) {
  return [...new Set((String(text ?? "").match(DRUG_SUFFIX) ?? []).map((token) => token.toLowerCase()))];
}

/**
 * Does the transcript deny `subject` anywhere it mentions it? Matches on a word stem, because the note and the speech rarely use the
 * same form ("didn't vomit" denies "vomiting"), and looks on both sides of the mention, because a question and its answer are
 * separate sentences ("Any vomiting?" ... "I didn't vomit").
 */
function deniedInTranscript(subject, transcript) {
  const stem = subject.slice(0, 5);
  if (stem.length < 4) return false;
  const negation = /\b(?:denies|denied|denying|no|not|none|never|without|didn't|did not|doesn't|does not|hasn't|has not|haven't|have not|isn't|is not|wasn't|was not|negative for)\b/;
  for (const match of transcript.matchAll(new RegExp(escapeRegExp(stem), "g"))) {
    const window = transcript.slice(Math.max(0, match.index - 70), match.index + subject.length + 70);
    if (negation.test(window)) return true;
  }
  return false;
}

const flag = (type, severity, section, message, extra = {}) => ({ type, severity, section, message, ...extra });

/**
 * Check the composed note against the transcript.
 *   note      what the model returned (sections, claims, reviewFlags)
 *   lines     the numbered-line map from prompt.js ([{ number, segmentId, ... }])
 *   segments  the transcription's segments (source of truth for text)
 *   manualFacts clinician-entered facts, by id
 * Returns { sections, claims, reviewFlags, blocking } with claims carrying resolved segment ids.
 * Throws when the response is structurally unusable (the caller treats that as a provider failure and never saves it).
 */
export function validateNote(note, { lines, segments, manualFacts = [] }) {
  if (!note || typeof note !== "object") throw new Error("SOAP response is not an object");
  const sections = note.sections;
  if (!sections || typeof sections !== "object") throw new Error("SOAP response has no sections");
  for (const section of SECTIONS) {
    if (typeof sections[section] !== "string") throw new Error(`SOAP response section '${section}' is missing or not text`);
  }
  if (Object.keys(sections).some((key) => !SECTIONS.includes(key))) throw new Error("SOAP response has unexpected sections");
  if (!Array.isArray(note.claims)) throw new Error("SOAP response has no claims");

  const byLine = new Map(lines.map((line) => [line.number, line]));
  const segmentText = new Map(segments.map((segment) => [segment.id, segment.text]));
  const factById = new Map(manualFacts.map((fact) => [fact.id, fact]));
  const uncertainSegments = new Set(segments.filter((segment) => segment.needsReview || segment.speakerId === null).map((segment) => segment.id));
  const allTranscriptText = norm(segments.map((segment) => segment.text).join(" "));
  const allTranscriptNumbers = numbersIn(segments.map((segment) => segment.text).join(" "));

  const flags = [];
  const claims = [];
  let blocking = 0;

  note.claims.forEach((raw, index) => {
    const section = SECTIONS.includes(raw?.section) ? raw.section : null;
    const text = squash(raw?.text);
    const id = `claim_${index + 1}`;
    if (!section || !text) {
      flags.push(flag("unsupported_claim", "warning", section ?? "none", "A generated statement had no usable section or text and was dropped.", { claimId: id }));
      blocking++;
      return;
    }

    // 1. The claim must actually be findable in the section text, or the UI cannot highlight it.
    const anchored = norm(sections[section]).includes(norm(text));

    // 2. Citations must resolve to real segments of THIS transcription. A fresh response cites line numbers; a stored claim being
    // re-checked after an edit already carries segment ids.
    const rawLines = Array.isArray(raw.sourceLines) ? raw.sourceLines : [];
    const resolved = rawLines.map((number) => byLine.get(number)).filter(Boolean);
    const invalidLines = rawLines.filter((number) => !byLine.has(number));
    const sourceSegmentIds = Array.isArray(raw.sourceSegmentIds) && !Array.isArray(raw.sourceLines)
      ? raw.sourceSegmentIds.filter((segmentId) => segmentText.has(segmentId))
      : [...new Set(resolved.map((line) => line.segmentId))].filter((segmentId) => segmentText.has(segmentId));
    const rawFactIds = Array.isArray(raw.sourceFactIds) ? raw.sourceFactIds : [];
    const sourceFactIds = rawFactIds.filter((factId) => factById.has(factId));
    const invalidFactIds = rawFactIds.filter((factId) => !factById.has(factId));

    const citedText = [...sourceSegmentIds.map((segmentId) => segmentText.get(segmentId)), ...sourceFactIds.map((factId) => factById.get(factId).text)].join(" ");
    const citedNorm = norm(citedText);
    const citedNumbers = numbersIn(citedText);

    let needsReview = Boolean(raw.needsReview);
    const reasons = [];

    if (!anchored) {
      // The claim text is not in the note the doctor sees: the citation cannot be shown, so it is not usable evidence.
      reasons.push("its wording does not appear in the note text");
      needsReview = true;
    }
    if (sourceSegmentIds.length === 0 && sourceFactIds.length === 0) {
      flags.push(flag("missing_source", "warning", section, `"${truncate(text)}" has no valid source in this consultation. Verify it against the transcript.`, { claimId: id }));
      needsReview = true;
      blocking++;
    }
    if (invalidLines.length > 0) {
      flags.push(flag("invalid_source", "warning", section, `"${truncate(text)}" cited transcript lines that do not exist. Verify it.`, { claimId: id }));
      needsReview = true;
      blocking++;
    }
    if (invalidFactIds.length > 0) {
      flags.push(flag("invalid_source", "warning", section, `"${truncate(text)}" cited clinician-entered context that does not exist. Verify it.`, { claimId: id }));
      needsReview = true;
      blocking++;
    }

    // 3. Numbers must come from somewhere. A dose or a blood pressure the sources never mention is the worst kind of error.
    const claimNumbers = [...numbersIn(text)];
    const unsupportedNumbers = claimNumbers.filter((value) => !citedNumbers.has(value) && !allTranscriptNumbers.has(value));
    if (unsupportedNumbers.length > 0) {
      flags.push(flag("unsupported_claim", "warning", section,
        `"${truncate(text)}" contains ${unsupportedNumbers.length === 1 ? "a number" : "numbers"} (${unsupportedNumbers.join(", ")}) that the transcript never states. Check it before approving.`, { claimId: id }));
      needsReview = true;
      blocking++;
    } else if (claimNumbers.some((value) => !citedNumbers.has(value))) {
      // present in the transcript but not in the cited lines: the citation is weak, not the number
      reasons.push("a number in it is not in the cited lines");
      needsReview = true;
    }

    // 4. Medication names must occur in the sources.
    const unsupportedDrugs = drugLikeTokens(text).filter((token) => !citedNorm.includes(token) && !allTranscriptText.includes(token));
    if (unsupportedDrugs.length > 0) {
      flags.push(flag("unclear_medication", "warning", section,
        `"${truncate(text)}" names ${unsupportedDrugs.join(", ")}, which does not appear in the transcript. Check it before approving.`, { claimId: id }));
      needsReview = true;
      blocking++;
    }

    // 5. Claims resting on uncertain speech inherit that uncertainty.
    if (sourceSegmentIds.some((segmentId) => uncertainSegments.has(segmentId))) {
      reasons.push("it rests on speech with an uncertain speaker or wording");
      needsReview = true;
    }

    if (reasons.length > 0) {
      flags.push(flag("needs_verification", "info", section, `"${truncate(text)}": ${reasons.join("; ")}.`, { claimId: id }));
    }

    claims.push({ id, section, text, sourceSegmentIds, sourceFactIds, needsReview });
  });

  // 6. Known fabrication patterns anywhere in the note that the transcript never contains.
  for (const section of SECTIONS) {
    const body = sections[section];
    if (!body) continue;
    for (const { pattern, label } of FABRICATION_PATTERNS) {
      const match = body.match(pattern);
      if (!match) continue;
      const phrase = norm(match[0]);
      if (phrase && allTranscriptText.includes(phrase)) continue; // the source really says it
      flags.push(flag("unsupported_claim", "warning", section,
        `The ${section} section contains a ${label} ("${squash(match[0])}") that the transcript does not state. Remove or correct it before approving.`));
      blocking++;
    }
  }

  // 7. Negation flips: the transcript reports a symptom, the note denies it.
  for (const section of SECTIONS) {
    for (const match of String(sections[section] ?? "").matchAll(/\b(?:denies|denied|no)\s+([a-z]{4,}(?:\s+[a-z]{4,})?)/gi)) {
      const subject = norm(match[1]).split(" ")[0];
      if (!subject || subject.length < 4) continue;
      const presentInSource = allTranscriptText.includes(subject.slice(0, 5));
      if (presentInSource && !deniedInTranscript(subject, allTranscriptText)) {
        flags.push(flag("conflicting_facts", "warning", section,
          `The ${section} section records "${squash(match[0])}", but the transcript mentions ${subject.split(" ")[0]} without denying it. Check this before approving.`));
        blocking++;
      }
    }
  }

  // 8. Section text with no claim covering it: the doctor cannot trace it.
  for (const section of SECTIONS) {
    const body = squash(sections[section]);
    if (!body) continue;
    const covered = claims.filter((claim) => claim.section === section).map((claim) => norm(claim.text)).join(" ");
    const uncovered = body.split(/(?<=[.;])\s+|\n+/).map(squash).filter((sentence) => sentence.length > 12 && !covered.includes(norm(sentence)));
    if (uncovered.length > 0) {
      flags.push(flag("needs_verification", "info", section,
        `${uncovered.length} statement${uncovered.length === 1 ? "" : "s"} in the ${section} section ${uncovered.length === 1 ? "has" : "have"} no source citation. Verify ${uncovered.length === 1 ? "it" : "them"} against the transcript.`));
    }
  }

  // 9. Empty sections are legitimate, but the doctor should know.
  for (const section of SECTIONS) {
    if (!squash(sections[section])) {
      flags.push(flag("missing_documentation", "info", section, `Nothing was documented for the ${section} section in this consultation.`));
    }
  }

  // The model's own flags, kept (it saw things the checks cannot), normalised and marked as its own.
  for (const raw of Array.isArray(note.reviewFlags) ? note.reviewFlags : []) {
    if (!raw?.message) continue;
    const section = SECTIONS.includes(raw.section) ? raw.section : "none";
    const type = typeof raw.type === "string" ? raw.type : "other";
    if (type === "missing_documentation" && flags.some((existing) => existing.type === "missing_documentation" && existing.section === section)) continue;
    flags.push(flag(type, raw.severity === "warning" ? "warning" : "info", section, squash(raw.message), { source: "model" }));
  }

  return { sections: Object.fromEntries(SECTIONS.map((section) => [section, squash(sections[section])])), claims, reviewFlags: withIds(flags), blocking };
}

/** Flags get stable ids and a resolution state so a doctor can acknowledge the non-blocking ones. */
function withIds(flags) {
  return flags.map((entry, index) => ({
    id: `flag_${index + 1}`,
    type: entry.type,
    severity: entry.severity,
    section: entry.section === "none" ? null : entry.section,
    claimId: entry.claimId ?? null,
    message: entry.message,
    // "warning" must be resolved or acknowledged before approval; "info" is advisory.
    blocking: entry.severity === "warning",
    resolved: false,
    acknowledgedAt: null,
    source: entry.source ?? "validator",
  }));
}

const truncate = (text, max = 60) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Stage-1 facts, checked the same way: a fact citing a line that does not exist is dropped, not trusted. */
export function validateFacts(response, { lines }) {
  if (!response || !Array.isArray(response.facts)) throw new Error("fact extraction returned no facts array");
  const byLine = new Map(lines.map((line) => [line.number, line]));
  const facts = [];
  let dropped = 0;
  response.facts.forEach((raw, index) => {
    const text = squash(raw?.text);
    const rawLines = Array.isArray(raw?.sourceLines) ? raw.sourceLines : [];
    const valid = rawLines.filter((number) => byLine.has(number));
    if (!text || valid.length === 0) { dropped++; return; }
    facts.push({
      id: `fact_${index + 1}`,
      text,
      category: typeof raw.category === "string" ? raw.category : "other",
      speaker: typeof raw.speaker === "string" ? raw.speaker : "unknown",
      sourceLines: valid,
      sourceSegmentIds: [...new Set(valid.map((number) => byLine.get(number).segmentId))],
      negated: Boolean(raw.negated),
      uncertain: Boolean(raw.uncertain) || valid.some((number) => byLine.get(number).needsReview || byLine.get(number).speakerId === null),
    });
  });
  return { facts, dropped };
}

export { FABRICATION_PATTERNS };
