// API behaviour tests. Tests that use a fake whisper script (makeFakeWhisper) mock the
// subprocess and only verify our handling of it. Real speech recognition is covered by
// real-inference.test.js.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  leftoverFiles,
  makeConfig,
  makeFakeWhisper,
  makeSilentWav,
  postAudio,
  readFixture,
  startServer,
} from "./helpers.js";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** Start a server with optional config overrides; whisper defaults to a fake in `fakeMode`. */
async function setup({ fakeMode, ...overrides } = {}) {
  const env = await makeConfig(overrides);
  cleanups.push(env.cleanup);
  if (fakeMode) env.config.whisperBin = await makeFakeWhisper(env.root, fakeMode);
  // The fake ignores the model, but the readiness check needs a file to exist.
  if (fakeMode && !overrides.whisperModel) {
    env.config.whisperModel = path.join(env.root, "model.bin");
    await writeFile(env.config.whisperModel, "x");
  }
  const server = await startServer(env.config);
  cleanups.push(server.close);
  return { ...env, ...server };
}

const expectError = async (res, status, code) => {
  assert.equal(res.status, status);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["code", "error"]);
  assert.equal(body.code, code);
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
  return body;
};

describe("GET /api/health", () => {
  test("reports ok when FFmpeg, whisper.cpp and the model are present", async (t) => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/api/health`);
    if (res.status === 503) return t.skip("local FFmpeg/whisper.cpp/model not installed");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  test("reports unavailable when the model file is missing", async () => {
    const { baseUrl } = await setup({ whisperModel: "/nonexistent/model.bin" });
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { status: "unavailable" });
  });

  test("reports unavailable when the whisper executable is missing", async () => {
    const { baseUrl } = await setup({ whisperBin: "definitely-not-installed-whisper" });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/health`)).json(), { status: "unavailable" });
  });

  test("reports unavailable when FFmpeg is missing", async () => {
    const { baseUrl } = await setup({ ffmpegBin: "definitely-not-installed-ffmpeg" });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/health`)).json(), { status: "unavailable" });
  });
});

describe("POST /api/transcribe validation", () => {
  test("rejects a request with no file", async () => {
    const { baseUrl } = await setup({ fakeMode: "ok" });
    const res = await fetch(`${baseUrl}/api/transcribe`, { method: "POST", body: new FormData() });
    await expectError(res, 400, "INVALID_AUDIO");
  });

  test("rejects a non-multipart request", async () => {
    const { baseUrl } = await setup({ fakeMode: "ok" });
    const res = await fetch(`${baseUrl}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await expectError(res, 400, "INVALID_AUDIO");
  });

  test("rejects a file sent under the wrong field name", async () => {
    const { baseUrl, tmpDir } = await setup({ fakeMode: "ok" });
    const res = await postAudio(baseUrl, await readFixture(), { field: "file" });
    await expectError(res, 400, "INVALID_AUDIO");
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });

  test("rejects an empty file", async () => {
    const { baseUrl } = await setup({ fakeMode: "ok" });
    await expectError(await postAudio(baseUrl, new Uint8Array(0)), 400, "INVALID_AUDIO");
  });

  test("rejects a file that is not decodable audio", async () => {
    const { baseUrl, tmpDir } = await setup({ fakeMode: "ok" });
    const res = await postAudio(baseUrl, Buffer.from("this is definitely not audio"), {
      filename: "fake.wav",
    });
    await expectError(res, 400, "INVALID_AUDIO");
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });

  test("rejects an upload over the size limit", async () => {
    const { baseUrl, tmpDir } = await setup({ fakeMode: "ok", maxUploadBytes: 100_000 });
    const res = await postAudio(baseUrl, await readFixture()); // ~352 KB
    await expectError(res, 413, "FILE_TOO_LARGE");
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });

  test("rejects audio longer than 60 seconds", async () => {
    const { baseUrl, root, tmpDir } = await setup({ fakeMode: "ok" });
    const longWav = path.join(root, "long.wav");
    makeSilentWav(longWav, 65);
    const res = await postAudio(baseUrl, await readFixture(longWav));
    const body = await expectError(res, 400, "INVALID_AUDIO");
    assert.match(body.error, /60 seconds/);
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });

  test("accepts audio at the 60 second limit", async () => {
    const { baseUrl, root } = await setup({ fakeMode: "ok" });
    const wav = path.join(root, "sixty.wav");
    makeSilentWav(wav, 60);
    const res = await postAudio(baseUrl, await readFixture(wav));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).durationSeconds, 60);
  });
});

describe("POST /api/transcribe response (mocked whisper subprocess)", () => {
  test("returns text and durationSeconds with exactly the contract's shape", async () => {
    const { baseUrl } = await setup({ fakeMode: "ok" });
    const res = await postAudio(baseUrl, await readFixture());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["durationSeconds", "text"]);
    assert.equal(body.text, "Hello world.");
    assert.equal(body.durationSeconds, 11);
  });

  test("adds timestamped segments only when ?segments=1 is requested", async () => {
    const { baseUrl } = await setup({ fakeMode: "ok" });
    const audio = await readFixture();
    const form = () => {
      const f = new FormData();
      f.append("audio", new Blob([audio], { type: "audio/wav" }), "a.wav");
      return f;
    };
    const withSegments = await (await fetch(`${baseUrl}/api/transcribe?segments=1`, { method: "POST", body: form() })).json();
    assert.deepEqual(Object.keys(withSegments).sort(), ["durationSeconds", "segments", "text"]);
    assert.deepEqual(withSegments.segments, [
      { start: 0.25, end: 1.5, text: "Hello" },
      { start: 1.5, end: 3, text: "world." },
    ]);
    assert.equal(withSegments.text, "Hello world.");

    const plain = await (await fetch(`${baseUrl}/api/transcribe`, { method: "POST", body: form() })).json();
    assert.deepEqual(Object.keys(plain).sort(), ["durationSeconds", "text"]);
  });

  test("ignores a hostile client filename and leaves no temp files behind", async () => {
    const { baseUrl, tmpDir } = await setup({ fakeMode: "ok" });
    const res = await postAudio(baseUrl, await readFixture(), { filename: "../../../../tmp/evil.wav" });
    assert.equal(res.status, 200);
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });

  test("treats silence markers as no speech (422 TRANSCRIPTION_FAILED)", async () => {
    const { baseUrl, tmpDir } = await setup({ fakeMode: "blank" });
    const body = await expectError(await postAudio(baseUrl, await readFixture()), 422, "TRANSCRIPTION_FAILED");
    assert.match(body.error, /No speech/);
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });
});

describe("POST /api/transcribe failure handling", () => {
  test("missing whisper executable -> SERVICE_UNAVAILABLE without leaking paths", async () => {
    const { baseUrl, config } = await setup({ whisperBin: "/opt/nowhere/whisper-cli" });
    const res = await postAudio(baseUrl, await readFixture());
    const body = await expectError(res, 503, "SERVICE_UNAVAILABLE");
    assert.ok(!body.error.includes("nowhere"));
    assert.ok(!body.error.includes(config.whisperModel));
  });

  test("missing model -> SERVICE_UNAVAILABLE", async () => {
    const { baseUrl } = await setup({ whisperModel: "/nonexistent/model.bin" });
    await expectError(await postAudio(baseUrl, await readFixture()), 503, "SERVICE_UNAVAILABLE");
  });

  test("missing FFmpeg -> SERVICE_UNAVAILABLE", async () => {
    const { baseUrl } = await setup({ ffmpegBin: "/opt/nowhere/ffmpeg" });
    await expectError(await postAudio(baseUrl, await readFixture()), 503, "SERVICE_UNAVAILABLE");
  });

  test("whisper exits non-zero -> TRANSCRIPTION_FAILED without leaking stderr or paths", async () => {
    const { baseUrl, tmpDir } = await setup({ fakeMode: "fail" });
    const body = await expectError(await postAudio(baseUrl, await readFixture()), 500, "TRANSCRIPTION_FAILED");
    assert.ok(!body.error.includes("secret"));
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });

  test("whisper produces unparseable output -> TRANSCRIPTION_FAILED", async () => {
    const { baseUrl } = await setup({ fakeMode: "badjson" });
    await expectError(await postAudio(baseUrl, await readFixture()), 500, "TRANSCRIPTION_FAILED");
  });

  test("whisper produces no output file -> TRANSCRIPTION_FAILED", async () => {
    const { baseUrl } = await setup({ fakeMode: "nooutput" });
    await expectError(await postAudio(baseUrl, await readFixture()), 500, "TRANSCRIPTION_FAILED");
  });

  test("processing timeout kills whisper and returns TRANSCRIPTION_FAILED (504)", async () => {
    const { baseUrl, tmpDir } = await setup({ fakeMode: "hang", processTimeoutMs: 2000 });
    const started = Date.now();
    const body = await expectError(await postAudio(baseUrl, await readFixture()), 504, "TRANSCRIPTION_FAILED");
    assert.match(body.error, /timed out/);
    assert.ok(Date.now() - started < 10_000, "should not wait for the 30 s sleep");
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });
});

describe("client disconnect", () => {
  test("kills whisper, frees the slot and removes temp files when the client aborts", async () => {
    const { baseUrl, root, tmpDir } = await setup({ fakeMode: "hang", maxConcurrent: 1 });
    const controller = new AbortController();
    const form = new FormData();
    form.append("audio", new Blob([await readFixture()], { type: "audio/wav" }), "a.wav");
    const request = fetch(`${baseUrl}/api/transcribe`, { method: "POST", body: form, signal: controller.signal });
    request.catch(() => {});

    // Wait until the (fake) whisper process is running, then hang up.
    const pidFile = path.join(root, "hang.pid");
    let pid;
    for (let i = 0; i < 50 && !pid; i++) {
      pid = Number.parseInt(await readFile(pidFile, "utf8").catch(() => ""), 10) || undefined;
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(pid, "whisper stand-in never started");
    controller.abort();

    const isAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && (isAlive() || (await leftoverFiles(tmpDir)).length); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(isAlive(), false, "whisper process should have been killed");
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });
});

describe("concurrency limit and CORS", () => {
  test("rejects excess concurrent jobs with SERVICE_UNAVAILABLE and Retry-After", async () => {
    const { baseUrl, tmpDir } = await setup({ fakeMode: "slow", maxConcurrent: 1 });
    const audio = await readFixture();
    const [a, b] = await Promise.all([postAudio(baseUrl, audio), postAudio(baseUrl, audio)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 503]);
    const busy = a.status === 503 ? a : b;
    assert.equal((await busy.json()).code, "SERVICE_UNAVAILABLE");
    assert.ok(busy.headers.get("retry-after"));
    // The slot is released afterwards.
    assert.equal((await postAudio(baseUrl, audio)).status, 200);
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });

  test("allows the configured frontend origin only", async () => {
    const { baseUrl } = await setup();
    const allowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "http://localhost:5173" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const other = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "http://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });
});
