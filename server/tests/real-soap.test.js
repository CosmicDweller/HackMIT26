// REAL Gemini generation on the corrected headache consultation. Skipped (not passed) without GEMINI_API_KEY.
//
// These are the only tests that show SOAP generation actually works: everything else scripts the provider. They send SYNTHETIC
// consultation text to Google's API and cost a small number of free-tier tokens per run.
//
// What they assert is not "the note reads nicely" but the things that make it safe: every section present, every claim traceable to a
// real segment, the forbidden fabrications from the brief absent, the numbers and the drug name correct, and nothing invented for a
// section the consultation never covered.
import assert from "node:assert/strict";
import { afterEach, before, describe, test } from "node:test";
import { loadConfig } from "../config.js";
import { createSoapGenerator } from "../services/soap/generate.js";
import { createSoapProvider } from "../services/soap/gemini.js";
import { createSoapService } from "../services/soap/service.js";
import { openStore } from "../db/store.js";
import { FABRICATION_PATTERNS } from "../services/soap/validate.js";
import { headacheTranscript } from "./soap-fixtures.js";

const KEY = process.env.GEMINI_API_KEY ?? "";
const skip = KEY ? false : "set GEMINI_API_KEY in server/.env (free tier: aistudio.google.com/apikey)";

const quiet = { log() {}, error() {}, warn() {} };
let config;
let generator;
const cleanups = [];
before(() => {
  // The free tier limits requests per MINUTE. These tests make several generations (two calls each), so they are paced and given
  // more retries than production: hitting the quota is a fact about the tier, not a failure of the code being tested.
  // process.env, not {}, so SOAP_MODEL from the environment is honoured: the free tier meters per model per day, so a run may need
  // to name a model whose daily allowance is not yet spent.
  config = { ...loadConfig(process.env), geminiApiKey: KEY, soapEnabled: true, soapMaxRetries: 5, soapRateLimitWaitMs: 30_000 };
  generator = createSoapGenerator({ config, provider: createSoapProvider(config, { logger: quiet }), logger: quiet });
});

// Keep a minimum gap between generations so a burst does not trip the per-minute quota before the retry logic even engages.
const GAP_MS = 20_000;
let lastStart = 0;
async function paced(work) {
  const wait = Math.max(0, lastStart + GAP_MS - Date.now());
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastStart = Date.now();
  return work();
}
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

/** A store with the headache consultation loaded, as the pipeline would have stored it. */
function stored(overrides = {}) {
  const store = openStore(":memory:");
  cleanups.push(() => store.close());
  store.upsertDoctor({ id: "doctor-a" });
  const transcription = store.createTranscription("doctor-a", { ...headacheTranscript(), ...overrides });
  return { store, transcription };
}

const allText = (note) => Object.values(note.sections).join("\n");
const report = (note) => `\n--- generated note ---\n${Object.entries(note.sections).map(([k, v]) => `[${k}] ${v}`).join("\n")}\n--- flags ---\n${note.reviewFlags.map((f) => `${f.blocking ? "BLOCKING" : "info"} ${f.type}: ${f.message}`).join("\n")}\n`;

describe("real Gemini: the corrected headache consultation", { skip, concurrency: 1 }, () => {
  let note;
  let usage;

  // ONE real generation; every test below inspects that same note. Generating per assertion would burn the free-tier quota and tell
  // us nothing extra.
  test("generates a four-section note from the stored transcript", async () => {
    const { transcription } = stored();
    const started = Date.now();
    const result = await paced(() => generator.generate(transcription, { templateId: "primary-care-standard" }));
    const seconds = (Date.now() - started) / 1000;
    note = result;
    usage = result.usage;
    console.log(`  real Gemini (${result.model}): ${seconds.toFixed(1)} s, ${usage.calls} calls, ${usage.inputTokens} in / ${usage.outputTokens} out tokens, ${result.facts.length} facts, ${result.claims.length} claims`);
    assert.deepEqual(Object.keys(result.sections).sort(), ["assessment", "objective", "plan", "subjective"]);
    for (const section of ["subjective", "objective", "assessment", "plan"]) {
      assert.ok(result.sections[section].trim().length > 0, `${section} is empty${report(result)}`);
    }
  });

  test("the documented facts are present", async () => {
    assert.ok(note, "the generation test must run first");
    const text = allText(note).toLowerCase();
    const required = [
      [/three days|3 days/, "duration"],
      [/right|temporal|retro-?orbital|behind (the|my|your) eye/, "location"],
      [/throbbing|pulsing|pulsatile/, "quality"],
      [/7|8/, "severity"],
      [/light|photophobia/, "light sensitivity"],
      [/nause/, "nausea"],
      [/ibuprofen/, "prior medication"],
      [/122\s*\/\s*78|122 over 78/, "blood pressure"],
      [/\b72\b/, "heart rate"],
      [/98\.6/, "temperature"],
      [/\b16\b/, "respiratory rate"],
      [/cranial nerve/, "cranial nerves"],
      [/migraine/, "assessment"],
      [/sumatriptan/, "prescription"],
      [/50\s*mg/, "dose"],
      [/200\s*mg/, "maximum dose"],
    ];
    const missing = required.filter(([pattern]) => !pattern.test(text)).map(([, label]) => label);
    assert.deepEqual(missing, [], `missing documented facts: ${missing.join(", ")}${report(note)}`);
  });

  test("NONE of the forbidden fabrications appear", async () => {
    assert.ok(note, "the generation test must run first");
    const text = allText(note);
    const found = [];
    for (const { pattern, label } of FABRICATION_PATTERNS) {
      const match = text.match(pattern);
      if (match) found.push(`${label} ("${match[0].trim()}")`);
    }
    assert.deepEqual(found, [], `the model invented content the consultation never contained: ${found.join("; ")}${report(note)}`);
  });

  test("specifically: no denial of phonophobia, and no itemised neurological findings", async () => {
    assert.ok(note, "the generation test must run first");
    const text = allText(note).toLowerCase();
    // A denial is legitimate when the consultation contains it ("I didn't vomit" -> "denies vomiting"); what must never appear is a
    // denial of something never discussed. The validator judges that, so this asserts on its verdict rather than on the word.
    assert.deepEqual(note.reviewFlags.filter((flag) => /denial|denies|never mentioned|without denying/i.test(flag.message)).map((flag) => flag.message), [],
      `a denial was invented or flipped${report(note)}`);
    assert.ok(!/phonophobia|photophobia/.test(text) || !/denies (phono|photo)/.test(text), `sensitivity was turned into a denial${report(note)}`);
    for (const invented of ["oriented", "5/5", "gait", "kernig", "brudzinski", "normocephalic"]) {
      assert.ok(!text.includes(invented), `invented neurological finding: ${invented}${report(note)}`);
    }
  });

  test("every claim cites a real segment of this consultation and is anchored in the note text", async () => {
    assert.ok(note, "the generation test must run first");
    assert.ok(note.claims.length >= 8, `only ${note.claims.length} claims${report(note)}`);
    const real = new Set(headacheTranscript().segments.map((segment) => segment.id));
    for (const claim of note.claims) {
      for (const id of claim.sourceSegmentIds) assert.ok(real.has(id), `claim cites an unreal segment ${id}`);
      assert.ok(note.sections[claim.section].includes(claim.text), `claim is not anchored in its section: "${claim.text}"`);
    }
    const grounded = note.claims.filter((claim) => claim.sourceSegmentIds.length > 0);
    assert.ok(grounded.length / note.claims.length >= 0.9, `only ${grounded.length}/${note.claims.length} claims have a source${report(note)}`);
  });

  test("the validator finds nothing blocking in the real output", async () => {
    assert.ok(note, "the generation test must run first");
    const blocking = note.reviewFlags.filter((flag) => flag.blocking);
    assert.deepEqual(blocking.map((flag) => flag.message), [], `real generation produced blocking problems${report(note)}`);
  });

  test("the clinician's assessment and plan are attributed to the clinician, not asserted by the model", async () => {
    assert.ok(note, "the generation test must run first");
    assert.match(note.sections.assessment.toLowerCase(), /clinician|clinical impression|assessed|per the/, `assessment is not attributed${report(note)}`);
    assert.match(note.sections.plan.toLowerCase(), /clinician|prescribed|advised|instructed/, `plan is not attributed${report(note)}`);
  });

  test("latency and token use are within the target", async () => {
    assert.ok(usage, "the generation test must run first");
    assert.ok(usage.ms < 60_000, `generation took ${usage.ms} ms`);
    console.log(`  measured: ${(usage.ms / 1000).toFixed(1)} s of provider time across ${usage.calls} calls (target under 30 s)`);
  });
});

describe("real Gemini: consultations with information missing", { skip, concurrency: 1 }, () => {
  test("a consultation with no examination leaves Objective EMPTY rather than inventing normal findings", async () => {
    const base = headacheTranscript();
    // keep only the history; drop the vitals, the examination, the assessment and the plan
    const segments = base.segments.slice(0, 14);
    const { transcription } = stored({ segments });
    const result = await paced(() => generator.generate(transcription, { templateId: "primary-care-standard" }));
    assert.equal(result.sections.objective.trim(), "", `Objective was invented from nothing: "${result.sections.objective}"${report(result)}`);
    assert.ok(result.reviewFlags.some((flag) => flag.type === "missing_documentation" && flag.section === "objective"),
      `no missing-documentation flag was raised${report(result)}`);
    assert.ok(result.sections.subjective.trim().length > 0, "the history that WAS documented is still written");
  });

  test("a consultation with no stated assessment or plan leaves those sections empty", async () => {
    const base = headacheTranscript();
    const segments = base.segments.slice(0, 17); // history + vitals + exam, nothing after
    const { transcription } = stored({ segments });
    const result = await paced(() => generator.generate(transcription, { templateId: "primary-care-standard" }));
    assert.equal(result.sections.assessment.trim(), "", `an assessment was invented: "${result.sections.assessment}"${report(result)}`);
    assert.equal(result.sections.plan.trim(), "", `a plan was invented: "${result.sections.plan}"${report(result)}`);
    assert.ok(result.sections.objective.trim().length > 0, "the examination that WAS documented is still written");
  });

  test("unconfirmed speakers: the model is told they are unidentified and must not attribute a plan to the clinician", async () => {
    const { transcription } = stored(headacheTranscript({ roles: "unassigned" }));
    const result = await paced(() => generator.generate(transcription, { templateId: "primary-care-standard" }));
    const uncertainty = result.reviewFlags.some((flag) => ["uncertain_speaker", "needs_verification"].includes(flag.type))
      || result.claims.some((claim) => claim.needsReview);
    assert.ok(uncertainty, `speaker uncertainty was not preserved anywhere${report(result)}`);
  });
});

describe("real Gemini: another template", { skip, concurrency: 1 }, () => {
  test("the concise template still produces four grounded sections with no fabrications", async () => {
    const { transcription } = stored();
    const result = await paced(() => generator.generate(transcription, { templateId: "primary-care-concise" }));
    for (const section of ["subjective", "objective", "assessment", "plan"]) {
      assert.ok(result.sections[section].trim().length > 0, `concise: ${section} is empty${report(result)}`);
    }
    const text = allText(result);
    const fabrications = FABRICATION_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
    assert.deepEqual(fabrications, [], `the concise template invented: ${fabrications.join(", ")}${report(result)}`);
    assert.deepEqual(result.reviewFlags.filter((flag) => flag.blocking).map((f) => f.message), [], report(result));
    console.log(`  concise: ${result.claims.length} claims, ${Object.values(result.sections).join(" ").length} characters`);
  });
});

describe("real Gemini: the whole note workflow with real generation", { skip, concurrency: 1 }, () => {
  test("draft -> edit -> approve -> export, on a really generated note", async () => {
    const { store, transcription } = stored();
    const soap = createSoapService({ config, store, generator, logger: quiet });
    const note = await paced(() => soap.createIfAbsent("doctor-a", transcription.id, { wait: true }));
    assert.equal(note.status, "draft_ready", `generation failed: ${note.errorCode}`);

    const edited = soap.update("doctor-a", transcription.id, {
      sections: { assessment: `${note.sections.assessment} Reviewed by the clinician.` }, revision: note.revision,
    });
    assert.match(edited.sections.assessment, /Reviewed by the clinician\./);

    for (const flag of edited.reviewFlags.filter((entry) => !entry.blocking && !entry.resolved)) {
      soap.acknowledgeFlag("doctor-a", transcription.id, flag.id);
    }
    const current = soap.get("doctor-a", transcription.id);
    const blocking = current.reviewFlags.filter((flag) => flag.blocking && !flag.resolved);
    assert.deepEqual(blocking.map((f) => f.message), [], "a really generated note should have nothing blocking after review");

    const approved = soap.approve("doctor-a", transcription.id, { revision: current.revision, confirmReviewed: true });
    assert.equal(approved.status, "approved");

    const { toPdf, toText } = await import("../services/soap/export.js");
    const pdf = toPdf(approved, store.get("doctor-a", transcription.id));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 1500);
    const text = toText(approved, store.get("doctor-a", transcription.id));
    assert.ok(text.includes("Reviewed by the clinician."));
    assert.ok(text.includes("S — Subjective") && text.includes("P — Plan"));
    console.log(`  approved note exported: ${pdf.length} byte PDF, ${text.length} character text file`);
  });
});
