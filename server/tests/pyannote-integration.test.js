// pyannote Community-1 inside the speaker analysis and the real job pipeline (HTTP, auth, database, FFmpeg). Deepgram is a stub, pyannote
// and the voice model are SCRIPTED (they return what the test decides), so these verify how results are combined, aligned, stored and
// protected. They are NOT evidence that the models work: tests/real-pyannote.test.js runs the real ones.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { loadConfig } from "../config.js";
import { normalizeDeepgramResponse } from "../services/deepgram.js";
import { analyzeSpeakers } from "../services/voice/analysis.js";
import { CONSENT_VERSION } from "../services/voice/calibration.js";
import { json, startDeepgramStub } from "./deepgram-stub.js";
import { fixtureSynthetic, makeAuth, makeConfig, readFixture, startServer, TEST_SUPABASE_URL } from "./helpers.js";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
const axis = (i) => unit(Array.from({ length: 16 }, (_, d) => (d === i ? 1 : 0)));
const VOICES = { D: axis(0), P: axis(1), N: axis(2) };
const PROFILE = [VOICES.D, unit(VOICES.D.map((x, i) => x + 0.01 * Math.sin(i)))];

/** turns: [{ who, at, seconds }] (seconds). Words every ~0.5 s. dg(turnIndex) is what Deepgram claims for that turn. */
function conversation(turns, dg) {
  const words = [];
  turns.forEach((t, ti) => {
    const n = Math.max(1, Math.floor(t.seconds / 0.5));
    for (let i = 0; i < n; i++) {
      const start = t.at + i * (t.seconds / n);
      words.push({ word: `w${ti}x${i}`, punctuated_word: `w${ti}x${i}${i === n - 1 ? "." : ""}`, start, end: start + (t.seconds / n) * 0.8, confidence: 0.99, speaker: dg(ti), speaker_confidence: 0.95 });
    }
  });
  const response = {
    metadata: { request_id: "r", duration: 60, model_info: { m: { name: "medical-nova-3", version: "1" } }, diarize_info: { arch: "v2", model_uuid: "u" } },
    results: { channels: [{ alternatives: [{ transcript: "x", words }] }], utterances: [] },
  };
  return { turns, response, normalized: normalizeDeepgramResponse(response) };
}
const TURNS = ["D", "P", "D", "P", "D", "P"].map((who, i) => ({ who, at: i * 7, seconds: 6 }));
const LABEL = { D: "SPEAKER_00", P: "SPEAKER_01", N: "SPEAKER_02" };

/** A scripted pyannote: one exclusive interval per turn (and optional extras); `fail` makes it error. */
function fakePyannote({ turns = TURNS, label = LABEL, exclusive, regular, fail = null, available = true, calls = [] } = {}) {
  const base = turns.map((t) => ({ startMs: Math.round(t.at * 1000), endMs: Math.round((t.at + t.seconds) * 1000), speaker: label[t.who] }));
  const ex = exclusive ?? base;
  return {
    calls,
    available: async () => available,
    diarize: async (wav, options) => {
      calls.push({ wav, options });
      if (fail) { const e = new Error(fail); e.code = fail; throw e; }
      const speakers = [...new Set(ex.map((r) => r.speaker))].sort();
      return { provider: "pyannote-community-1", model: "pyannote/speaker-diarization-community-1", speakers, regular: regular ?? ex, exclusive: ex, audioDurationMs: 60_000, loadTimeMs: 1, inferenceTimeMs: 2, processingTimeMs: 3, device: "cpu", versions: { "pyannote.audio": "test" } };
    },
  };
}

function scriptedEmbedder(turns = TURNS, { available = true, seen = [] } = {}) {
  const whoAt = (ms) => turns.find((t) => ms >= t.at * 1000 - 1 && ms <= (t.at + t.seconds) * 1000 + 1)?.who ?? "P";
  return {
    available: async () => available,
    modelVersion: async () => "fake-model@1",
    quality: async (paths) => paths.map(() => ({ durationMs: 12000, voicedMs: 9000, clipRatio: 0, peak: 0.6, windowMinSimilarity: 0.8, windows: 3, embedding: VOICES.D })),
    embedRegions: async (_wav, regions) => { seen.push(...regions); return regions.map((r) => VOICES[whoAt((r.startMs + r.endMs) / 2)]); },
  };
}

const CONFIG = { ...loadConfig({}), pyannoteEnabled: true, pyannotePolicy: "always", diarizationEnabled: false };
const analyze = (conv, { pyannote, references = PROFILE, embedder = scriptedEmbedder(conv.turns), config = CONFIG } = {}) =>
  analyzeSpeakers({ normalized: conv.normalized, wavPath: "/unused.wav", references, config, embedder, pyannote });
const words = (n) => n.groups.flat().map((w) => [w.text, w.start, w.end]);
const truthOf = (conv, ms) => conv.turns.find((t) => ms >= t.at * 1000 && ms <= (t.at + t.seconds) * 1000)?.who;
/** fraction of words whose speaker id maps consistently onto the true speaker */
function attribution(conv, normalized) {
  const votes = new Map();
  for (const w of normalized.groups.flat()) {
    const who = truthOf(conv, ((w.start + w.end) / 2) * 1000);
    if (w.speaker === null) continue;
    const key = `${who}:${w.speaker}`;
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  const total = normalized.groups.flat().length;
  const best = new Map();
  for (const [key, n] of votes) { const [who] = key.split(":"); best.set(who, Math.max(best.get(who) ?? 0, n)); }
  return [...best.values()].reduce((a, b) => a + b, 0) / total;
}

describe("pyannote decides who spoke when; Deepgram's words are kept exactly", () => {
  test("Deepgram merged two speakers into one, pyannote separates them: two speakers, every word and time unchanged", async () => {
    const conv = conversation(TURNS, () => 0);
    const r = await analyze(conv, { pyannote: fakePyannote() });
    assert.equal(r.source, "pyannote");
    assert.deepEqual(r.normalized.speakerIndices, [0, 1]);
    assert.deepEqual(words(r.normalized), words(conv.normalized), "no word lost, duplicated, reordered or re-timed");
    assert.deepEqual(r.normalized.segments.map((s) => s.providerSpeaker), [0, 1, 0, 1, 0, 1], "the returning speaker keeps their id");
    assert.equal(attribution(conv, r.normalized), 1);
    assert.ok(r.warnings.some((w) => w.code === "SPEAKERS_FROM_PYANNOTE"));
    assert.equal(r.normalized.diarizationStatus, "completed");
  });

  test("segments are split at the pyannote speaker changes, not at Deepgram's utterance boundaries", async () => {
    const conv = conversation(TURNS, () => 0); // one Deepgram speaker: one long run of words
    const r = await analyze(conv, { pyannote: fakePyannote() });
    assert.equal(r.normalized.segments.length, 6);
    assert.deepEqual(r.normalized.segments.map((s) => s.text.split(" ").length), [12, 12, 12, 12, 12, 12]);
  });

  test("Deepgram was right about two speakers: no warning, and the same attribution", async () => {
    const conv = conversation(TURNS, (i) => i % 2);
    const r = await analyze(conv, { pyannote: fakePyannote() });
    assert.equal(r.source, "pyannote");
    assert.ok(!r.warnings.some((w) => w.code === "SPEAKERS_FROM_PYANNOTE"));
    assert.equal(attribution(conv, r.normalized), 1);
  });

  test("Deepgram mislabelled a turn: pyannote's speaker turns correct it", async () => {
    const conv = conversation(TURNS, (i) => (i === 3 ? 0 : i % 2)); // turn 3 (patient) wrongly given to the doctor's speaker
    assert.ok(attribution(conv, conv.normalized) < 1);
    const r = await analyze(conv, { pyannote: fakePyannote() });
    assert.equal(attribution(conv, r.normalized), 1);
  });

  test("speaker ids are numbered by first appearance in the recording, not by the model's label numbers", async () => {
    const conv = conversation(TURNS, () => 0);
    const r = await analyze(conv, { pyannote: fakePyannote({ label: { D: "SPEAKER_07", P: "SPEAKER_02", N: "SPEAKER_04" } }) });
    assert.deepEqual(r.normalized.segments.map((s) => s.providerSpeaker), [0, 1, 0, 1, 0, 1]);
    assert.equal(r.internal.pyannote.labelToSpeaker.SPEAKER_07, 0);
  });

  test("a genuine one-speaker recording stays one speaker", async () => {
    const solo = conversation([{ who: "D", at: 0, seconds: 20 }], () => 0);
    const r = await analyze(solo, { pyannote: fakePyannote({ turns: solo.turns }) });
    assert.deepEqual(r.normalized.speakerIndices, [0]);
    assert.ok(!r.warnings.some((w) => w.code === "SPEAKERS_FROM_PYANNOTE"));
  });

  test("three speakers stay three", async () => {
    const turns = ["D", "P", "N", "D", "P", "N"].map((who, i) => ({ who, at: i * 7, seconds: 6 }));
    const conv = conversation(turns, () => 0);
    const r = await analyze(conv, { pyannote: fakePyannote({ turns }) });
    assert.deepEqual(r.normalized.speakerIndices, [0, 1, 2]);
    assert.equal(attribution(conv, r.normalized), 1);
  });

  test("Deepgram's raw speaker labels are kept for diagnostics (internal only)", async () => {
    const conv = conversation(TURNS, (i) => i % 2);
    const r = await analyze(conv, { pyannote: fakePyannote() });
    assert.equal(r.internal.deepgramSpeakers, 2);
    assert.equal(r.internal.deepgramRuns.length, 6);
    assert.deepEqual(r.internal.deepgramRuns.map((x) => x.speaker), [0, 1, 0, 1, 0, 1]);
  });
});

describe("what happens when a word has no clear speaker", () => {
  test("a word with no speaker turn is kept, unassigned, and its segment is flagged", async () => {
    const conv = conversation(TURNS, () => 0);
    const gap = fakePyannote({ exclusive: [{ startMs: 0, endMs: 6000, speaker: "SPEAKER_00" }, { startMs: 7000, endMs: 13000, speaker: "SPEAKER_01" }, { startMs: 28000, endMs: 34000, speaker: "SPEAKER_00" }] });
    const r = await analyze(conv, { pyannote: gap });
    assert.deepEqual(words(r.normalized), words(conv.normalized));
    const unassigned = r.normalized.segments.filter((s) => s.providerSpeaker === null);
    assert.ok(unassigned.length > 0);
    assert.ok(unassigned.every((s) => s.needsReview === true));
    assert.equal(r.normalized.diarizationStatus, "partial");
  });

  test("simultaneous speech is flagged for review", async () => {
    const conv = conversation(TURNS, () => 0);
    const regular = [...fakePyannote().calls, { startMs: 0, endMs: 6000, speaker: "SPEAKER_00" }, { startMs: 2000, endMs: 5000, speaker: "SPEAKER_01" }, { startMs: 7000, endMs: 13000, speaker: "SPEAKER_01" }, { startMs: 14000, endMs: 20000, speaker: "SPEAKER_00" }, { startMs: 21000, endMs: 27000, speaker: "SPEAKER_01" }, { startMs: 28000, endMs: 34000, speaker: "SPEAKER_00" }, { startMs: 35000, endMs: 41000, speaker: "SPEAKER_01" }];
    const r = await analyze(conv, { pyannote: fakePyannote({ regular }) });
    assert.equal(r.normalized.segments[0].needsReview, true, "the first turn contains overlapping speech");
    assert.equal(r.normalized.segments[1].needsReview, false);
    assert.deepEqual(words(r.normalized), words(conv.normalized));
  });
});

describe("doctor matching on pyannote's speakers", () => {
  test("the enrolled doctor's speaker is matched (a suggestion), the other stays unknown, and no role is assumed", async () => {
    const conv = conversation(TURNS, () => 0);
    const r = await analyze(conv, { pyannote: fakePyannote() });
    assert.equal(r.identification.get(0).status, "matched");
    assert.equal(r.identification.get(0).suggestedRole, "doctor");
    assert.equal(r.identification.get(1).status, "unknown");
    assert.equal(r.identification.get(1).suggestedRole, null, "not the doctor is not 'the patient'");
    assert.equal(r.voiceStatus, "completed");
  });

  test("the doctor may be the second speaker to appear", async () => {
    const turns = ["P", "D", "P", "D", "P", "D"].map((who, i) => ({ who, at: i * 7, seconds: 6 }));
    const conv = conversation(turns, () => 0);
    const r = await analyze(conv, { pyannote: fakePyannote({ turns }), embedder: scriptedEmbedder(turns) });
    assert.equal(r.identification.get(1).status, "matched");
    assert.equal(r.identification.get(0).status, "unknown");
  });

  test("the doctor is absent: nobody is matched", async () => {
    const turns = ["P", "N", "P", "N", "P", "N"].map((who, i) => ({ who, at: i * 7, seconds: 6 }));
    const conv = conversation(turns, () => 0);
    const r = await analyze(conv, { pyannote: fakePyannote({ turns }), embedder: scriptedEmbedder(turns) });
    assert.ok([...r.identification.values()].every((v) => v.status !== "matched" && v.suggestedRole === null));
  });

  test("with three speakers only the doctor is matched; the others are never labelled patient or nurse", async () => {
    const turns = ["D", "P", "N", "D", "P", "N"].map((who, i) => ({ who, at: i * 7, seconds: 6 }));
    const conv = conversation(turns, () => 0);
    const r = await analyze(conv, { pyannote: fakePyannote({ turns }), embedder: scriptedEmbedder(turns) });
    assert.deepEqual([0, 1, 2].map((s) => r.identification.get(s).status), ["matched", "unknown", "unknown"]);
    assert.ok([1, 2].every((s) => r.identification.get(s).suggestedRole === null));
  });

  test("speech that overlaps another speaker is not used to identify anyone", async () => {
    const conv = conversation(TURNS, () => 0);
    const seen = [];
    const regular = [{ startMs: 0, endMs: 6000, speaker: "SPEAKER_00" }, { startMs: 2000, endMs: 4000, speaker: "SPEAKER_01" }, { startMs: 7000, endMs: 13000, speaker: "SPEAKER_01" }, { startMs: 14000, endMs: 20000, speaker: "SPEAKER_00" }, { startMs: 21000, endMs: 27000, speaker: "SPEAKER_01" }, { startMs: 28000, endMs: 34000, speaker: "SPEAKER_00" }, { startMs: 35000, endMs: 41000, speaker: "SPEAKER_01" }];
    await analyze(conv, { pyannote: fakePyannote({ regular }), embedder: scriptedEmbedder(conv.turns, { seen }) });
    // no embedded region may cover the overlapped span 2.0 to 4.0 s (words inside it were excluded; a region spanning it would contain them)
    assert.ok(seen.every((region) => !(region.startMs < 2000 && region.endMs > 4000)), JSON.stringify(seen.slice(0, 4)));
  });

  test("without an enrolled doctor the speakers are still separated, and identification is simply not run", async () => {
    const conv = conversation(TURNS, () => 0);
    const r = await analyze(conv, { pyannote: fakePyannote(), references: null });
    assert.equal(r.source, "pyannote");
    assert.equal(r.voiceStatus, "not_enrolled");
    assert.equal(r.identification.size, 0);
  });

  test("pyannote works without the voice model installed (no identification, no embedder needed)", async () => {
    const conv = conversation(TURNS, () => 0);
    const r = await analyze(conv, { pyannote: fakePyannote(), references: null, embedder: scriptedEmbedder(TURNS, { available: false }) });
    assert.equal(r.source, "pyannote");
    assert.deepEqual(r.normalized.speakerIndices, [0, 1]);
  });
});

describe("failures and policy", () => {
  test("if pyannote fails, Deepgram's labels are kept, clearly marked as the fallback, and nothing is lost", async () => {
    const conv = conversation(TURNS, (i) => i % 2);
    const r = await analyze(conv, { pyannote: fakePyannote({ fail: "PYANNOTE_TIMEOUT" }), embedder: scriptedEmbedder(TURNS, { available: false }), references: null });
    assert.equal(r.source, "deepgram");
    assert.ok(r.warnings.some((w) => w.code === "PYANNOTE_FAILED"));
    assert.equal(r.internal.pyannote.failed, "PYANNOTE_TIMEOUT");
    assert.deepEqual(words(r.normalized), words(conv.normalized));
    assert.deepEqual(r.normalized.segments.map((s) => s.providerSpeaker), [0, 1, 0, 1, 0, 1]);
  });

  test("a failed pyannote never labels the whole recording as one speaker", async () => {
    const conv = conversation(TURNS, () => 0);
    const r = await analyze(conv, { pyannote: fakePyannote({ fail: "MODEL_ACCESS_DENIED" }), embedder: scriptedEmbedder(TURNS, { available: false }), references: null });
    assert.equal(r.source, "deepgram");
    assert.deepEqual(r.normalized.speakerIndices, [0], "still exactly what Deepgram said, with a warning");
    assert.ok(r.warnings.some((w) => w.code === "PYANNOTE_FAILED"));
  });

  test("when pyannote fails and the voice model can still help, the older independent check is the fallback", async () => {
    const conv = conversation(TURNS, () => 0);
    const cfg = { ...CONFIG, diarizationEnabled: false }; // no sherpa here: the fallback is attempted and reported, not silently skipped
    const r = await analyze(conv, { pyannote: fakePyannote({ fail: "PYANNOTE_CRASHED" }), config: cfg });
    assert.ok(r.warnings.some((w) => w.code === "PYANNOTE_FAILED"));
    assert.ok(r.warnings.some((w) => w.code === "VOICE_ANALYSIS_FAILED"), "the second fallback could not run either, and says so");
  });

  test("policy 'when-merged' does not run pyannote when Deepgram already found two speakers, and does when it found one", async () => {
    const cfg = { ...CONFIG, pyannotePolicy: "when-merged" };
    const calls = [];
    const two = conversation(TURNS, (i) => i % 2);
    const kept = await analyze(two, { pyannote: fakePyannote({ calls }), config: cfg });
    assert.equal(calls.length, 0);
    assert.equal(kept.source, "deepgram");
    const one = conversation(TURNS, () => 0);
    const used = await analyze(one, { pyannote: fakePyannote({ calls }), config: cfg });
    assert.equal(calls.length, 1);
    assert.equal(used.source, "pyannote");
  });

  test("policy 'more-speakers': pyannote's labels replace Deepgram's only when pyannote heard MORE speakers", async () => {
    const cfg = { ...CONFIG, pyannotePolicy: "more-speakers" };
    // Deepgram merged two voices, pyannote separates them: adopted
    const merged = await analyze(conversation(TURNS, () => 0), { pyannote: fakePyannote(), config: cfg });
    assert.equal(merged.source, "pyannote");
    assert.deepEqual(merged.normalized.speakerIndices, [0, 1]);
    assert.equal(merged.internal.pyannote.used, true);
    assert.ok(merged.warnings.some((w) => w.code === "SPEAKERS_FROM_PYANNOTE"));
    // Deepgram found two (correctly), pyannote merged them into one: Deepgram's split is kept, pyannote's turns are only diagnostics
    const twoTurns = TURNS.map((t) => ({ ...t, who: "D" }));
    const kept = await analyze(conversation(TURNS, (i) => i % 2), { pyannote: fakePyannote({ turns: twoTurns }), config: cfg });
    assert.equal(kept.source, "deepgram");
    assert.deepEqual(kept.normalized.speakerIndices, [0, 1]);
    assert.equal(kept.internal.pyannote.used, false);
    assert.ok(!kept.warnings.some((w) => w.code === "SPEAKERS_FROM_PYANNOTE"));
    // both found two: Deepgram's labels stand
    const same = await analyze(conversation(TURNS, (i) => i % 2), { pyannote: fakePyannote(), config: cfg });
    assert.equal(same.source, "deepgram");
    // pyannote heard three where Deepgram found two: adopted (and flagged for review)
    const threeTurns = ["D", "P", "N", "D", "P", "N"].map((who, i) => ({ who, at: i * 7, seconds: 6 }));
    const more = await analyze(conversation(threeTurns, (i) => i % 2), { pyannote: fakePyannote({ turns: threeTurns }), embedder: scriptedEmbedder(threeTurns), config: cfg });
    assert.equal(more.source, "pyannote");
    assert.deepEqual(more.normalized.speakerIndices, [0, 1, 2]);
  });

  test("an unavailable pyannote (not installed) is skipped silently and the previous behaviour is unchanged", async () => {
    const conv = conversation(TURNS, (i) => i % 2);
    const calls = [];
    const r = await analyze(conv, { pyannote: fakePyannote({ available: false, calls }) });
    assert.equal(calls.length, 0);
    assert.equal(r.source, "deepgram");
    assert.ok(!r.warnings.some((w) => w.code === "PYANNOTE_FAILED"));
  });

  test("no pyannote object at all: exactly the old behaviour", async () => {
    const conv = conversation(TURNS, (i) => i % 2);
    const r = await analyze(conv, {});
    assert.equal(r.source, "deepgram");
    assert.equal(r.identification.get(0).status, "matched");
  });

  test("a client that disconnects cancels the analysis instead of being swallowed as a failure", async () => {
    const conv = conversation(TURNS, () => 0);
    const cancelling = { available: async () => true, diarize: async () => { const e = new Error("cancelled"); e.status = 499; e.code = "REQUEST_CANCELLED"; throw e; } };
    await assert.rejects(analyze(conv, { pyannote: cancelling }), (e) => e.status === 499);
  });

  test("the audio path and length are handed to pyannote (the length scales its timeout)", async () => {
    const calls = [];
    await analyze(conversation(TURNS, () => 0), { pyannote: fakePyannote({ calls }) });
    assert.equal(calls[0].wav, "/unused.wav");
    assert.ok(calls[0].options.durationSeconds > 40);
  });
});

// ---- through the real job pipeline ------------------------------------------------------------------------------------------------
const KEY = "dg-test-key-NOT-A-REAL-KEY-12345";
async function setup({ dg = () => 0, pyannote = fakePyannote(), embedder = scriptedEmbedder() } = {}) {
  const stub = await startDeepgramStub(json(200, conversation(TURNS, dg).response));
  cleanups.push(stub.close);
  const env = await makeConfig({
    supabaseUrl: TEST_SUPABASE_URL, sttEngine: "deepgram", deepgramApiKey: KEY, deepgramBaseUrl: stub.url,
    voiceEnabled: true, voiceProfileKey: randomBytes(32).toString("base64"), pyannoteEnabled: true, diarizationEnabled: false,
  });
  cleanups.push(env.cleanup);
  const keys = await makeAuth();
  const server = await startServer(env.config, { jwks: keys.jwks, embedder, pyannote });
  cleanups.push(server.close);
  const audio = await readFixture(fixtureSynthetic("single-speaker.wav"));
  const call = async (token, method, url, body) => {
    const res = await fetch(`${server.baseUrl}${url}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  const enroll = async (token) => {
    const form = new FormData();
    for (let i = 0; i < 3; i++) form.append("samples", new Blob([audio], { type: "audio/wav" }), `s${i}.wav`);
    form.append("consent", "true");
    form.append("consentVersion", CONSENT_VERSION);
    const res = await fetch(`${server.baseUrl}/api/me/voice-profile/enroll`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    assert.equal(res.status, 201, await res.clone().text());
  };
  const transcribe = async (token) => {
    const form = new FormData();
    form.append("audio", new Blob([audio], { type: "audio/wav" }), "visit.wav");
    const res = await fetch(`${server.baseUrl}/api/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, text: await res.clone().text(), body: await res.json() };
  };
  return { ...env, ...server, stub, keys, call, enroll, transcribe, tokenFor: (s) => keys.sign(s), store: server.app.locals.store };
}

describe("pyannote through the job pipeline", () => {
  test("a recording Deepgram merged comes back as separated speakers with the doctor suggested, through the real API", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const { status, body } = await env.transcribe(token);
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.engine, "deepgram");
    assert.equal(body.speakerSource, "pyannote");
    assert.equal(body.diarizationProvider, "pyannote-community-1");
    assert.equal(body.diarizationStatus, "completed");
    assert.deepEqual(body.speakers.map((s) => [s.id, s.role, s.identificationStatus, s.suggestedRole]), [
      ["speaker_0", "unassigned", "matched", "doctor"],
      ["speaker_1", "unassigned", "unknown", null],
    ]);
    assert.deepEqual(body.segments.map((s) => s.speakerId), ["speaker_0", "speaker_1", "speaker_0", "speaker_1", "speaker_0", "speaker_1"]);
    assert.ok(body.warnings.some((w) => w.code === "SPEAKERS_FROM_PYANNOTE"));
    assert.equal(body.text.split(" ").length, 72, "all 72 words of the Deepgram transcript are present");
  });

  test("stored diagnostics (Deepgram's raw labels, pyannote's turns) stay internal: the API never returns them, the database keeps them", async () => {
    const env = await setup({ dg: (i) => i % 2 });
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const { body, text } = await env.transcribe(token);
    assert.ok(!/exclusive|deepgramRuns|labelToSpeaker|score|embedding|pyannote-community/i.test(text.replace(/"diarizationProvider":"[^"]*"/, "")), "no internals in the response");
    assert.ok(!text.includes("SPEAKER_0"), "the model's own speaker labels are not exposed (only speaker_0-style ids)");
    const meta = env.store.providerMeta("doctor-a", body.id);
    assert.equal(meta.voice.pyannote.speakers.length, 2);
    assert.equal(meta.voice.pyannote.exclusive.length, 6);
    assert.equal(meta.voice.deepgramRuns.length, 6);
    assert.equal(meta.voice.pyannote.versions["pyannote.audio"], "test");
  });

  test("without an enrolled doctor the speakers are still separated", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    const { body } = await env.transcribe(token);
    assert.equal(body.voiceIdentificationStatus, "not_enrolled");
    assert.equal(body.speakerSource, "pyannote");
    assert.equal(body.speakers.length, 2);
    assert.ok(body.speakers.every((s) => s.identificationStatus === "unavailable" && s.suggestedRole === null));
  });

  test("when pyannote fails the job still completes with Deepgram's transcript and an honest warning", async () => {
    const env = await setup({ dg: (i) => i % 2, pyannote: fakePyannote({ fail: "PYANNOTE_TIMEOUT" }) });
    const token = await env.tokenFor("doctor-a");
    const { status, body } = await env.transcribe(token);
    assert.equal(status, 201);
    assert.equal(body.speakerSource, "deepgram");
    assert.equal(body.diarizationProvider, "deepgram");
    assert.ok(body.warnings.some((w) => w.code === "PYANNOTE_FAILED"));
    assert.equal(body.speakers.length, 2, "Deepgram's own speakers are kept");
  });

  test("the doctor's confirmed role, edits and review survive: editing text, roles and reviewing all work on a pyannote transcript", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const { body } = await env.transcribe(token);
    const role = await env.call(token, "PATCH", `/api/transcriptions/${body.id}/speakers`, { speakerId: "speaker_0", role: "doctor" });
    assert.equal(role.status, 200);
    const edited = await env.call(token, "PATCH", `/api/transcriptions/${body.id}/segments/segment_1`, { text: "Corrected text." });
    assert.equal(edited.status, 200);
    const reloaded = await env.call(token, "GET", `/api/transcriptions/${body.id}`);
    assert.equal(reloaded.body.speakers[0].role, "doctor");
    assert.equal(reloaded.body.segments[0].text, "Corrected text.");
    assert.equal(reloaded.body.speakerSource, "pyannote");
    const reviewed = await env.call(token, "POST", `/api/transcriptions/${body.id}/review`);
    assert.equal(reviewed.body.reviewStatus, "reviewed");
    const history = await env.call(token, "GET", "/api/transcriptions");
    assert.equal(history.body.transcriptions.length, 1);
  });

  test("another doctor cannot read a pyannote-analysed transcript", async () => {
    const env = await setup();
    const owner = await env.tokenFor("doctor-a");
    const { body } = await env.transcribe(owner);
    const other = await env.tokenFor("doctor-b");
    assert.equal((await env.call(other, "GET", `/api/transcriptions/${body.id}`)).status, 404);
    assert.equal((await env.call("bad-token", "GET", `/api/transcriptions/${body.id}`)).status, 401);
  });

  test("no working files are left behind, and the recording is deleted", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.transcribe(token);
    const { readdir } = await import("node:fs/promises");
    const left = await readdir(env.tmpDir).catch(() => []);
    assert.deepEqual(left.filter((n) => !n.startsWith(".")), [], `left in the work directory: ${left}`);
  });
});
