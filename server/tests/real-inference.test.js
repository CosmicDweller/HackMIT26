// Real speech recognition: FFmpeg + whisper.cpp + the small.en model with VAD, no mocks.
// tests/fixtures/jfk.wav is the public-domain JFK sample from the whisper.cpp repo.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";
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
import { fileExists } from "../lib/exec.js";

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

const EXPECTED = /ask not what your country can do for you[,.] ask what you can do for your country/i;

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

// Whisper alone hallucinates "you" / "Thank you." on silence and quiet noise. These use
// the real model with voice activity detection and must report "no speech".
for (const [name, source] of [
  ["digital silence", "anullsrc=r=16000:cl=mono"],
  ["quiet background noise", "anoisesrc=color=pink:amplitude=0.02:r=16000"],
]) {
  test(`real whisper.cpp reports no speech for ${name}`, async (t) => {
    const env = await setupReal();
    if (!env.ready) return t.skip(`missing: ${env.missing.join(", ")}. See server/README.md`);
    if (!env.config.whisperVadModel || !(await fileExists(env.config.whisperVadModel))) {
      return t.skip("VAD model missing. Run `npm run setup:model`");
    }

    const wav = path.join(env.root, "input.wav");
    const made = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", source, "-t", "4", wav]);
    assert.equal(made.status, 0);

    const res = await postAudio(env.baseUrl, await readFixture(wav));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, "TRANSCRIPTION_FAILED");
    assert.match(body.error, /No speech/);
    assert.deepEqual(await leftoverFiles(env.tmpDir), []);
  });
}

// Browser MediaRecorder output is streamed WebM with no duration in its header.
test("real whisper.cpp transcribes WebM that has no duration header (MediaRecorder style)", async (t) => {
  const env = await setupReal();
  if (!env.ready) return t.skip(`missing: ${env.missing.join(", ")}. See server/README.md`);

  const streamed = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", jfkWav, "-c:a", "libopus", "-f", "webm", "pipe:1"],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  assert.equal(streamed.status, 0);

  const res = await postAudio(env.baseUrl, streamed.stdout, { filename: "rec.webm", type: "audio/webm" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.text, EXPECTED);
  assert.ok(Math.abs(body.durationSeconds - 11) < 0.2, `duration ${body.durationSeconds}`);
});

test("real whisper.cpp returns ordered timestamped segments when asked", async (t) => {
  const env = await setupReal();
  if (!env.ready) return t.skip(`missing: ${env.missing.join(", ")}. See server/README.md`);

  const form = new FormData();
  form.append("audio", new Blob([await readFixture(jfkWav)], { type: "audio/wav" }), "jfk.wav");
  const res = await fetch(`${env.baseUrl}/api/transcribe?segments=1`, { method: "POST", body: form });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(body.segments.length >= 1);
  assert.equal(body.segments.map((segment) => segment.text).join(" "), body.text);
  let previousEnd = 0;
  for (const { start, end, text } of body.segments) {
    assert.ok(start >= previousEnd - 0.01 && end > start && typeof text === "string", JSON.stringify({ start, end }));
    previousEnd = end;
  }
  assert.ok(previousEnd <= body.durationSeconds + 0.5);
});
