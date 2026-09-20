// Speaker analysis logic (independent segmentation + clustering + doctor identification + word relabelling) with SCRIPTED voices:
// a fake segmentation (turn boundaries) and a fake embedder that returns a fixed vector per "person". These verify the LOGIC,
// deterministically. They are not evidence that real voices are recognised: see real-voice.test.js for that.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { loadConfig } from "../config.js";
import { normalizeDeepgramResponse } from "../services/deepgram.js";
import { analyzeSpeakers, regionsFromIntervals, speakerRegionsFromWords } from "../services/voice/analysis.js";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

// people: D = the enrolled doctor, others are different voices; "twin" is nearly identical to the doctor
const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
const axis = (i, extra = {}) => unit(Array.from({ length: 16 }, (_, d) => (d === i ? 1 : 0) + (extra[d] ?? 0)));
const VOICES = { D: axis(0), P: axis(1), N: axis(2), X: axis(3), twin: axis(0, { 5: 0.25 }), between: axis(0, { 1: 0.55 }) };
const PROFILE = [VOICES.D, unit(VOICES.D.map((x, i) => x + 0.01 * Math.sin(i)))];

/** turns: [{ who, at (seconds), seconds }]; dg: (turnIndex) => Deepgram speaker number | null. */
function scenario(turns, dg) {
  const words = [];
  turns.forEach((t, ti) => {
    const n = Math.max(1, Math.floor(t.seconds / 0.5));
    for (let i = 0; i < n; i++) {
      const start = t.at + i * (t.seconds / n);
      words.push({ word: `w${ti}x${i}`, punctuated_word: `w${ti}x${i}${i === n - 1 ? "." : ""}`, start, end: start + (t.seconds / n) * 0.8, confidence: 0.99, speaker: dg(ti), speaker_confidence: 0.95 });
    }
  });
  const response = {
    metadata: { request_id: "r", duration: 1, model_info: { m: { name: "m", version: "1" } }, diarize_info: { arch: "v2", model_uuid: "u" } },
    results: { channels: [{ alternatives: [{ transcript: "x", words }] }], utterances: [] },
  };
  return { normalized: normalizeDeepgramResponse(response), turns, words };
}

async function run(sc, { references = PROFILE, voiceOf, embedderOverrides = {}, segments } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "va-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const intervals = segments ?? sc.turns.map((t) => ({ speaker: 0, start: t.at, end: t.at + t.seconds }));
  const script = path.join(dir, "fake-seg");
  await writeFile(script, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ engine: "fake", segments: intervals })}'\n`);
  await chmod(script, 0o755);
  const config = { ...loadConfig({}), diarizationEnabled: true, diarizationPython: script, diarizationScript: script, diarizationTimeoutMs: 10_000 };
  const whoAt = voiceOf ?? ((ms) => sc.turns.find((t) => ms >= t.at * 1000 - 1 && ms <= (t.at + t.seconds) * 1000 + 1)?.who ?? "P");
  const embedder = {
    available: async () => true,
    embedRegions: async (_wav, regions) => regions.map((r) => VOICES[whoAt((r.startMs + r.endMs) / 2)]),
    ...embedderOverrides,
  };
  return analyzeSpeakers({ normalized: sc.normalized, wavPath: "/unused.wav", references, config, embedder });
}
const wordsOf = (n) => n.groups.flat().map((w) => [w.text, w.start, w.end]);
const statusOf = (result, index) => result.identification.get(index)?.status;
const DPDPDP = [{ who: "D", at: 0, seconds: 6 }, { who: "P", at: 7, seconds: 6 }, { who: "D", at: 14, seconds: 6 }, { who: "P", at: 21, seconds: 6 }, { who: "D", at: 28, seconds: 6 }, { who: "P", at: 35, seconds: 6 }];

describe("Deepgram found both speakers", () => {
  test("Doctor -> Patient -> Doctor ...: the doctor is matched, the patient is a reliable non-match, and no role is assigned", async () => {
    const r = await run(scenario(DPDPDP, (i) => i % 2));
    assert.equal(r.source, "deepgram", "Deepgram's speaker labels are kept");
    assert.equal(r.voiceStatus, "completed");
    assert.equal(statusOf(r, 0), "matched");
    assert.equal(r.identification.get(0).suggestedRole, "doctor");
    assert.equal(statusOf(r, 1), "unknown");
    assert.equal(r.identification.get(1).suggestedRole, null, "a non-matching voice is never assumed to be the patient");
    assert.ok(!("role" in r.identification.get(0)), "the analysis suggests; only the doctor confirms a role");
  });

  test("the returning-speaker pattern is preserved (A-B-A)", async () => {
    const r = await run(scenario(DPDPDP, (i) => i % 2));
    assert.deepEqual(r.normalized.segments.map((s) => s.providerSpeaker), [0, 1, 0, 1, 0, 1]);
  });

  test("the doctor is not matched by Deepgram's numbering: the doctor may be speaker 1", async () => {
    const r = await run(scenario(DPDPDP, (i) => (i % 2 === 0 ? 1 : 0)));
    assert.equal(statusOf(r, 1), "matched");
    assert.equal(statusOf(r, 0), "unknown");
  });

  test("doctor absent: nobody is matched", async () => {
    const turns = DPDPDP.map((t) => ({ ...t, who: t.who === "D" ? "N" : "P" }));
    const r = await run(scenario(turns, (i) => i % 2));
    assert.deepEqual([statusOf(r, 0), statusOf(r, 1)], ["unknown", "unknown"]);
  });

  test("near-identical voices both reach the match line, so BOTH stay uncertain (never a guessed doctor)", async () => {
    const turns = DPDPDP.map((t) => ({ ...t, who: t.who === "D" ? "D" : "twin" }));
    const r = await run(scenario(turns, (i) => i % 2));
    assert.deepEqual([statusOf(r, 0), statusOf(r, 1)], ["uncertain", "uncertain"]);
    assert.equal(r.identification.get(0).reason, "MULTIPLE_CLOSE_MATCHES");
    assert.equal(r.identification.get(0).suggestedRole, null);
  });

  test("a borderline score is uncertain, not a match", async () => {
    const turns = DPDPDP.map((t) => ({ ...t, who: t.who === "D" ? "between" : "P" }));
    const r = await run(scenario(turns, (i) => i % 2));
    assert.equal(statusOf(r, 0), "uncertain");
  });

  test("a speaker with too little speech cannot be matched or rejected", async () => {
    const turns = [{ who: "D", at: 0, seconds: 1.6 }, ...DPDPDP.filter((t) => t.who === "P").map((t, i) => ({ ...t, at: 5 + i * 8 })), ];
    const r = await run(scenario(turns, (i) => (i === 0 ? 0 : 1)));
    assert.equal(statusOf(r, 0), "uncertain");
    assert.match(r.identification.get(0).reason, /INSUFFICIENT|NO_USABLE/);
  });

  test("no profile: nothing is identified, and Deepgram's labels are left alone", async () => {
    const r = await run(scenario(DPDPDP, (i) => i % 2), { references: null });
    assert.equal(r.voiceStatus, "not_enrolled");
    assert.equal(r.identification.size, 0);
    assert.equal(r.source, "deepgram");
  });

  test("a different doctor's profile never matches (profiles are per account)", async () => {
    const other = [axis(9)];
    const r = await run(scenario(DPDPDP, (i) => i % 2), { references: other });
    assert.deepEqual([statusOf(r, 0), statusOf(r, 1)], ["unknown", "unknown"]);
  });
});

describe("Deepgram merged voices into ONE speaker", () => {
  test("independent evidence separates them: two speakers, the doctor matched, every word and timestamp untouched", async () => {
    const sc = scenario(DPDPDP, () => 0);
    const before = wordsOf(sc.normalized);
    const r = await run(sc);
    assert.equal(r.source, "independent");
    assert.equal(r.normalized.speakerIndices.length, 2);
    assert.deepEqual(r.normalized.segments.map((s) => s.providerSpeaker), [0, 1, 0, 1, 0, 1]);
    assert.deepEqual(wordsOf(r.normalized), before, "no word dropped, duplicated, reordered or re-timed");
    assert.ok(r.warnings.some((w) => w.code === "SPEAKERS_FROM_VOICE_ANALYSIS"), "the doctor is told");
    assert.equal(statusOf(r, 0), "matched");
    assert.equal(statusOf(r, 1), "unknown");
  });

  test("without a profile the split is still made, but nobody is identified", async () => {
    const r = await run(scenario(DPDPDP, () => 0), { references: null });
    assert.equal(r.source, "independent");
    assert.equal(r.normalized.speakerIndices.length, 2);
    assert.equal(r.voiceStatus, "not_enrolled");
    assert.equal(r.identification.size, 0);
  });

  test("three speakers (doctor, patient, nurse): all separated, only the doctor matched, the others stay unknown and distinct", async () => {
    const turns = [];
    ["D", "P", "N", "D", "P", "N", "D", "P", "N"].forEach((who, i) => turns.push({ who, at: i * 7, seconds: 6 }));
    const r = await run(scenario(turns, () => 0));
    assert.equal(r.normalized.speakerIndices.length, 3);
    assert.deepEqual(r.normalized.segments.map((s) => s.providerSpeaker), [0, 1, 2, 0, 1, 2, 0, 1, 2]);
    assert.deepEqual([0, 1, 2].map((i) => statusOf(r, i)), ["matched", "unknown", "unknown"]);
    assert.ok([0, 1, 2].every((i) => i === 0 || r.identification.get(i).suggestedRole === null), "nobody is assumed to be the patient or a nurse");
  });

  test("a genuine one-speaker recording stays one speaker (no fabricated split)", async () => {
    const turns = [0, 1, 2, 3, 4].map((i) => ({ who: "D", at: i * 7, seconds: 6 }));
    const r = await run(scenario(turns, () => 0));
    assert.equal(r.source, "deepgram");
    assert.equal(r.normalized.speakerIndices.length, 1);
    assert.ok(!r.warnings.some((w) => w.code === "SPEAKERS_FROM_VOICE_ANALYSIS"));
    assert.equal(statusOf(r, 0), "matched");
  });

  test("a single-speaker recording of someone else is not labelled as the doctor", async () => {
    const turns = [0, 1, 2, 3, 4].map((i) => ({ who: "P", at: i * 7, seconds: 6 }));
    const r = await run(scenario(turns, () => 0));
    assert.equal(statusOf(r, 0), "unknown");
  });

  test("the doctor returns after a very long gap and is still the same speaker", async () => {
    const turns = [{ who: "D", at: 0, seconds: 6 }, { who: "P", at: 7, seconds: 6 }, { who: "D", at: 14, seconds: 6 }, { who: "P", at: 21, seconds: 6 },
      { who: "D", at: 3600, seconds: 6 }, { who: "P", at: 3607, seconds: 6 }, { who: "D", at: 3614, seconds: 6 }];
    const r = await run(scenario(turns, () => 0));
    assert.deepEqual(r.normalized.segments.map((s) => s.providerSpeaker), [0, 1, 0, 1, 0, 1, 0]);
    assert.equal(r.normalized.segments.at(-1).startMs, 3_614_000, "timestamps are the recording's own, not reset");
    assert.equal(statusOf(r, 0), "matched");
  });

  test("overlapping speech: every word is kept and gets one speaker", async () => {
    const turns = [{ who: "D", at: 0, seconds: 6 }, { who: "P", at: 4, seconds: 6 }, { who: "D", at: 11, seconds: 6 }, { who: "P", at: 18, seconds: 6 }, { who: "D", at: 25, seconds: 6 }];
    const sc = scenario(turns, () => 0);
    const before = wordsOf(sc.normalized);
    const r = await run(sc);
    assert.deepEqual(wordsOf(r.normalized), before);
    assert.ok(r.normalized.groups.flat().every((w) => w.speaker === null || Number.isInteger(w.speaker)));
  });

  test("a region too short to embed leaves its words unassigned rather than guessed", async () => {
    const sc = scenario(DPDPDP, () => 0);
    const r = await run(sc, { segments: [...DPDPDP.map((t) => ({ speaker: 0, start: t.at, end: t.at + t.seconds })), { speaker: 1, start: 50, end: 50.4 }] });
    assert.equal(r.normalized.speakerIndices.length, 2);
  });
});

describe("failure and unavailability (never fabricated)", () => {
  test("if the embedding model fails, Deepgram's labels are kept and the doctor is told nothing was identified", async () => {
    const sc = scenario(DPDPDP, (i) => i % 2);
    const r = await run(sc, { embedderOverrides: { embedRegions: async () => { throw new Error("model exploded"); } } });
    assert.equal(r.voiceStatus, "unavailable");
    assert.ok(r.warnings.some((w) => w.code === "VOICE_IDENTIFICATION_FAILED"));
    assert.equal(r.identification.size, 0);
    assert.deepEqual(r.normalized.segments.map((s) => s.providerSpeaker), [0, 1, 0, 1, 0, 1]);
    assert.ok(!JSON.stringify(r.warnings).includes("exploded"), "no internal error text");
  });

  test("an unavailable model with an enrolled doctor is reported as unavailable", async () => {
    const r = await run(scenario(DPDPDP, (i) => i % 2), { embedderOverrides: { available: async () => false } });
    assert.equal(r.voiceStatus, "unavailable");
    assert.equal(r.identification.size, 0);
  });

  test("failed independent segmentation falls back to Deepgram's labels without inventing speakers", async () => {
    const sc = scenario(DPDPDP, () => 0);
    const r = await run(sc, { segments: [] });
    assert.equal(r.source, "deepgram");
    assert.equal(r.normalized.speakerIndices.length, 1);
  });

  test("scores and evidence are internal: they are numbers about evidence, never a claim of identity", async () => {
    const r = await run(scenario(DPDPDP, (i) => i % 2));
    const d = r.identification.get(0);
    assert.equal(typeof d.score, "number");
    assert.ok(d.regions >= 3 && d.speechSeconds >= 6);
  });
});

describe("regions", () => {
  test("turns cut at the segmentation model's 10 s window edges are re-joined", () => {
    const regions = regionsFromIntervals([{ startMs: 8000, endMs: 10000 }, { startMs: 10000, endMs: 11500 }, { startMs: 13000, endMs: 14000 }]);
    assert.deepEqual(regions, [{ startMs: 8000, endMs: 11500 }, { startMs: 13000, endMs: 14000 }]);
  });
  test("a real pause or speaker change is never joined", () => {
    assert.equal(regionsFromIntervals([{ startMs: 1000, endMs: 3000 }, { startMs: 3050, endMs: 5000 }]).length, 2);
  });
  test("very long regions are cut into bounded pieces", () => {
    const regions = regionsFromIntervals([{ startMs: 0, endMs: 70_000 }]);
    assert.ok(regions.every((r) => r.endMs - r.startMs <= 20_000));
    assert.equal(regions.at(-1).endMs, 70_000);
  });
  test("a speaker's words become regions, split at long pauses", () => {
    const words = [{ speaker: 0, valid: true, start: 0, end: 1 }, { speaker: 0, valid: true, start: 1.2, end: 2 }, { speaker: 0, valid: true, start: 5, end: 6 }, { speaker: 1, valid: true, start: 6.2, end: 7 }];
    const by = speakerRegionsFromWords(words);
    assert.deepEqual(by.get(0), [{ speaker: 0, startMs: 0, endMs: 2000 }, { speaker: 0, startMs: 5000, endMs: 6000 }]);
    assert.equal(by.get(1).length, 1);
  });
});
