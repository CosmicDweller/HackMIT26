// REAL voice recognition: the real SpeechBrain ECAPA-TDNN model, the real segmentation model, real FFmpeg, real enrollment, on
// SYNTHETIC (text-to-speech) voices. No mocks, no network for part 1. Skipped (not passed) when the voice model is not installed
// (`npm run setup:voice`). Part 2 additionally uses the live Deepgram service and needs DEEPGRAM_API_KEY + DEEPGRAM_LIVE_TEST=1.
//
// IMPORTANT: text-to-speech voices are far more consistent than real people. Passing here shows the pipeline works; it does NOT
// show a given accuracy on real doctors. The thresholds must be re-measured with real consenting speakers (see docs/VOICE_EVALUATION.md).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { CONSENT_VERSION } from "../services/voice/calibration.js";
import { createEmbedder } from "../services/voice/embedder.js";
import { loadConfig } from "../config.js";
import { realEnvironment, runScenario } from "../scripts/probe-voice-scenarios.mjs";
import { makeAuth, makeConfig, startServer, TEST_SUPABASE_URL } from "./helpers.js";
import { der } from "./eval.js";

const F = new URL("./fixtures/voice/", import.meta.url).pathname;
const installed = await createEmbedder(loadConfig({})).available();
const skip = installed ? false : "voice model not installed (npm run setup:voice)";
let env;
before(async () => { if (installed) env = await realEnvironment(); });

const statusOf = (r, id) => r.map[id]?.status;

describe("real enrollment", { skip }, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "voice-enroll-"));
  const ff = (args, out) => { const r = spawnSync("ffmpeg", ["-y", "-v", "error", ...args, out]); assert.equal(r.status, 0, String(r.stderr)); return out; };
  const good = (i) => `${F}enroll-ralph-${i}.flac`;
  const enroll = (files, id = "someone") => { env.store.upsertDoctor({ id }); return env.voice.enroll(id, { files: files.map((p) => ({ path: p })), consent: "true", consentVersion: CONSENT_VERSION }); };
  const rejection = async (files) => { try { await enroll(files); } catch (error) { assert.equal(error.code, "ENROLLMENT_REJECTED"); return error.extra.problems; } assert.fail("expected the enrollment to be rejected"); };

  test("three clean samples of one voice create a real model-generated profile", async () => {
    const status = await enroll([good(0), good(1), good(2)], "fresh-doctor");
    assert.equal(status.status, "enrolled");
    const refs = await env.voice.loadReferences("fresh-doctor");
    assert.equal(refs.length, 9);
    assert.equal(refs[0].length, 192, "a real 192-dimensional ECAPA embedding");
    assert.ok(Math.abs(Math.hypot(...refs[0]) - 1) < 1e-3, "L2-normalised");
    assert.ok(refs.some((r, i) => i > 0 && r.some((x, d) => x !== refs[0][d])), "the embeddings are not all identical");
  });

  test("silence is rejected", async () => {
    const silent = ff(["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "12"], `${tmp}/silent.wav`);
    const problems = await rejection([silent, good(1), good(2)]);
    assert.equal(problems[0].sample, 1);
    assert.equal(problems[0].code, "SAMPLE_SILENT");
  });

  test("a very short sample is rejected with how much speech was found", async () => {
    const short = ff(["-i", good(0), "-t", "3"], `${tmp}/short.wav`);
    const problems = await rejection([good(1), short, good(2)]);
    assert.equal(problems[0].sample, 2);
    assert.match(problems[0].code, /SAMPLE_TOO_SHORT/);
  });

  test("a clipped (distorted) recording is rejected", async () => {
    const clipped = ff(["-i", good(0), "-af", "volume=40dB,alimiter=limit=1:level=false"], `${tmp}/clipped.wav`);
    const problems = await rejection([good(1), good(2), clipped]);
    assert.equal(problems[0].sample, 3);
    assert.equal(problems[0].code, "SAMPLE_CLIPPED");
  });

  test("a sample where two different people speak is caught", async () => {
    const mixed = ff(["-i", good(0), "-i", `${F}enroll-kathy-1.flac`, "-filter_complex", "[0:a]atrim=0:6[a];[1:a]atrim=4:12,asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1", "-ar", "16000", "-ac", "1"], `${tmp}/mixed.wav`);
    const problems = await rejection([good(1), mixed, good(2)]);
    assert.equal(problems[0].sample, 2);
    assert.equal(problems[0].code, "MULTIPLE_SPEAKERS_SUSPECTED");
  });

  test("three samples from three different people are rejected as not the same person", async () => {
    const problems = await rejection([good(0), `${F}enroll-kathy-1.flac`, `${F}enroll-reed_uk-2.flac`]);
    assert.equal(problems[0].code, "SAMPLES_DIFFER");
  });

  test("nothing was saved by any of the rejected attempts", () => {
    assert.equal(env.store.voiceProfileMeta("someone"), undefined);
  });
});

describe("real doctor identification (real ECAPA + real segmentation; Deepgram's labels are merged so the independent path is exercised)", { skip }, () => {
  const scenario = async (name, doctor) => runScenario(env, name, doctor);

  test("Doctor -> Patient: two speakers, the doctor matched, the patient a reliable non-match, never assumed to be the patient", async () => {
    const r = await scenario("dpdp", "ralph");
    assert.equal(r.foundSpeakers, 2);
    assert.equal(statusOf(r, "D"), "matched");
    assert.equal(statusOf(r, "P"), "unknown");
    assert.equal(r.result.identification.get(r.map.P.speaker).suggestedRole, null);
    assert.notEqual(r.map.D.speaker, r.map.P.speaker);
  });

  test("Doctor -> Patient -> Doctor ...: the returning doctor keeps one speaker id, and word timestamps are untouched", async () => {
    const r = await scenario("dpdp", "ralph");
    const seq = r.result.normalized.segments.map((s) => s.providerSpeaker).filter((x, i, arr) => i === 0 || x !== arr[i - 1]);
    assert.deepEqual(seq, [0, 1, 0, 1, 0, 1, 0, 1], "alternating turns, and no words left without a speaker");
    const words = r.result.normalized.groups.flat();
    assert.equal(words.length, r.truth.turns.reduce((n, t) => n + Math.max(2, Math.round((t.endMs - t.startMs) / 450)), 0), "no word lost or duplicated");
    assert.ok(words.every((w, i) => i === 0 || w.start >= words[i - 1].start), "no reordering or time reset");
  });

  test("the doctor is NOT falsely found when absent (two other voices)", async () => {
    const r = await scenario("doctor-absent", "ralph");
    assert.equal(r.foundSpeakers, 2);
    assert.deepEqual([statusOf(r, "P"), statusOf(r, "N")], ["unknown", "unknown"]);
  });

  test("a recording of only the patient is not labelled as the doctor", async () => {
    const r = await scenario("patient-alone", "ralph");
    assert.equal(statusOf(r, "P"), "unknown");
  });

  test("a recording of only the doctor is recognised as the doctor (a genuine one-speaker recording stays one speaker)", async () => {
    const r = await scenario("doctor-alone", "ralph");
    assert.equal(r.foundSpeakers, 1);
    assert.equal(statusOf(r, "D"), "matched");
  });

  test("three speakers (doctor, patient, nurse): three distinct voices, only the doctor matched, nobody assumed to be a patient or nurse", async () => {
    const r = await scenario("three-speakers", "ralph");
    assert.equal(r.foundSpeakers, 3);
    assert.equal(statusOf(r, "D"), "matched");
    assert.notEqual(statusOf(r, "P"), "matched");
    assert.notEqual(statusOf(r, "N"), "matched");
    assert.equal(new Set(Object.values(r.map).map((m) => m.speaker)).size, 3, "not merged into one");
    for (const id of ["P", "N"]) assert.equal(r.result.identification.get(r.map[id].speaker).suggestedRole, null);
  });

  test("a doctor's enrolled voice is recognised through a different microphone (band-limited, lossy, noisy)", async () => {
    const r = await scenario("different-mic", "ralph");
    assert.equal(r.foundSpeakers, 2);
    assert.equal(statusOf(r, "D"), "matched");
    assert.equal(statusOf(r, "P"), "unknown");
  });

  test("the doctor returns after a 2.5 minute gap and is still the same speaker", async () => {
    const r = await scenario("long-gap", "ralph");
    assert.equal(r.foundSpeakers, 2);
    assert.equal(statusOf(r, "D"), "matched");
    const afterGap = r.result.normalized.segments.filter((s) => s.startMs > 150_000);
    assert.ok(afterGap.length >= 2, "real recording-wide timestamps");
    const doctorTurn = afterGap.find((s) => s.startMs >= 183_000 && s.startMs < 188_000);
    assert.equal(doctorTurn.providerSpeaker, r.map.D.speaker, "the doctor's turn after the gap has the doctor's id");
    assert.equal(afterGap.at(-1).providerSpeaker, r.map.P.speaker, "and the patient's reply the patient's");
  });

  test("a genuine miss by Deepgram (two voices merged) is separated into exactly two speakers, and the doctor matched", async () => {
    const r = await scenario("deepgram-miss", "kathy");
    assert.equal(r.foundSpeakers, 2, "no fabricated third or fourth speaker");
    assert.equal(r.result.source, "independent");
    assert.equal(statusOf(r, "D"), "matched");
    assert.equal(statusOf(r, "P"), "unknown");
    assert.ok(r.result.warnings.some((w) => w.code === "SPEAKERS_FROM_VOICE_ANALYSIS"));
  });

  test("diarization quality on the separated recording: word-level speaker regions agree with the reference", async () => {
    const r = await scenario("deepgram-miss", "kathy");
    const hyp = r.result.normalized.segments.filter((s) => s.providerSpeaker !== null).map((s) => ({ speaker: s.providerSpeaker, startMs: s.startMs, endMs: s.endMs }));
    const result = der(r.truth.turns.map((t) => ({ speaker: t.speaker, startMs: t.startMs, endMs: t.endMs })), hyp);
    assert.ok(result.der < 0.15, `DER ${(result.der * 100).toFixed(1)}%`);
  });

  test("a different doctor's profile does not match either speaker", async () => {
    const r = await runScenario(env, "dpdp", "kathy"); // kathy is the PATIENT in this recording, so "kathy enrolled" matches the patient voice
    assert.equal(statusOf(r, "P"), "matched");
    assert.equal(statusOf(r, "D"), "unknown", "the real doctor is not kathy");
  });

  // ---- KNOWN LIMITATIONS, pinned so they cannot be forgotten or quietly changed --------------------------------------
  test("KNOWN LIMITATION: two near-identical voices cannot be separated by any model, so they stay one speaker", async () => {
    const r = await scenario("similar-voices", "reed_uk");
    assert.equal(r.foundSpeakers, 1, "acoustically the same voice: neither Deepgram nor independent analysis separates them");
    assert.equal(statusOf(r, "D"), statusOf(r, "P"), "both truth speakers share one label");
  });

  test("a single short doctor reply inside the patient's long speech is separated but NOT confidently identified", async () => {
    const r = await scenario("short-doctor-reply", "ralph");
    assert.equal(r.foundSpeakers, 2);
    assert.equal(statusOf(r, "P"), "unknown");
    assert.equal(statusOf(r, "D"), "uncertain", "one short region is not enough evidence for a definitive status");
    assert.equal(r.result.identification.get(r.map.D.speaker).suggestedRole, null);
  });
});

describe("voice analysis on long recordings", { skip }, () => {
  test("the analysis handles a long recording within bounded memory (embeds regions, never whole files)", async () => {
    const before = process.memoryUsage().rss;
    const r = await runScenario(env, "long-gap", "ralph");
    assert.equal(r.foundSpeakers, 2);
    assert.ok(process.memoryUsage().rss - before < 600 * 1024 * 1024, "the Node process stays small; the model runs in its own process");
  });
});

// ---- part 2: live Deepgram + real voice, through the whole job pipeline ---------------------------------------------------------
const LIVE = Boolean(process.env.DEEPGRAM_API_KEY) && process.env.DEEPGRAM_LIVE_TEST === "1";
describe("live: Deepgram + real voice model through the complete job pipeline", { skip: skip || (LIVE ? false : "set DEEPGRAM_API_KEY and DEEPGRAM_LIVE_TEST=1 (uploads synthetic audio to Deepgram)") }, () => {
  let app;
  after(async () => { await app?.close(); });

  async function boot() {
    const cfg = await makeConfig({ supabaseUrl: TEST_SUPABASE_URL, sttEngine: "deepgram", deepgramApiKey: process.env.DEEPGRAM_API_KEY, voiceEnabled: true, voiceProfileKey: env.config.voiceProfileKey });
    const keys = await makeAuth();
    const server = await startServer(cfg.config, { jwks: keys.jwks });
    app = { ...server, cleanup: cfg.cleanup, keys, config: cfg.config };
    return app;
  }
  const api = async (a, token, method, url, form) => {
    const res = await fetch(`${a.baseUrl}${url}`, { method, headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const upload = async (a, token, name) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "live-"));
    const wav = path.join(dir, `${name}.wav`);
    spawnSync("ffmpeg", ["-y", "-v", "error", "-i", `${F}${name}.flac`, "-ac", "1", "-ar", "16000", wav]);
    const form = new FormData();
    form.append("audio", new Blob([await readFile(wav)], { type: "audio/wav" }), `${name}.wav`);
    return api(a, token, "POST", "/api/transcriptions", form);
  };
  const enrollLive = async (a, token, voice) => {
    const form = new FormData();
    for (let i = 0; i < 3; i++) form.append("samples", new Blob([await readFile(`${F}enroll-${voice}-${i}.flac`)], { type: "audio/flac" }), `s${i}.flac`);
    form.append("consent", "true");
    form.append("consentVersion", CONSENT_VERSION);
    return api(a, token, "POST", "/api/me/voice-profile/enroll", form);
  };

  test("Doctor -> Patient with the live service: speakers separated, the doctor identified, every word from Deepgram kept", async () => {
    const a = await boot();
    const token = await a.keys.sign("live-doctor");
    assert.equal((await enrollLive(a, token, "ralph")).status, 201);
    const { status, body } = await upload(a, token, "dpdp");
    assert.equal(status, 201);
    assert.equal(body.engine, "deepgram");
    assert.equal(body.voiceIdentificationStatus, "completed");
    assert.equal(body.speakers.length, 2);
    const doctor = body.speakers.find((s) => s.identificationStatus === "matched");
    assert.ok(doctor, "the enrolled doctor is identified");
    assert.equal(doctor.suggestedRole, "doctor");
    assert.equal(doctor.role, "unassigned", "the role is still the doctor's to confirm");
    assert.match(body.text, /blood pressure/i);
  });

  test("the doctor's voice is not found in a consultation without the doctor (live)", async () => {
    const a = app ?? (await boot());
    const token = await a.keys.sign("live-doctor");
    const { body } = await upload(a, token, "doctor-absent");
    assert.ok(body.speakers.every((s) => s.identificationStatus !== "matched"));
    assert.ok(body.speakers.every((s) => s.suggestedRole === null));
  });

  test("the recording Deepgram merges is still separated end to end (live)", async () => {
    const a = app ?? (await boot());
    const token = await a.keys.sign("live-kathy");
    assert.equal((await enrollLive(a, token, "kathy")).status, 201);
    const { body } = await upload(a, token, "deepgram-miss");
    assert.equal(body.speakers.length, 2, `speakers: ${JSON.stringify(body.speakers.map((s) => s.identificationStatus))}`);
    assert.equal(body.speakers.filter((s) => s.identificationStatus === "matched").length, 1);
  });
});
