// Real speech recognition: FFmpeg + whisper.cpp + the base.en model, no mocks.
// tests/fixtures/jfk.wav is the public-domain JFK sample from the whisper.cpp repo.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import path from "node:path";
import {
  leftoverFiles,
  makeConfig,
  makeWebm,
  jfkWav,
  postAudio,
  readFixture,
  startServer,
} from "./helpers.js";
import { checkReadiness } from "../services/readiness.js";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setupReal() {
  const env = await makeConfig();
  cleanups.push(env.cleanup);
  const { ready, missing } = await checkReadiness(env.config);
  const server = await startServer(env.config);
  cleanups.push(server.close);
  return { ...env, ...server, ready, missing };
}

const EXPECTED = /ask not what your country can do for you, ask what you can do for your country/i;

test("real whisper.cpp transcribes a WAV recording", async (t) => {
  const env = await setupReal();
  if (!env.ready) return t.skip(`missing: ${env.missing.join(", ")}. See server/README.md`);

  const started = Date.now();
  const res = await postAudio(env.baseUrl, await readFixture(jfkWav));
  const elapsedMs = Date.now() - started;

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["durationSeconds", "text"]);
  assert.match(body.text, EXPECTED);
  assert.equal(body.durationSeconds, 11);
  assert.deepEqual(await leftoverFiles(env.tmpDir), []);
  t.diagnostic(`transcribed 11 s of audio in ${elapsedMs} ms`);
});

test("real whisper.cpp transcribes browser-style WebM/Opus audio", async (t) => {
  const env = await setupReal();
  if (!env.ready) return t.skip(`missing: ${env.missing.join(", ")}. See server/README.md`);

  const webm = path.join(env.root, "recording.webm");
  makeWebm(jfkWav, webm);

  const res = await postAudio(env.baseUrl, await readFixture(webm), {
    filename: "recording.webm",
    type: "audio/webm;codecs=opus",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.text, EXPECTED);
  assert.ok(Math.abs(body.durationSeconds - 11) < 0.2, `duration ${body.durationSeconds}`);
  assert.deepEqual(await leftoverFiles(env.tmpDir), []);
});
