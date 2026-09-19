// Opt-in Deepgram engine. Tests run against a STUB HTTP server modelled on Deepgram's pre-recorded API
// reference, so they verify our request/response handling, privacy settings and fallback behaviour.
// They are NOT evidence that the live Deepgram service works. The one live test is skipped unless
// DEEPGRAM_API_KEY and DEEPGRAM_LIVE_TEST=1 are both set (it uploads only synthetic audio).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, test } from "node:test";
import {
  fixtureSynthetic, leftoverFiles, makeAuth, makeConfig, makeFakeDiarizer, makeFakeWhisper, postAudio, readFixture, startServer, TEST_SUPABASE_URL,
} from "./helpers.js";
import { MAX_GAP_SECONDS, wordsToSegments } from "../services/deepgram.js";

const KEY = "dg-test-key-NOT-A-REAL-KEY-12345";
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const word = (text, start, end, speaker, speakerConfidence = 0.9) => ({
  word: text.toLowerCase().replace(/[^a-z]/g, ""), punctuated_word: text, start, end, confidence: 0.99,
  ...(speaker === undefined ? {} : { speaker, speaker_confidence: speakerConfidence }),
});
const response = (words, { diarize = true } = {}) => ({
  metadata: diarize ? { diarize_info: { arch: "v2" } } : {},
  results: { channels: [{ alternatives: [{ transcript: words.map((w) => w.punctuated_word).join(" "), words }] }] },
});
const TWO_SPEAKERS = response([word("Hello", 0.25, 0.9, 0), word("world.", 1.6, 2.4, 1)]);

describe("wordsToSegments", () => {
  test("groups consecutive words by speaker and keeps real word timestamps", () => {
    const { segments, intervals } = wordsToSegments(
      [word("Are", 1, 1.2, 0), word("you", 1.2, 1.4, 0), word("eating?", 1.4, 2, 0), word("Twice.", 2.5, 3, 1)],
      { diarizeRan: true },
    );
    assert.deepEqual(segments, [{ start: 1, end: 2, text: "Are you eating?" }, { start: 2.5, end: 3, text: "Twice." }]);
    assert.deepEqual(intervals, [{ speaker: 0, startMs: 1000, endMs: 2000 }, { speaker: 1, startMs: 2500, endMs: 3000 }]);
  });

  test("splits a long pause even for the same speaker, and splits exactly at a speaker change", () => {
    const { segments } = wordsToSegments(
      [word("One.", 0, 0.5, 0), word("Two.", 0.5 + MAX_GAP_SECONDS + 0.1, 2, 0), word("Three.", 2, 2.5, 1), word("Four.", 2.5, 3, 0)],
      { diarizeRan: true },
    );
    assert.deepEqual(segments.map((s) => s.text), ["One.", "Two.", "Three.", "Four."]);
  });

  test("low-confidence speaker runs are left unassigned instead of guessed", () => {
    const { segments, intervals } = wordsToSegments([word("Maybe", 0, 0.5, 0, 0.2), word("so.", 0.5, 1, 0, 0.3)], { diarizeRan: true });
    assert.equal(segments.length, 1);
    assert.deepEqual(intervals, []);
  });

  test("no diarization metadata: no speaker is invented", () => {
    const { segments, intervals } = wordsToSegments([word("Hi.", 0, 1, 0)], { diarizeRan: false });
    assert.equal(segments.length, 1);
    assert.deepEqual(intervals, []);
  });

  test("diarization ran but nobody is labelled (single speaker): one speaker", () => {
    const { intervals } = wordsToSegments([word("Just", 0, 0.5), word("me.", 0.5, 1)], { diarizeRan: true });
    assert.deepEqual(intervals, [{ speaker: 0, startMs: 0, endMs: 1000 }]);
  });

  test("a word without a label in a labelled response stays unassigned", () => {
    const { intervals } = wordsToSegments([word("Hi", 0, 0.4, 0), word("there.", 0.4, 0.9)], { diarizeRan: true });
    assert.deepEqual(intervals, [{ speaker: 0, startMs: 0, endMs: 400 }]);
  });

  test("no words: nothing", () => {
    assert.deepEqual(wordsToSegments([], { diarizeRan: true }), { segments: [], intervals: [] });
  });
});

/** A stand-in for api.deepgram.com that records requests. `reply` decides the response. */
async function startStub(reply) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = { method: req.method, url: new URL(req.url, "http://stub"), headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(record);
    await reply(record, res, req);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}
const json = (status, body) => (_req, res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function setup(stubReply, overrides = {}) {
  const stub = await startStub(stubReply);
  const env = await makeConfig({
    supabaseUrl: TEST_SUPABASE_URL, sttEngine: "deepgram", deepgramApiKey: KEY, deepgramBaseUrl: stub.url, ...overrides,
  });
  cleanups.push(env.cleanup);
  // Local engine stand-ins, used when we fall back.
  env.config.whisperBin = await makeFakeWhisper(env.root, "ok");
  env.config.whisperModel = path.join(env.root, "model.bin");
  await writeFile(env.config.whisperModel, "x");
  env.config.whisperVadModel = null;
  env.config.diarizationPython = await makeFakeDiarizer(env.root, "ok");
  env.config.diarizationScript = env.config.diarizationPython;

  const keys = await makeAuth();
  const server = await startServer(env.config, { jwks: keys.jwks });
  cleanups.push(server.close);
  const token = await keys.sign("doctor-a");
  const upload = async () => {
    const form = new FormData();
    form.append("audio", new Blob([await readFixture()], { type: "audio/wav" }), "visit.wav");
    const res = await fetch(`${server.baseUrl}/api/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, headers: res.headers, text: await res.clone().text(), body: await res.json() };
  };
  return { ...env, ...server, stub, token, upload };
}

describe("Deepgram engine (stub server)", () => {
  test("sends a privacy-preserving request with the key only in the Authorization header", async () => {
    const { upload, stub } = await setup(json(200, TWO_SPEAKERS));
    await upload();
    assert.equal(stub.requests.length, 1);
    const [request] = stub.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url.pathname, "/v1/listen");
    assert.equal(request.url.searchParams.get("mip_opt_out"), "true", "must opt out of model-improvement data use");
    assert.equal(request.url.searchParams.get("diarize_model"), "latest");
    assert.equal(request.url.searchParams.get("model"), "nova-3");
    assert.equal(request.url.searchParams.get("language"), "en");
    assert.equal(request.headers.authorization, `Token ${KEY}`);
    assert.ok(!request.url.search.includes(KEY), "the key must not be in the URL");
    assert.equal(request.headers["content-type"], "audio/wav");
    assert.equal(request.body.subarray(0, 4).toString("ascii"), "RIFF", "sends the normalized WAV, not the raw upload");
  });

  test("maps words and speakers into the standard transcription resource", async () => {
    const { upload, token, baseUrl } = await setup(json(200, TWO_SPEAKERS));
    const { status, body, headers, text } = await upload();
    assert.equal(status, 201);
    assert.equal(body.engine, "deepgram");
    assert.deepEqual(body.diarization, { status: "ok", speakerCount: 2 });
    assert.deepEqual(body.segments, [
      { id: "segment_1", startMs: 250, endMs: 900, text: "Hello", speakerId: "speaker_1" },
      { id: "segment_2", startMs: 1600, endMs: 2400, text: "world.", speakerId: "speaker_2" },
    ]);
    assert.deepEqual(body.speakers.map((s) => s.role), ["unassigned", "unassigned"]);
    assert.equal(body.text, "Hello world.");
    assert.equal(body.reviewStatus, "needs_review");
    assert.ok(!text.includes(KEY) && ![...headers.values()].some((v) => v.includes(KEY)), "the key must never reach clients");

    const again = await (await fetch(`${baseUrl}/api/transcriptions/${body.id}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(again.engine, "deepgram", "the engine is persisted so it is auditable");
  });

  test("diarization that did not run is reported as failed with every speaker null", async () => {
    const { upload } = await setup(json(200, response([word("Hello", 0.25, 0.9, 0), word("world.", 1.6, 2.4, 1)], { diarize: false })));
    const { body } = await upload();
    assert.equal(body.engine, "deepgram");
    assert.equal(body.diarization.status, "failed");
    assert.deepEqual(body.speakers, []);
    assert.ok(body.segments.every((s) => s.speakerId === null));
  });

  for (const [name, reply, overrides] of [
    ["an authentication error (401)", json(401, { err_msg: `bad key ${KEY}` })],
    ["a server error (500)", json(500, { err: "boom" })],
    ["rate limiting (429)", json(429, {})],
    ["malformed JSON", (_req, res) => { res.writeHead(200); res.end("not json"); }],
    ["an unexpected response shape", json(200, { results: {} })],
    ["a timeout", () => {}, { deepgramTimeoutMs: 500 }],
  ]) {
    test(`falls back to the local engine on ${name}`, async () => {
      const { upload, tmpDir } = await setup(reply, overrides ?? {});
      const errors = [];
      const original = console.error;
      console.error = (...args) => { errors.push(args.join(" ")); };
      let result;
      try {
        result = await upload();
      } finally {
        console.error = original;
      }
      assert.equal(result.status, 201);
      assert.equal(result.body.engine, "local");
      assert.deepEqual(result.body.diarization, { status: "ok", speakerCount: 2 });
      assert.equal(result.body.text, "Hello world.");
      assert.ok(!errors.join("\n").includes(KEY), "the API key must not be logged");
      assert.ok(!errors.join("\n").includes("bad key"), "provider error bodies must not be logged");
      assert.deepEqual(await leftoverFiles(tmpDir), []);
    });
  }

  test("falls back when Deepgram is unreachable", async () => {
    const { upload } = await setup(json(200, TWO_SPEAKERS), { deepgramBaseUrl: "http://127.0.0.1:1" });
    const { body } = await upload();
    assert.equal(body.engine, "local");
  });

  test("no speech is a normal 422 and does not fall back or store anything", async () => {
    const { upload, stub } = await setup(json(200, response([])));
    const { status, body } = await upload();
    assert.equal(status, 422);
    assert.equal(body.code, "TRANSCRIPTION_FAILED");
    assert.equal(stub.requests.length, 1);
  });

  test("without an API key the cloud engine is never contacted", async () => {
    const { upload, stub } = await setup(json(200, TWO_SPEAKERS), { deepgramApiKey: "" });
    const { body } = await upload();
    assert.equal(body.engine, "local");
    assert.equal(stub.requests.length, 0);
  });

  test("the default engine is local: no cloud call unless STT_ENGINE=deepgram", async () => {
    const { upload, stub } = await setup(json(200, TWO_SPEAKERS), { sttEngine: "local" });
    assert.equal((await upload()).body.engine, "local");
    assert.equal(stub.requests.length, 0);
  });

  test("the public /api/transcribe never uses Deepgram", async () => {
    const { baseUrl, stub } = await setup(json(200, TWO_SPEAKERS));
    const res = await postAudio(baseUrl, await readFixture());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, "Hello world.");
    assert.equal(stub.requests.length, 0, "unauthenticated audio must not be sent to a third party");
  });

  test("a client disconnect cancels the cloud request and leaves no files", async () => {
    const { baseUrl, token, stub, tmpDir } = await setup(() => {}); // stub never answers
    const controller = new AbortController();
    const form = new FormData();
    form.append("audio", new Blob([await readFixture()], { type: "audio/wav" }), "a.wav");
    const request = fetch(`${baseUrl}/api/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: controller.signal });
    request.catch(() => {});
    for (let i = 0; i < 50 && stub.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(stub.requests.length, 1);
    controller.abort();
    for (let i = 0; i < 50 && (await leftoverFiles(tmpDir)).length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });
});

describe("Deepgram engine (live service)", () => {
  test("transcribes and diarizes a synthetic conversation", async (t) => {
    if (!process.env.DEEPGRAM_API_KEY || process.env.DEEPGRAM_LIVE_TEST !== "1") {
      return t.skip("set DEEPGRAM_API_KEY and DEEPGRAM_LIVE_TEST=1 to send SYNTHETIC audio to Deepgram");
    }
    const env = await makeConfig({ supabaseUrl: TEST_SUPABASE_URL, sttEngine: "deepgram", deepgramApiKey: process.env.DEEPGRAM_API_KEY });
    cleanups.push(env.cleanup);
    const keys = await makeAuth();
    const server = await startServer(env.config, { jwks: keys.jwks });
    cleanups.push(server.close);
    const form = new FormData();
    form.append("audio", new Blob([await readFixture(fixtureSynthetic("two-speaker.wav"))], { type: "audio/wav" }), "two-speaker.wav");
    const res = await fetch(`${server.baseUrl}/api/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${await keys.sign("doctor-live")}` }, body: form });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.engine, "deepgram");
    assert.equal(body.diarization.status, "ok");
    assert.equal(body.speakers.length, 2);
    assert.match(body.text, /headache/i);
  });
});
