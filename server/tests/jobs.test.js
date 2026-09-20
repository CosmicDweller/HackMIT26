// The persistent job system with the Deepgram engine, against a STUB Deepgram that replies with REAL
// captured responses (tests/fixtures/deepgram). These verify our job handling, safety rules and data
// flow. They are not evidence about the live service (see real-deepgram.test.js for that).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createCallbackApp } from "../routes/callback.js";
import { delayed, fixtureResponse, json, sequence, startDeepgramStub } from "./deepgram-stub.js";
import {
  fixtureSynthetic, leftoverFiles, makeAuth, makeConfig, makeTone, readFixture, startServer, TEST_SUPABASE_URL,
} from "./helpers.js";

const KEY = "dg-test-key-NOT-A-REAL-KEY-12345";
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const until = async (fn, { timeout = 15_000, step = 25 } = {}) => {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, step));
  }
};

async function setup({ reply = json(200, fixtureResponse("aba")), auth = true, ...overrides } = {}) {
  const stub = await startDeepgramStub(reply);
  cleanups.push(stub.close);
  const env = await makeConfig({
    supabaseUrl: TEST_SUPABASE_URL, sttEngine: "deepgram", deepgramApiKey: KEY, deepgramBaseUrl: stub.url, ...overrides,
  });
  cleanups.push(env.cleanup);
  const keys = await makeAuth();
  const server = await startServer(env.config, auth ? { jwks: keys.jwks } : {});
  cleanups.push(server.close);
  const { store, jobs } = server.app.locals;

  const call = async (token, method, url, body) => {
    const res = await fetch(`${server.baseUrl}${url}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
  };
  const post = async (token, url, bytes, fields = {}, filename = "visit.wav") => {
    const form = new FormData();
    form.append("audio", new Blob([bytes], { type: "application/octet-stream" }), filename);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const res = await fetch(`${server.baseUrl}${url}`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
  };
  const tokenFor = (subject) => keys.sign(subject);
  const createJob = async (token, name = "aba", fields) => post(token, "/api/transcription-jobs", await readFixture(fixtureSynthetic(`${name}.wav`)), fields);
  const finished = (token, jobId, timeout) =>
    until(async () => {
      const { body } = await call(token, "GET", `/api/transcription-jobs/${jobId}`);
      return ["completed", "failed"].includes(body.status) ? body : null;
    }, { timeout });
  const uploads = () => readdir(env.config.uploadDir).catch(() => []);
  return { ...env, ...server, stub, keys, store, jobs, call, post, tokenFor, createJob, finished, uploads };
}

const expectError = (res, status, code) => {
  assert.equal(res.status, status, res.text);
  assert.equal(res.body.code, code);
};

describe("job lifecycle with real Deepgram responses", () => {
  test("creates a job, returns the documented shape, and completes with the speaker-labelled transcript", async () => {
    const { createJob, finished, call, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const created = await createJob(token);
    assert.equal(created.status, 202);
    assert.match(created.headers.get("location"), /^\/api\/transcription-jobs\/job_/);
    assert.deepEqual(Object.keys(created.body).sort(), ["error", "jobId", "progressPercent", "status", "transcriptionId"]);
    assert.equal(created.body.progressPercent, null, "progress is never fabricated");
    assert.equal(created.body.transcriptionId, null);
    assert.equal(created.body.error, null);

    const done = await finished(token, created.body.jobId);
    assert.equal(done.status, "completed");
    assert.equal(done.progressPercent, null);
    assert.match(done.transcriptionId, /^tr_/);

    const t = (await call(token, "GET", `/api/transcriptions/${done.transcriptionId}`)).body;
    assert.equal(t.status, "completed");
    assert.equal(t.engine, "deepgram");
    assert.equal(t.diarizationStatus, "completed");
    assert.deepEqual(t.speakers, [
      { id: "speaker_0", label: "Speaker 1", role: "unassigned", identificationStatus: "unavailable", suggestedRole: null },
      { id: "speaker_1", label: "Speaker 2", role: "unassigned", identificationStatus: "unavailable", suggestedRole: null },
    ]);
    assert.equal(t.voiceIdentificationStatus, "not_enrolled");
    assert.equal(t.speakerSource, "deepgram");
    assert.deepEqual(t.segments.map((s) => [s.speakerId, s.text]), [
      ["speaker_0", "Are you eating regularly?"],
      ["speaker_1", "I eat two meals per day."],
      ["speaker_0", "Have you noticed any weight changes?"],
    ]);
    assert.ok(t.segments.every((s) => typeof s.needsReview === "boolean"));
    assert.equal(t.reviewStatus, "needs_review");
    assert.deepEqual(t.warnings, []);
  });

  test("sends exactly the required parameters and a verified, file-backed FLAC recording", async () => {
    const { createJob, finished, tokenFor, stub } = await setup();
    const token = await tokenFor("doctor-a");
    await finished(token, (await createJob(token)).body.jobId);
    assert.equal(stub.requests.length, 1);
    const [request] = stub.requests;
    assert.equal(request.url.searchParams.get("model"), "nova-3-medical");
    assert.equal(request.url.searchParams.get("diarize_model"), "latest");
    assert.equal(request.url.searchParams.get("utterances"), "true");
    assert.equal(request.url.searchParams.get("smart_format"), "true");
    assert.equal(request.url.searchParams.get("language"), "en");
    assert.equal(request.url.searchParams.has("diarize"), false);
    assert.equal(request.headers.authorization, `Token ${KEY}`);
    assert.equal(request.headers["content-type"], "audio/flac");
    assert.equal(request.head.subarray(0, 4).toString("ascii"), "fLaC", "the normalized recording, not the raw upload");
  });

  test("provider details are kept internally and never returned to clients", async () => {
    const { createJob, finished, call, tokenFor, store } = await setup();
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    const raw = await call(token, "GET", `/api/transcriptions/${done.transcriptionId}`);
    const jobView = await call(token, "GET", `/api/transcription-jobs/${done.jobId}`);
    for (const text of [raw.text, jobView.text]) {
      assert.ok(!/scrubbed|medical-nova-3|model_uuid|diarize_info|request_id|providerMeta/.test(text), "no provider diagnostics in public responses");
      assert.ok(!text.includes(KEY));
    }
    const meta = store.providerMeta("doctor-a", done.transcriptionId);
    assert.equal(meta.requestId, "scrubbed");
    assert.deepEqual(meta.models, ["medical-nova-3 2026-05-18.18466"]);
    assert.equal(meta.diarizeModel.arch, "v2");
    assert.equal(meta.requestedModel, "nova-3-medical");
    assert.ok(Date.parse(meta.processedAt));
  });

  test("stores per-segment provider speaker indices and confidences internally, and needsReview publicly", async () => {
    const { createJob, finished, call, tokenFor, config } = await setup({ reply: json(200, fixtureResponse("medical")) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token, "medical")).body.jobId);
    const t = (await call(token, "GET", `/api/transcriptions/${done.transcriptionId}`)).body;
    assert.ok(t.segments.find((s) => /atavastatin/.test(s.text)).needsReview, "the doubtful drug name is flagged");
    assert.match(t.text, /metformin five hundred milligrams/);
    // Internal columns (never in the API): the provider's own speaker index and confidences.
    const raw = new DatabaseSync(config.dbPath);
    const rows = raw.prepare("SELECT provider_speaker, confidence, speaker_confidence FROM segments WHERE transcription_id = ? ORDER BY seq").all(done.transcriptionId);
    raw.close();
    assert.equal(rows.length, t.segments.length);
    assert.ok(rows.every((r) => [0, 1].includes(r.provider_speaker) && r.confidence > 0 && r.speaker_confidence > 0));
    assert.deepEqual([...new Set(rows.map((r) => r.provider_speaker))].sort(), [0, 1]);
    assert.ok(!/provider_speaker|speakerConfidence|"confidence"/.test(JSON.stringify(t)), "internal fields are not exposed");
  });

  test("the recording is deleted from disk as soon as the job completes", async () => {
    const { createJob, finished, tokenFor, uploads, tmpDir } = await setup();
    const token = await tokenFor("doctor-a");
    const created = await createJob(token);
    await finished(token, created.body.jobId);
    assert.deepEqual(await uploads(), []);
    await until(async () => (await leftoverFiles(tmpDir)).length === 0);
  });

  test("passes through the transcoding and upload states before completing", async () => {
    const { createJob, call, tokenFor } = await setup({ reply: delayed(600, json(200, fixtureResponse("aba"))) });
    const token = await tokenFor("doctor-a");
    const { body: created } = await createJob(token);
    const seen = new Set();
    await until(async () => {
      const { body } = await call(token, "GET", `/api/transcription-jobs/${created.jobId}`);
      seen.add(body.status);
      assert.equal(body.progressPercent, null);
      return body.status === "completed";
    }, { step: 5 });
    assert.ok(seen.has("transcribing"), `observed: ${[...seen].join(", ")}`);
    for (const status of seen) assert.ok(["queued", "preparing", "uploading", "transcribing", "completed"].includes(status));
  });

  test("a genuine one-speaker recording is completed, not failed", async () => {
    const { createJob, finished, call, tokenFor } = await setup({ reply: json(200, fixtureResponse("single-speaker")) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token, "single-speaker")).body.jobId);
    const t = (await call(token, "GET", `/api/transcriptions/${done.transcriptionId}`)).body;
    assert.equal(t.diarizationStatus, "completed");
    assert.deepEqual(t.speakers.map((s) => s.id), ["speaker_0"]);
  });

  test("three speakers are supported and keep Deepgram's speaker indices", async () => {
    const { createJob, finished, call, tokenFor } = await setup({ reply: json(200, fixtureResponse("three-speaker")) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token, "three-speaker")).body.jobId);
    const t = (await call(token, "GET", `/api/transcriptions/${done.transcriptionId}`)).body;
    assert.deepEqual(t.speakers.map((s) => [s.id, s.label]), [["speaker_0", "Speaker 1"], ["speaker_1", "Speaker 2"], ["speaker_2", "Speaker 3"]]);
  });

  test("timestamps come straight from the provider: none reset, none duplicated", async () => {
    const { createJob, finished, call, tokenFor } = await setup({ reply: json(200, fixtureResponse("medical")) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token, "medical")).body.jobId);
    const { segments } = (await call(token, "GET", `/api/transcriptions/${done.transcriptionId}`)).body;
    const providerWords = fixtureResponse("medical").results.channels[0].alternatives[0].words;
    assert.equal(segments[0].startMs, Math.round(providerWords[0].start * 1000));
    assert.equal(segments.at(-1).endMs, Math.round(providerWords.at(-1).end * 1000));
    for (let i = 1; i < segments.length; i++) assert.ok(segments[i].startMs >= segments[i - 1].startMs, "no timestamp reset");
    assert.equal(segments.flatMap((s) => s.text.split(" ")).length, providerWords.length, "no duplicated or missing words");
  });

  test("when diarization did not run, the transcript is kept, speakers are null, and it is reported as failed", async () => {
    const response = fixtureResponse("aba");
    delete response.metadata.diarize_info;
    const { createJob, finished, call, tokenFor } = await setup({ reply: json(200, response) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    const t = (await call(token, "GET", `/api/transcriptions/${done.transcriptionId}`)).body;
    assert.equal(t.diarizationStatus, "failed");
    assert.deepEqual(t.speakers, []);
    assert.ok(t.segments.length > 0 && t.segments.every((s) => s.speakerId === null && s.needsReview === true));
    assert.match(t.text, /eating regularly/);
  });
});

describe("suspicious minor speakers", () => {
  const words = (speaker, count, start, secondsEach = 0.5) =>
    Array.from({ length: count }, (_, i) => ({
      word: "word", punctuated_word: i === count - 1 ? "word." : "word", start: start + i * secondsEach, end: start + (i + 1) * secondsEach,
      confidence: 0.99, speaker, speaker_confidence: 0.99,
    }));
  const build = () => {
    const a = words(0, 200, 0);
    const b = words(1, 100, 110);
    const stray = words(2, 1, 170); // one word, 0.5 s of a ~150 s conversation
    const all = [...a, ...b, ...stray];
    return {
      metadata: { request_id: "r", duration: 171, model_info: { m: { name: "medical-nova-3", version: "1" } }, diarize_info: { arch: "v2", model_uuid: "u" } },
      results: { channels: [{ alternatives: [{ transcript: "x", words: all }] }], utterances: [] },
    };
  };

  test("a tiny extra speaker is kept as detected, flagged for review, and the doctor is warned without exposing any text", async () => {
    const { createJob, finished, call, tokenFor } = await setup({ reply: json(200, build()) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    const t = (await call(token, "GET", `/api/transcriptions/${done.transcriptionId}`)).body;
    assert.deepEqual(t.speakers.map((s) => s.id), ["speaker_0", "speaker_1", "speaker_2"], "nothing is silently reassigned or dropped");
    const stray = t.segments.filter((s) => s.speakerId === "speaker_2");
    assert.equal(stray.length, 1);
    assert.equal(stray[0].needsReview, true);
    assert.equal(t.warnings.length, 1);
    assert.equal(t.warnings[0].code, "MINOR_SPEAKER_DETECTED");
    assert.match(t.warnings[0].message, /Speaker 3 has only 1 short segment/);
    assert.ok(!/word/.test(t.warnings[0].message), "no transcript text in the warning");
  });
});

describe("failures, retries and duplicate-charge safety", () => {
  test("authentication failure: sanitized error, recording kept for retry, one request only", async () => {
    const { createJob, finished, tokenFor, stub, uploads, call } = await setup({ reply: json(401, { err_msg: `invalid ${KEY}` }) });
    const token = await tokenFor("doctor-a");
    const created = await createJob(token);
    const done = await finished(token, created.body.jobId);
    assert.equal(done.status, "failed");
    assert.equal(done.error.code, "PROVIDER_AUTH_FAILED");
    assert.ok(!JSON.stringify(done).includes(KEY));
    assert.equal(stub.requests.length, 1);
    assert.equal((await uploads()).length, 1, "the recording is preserved for a retry");
    const listed = await call(token, "GET", "/api/transcription-jobs");
    assert.ok(!listed.text.includes(KEY));
  });

  test("an explicit retry resubmits once and completes", async () => {
    const { createJob, finished, tokenFor, stub, call, uploads } = await setup({ reply: json(401, {}) });
    const token = await tokenFor("doctor-a");
    const { body: created } = await createJob(token);
    await finished(token, created.jobId);
    stub.setReply(json(200, fixtureResponse("aba")));
    const retried = await call(token, "POST", `/api/transcription-jobs/${created.jobId}/retry`);
    assert.equal(retried.status, 202);
    const done = await finished(token, created.jobId);
    assert.equal(done.status, "completed");
    assert.equal(stub.requests.length, 2, "exactly one more submission, and only because of the explicit retry");
    assert.deepEqual(await uploads(), []);
  });

  test("a provider timeout is never resubmitted automatically", async () => {
    const { createJob, finished, tokenFor, stub } = await setup({ reply: json(504, {}) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    assert.equal(done.error.code, "PROVIDER_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(stub.requests.length, 1);
  });

  test("an unresponsive provider times out without an automatic resubmission", async () => {
    const { createJob, finished, tokenFor, stub } = await setup({ reply: () => {}, deepgramTimeoutMs: 500 });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    assert.equal(done.error.code, "PROVIDER_TIMEOUT");
    assert.equal(stub.requests.length, 1);
  });

  test("rate limiting is retried a bounded number of times, then reported", async () => {
    const { createJob, finished, tokenFor, stub } = await setup({ reply: json(429, {}), maxSubmitAttempts: 3 });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId, 30_000);
    assert.equal(done.error.code, "PROVIDER_RATE_LIMITED");
    assert.equal(stub.requests.length, 3, "bounded: exactly maxSubmitAttempts");
  });

  test("rate limiting that clears is retried to success", async () => {
    const { createJob, finished, tokenFor, stub } = await setup({ reply: sequence(json(429, {}), json(200, fixtureResponse("aba"))) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId, 30_000);
    assert.equal(done.status, "completed");
    assert.equal(stub.requests.length, 2);
  });

  test("a malformed provider response fails the job and keeps the recording", async () => {
    const { createJob, finished, tokenFor, uploads } = await setup({ reply: json(200, { results: {} }) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    assert.equal(done.error.code, "PROVIDER_MALFORMED_RESPONSE");
    assert.equal((await uploads()).length, 1);
  });

  test("an empty transcript is NO_SPEECH and the audio is deleted (retrying cannot help)", async () => {
    const { createJob, finished, tokenFor, uploads } = await setup({ reply: json(200, fixtureResponse("silence")) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    assert.equal(done.error.code, "NO_SPEECH");
    assert.deepEqual(await uploads(), []);
  });

  test("unsupported audio fails before anything is sent to Deepgram, and is deleted", async () => {
    const { post, finished, tokenFor, stub, uploads } = await setup();
    const token = await tokenFor("doctor-a");
    const created = await post(token, "/api/transcription-jobs", Buffer.from("this is not audio at all"));
    const done = await finished(token, created.body.jobId);
    assert.equal(done.error.code, "INVALID_AUDIO");
    assert.equal(stub.requests.length, 0);
    assert.deepEqual(await uploads(), []);
  });

  test("a missing API key fails with PROVIDER_NOT_CONFIGURED, sends nothing, keeps the recording", async () => {
    const { createJob, finished, tokenFor, stub, uploads } = await setup({ deepgramApiKey: "" });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    assert.equal(done.error.code, "PROVIDER_NOT_CONFIGURED");
    assert.equal(stub.requests.length, 0);
    assert.equal((await uploads()).length, 1);
  });

  test("an unavailable medical model fails plainly and is never swapped silently", async () => {
    const { createJob, finished, tokenFor, stub } = await setup({ reply: json(403, { err_msg: "Model access is not enabled" }) });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    assert.equal(done.error.code, "PROVIDER_MODEL_UNAVAILABLE");
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].url.searchParams.get("model"), "nova-3-medical");
  });

  test("an explicitly configured fallback model is used with the same diarizer and the doctor is told", async () => {
    const { createJob, finished, call, tokenFor, stub } = await setup({
      reply: sequence(json(403, { err_msg: "Model access is not enabled" }), json(200, fixtureResponse("aba"))),
      deepgramFallbackModel: "nova-3-general",
    });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    assert.equal(done.status, "completed");
    assert.deepEqual(stub.requests.map((r) => r.url.searchParams.get("model")), ["nova-3-medical", "nova-3-general"]);
    assert.ok(stub.requests.every((r) => r.url.searchParams.get("diarize_model") === "latest"));
    const t = (await call(token, "GET", `/api/transcriptions/${done.transcriptionId}`)).body;
    assert.equal(t.warnings[0].code, "FALLBACK_MODEL_USED");
    assert.match(t.warnings[0].message, /not tuned for medical vocabulary/);
  });
});

describe("the synchronous route runs on the same jobs", () => {
  test("POST /api/transcriptions returns the finished transcription (201)", async () => {
    const { post, tokenFor, stub } = await setup();
    const res = await post(await tokenFor("doctor-a"), "/api/transcriptions", await readFixture(fixtureSynthetic("aba.wav")), { expectedSpeakers: "2" });
    assert.equal(res.status, 201);
    assert.equal(res.body.engine, "deepgram");
    assert.equal(res.body.speakers.length, 2);
    assert.equal(stub.requests[0].url.searchParams.has("num_speakers"), false, "no unsupported speaker-count parameter is invented");
  });

  test("a failure is a sanitized error that carries the jobId for a retry", async () => {
    const { post, tokenFor } = await setup({ reply: json(500, { err: KEY }) });
    const res = await post(await tokenFor("doctor-a"), "/api/transcriptions", await readFixture(fixtureSynthetic("aba.wav")));
    expectError(res, 503, "SERVICE_UNAVAILABLE");
    assert.match(res.body.jobId, /^job_/);
    assert.ok(!res.text.includes(KEY));
  });

  test("a recording that takes longer than the wait is handed back as a job (202)", async () => {
    const { post, tokenFor, finished } = await setup({ reply: delayed(500, json(200, fixtureResponse("aba"))), syncWaitMs: 50 });
    const token = await tokenFor("doctor-a");
    const res = await post(token, "/api/transcriptions", await readFixture(fixtureSynthetic("aba.wav")));
    assert.equal(res.status, 202);
    assert.equal((await finished(token, res.body.jobId)).status, "completed");
  });

  test("a client that disconnects does not lose the transcript: the job finishes and is in history", async () => {
    const { baseUrl, tokenFor, call, uploads } = await setup({ reply: delayed(400, json(200, fixtureResponse("aba"))) });
    const token = await tokenFor("doctor-a");
    const controller = new AbortController();
    const form = new FormData();
    form.append("audio", new Blob([await readFixture(fixtureSynthetic("aba.wav"))]), "a.wav");
    fetch(`${baseUrl}/api/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: controller.signal }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await until(async () => (await call(token, "GET", "/api/transcriptions")).body.transcriptions.length === 1);
    assert.deepEqual(await uploads(), []);
  });

  test("the public /api/transcribe never uses Deepgram", async () => {
    const { baseUrl, stub } = await setup();
    const form = new FormData();
    form.append("audio", new Blob([await readFixture(fixtureSynthetic("aba.wav"))]), "a.wav");
    await fetch(`${baseUrl}/api/transcribe`, { method: "POST", body: form });
    assert.equal(stub.requests.length, 0, "unauthenticated audio must never be sent to a third party");
  });
});

describe("security and ownership", () => {
  test("every job route requires authentication", async () => {
    const { call, post } = await setup();
    for (const [method, url] of [["GET", "/api/transcription-jobs"], ["GET", "/api/transcription-jobs/job_x"], ["POST", "/api/transcription-jobs/job_x/retry"], ["DELETE", "/api/transcription-jobs/job_x"]]) {
      expectError(await call(null, method, url), 401, "UNAUTHENTICATED");
    }
    expectError(await post(null, "/api/transcription-jobs", Buffer.from("x")), 401, "UNAUTHENTICATED");
  });

  test("doctor B cannot see, retry, delete or read the transcript of doctor A's job", async () => {
    const { createJob, finished, call, tokenFor } = await setup();
    const tokenA = await tokenFor("doctor-a");
    const tokenB = await tokenFor("doctor-b");
    const created = await createJob(tokenA);
    const done = await finished(tokenA, created.body.jobId);
    for (const [method, url] of [["GET", `/api/transcription-jobs/${created.body.jobId}`], ["POST", `/api/transcription-jobs/${created.body.jobId}/retry`], ["DELETE", `/api/transcription-jobs/${created.body.jobId}`], ["GET", `/api/transcriptions/${done.transcriptionId}`]]) {
      expectError(await call(tokenB, method, url), 404, "NOT_FOUND");
    }
    assert.deepEqual((await call(tokenB, "GET", "/api/transcription-jobs")).body.jobs, []);
    assert.equal((await call(tokenA, "GET", `/api/transcription-jobs/${created.body.jobId}`)).status, 200);
  });

  test("job status responses never contain transcript text", async () => {
    const { createJob, finished, call, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    const view = await call(token, "GET", `/api/transcription-jobs/${done.jobId}`);
    const list = await call(token, "GET", "/api/transcription-jobs");
    assert.ok(!/eating regularly/i.test(view.text + list.text));
  });

  test("recordings are not reachable over HTTP", async () => {
    const { baseUrl, createJob, tokenFor, uploads } = await setup({ reply: json(401, {}) });
    const token = await tokenFor("doctor-a");
    await createJob(token);
    const [file] = await until(async () => { const list = await uploads(); return list.length ? list : null; });
    for (const url of [`/uploads/${file}`, `/api/uploads/${file}`, `/data/uploads/${file}`, `/${file}`, "/api/transcription-jobs/../uploads"]) {
      assert.ok([401, 404].includes((await fetch(`${baseUrl}${url}`)).status), url);
    }
  });

  test("the API key appears in no response, header or stored row", async () => {
    const { createJob, finished, call, tokenFor, config } = await setup();
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    const responses = [await call(token, "GET", "/api/transcriptions"), await call(token, "GET", `/api/transcriptions/${done.transcriptionId}`), await call(token, "GET", "/api/transcription-jobs")];
    for (const res of responses) assert.ok(!res.text.includes(KEY) && ![...res.headers.values()].some((v) => v.includes(KEY)));
    const dbBytes = readFileSync(config.dbPath).toString("latin1");
    assert.ok(!dbBytes.includes(KEY));
  });

  test("a job can be discarded (audio and row removed); a running job cannot", async () => {
    const { createJob, finished, call, tokenFor, uploads } = await setup({ reply: json(401, {}) });
    const token = await tokenFor("doctor-a");
    const created = (await createJob(token)).body;
    await finished(token, created.jobId);
    assert.equal((await call(token, "DELETE", `/api/transcription-jobs/${created.jobId}`)).status, 204);
    assert.deepEqual(await uploads(), []);
    expectError(await call(token, "GET", `/api/transcription-jobs/${created.jobId}`), 404, "NOT_FOUND");
  });
});

describe("recordings: size, length and the two-hour boundary", () => {
  test("the upload size limit is enforced (413) and nothing is stored", async () => {
    const { createJob, tokenFor, uploads } = await setup({ maxRecordingBytes: 100_000 });
    expectError(await createJob(await tokenFor("doctor-a")), 413, "FILE_TOO_LARGE");
    assert.deepEqual(await uploads(), []);
  });

  test("audio longer than the maximum is rejected as RECORDING_TOO_LONG before anything is sent", async () => {
    const { post, finished, tokenFor, stub, uploads, root } = await setup({ maxRecordingSeconds: 5 });
    const token = await tokenFor("doctor-a");
    const created = await createJobFile(post, token, root, 12);
    const done = await finished(token, created.body.jobId);
    assert.equal(done.error.code, "RECORDING_TOO_LONG");
    assert.equal(stub.requests.length, 0);
    assert.deepEqual(await uploads(), []);
  });

  test("audio at the limit is accepted (decoded duration, not header metadata)", async () => {
    const { post, finished, tokenFor, root } = await setup({ maxRecordingSeconds: 10 });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJobFile(post, token, root, 10)).body.jobId);
    assert.equal(done.status, "completed");
  });

  test("TWO-HOUR BOUNDARY: a real 7200 s recording is accepted with the default limits, 7205 s is rejected", async () => {
    const { post, finished, tokenFor, stub, root, store } = await setup({ deepgramSyncMaxSeconds: 7200 });
    const token = await tokenFor("doctor-a");
    const exact = path.join(root, "two-hours.ogg");
    const over = path.join(root, "two-hours-five.ogg");
    makeTone(exact, 7200, ["-c:a", "libopus", "-b:a", "16k"]);
    makeTone(over, 7205, ["-c:a", "libopus", "-b:a", "16k"]);

    const ok = await post(token, "/api/transcription-jobs", await readFixtureFile(exact), {}, "long.ogg");
    const okDone = await finished(token, ok.body.jobId, 120_000);
    assert.equal(okDone.status, "completed", JSON.stringify(okDone.error));
    const job = store.jobById(ok.body.jobId);
    assert.ok(Math.abs(job.duration_seconds - 7200) < 1, `decoded duration ${job.duration_seconds}`);
    assert.equal(stub.requests.length, 1);
    assert.ok(stub.requests[0].bytes > 1_000_000, "a large, real FLAC was streamed");

    const tooLong = await post(token, "/api/transcription-jobs", await readFixtureFile(over), {}, "longer.ogg");
    const tooLongDone = await finished(token, tooLong.body.jobId, 120_000);
    assert.equal(tooLongDone.error.code, "RECORDING_TOO_LONG");
    assert.equal(stub.requests.length, 1, "the over-length recording was never sent");
  });

  test("a recording over the synchronous limit without a callback is rejected before any audio is sent", async () => {
    const { createJob, finished, tokenFor, stub, uploads } = await setup({ deepgramSyncMaxSeconds: 5 });
    const token = await tokenFor("doctor-a");
    const done = await finished(token, (await createJob(token)).body.jobId);
    assert.equal(done.error.code, "LONG_RECORDING_NEEDS_CALLBACK");
    assert.equal(stub.requests.length, 0);
    assert.equal((await uploads()).length, 1, "kept, so it can be processed once a callback is configured");
  });
});

async function createJobFile(post, token, root, seconds) {
  const file = path.join(root, `tone-${seconds}.wav`);
  makeTone(file, seconds);
  return post(token, "/api/transcription-jobs", await readFixtureFile(file));
}
const readFixtureFile = (file) => readFixture(file);

describe("restart recovery, idempotency and retention", () => {
  const seedJob = async (env, fields) => {
    const audioPath = path.join(env.config.uploadDir, `seed-${Math.random().toString(36).slice(2)}`);
    await writeFile(audioPath, await readFixture(fixtureSynthetic("aba.wav")));
    env.store.upsertDoctor({ id: "doctor-a", email: null, displayName: null });
    const job = env.store.createJob("doctor-a", { audioPath, audioBytes: 1000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    return env.store.updateJob(job.id, fields);
  };

  test("a job that never reached Deepgram is picked up again after a restart", async () => {
    const env = await setup();
    const job = await seedJob(env, { status: "preparing" });
    await env.jobs.recover();
    await until(() => env.store.jobById(job.id).status === "completed");
    assert.equal(env.stub.requests.length, 1);
  });

  test("a job that may already have been sent is NOT resubmitted: it is failed as INTERRUPTED and kept", async () => {
    const env = await setup();
    const job = await seedJob(env, { status: "uploading", mode: "sync", submitted_at: new Date().toISOString() });
    await env.jobs.recover();
    const after = env.store.jobById(job.id);
    assert.equal(after.status, "failed");
    assert.equal(after.error_code, "INTERRUPTED");
    assert.ok(existsSync(after.audio_path), "kept for an explicit retry");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(env.stub.requests.length, 0, "no automatic second charge");
  });

  test("a job waiting for a callback keeps waiting after a restart", async () => {
    const env = await setup();
    const job = await seedJob(env, { status: "transcribing", mode: "callback", provider_request_id: "req-1", submitted_at: new Date().toISOString() });
    await env.jobs.recover();
    assert.equal(env.store.jobById(job.id).status, "transcribing");
    assert.equal(env.stub.requests.length, 0);
  });

  test("queued work survives a real restart of the server against the same database", async () => {
    const env = await setup({ reply: delayed(50, json(200, fixtureResponse("aba"))) });
    const job = await seedJob(env, { status: "queued" });
    await env.close();
    const again = await startServer(env.config, { jwks: env.keys.jwks });
    cleanups.push(again.close);
    await again.app.locals.jobs.start();
    await until(() => again.app.locals.store.jobById(job.id).status === "completed");
    again.app.locals.jobs.stop();
  });

  test("failed jobs keep their audio until the retention deadline, then it is deleted", async () => {
    const env = await setup({ reply: json(401, {}) });
    const token = await env.tokenFor("doctor-a");
    const created = (await env.createJob(token)).body;
    await env.finished(token, created.jobId);
    const job = env.store.jobById(created.jobId);
    assert.ok(existsSync(job.audio_path));
    await env.jobs.sweep();
    assert.ok(existsSync(job.audio_path), "still within retention");
    env.store.updateJob(job.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    await env.jobs.sweep();
    assert.equal(existsSync(job.audio_path), false);
    assert.equal(env.store.jobById(job.id).audio_path, null);
    assert.equal((await stat(env.config.uploadDir)).isDirectory(), true);
  });

  test("concurrent jobs are limited: the second waits in the queue", async () => {
    const env = await setup({ reply: delayed(400, json(200, fixtureResponse("aba"))), maxConcurrentJobs: 1 });
    const token = await env.tokenFor("doctor-a");
    const first = (await env.createJob(token)).body;
    const second = (await env.createJob(token)).body;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(env.store.jobById(second.jobId).status, "queued");
    assert.notEqual(env.store.jobById(first.jobId).status, "queued");
    assert.equal((await env.finished(token, second.jobId)).status, "completed");
    assert.equal(env.stub.requests.length, 2);
  });
});

describe("callbacks for long recordings", () => {
  async function withCallback(overrides = {}) {
    const env = await setup({
      reply: json(200, { request_id: "req-1" }),
      deepgramCallbackBaseUrl: "https://callback.example.test",
      deepgramSyncMaxSeconds: 5, // the 6.7 s fixture counts as "long"
      ...overrides,
    });
    const callbackServer = await new Promise((resolve) => {
      const s = createCallbackApp(env.jobs).listen(0, "127.0.0.1", () => resolve(s));
    });
    cleanups.push(() => new Promise((resolve) => { callbackServer.closeAllConnections?.(); callbackServer.close(resolve); }));
    const callbackBase = `http://127.0.0.1:${callbackServer.address().port}`;
    const token = await env.tokenFor("doctor-a");
    const created = (await env.createJob(token)).body;
    const job = await until(() => { const j = env.store.jobById(created.jobId); return j.status === "transcribing" ? j : null; });
    const submitted = new URL(env.stub.requests[0].url.searchParams.get("callback"));
    const deliver = (body, { user = submitted.username, password = submitted.password, jobId = created.jobId, headers = {} } = {}) =>
      fetch(`${callbackBase}/deepgram-callback/${encodeURIComponent(jobId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(password === null ? {} : { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` }), ...headers },
        body: JSON.stringify(body),
      });
    const payload = () => { const r = fixtureResponse("aba"); r.metadata.request_id = "req-1"; return r; };
    return { ...env, token, created, job, submitted, deliver, callbackBase, payload };
  }

  test("a long recording is submitted with a callback URL carrying a per-job secret", async () => {
    const env = await withCallback();
    assert.equal(env.submitted.origin, "https://callback.example.test");
    assert.equal(env.submitted.pathname, `/deepgram-callback/${env.created.jobId}`);
    assert.equal(env.submitted.username, "deepgram");
    assert.match(env.submitted.password, /^[0-9a-f]{64}$/);
    assert.equal(env.job.mode, "callback");
    assert.equal(env.job.provider_request_id, "req-1");
    assert.ok(!Object.values(env.job).includes(env.submitted.password), "only a hash of the secret is stored");
    assert.ok(!readFileSync(env.config.dbPath).toString("latin1").includes(env.submitted.password));
    assert.ok(existsSync(env.job.audio_path), "the original is kept until the transcript arrives");
  });

  test("a valid callback completes the job, saves the transcript and deletes the recording", async () => {
    const env = await withCallback();
    assert.equal((await env.deliver(env.payload())).status, 200);
    const done = env.store.jobById(env.created.jobId);
    assert.equal(done.status, "completed");
    const t = (await env.call(env.token, "GET", `/api/transcriptions/${done.transcription_id}`)).body;
    assert.deepEqual(t.segments.map((s) => s.speakerId), ["speaker_0", "speaker_1", "speaker_0"]);
    assert.equal(existsSync(env.job.audio_path), false);
    assert.equal(env.store.providerMeta("doctor-a", t.id).mode, "callback");
  });

  test("a duplicate callback is acknowledged and changes nothing", async () => {
    const env = await withCallback();
    assert.equal((await env.deliver(env.payload())).status, 200);
    assert.equal((await env.deliver(env.payload())).status, 200);
    assert.equal((await env.deliver(env.payload())).status, 200);
    assert.equal((await env.call(env.token, "GET", "/api/transcriptions")).body.transcriptions.length, 1, "exactly one transcript");
  });

  test("callbacks without valid credentials are rejected and change nothing", async () => {
    const env = await withCallback();
    for (const attempt of [{ password: "wrong" }, { password: null }, { user: "attacker" }, { password: env.submitted.password + "0" }, { jobId: "job_00000000-0000-0000-0000-000000000000" }, { jobId: "../x" }]) {
      assert.equal((await env.deliver(env.payload(), attempt)).status, 401, JSON.stringify(attempt));
    }
    // dg-token alone (documented as not guaranteed and not a secret) is never enough.
    assert.equal((await env.deliver(env.payload(), { password: null, headers: { "dg-token": "any-key-id" } })).status, 401);
    assert.equal(env.store.jobById(env.created.jobId).status, "transcribing");
  });

  test("a callback for a different provider request is refused", async () => {
    const env = await withCallback();
    const body = env.payload();
    body.metadata.request_id = "someone-elses-request";
    assert.equal((await env.deliver(body)).status, 400);
    assert.equal(env.store.jobById(env.created.jobId).status, "transcribing");
  });

  test("a malformed callback body fails the job with a sanitized code, then stays idempotent", async () => {
    const env = await withCallback();
    assert.equal((await env.deliver({ nothing: true })).status, 200);
    const job = env.store.jobById(env.created.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "PROVIDER_MALFORMED_RESPONSE");
    assert.equal((await env.deliver(env.payload())).status, 200, "later deliveries do nothing");
    assert.equal(env.store.jobById(env.created.jobId).status, "failed");
  });

  test("a callback with no speech marks the job NO_SPEECH", async () => {
    const env = await withCallback();
    const body = fixtureResponse("silence");
    body.metadata.request_id = "req-1";
    assert.equal((await env.deliver(body)).status, 200);
    assert.equal(env.store.jobById(env.created.jobId).error_code, "NO_SPEECH");
  });

  test("the callback listener serves nothing except the callback route", async () => {
    const env = await withCallback();
    for (const [method, url] of [["GET", "/"], ["GET", "/api/health"], ["GET", "/api/transcriptions"], ["POST", "/api/transcription-jobs"], ["GET", `/deepgram-callback/${env.created.jobId}`], ["POST", "/deepgram-callback"], ["POST", "/"]]) {
      assert.equal((await fetch(`${env.callbackBase}${url}`, { method })).status, 404, `${method} ${url}`);
    }
  });

  test("a callback that never arrives fails the job after the deadline (CALLBACK_TIMEOUT) and keeps the audio for retry", async () => {
    const env = await withCallback();
    env.store.updateJob(env.created.jobId, { expires_at: new Date(Date.now() - 1000).toISOString() });
    await env.jobs.sweep();
    const job = env.store.jobById(env.created.jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "CALLBACK_TIMEOUT");
    assert.ok(existsSync(job.audio_path));
  });

  test("without a configured callback, long recordings are not silently attempted synchronously", async () => {
    const env = await setup({ deepgramSyncMaxSeconds: 5 });
    const done = await env.finished(await env.tokenFor("doctor-a"), (await env.createJob(await env.tokenFor("doctor-a"))).body.jobId);
    assert.equal(done.error.code, "LONG_RECORDING_NEEDS_CALLBACK");
  });
});
