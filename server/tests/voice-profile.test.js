// Doctor voice profile API: consent, validation, storage, ownership, deletion and secrecy.
// The ML model is replaced by a deterministic FAKE embedder here (real ffmpeg, real HTTP, real auth and database), so these
// verify the API and data handling only. Real speaker recognition is covered by real-voice.test.js.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { calibration, CONSENT_VERSION } from "../services/voice/calibration.js";
import { decryptJson, parseKey } from "../services/voice/protect.js";
import { fixtureSynthetic, leftoverFiles, makeAuth, makeConfig, readFixture, startServer, TEST_SUPABASE_URL } from "./helpers.js";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const unit = (seed, dim = 192) => {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * 12.9898 + i * 78.233) * 0.5 + Math.cos(seed * 4.1 + i));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};
const GOOD = { durationMs: 12_000, voicedMs: 9_000, clipRatio: 0, peak: 0.6, windowMinSimilarity: 0.8, windows: 3 };

/** A stand-in for embed.py. `perFile(index, path)` may override a sample's measured quality. */
function fakeEmbedder({ perFile = () => ({}), delayMs = 0, available = true, version = "fake-model@1", voiceSeed = 1 } = {}) {
  let n = 0;
  return {
    calls: [],
    available: async () => available,
    modelVersion: async () => version,
    quality: async (paths) => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return paths.map((p, i) => {
        const overrides = perFile(n++, p);
        // all samples of one "person" share a base vector plus a tiny per-file difference
        const base = unit(voiceSeed);
        const noisy = base.map((x, d) => x + 0.001 * Math.sin(i * 3 + d));
        const norm = Math.sqrt(noisy.reduce((s, x) => s + x * x, 0));
        return { ...GOOD, embedding: noisy.map((x) => x / norm), ...overrides };
      });
    },
    embedRegions: async (_wav, regions) => regions.map(() => unit(voiceSeed)),
  };
}

async function setup({ embedder = fakeEmbedder(), key = randomBytes(32).toString("base64"), ...overrides } = {}) {
  const env = await makeConfig({ supabaseUrl: TEST_SUPABASE_URL, voiceEnabled: true, voiceProfileKey: key, ...overrides });
  cleanups.push(env.cleanup);
  const keys = await makeAuth();
  const server = await startServer(env.config, { jwks: keys.jwks, embedder });
  cleanups.push(server.close);
  const call = async (token, method, url, { headers = {}, form } = {}) => {
    const res = await fetch(`${server.baseUrl}${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: form });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  const wav = await readFixture(fixtureSynthetic("single-speaker.wav"));
  const enrollForm = ({ count = 3, consent = "true", consentVersion = CONSENT_VERSION, files } = {}) => {
    const form = new FormData();
    for (let i = 0; i < count; i++) form.append("samples", new Blob([files?.[i] ?? wav], { type: "audio/wav" }), `sample-${i}.wav`);
    if (consent !== null) form.append("consent", consent);
    if (consentVersion !== null) form.append("consentVersion", consentVersion);
    return form;
  };
  const enroll = (token, options) => call(token, "POST", "/api/me/voice-profile/enroll", { form: enrollForm(options) });
  return { ...env, ...server, keys, call, enroll, enrollForm, embedder, key, store: server.app.locals.store, voice: server.app.locals.voice, tokenFor: (s) => keys.sign(s) };
}

const problems = (res) => res.body.extra?.problems ?? res.body.problems;

describe("status and consent", () => {
  test("reports not_enrolled with the exact consent wording the doctor must agree to", async () => {
    const { call, tokenFor } = await setup();
    const res = await call(await tokenFor("doctor-a"), "GET", "/api/me/voice-profile");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "not_enrolled");
    assert.equal(res.body.consent.version, CONSENT_VERSION);
    assert.match(res.body.consent.text, /never shared or used to log me in/);
    assert.equal(res.body.requiredSamples, 3);
  });

  test("enrollment without explicit consent is refused and saves nothing", async () => {
    const { enroll, call, tokenFor, tmpDir } = await setup();
    const token = await tokenFor("doctor-a");
    for (const options of [{ consent: null }, { consent: "false" }, { consentVersion: null }, { consentVersion: "some-other-version" }]) {
      const res = await enroll(token, options);
      assert.equal(res.status, 400, JSON.stringify(options));
      assert.equal(res.body.code, "CONSENT_REQUIRED");
    }
    assert.equal((await call(token, "GET", "/api/me/voice-profile")).body.status, "not_enrolled");
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });
});

describe("successful enrollment", () => {
  test("creates the profile for the verified account and returns safe metadata only", async () => {
    const { enroll, call, tokenFor, tmpDir } = await setup();
    const token = await tokenFor("doctor-a");
    const res = await enroll(token);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "enrolled");
    assert.equal(res.body.sampleCount, 3);
    assert.equal(res.body.modelVersion, "fake-model@1");
    assert.ok(Date.parse(res.body.enrolledAt));
    assert.ok(Date.parse(res.body.consentRecordedAt));
    assert.ok(!/embedding|references|vector|ciphertext/i.test(res.text), "no biometric data in the response");
    assert.ok(!/\d\.\d{4,}/.test(res.text), "no long floating-point arrays in the response");
    assert.deepEqual(await leftoverFiles(tmpDir), [], "raw enrollment audio is deleted");
    assert.equal((await call(token, "GET", "/api/me/voice-profile")).body.status, "enrolled");
  });

  test("stores the references encrypted: no plaintext in the database, and the owner-bound key opens them", async () => {
    const { enroll, tokenFor, config, key, store } = await setup();
    await enroll(await tokenFor("doctor-a"));
    const raw = new DatabaseSync(config.dbPath);
    const row = raw.prepare("SELECT * FROM voice_profiles WHERE owner_id = 'doctor-a'").get();
    raw.close();
    const dbBytes = readFileSync(config.dbPath).toString("latin1") + (() => { try { return readFileSync(`${config.dbPath}-wal`).toString("latin1"); } catch { return ""; } })();
    assert.ok(!dbBytes.includes(String(unit(1)[0]).slice(0, 8)), "embedding values must not appear in the database file");
    assert.ok(!dbBytes.includes("0.0"), "no plaintext arrays");
    const payload = decryptJson(row.ciphertext, parseKey(key), `doctor-a|${row.model_version}|${row.embedding_version}`);
    assert.equal(payload.references.length, 9, "3 clean samples plus 6 degraded copies (multi-condition enrollment)");
    assert.equal(payload.references[0].length, 192);
    assert.equal(row.sample_count, 3);
    assert.equal(row.consent_version, CONSENT_VERSION);
    assert.equal(store.voiceProfileCiphertext("doctor-a").equals(row.ciphertext), true);
  });

  test("re-enrolling REPLACES the profile (one per doctor) and keeps the original creation time", async () => {
    const { enroll, call, tokenFor, config } = await setup();
    const token = await tokenFor("doctor-a");
    const first = await enroll(token);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await enroll(token);
    assert.equal(second.status, 201);
    assert.equal(second.body.enrolledAt, first.body.enrolledAt, "creation time is kept");
    assert.ok(second.body.updatedAt > first.body.updatedAt);
    const raw = new DatabaseSync(config.dbPath);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM voice_profiles").get().n, 1);
    raw.close();
    assert.equal((await call(token, "GET", "/api/me/voice-profile")).body.status, "enrolled");
  });

  test("a profile persists across a server restart", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    await env.close();
    const again = await startServer(env.config, { jwks: env.keys.jwks, embedder: fakeEmbedder() });
    cleanups.push(again.close);
    const res = await fetch(`${again.baseUrl}/api/me/voice-profile`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await res.json()).status, "enrolled");
  });

  test("a second enrollment at the same time is refused (409)", async () => {
    const { enroll, tokenFor } = await setup({ embedder: fakeEmbedder({ delayMs: 400 }) });
    const token = await tokenFor("doctor-a");
    const [a, b] = await Promise.all([enroll(token), (async () => { await new Promise((r) => setTimeout(r, 100)); return enroll(token); })()]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  });
});

describe("recoverable enrollment failures (nothing is saved)", () => {
  const rejected = async (perFile, options) => {
    const env = await setup({ embedder: fakeEmbedder({ perFile }) });
    const token = await env.tokenFor("doctor-a");
    const res = await env.enroll(token, options);
    assert.equal(res.status, 422, res.text);
    assert.equal(res.body.code, "ENROLLMENT_REJECTED");
    assert.equal((await env.call(token, "GET", "/api/me/voice-profile")).body.status, "not_enrolled", "no profile from invalid audio");
    assert.deepEqual(await leftoverFiles(env.tmpDir), []);
    return problems(res);
  };

  test("a file that is not audio names the sample", async () => {
    const p = await rejected(() => ({}), { files: [null, Buffer.from("not audio at all"), null] });
    assert.deepEqual(p.map((x) => [x.sample, x.code]), [[2, "INVALID_AUDIO"]]);
  });
  test("silent audio", async () => {
    const p = await rejected((i) => (i === 0 ? { peak: 0.001, voicedMs: 200 } : {}));
    assert.deepEqual(p.map((x) => [x.sample, x.code]), [[1, "SAMPLE_SILENT"]]);
  });
  test("clipped (distorted) audio", async () => {
    const p = await rejected((i) => (i === 1 ? { clipRatio: 0.2 } : {}));
    assert.deepEqual(p.map((x) => [x.sample, x.code]), [[2, "SAMPLE_CLIPPED"]]);
  });
  test("insufficient speech says how much was found and how much is needed", async () => {
    const p = await rejected((i) => (i === 2 ? { voicedMs: 2500 } : {}));
    assert.equal(p[0].code, "SAMPLE_TOO_SHORT");
    assert.match(p[0].message, new RegExp(`2\\.5 seconds.*at least ${calibration.enrollment.minVoicedSeconds}`));
  });
  test("a sample that seems to contain more than one voice", async () => {
    const p = await rejected((i) => (i === 0 ? { windowMinSimilarity: 0.2 } : {}));
    assert.deepEqual(p.map((x) => x.code), ["MULTIPLE_SPEAKERS_SUSPECTED"]);
  });
  test("a sample that is too long", async () => {
    const p = await rejected((i) => (i === 0 ? { durationMs: 120_000 } : {}));
    assert.equal(p[0].code, "SAMPLE_TOO_LONG");
  });
  test("three samples that do not sound like the same person", async () => {
    let i = 0;
    const env = await setup({ embedder: { ...fakeEmbedder(), quality: async (paths) => paths.map(() => ({ ...GOOD, embedding: unit(++i * 7) })) } });
    const res = await env.enroll(await env.tokenFor("doctor-a"));
    assert.equal(res.status, 422);
    assert.equal(problems(res)[0].code, "SAMPLES_DIFFER");
  });
  test("the wrong number of samples is a plain request error", async () => {
    const { enroll, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    assert.equal((await enroll(token, { count: 2 })).status, 400);
    assert.equal((await enroll(token, { count: 4 })).status, 400);
  });
  test("an unavailable model is a 503, not a fake profile", async () => {
    const { enroll, tokenFor } = await setup({ embedder: fakeEmbedder({ available: false }) });
    assert.equal((await enroll(await tokenFor("doctor-a"))).status, 503);
  });
  test("without an encryption key no profile can be created", async () => {
    const { enroll, tokenFor } = await setup({ key: "" });
    const res = await enroll(await tokenFor("doctor-a"));
    assert.equal(res.status, 503);
    assert.match(res.body.error, /encryption key/);
  });
});

describe("deletion", () => {
  test("requires an explicit confirmation, then removes the profile for good", async () => {
    const { enroll, call, tokenFor, config } = await setup();
    const token = await tokenFor("doctor-a");
    await enroll(token);
    assert.equal((await call(token, "DELETE", "/api/me/voice-profile")).body.code, "CONFIRMATION_REQUIRED");
    assert.equal((await call(token, "GET", "/api/me/voice-profile")).body.status, "enrolled", "unconfirmed delete changes nothing");
    assert.equal((await call(token, "DELETE", "/api/me/voice-profile", { headers: { "X-Confirm": "delete-voice-profile" } })).status, 204);
    assert.equal((await call(token, "GET", "/api/me/voice-profile")).body.status, "not_enrolled");
    const raw = new DatabaseSync(config.dbPath);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM voice_profiles").get().n, 0);
    raw.close();
    assert.equal((await call(token, "DELETE", "/api/me/voice-profile", { headers: { "X-Confirm": "delete-voice-profile" } })).status, 404);
  });
});

describe("ownership and security", () => {
  test("every route requires a verified session (a voice alone is never a login)", async () => {
    const { call, enrollForm, tmpDir } = await setup();
    assert.equal((await call(null, "GET", "/api/me/voice-profile")).status, 401);
    assert.equal((await call(null, "POST", "/api/me/voice-profile/enroll", { form: enrollForm() })).status, 401);
    assert.equal((await call(null, "DELETE", "/api/me/voice-profile", { headers: { "X-Confirm": "delete-voice-profile" } })).status, 401);
    assert.equal((await call("garbage.token.value", "GET", "/api/me/voice-profile")).status, 401);
    assert.deepEqual(await leftoverFiles(tmpDir), [], "nothing was processed or stored");
  });

  test("doctor B cannot see, replace or delete doctor A's profile", async () => {
    const { enroll, call, tokenFor, store } = await setup();
    const a = await tokenFor("doctor-a");
    const b = await tokenFor("doctor-b");
    await enroll(a);
    assert.equal((await call(b, "GET", "/api/me/voice-profile")).body.status, "not_enrolled");
    assert.equal((await call(b, "DELETE", "/api/me/voice-profile", { headers: { "X-Confirm": "delete-voice-profile" } })).status, 404);
    assert.equal((await call(a, "GET", "/api/me/voice-profile")).body.status, "enrolled", "A's profile is untouched");
    await enroll(b);
    assert.ok(store.voiceProfileCiphertext("doctor-a") && store.voiceProfileCiphertext("doctor-b"));
    assert.ok(!store.voiceProfileCiphertext("doctor-a").equals(store.voiceProfileCiphertext("doctor-b")), "separate profiles");
  });

  test("a client-supplied owner id is ignored", async () => {
    const { call, enrollForm, tokenFor } = await setup();
    const form = enrollForm();
    form.append("ownerId", "doctor-b");
    form.append("userId", "doctor-b");
    const a = await tokenFor("doctor-a");
    assert.equal((await call(a, "POST", "/api/me/voice-profile/enroll", { form })).status, 201);
    assert.equal((await call(await tokenFor("doctor-b"), "GET", "/api/me/voice-profile")).body.status, "not_enrolled");
  });

  test("a profile copied to another account cannot be decrypted (bound to its owner)", async () => {
    const { enroll, tokenFor, store, voice } = await setup();
    await enroll(await tokenFor("doctor-a"));
    store.upsertDoctor({ id: "doctor-b" });
    const meta = store.voiceProfileMeta("doctor-a");
    store.saveVoiceProfile("doctor-b", { modelName: meta.modelName, modelVersion: meta.modelVersion, embeddingVersion: meta.embeddingVersion, sampleCount: 3, consentVersion: CONSENT_VERSION, ciphertext: store.voiceProfileCiphertext("doctor-a") });
    assert.equal(await voice.loadReferences("doctor-b"), null, "copied ciphertext is refused");
    assert.equal((await voice.loadReferences("doctor-a")).length, 9);
  });

  test("a profile made with another model or pipeline version needs re-enrollment and is never used", async () => {
    const env = await setup();
    const token = await env.tokenFor("doctor-a");
    await env.enroll(token);
    env.embedder.modelVersion = async () => "fake-model@2";
    const res = await env.call(token, "GET", "/api/me/voice-profile");
    assert.equal(res.body.status, "needs_reenrollment");
    assert.equal(await env.voice.loadReferences("doctor-a"), null);
    const raw = new DatabaseSync(env.config.dbPath);
    raw.prepare("UPDATE voice_profiles SET embedding_version = 'ecapa-v0'").run();
    raw.close();
    env.embedder.modelVersion = async () => "fake-model@1";
    assert.equal((await env.call(token, "GET", "/api/me/voice-profile")).body.status, "needs_reenrollment");
  });

  test("embeddings, keys and audio never reach the logs", async () => {
    const lines = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    for (const level of Object.keys(originals)) console[level] = (...args) => lines.push(args.map(String).join(" "));
    let key;
    try {
      const env = await setup({ embedder: fakeEmbedder({ perFile: (i) => (i === 0 ? { peak: 0.0001, voicedMs: 10 } : {}) }) });
      key = env.key;
      const token = await env.tokenFor("doctor-a");
      await env.enroll(token); // rejected
      await env.enroll(token, { files: [null, null, null] }); // rejected again
    } finally {
      Object.assign(console, originals);
    }
    const all = lines.join("\n");
    assert.ok(!all.includes(key), "encryption key in logs");
    assert.ok(!/\d\.\d{5,}/.test(all), "long floats (embeddings) in logs");
  });
});
