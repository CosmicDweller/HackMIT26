// The Deepgram client: exact request parameters, streaming, error classification and secrecy.
// Uses a stub server (see deepgram-stub.js), so this verifies our request/response handling only.
import assert from "node:assert/strict";
import { closeSync, openSync, ftruncateSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { loadConfig } from "../config.js";
import { buildQuery, DeepgramError, requestDeepgram } from "../services/deepgram.js";
import { delayed, fixtureResponse, json, startDeepgramStub } from "./deepgram-stub.js";

const KEY = "dg-test-key-NOT-A-REAL-KEY-12345";
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const tmpFile = (bytes = Buffer.from("fLaC-not-really-audio")) => {
  const file = path.join(os.tmpdir(), `dg-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, bytes);
  cleanups.push(() => unlinkSync(file));
  return file;
};
const clientFor = async (reply, overrides = {}) => {
  const stub = await startDeepgramStub(reply);
  cleanups.push(stub.close);
  return { stub, config: { ...loadConfig({}), deepgramApiKey: KEY, deepgramBaseUrl: stub.url, ...overrides } };
};
const failure = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a DeepgramError");
};

describe("request parameters", () => {
  test("uses exactly the required model, batch diarizer, utterances, formatting and language", () => {
    const query = buildQuery(loadConfig({}));
    assert.equal(query.get("model"), "nova-3-medical");
    assert.equal(query.get("diarize_model"), "latest");
    assert.equal(query.get("utterances"), "true");
    assert.equal(query.get("smart_format"), "true");
    assert.equal(query.get("language"), "en");
    assert.equal(query.get("mip_opt_out"), "true", "audio must not be used to improve Deepgram's models");
  });

  test("never combines diarize=true with diarize_model, and never sends legacy or unsupported parameters", () => {
    const names = [...buildQuery({ ...loadConfig({}), deepgramKeyterms: [] }).keys()].sort();
    assert.deepEqual(names, ["diarize_model", "language", "mip_opt_out", "model", "smart_format", "utterances"]);
    for (const forbidden of ["diarize", "keywords", "punctuate", "multichannel", "diarize_version", "num_speakers", "max_speakers"]) {
      assert.ok(!names.includes(forbidden), forbidden);
    }
  });

  test("keyterm prompting is optional and only sent when configured", () => {
    assert.deepEqual(buildQuery(loadConfig({})).getAll("keyterm"), []);
    const configured = buildQuery({ ...loadConfig({}), deepgramKeyterms: ["metformin", "atorvastatin"] });
    assert.deepEqual(configured.getAll("keyterm"), ["metformin", "atorvastatin"]);
    assert.equal(loadConfig({ DEEPGRAM_KEYTERMS: " a , b ,," }).deepgramKeyterms.join("|"), "a|b");
  });

  test("model and diarizer come from configuration (defaults: nova-3-medical, latest)", () => {
    const config = loadConfig({ DEEPGRAM_MODEL: "nova-3-general", DEEPGRAM_DIARIZE_MODEL: "v2" });
    assert.equal(buildQuery(config).get("model"), "nova-3-general");
    assert.equal(buildQuery(config).get("diarize_model"), "v2");
    const defaults = loadConfig({});
    assert.equal(defaults.deepgramModel, "nova-3-medical");
    assert.equal(defaults.deepgramDiarizeModel, "latest");
  });

  test("a callback URL is only added when provided", () => {
    assert.equal(buildQuery(loadConfig({})).has("callback"), false);
    assert.equal(buildQuery(loadConfig({}), { callbackUrl: "https://x.example/cb" }).get("callback"), "https://x.example/cb");
  });
});

describe("the request on the wire", () => {
  test("posts the file with the key only in the Authorization header", async () => {
    const audio = Buffer.alloc(50_000, 7);
    const { stub, config } = await clientFor(json(200, fixtureResponse("aba")));
    const result = await requestDeepgram(tmpFile(audio), config, { contentType: "audio/flac", timeoutMs: 5000 });
    assert.equal(result.metadata.diarize_info.arch, "v2");
    const [request] = stub.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url.pathname, "/v1/listen");
    assert.equal(request.headers.authorization, `Token ${KEY}`);
    assert.equal(request.headers["content-type"], "audio/flac");
    assert.equal(request.bytes, audio.length, "the whole file arrived");
    assert.ok(!request.url.search.includes(KEY), "the key must not be in the URL");
    assert.equal(request.url.searchParams.get("model"), "nova-3-medical");
  });

  test("streams from disk: a 300 MB file does not balloon memory", async () => {
    const file = path.join(os.tmpdir(), `dg-big-${process.pid}`);
    const fd = openSync(file, "w");
    ftruncateSync(fd, 300 * 1024 * 1024); // sparse: no real disk needed
    closeSync(fd);
    cleanups.push(() => unlinkSync(file));
    const { stub, config } = await clientFor(json(200, fixtureResponse("aba")));
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    await requestDeepgram(file, config, { contentType: "audio/flac", timeoutMs: 60_000 });
    clearInterval(timer);
    assert.equal(stub.requests[0].bytes, 300 * 1024 * 1024);
    assert.ok(peak - before < 150 * 1024 * 1024, `memory grew by ${Math.round((peak - before) / 1048576)} MB`);
  });

  test("onBodySent fires once the whole file has been read for sending", async () => {
    const { config } = await clientFor(json(200, fixtureResponse("aba")));
    let sent = 0;
    await requestDeepgram(tmpFile(), config, { contentType: "audio/flac", onBodySent: () => { sent += 1; } });
    assert.equal(sent, 1);
  });
});

describe("error classification (sanitized, never leaking the key or provider bodies)", () => {
  const cases = [
    [401, {}, "PROVIDER_AUTH_FAILED", false, false],
    [403, { err_msg: "Model access not allowed" }, "PROVIDER_MODEL_UNAVAILABLE", false, false],
    [402, {}, "PROVIDER_ACCOUNT_LIMIT", false, false],
    [429, {}, "PROVIDER_RATE_LIMITED", true, true],
    [504, {}, "PROVIDER_TIMEOUT", true, false],
    [500, {}, "PROVIDER_UNAVAILABLE", true, false],
    [503, {}, "PROVIDER_UNAVAILABLE", true, false],
    [400, { err_msg: "corrupt or unsupported data" }, "PROVIDER_BAD_AUDIO", false, false],
    [415, {}, "PROVIDER_BAD_AUDIO", false, false],
    [400, { err_msg: "Invalid model name: nova-9" }, "PROVIDER_MODEL_UNAVAILABLE", false, false],
  ];
  for (const [status, body, code, retriable, autoRetry] of cases) {
    test(`HTTP ${status} ${JSON.stringify(body).slice(0, 40)} -> ${code}`, async () => {
      const { config } = await clientFor(json(status, { ...body, secret_echo: KEY }));
      const error = await failure(requestDeepgram(tmpFile(), config, { contentType: "audio/flac" }));
      assert.ok(error instanceof DeepgramError);
      assert.equal(error.code, code);
      assert.equal(error.retriable, retriable);
      assert.equal(error.autoRetry, autoRetry, "only failures where nothing was processed may be auto-retried");
      assert.equal(error.message, code, "the message is just the code");
      assert.ok(!JSON.stringify(error).includes(KEY) && !String(error.stack).includes(KEY));
    });
  }

  test("a timeout is never auto-retried (Deepgram may already have processed and billed it)", async () => {
    const { config } = await clientFor(delayed(5000, json(200, {})));
    const error = await failure(requestDeepgram(tmpFile(), config, { contentType: "audio/flac", timeoutMs: 300 }));
    assert.equal(error.code, "PROVIDER_TIMEOUT");
    assert.equal(error.autoRetry, false);
  });

  test("a refused connection (nothing reached Deepgram) may be auto-retried", async () => {
    const { config } = await clientFor(json(200, {}), { deepgramBaseUrl: "http://127.0.0.1:1" });
    const error = await failure(requestDeepgram(tmpFile(), config, { contentType: "audio/flac" }));
    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
    assert.equal(error.autoRetry, true);
  });

  test("an unparseable success body is a malformed response", async () => {
    const { config } = await clientFor((_req, res) => { res.writeHead(200); res.end("not json"); });
    assert.equal((await failure(requestDeepgram(tmpFile(), config, { contentType: "audio/flac" }))).code, "PROVIDER_MALFORMED_RESPONSE");
  });

  test("a missing API key fails before any network request", async () => {
    const { stub, config } = await clientFor(json(200, {}), { deepgramApiKey: "" });
    const error = await failure(requestDeepgram(tmpFile(), config, { contentType: "audio/flac" }));
    assert.equal(error.code, "PROVIDER_NOT_CONFIGURED");
    assert.equal(stub.requests.length, 0);
  });

  test("aborting cancels the request", async () => {
    const { stub, config } = await clientFor(() => {}); // never answers
    const controller = new AbortController();
    const pending = failure(requestDeepgram(tmpFile(), config, { contentType: "audio/flac", signal: controller.signal, timeoutMs: 30_000 }));
    for (let i = 0; i < 50 && stub.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const error = await pending;
    assert.equal(error.status, 499, "cancelled, not a provider error");
  });
});
