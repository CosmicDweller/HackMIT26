// Voice identification inside the real job pipeline (HTTP, auth, database, FFmpeg): Deepgram is a stub replaying a scripted
// response, and the voice model is a scripted fake, so these verify how results flow into stored transcripts, ownership,
// and failure handling. Real voice recognition is covered by real-voice.test.js.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { CONSENT_VERSION } from "../services/voice/calibration.js";
import { json, startDeepgramStub } from "./deepgram-stub.js";
import { fixtureSynthetic, makeAuth, makeConfig, readFixture, startServer, TEST_SUPABASE_URL } from "./helpers.js";

const KEY = "dg-test-key-NOT-A-REAL-KEY-12345";
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map((x) => x / n); };
const axis = (i) => unit(Array.from({ length: 16 }, (_, d) => (d === i ? 1 : 0)));
const VOICES = { D: axis(0), P: axis(1), N: axis(2) };

function response(turns, dg) {
  const words = [];
  turns.forEach((t, ti) => {
    const n = Math.max(1, Math.floor(t.seconds / 0.5));
    for (let i = 0; i < n; i++) {
      const start = t.at + i * (t.seconds / n);
      words.push({ word: `w${ti}x${i}`, punctuated_word: `w${ti}x${i}${i === n - 1 ? "." : ""}`, start, end: start + (t.seconds / n) * 0.8, confidence: 0.99, speaker: dg(ti), speaker_confidence: 0.95 });
    }
  });
  return {
    metadata: { request_id: "r", duration: 60, model_info: { m: { name: "medical-nova-3", version: "1" } }, diarize_info: { arch: "v2", model_uuid: "u" } },
    results: { channels: [{ alternatives: [{ transcript: "x", words }] }], utterances: [] },
  };
}
const TURNS = ["D", "P", "D", "P", "D", "P"].map((who, i) => ({ who, at: i * 7, seconds: 6 }));

function fakeEmbedder({ turns = TURNS, enrollVoice = "D", throwOnRegions = false, available = true } = {}) {
  const whoAt = (ms) => turns.find((t) => ms >= t.at * 1000 - 1 && ms <= (t.at + t.seconds) * 1000 + 1)?.who ?? "P";
  return {
    available: async () => available,
    modelVersion: async () => "fake-model@1",
    quality: async (paths) => paths.map(() => ({ durationMs: 12000, voicedMs: 9000, clipRatio: 0, peak: 0.6, windowMinSimilarity: 0.8, windows: 3, embedding: VOICES[enrollVoice] })),
    embedRegions: async (_wav, regions) => {
      if (throwOnRegions) throw new Error("boom");
      return regions.map((r) => VOICES[whoAt((r.startMs + r.endMs) / 2)]);
    },
  };
}

async function setup({ dg = (i) => i % 2, turns = TURNS, embedder = fakeEmbedder({ turns }), segments } = {}) {
  const stub = await startDeepgramStub(json(200, response(turns, dg)));
  cleanups.push(stub.close);
  const env = await makeConfig({
    supabaseUrl: TEST_SUPABASE_URL, sttEngine: "deepgram", deepgramApiKey: KEY, deepgramBaseUrl: stub.url,
    voiceEnabled: true, voiceProfileKey: randomBytes(32).toString("base64"), diarizationEnabled: true, diarizationTimeoutMs: 10_000,
  });
  cleanups.push(env.cleanup);
  const seg = path.join(env.root, "fake-seg");
  await writeFile(seg, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ engine: "fake", segments: segments ?? turns.map((t) => ({ speaker: 0, start: t.at, end: t.at + t.seconds })) })}'\n`);
  await chmod(seg, 0o755);
  env.config.diarizationPython = seg;
  env.config.diarizationScript = seg;
  const keys = await makeAuth();
  const server = await startServer(env.config, { jwks: keys.jwks, embedder });
  cleanups.push(server.close);
  const call = async (token, method, url, body) => {
    const res = await fetch(`${server.baseUrl}${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  const audio = await readFixture(fixtureSynthetic("single-speaker.wav"));
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

describe("identification in stored transcripts", () => {
  test("an enrolled doctor: the doctor's speaker is matched and suggested, the other stays unknown, and no role is assigned", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const { status, body } = await env.transcribe(token);
    assert.equal(status, 201);
    assert.equal(body.voiceIdentificationStatus, "completed");
    assert.equal(body.speakerSource, "deepgram");
    assert.deepEqual(body.speakers.map((s) => [s.id, s.role, s.identificationStatus, s.suggestedRole]), [
      ["speaker_0", "unassigned", "matched", "doctor"],
      ["speaker_1", "unassigned", "unknown", null],
    ]);
    assert.equal(body.diarizationStatus, "completed");
    assert.ok(body.segments.every((s) => s.needsReview === false));
  });

  test("scores, evidence and embeddings are never sent to the client, but are kept internally", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const { body, text } = await env.transcribe(token);
    assert.ok(!/score|embedding|similarity|cosine/i.test(text), "no scores or embeddings in the API response");
    const meta = env.store.providerMeta("doctor-a", body.id);
    assert.equal(meta.voice.status, "completed");
    assert.equal(typeof meta.voice.speakers["0"].score, "number");
  });

  test("the doctor confirms the role: the role changes, the speaker id and model suggestion stay separate", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const { body } = await env.transcribe(token);
    const patched = await env.call(token, "PATCH", `/api/transcriptions/${body.id}/speakers`, { speakerId: "speaker_0", role: "doctor" });
    const s0 = patched.body.speakers[0];
    assert.deepEqual([s0.id, s0.role, s0.identificationStatus, s0.suggestedRole], ["speaker_0", "doctor", "matched", "doctor"]);
    assert.deepEqual(patched.body.segments.map((s) => s.speakerId), body.segments.map((s) => s.speakerId), "segments keep the internal speaker id");
    assert.equal(patched.body.reviewStatus, "needs_review", "a model suggestion or a role is not a review");
  });

  test("the doctor may reject the suggestion: a different role can be confirmed and the suggestion remains only a suggestion", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const { body } = await env.transcribe(token);
    const patched = await env.call(token, "PATCH", `/api/transcriptions/${body.id}/speakers`, { speakerId: "speaker_0", role: "other" });
    assert.equal(patched.body.speakers[0].role, "other");
    assert.equal(patched.body.speakers[0].suggestedRole, "doctor");
  });

  test("not enrolled: identification is not_enrolled and every speaker is unavailable", async () => {
    const env = await setup();
    const { body } = await env.transcribe(await env.tokenFor("doctor-a"));
    assert.equal(body.voiceIdentificationStatus, "not_enrolled");
    assert.ok(body.speakers.every((s) => s.identificationStatus === "unavailable" && s.suggestedRole === null));
  });

  test("doctor A's profile is never used for doctor B's recording", async () => {
    const env = await setup();
    await env.enroll(await env.tokenFor("doctor-a"));
    const { body } = await env.transcribe(await env.tokenFor("doctor-b"));
    assert.equal(body.voiceIdentificationStatus, "not_enrolled");
    assert.ok(body.speakers.every((s) => s.suggestedRole === null));
  });

  test("after the profile is deleted, new recordings are not identified (an existing transcript keeps what it had)", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const first = (await env.transcribe(token)).body;
    assert.equal((await env.call(token, "DELETE", "/api/me/voice-profile")).status, 400);
    const res = await fetch(`${env.baseUrl}/api/me/voice-profile`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, "X-Confirm": "delete-voice-profile" } });
    assert.equal(res.status, 204);
    const second = (await env.transcribe(token)).body;
    assert.equal(second.voiceIdentificationStatus, "not_enrolled");
    assert.equal((await env.call(token, "GET", `/api/transcriptions/${first.id}`)).body.speakers[0].suggestedRole, "doctor");
  });

  test("a profile from another model version is not used and the doctor is told to re-enroll", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    env.app.locals.embedder.modelVersion = async () => "fake-model@2";
    const { body } = await env.transcribe(token);
    assert.equal(body.voiceIdentificationStatus, "needs_reenrollment");
    assert.ok(body.speakers.every((s) => s.suggestedRole === null));
  });
});

describe("independent speaker analysis in stored transcripts", () => {
  test("Deepgram merged two voices: the transcript gets two speakers, the doctor is told, every word is kept", async () => {
    const env = await setup({ dg: () => 0 });
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const { body } = await env.transcribe(token);
    assert.equal(body.speakerSource, "independent");
    assert.equal(body.speakers.length, 2);
    assert.deepEqual(body.segments.map((s) => s.speakerId), ["speaker_0", "speaker_1", "speaker_0", "speaker_1", "speaker_0", "speaker_1"]);
    assert.ok(body.warnings.some((w) => w.code === "SPEAKERS_FROM_VOICE_ANALYSIS"));
    assert.equal(body.speakers[0].suggestedRole, "doctor");
    const words = body.text.split(" ");
    assert.equal(words.length, 6 * 12, "no word lost or duplicated");
  });

  test("without an enrolled profile the split still happens (nobody is identified)", async () => {
    const env = await setup({ dg: () => 0 });
    const { body } = await env.transcribe(await env.tokenFor("doctor-b"));
    assert.equal(body.speakerSource, "independent");
    assert.equal(body.voiceIdentificationStatus, "not_enrolled");
    assert.equal(body.speakers.length, 2);
  });

  test("insufficient voice evidence leaves the speaker uncertain and marks its segments for review", async () => {
    const turns = [{ who: "D", at: 0, seconds: 1.6 }, { who: "P", at: 3, seconds: 6 }, { who: "P", at: 10, seconds: 6 }, { who: "P", at: 17, seconds: 6 }];
    const env = await setup({ turns, dg: (i) => (i === 0 ? 0 : 1) });
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const { body } = await env.transcribe(token);
    assert.equal(body.speakers[0].identificationStatus, "uncertain");
    assert.equal(body.speakers[0].suggestedRole, null);
    assert.ok(body.segments.filter((s) => s.speakerId === "speaker_0").every((s) => s.needsReview === true));
    assert.ok(body.segments.filter((s) => s.speakerId === "speaker_1").every((s) => s.needsReview === false));
  });

  test("a voice-model failure never breaks the transcript: Deepgram's labels are kept and the doctor is told", async () => {
    const env = await setup({ embedder: fakeEmbedder({ throwOnRegions: true }) });
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    const { status, body } = await env.transcribe(token);
    assert.equal(status, 201);
    assert.equal(body.voiceIdentificationStatus, "unavailable");
    assert.ok(body.warnings.some((w) => w.code === "VOICE_IDENTIFICATION_FAILED"));
    assert.deepEqual(body.segments.map((s) => s.speakerId), ["speaker_0", "speaker_1", "speaker_0", "speaker_1", "speaker_0", "speaker_1"]);
    assert.ok(body.speakers.every((s) => s.suggestedRole === null));
  });

  test("the recording and temporary files are deleted after analysis", async () => {
    const env = await setup({ dg: () => 0 });
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    await env.transcribe(token);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(env.config.uploadDir).catch(() => []), []);
    assert.deepEqual((await readdir(env.config.tmpDir).catch(() => [])).filter((f) => !f.startsWith("upload-")), []);
  });
});
