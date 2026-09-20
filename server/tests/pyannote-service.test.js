// The Node service that runs the pyannote worker: subprocess handling, validation, limits and cleanup, using a fake worker script.
// (These do NOT prove the model works: tests/real-pyannote.test.js runs the real model.)
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createPyannote, hubCacheDir, modelCached, PyannoteError, validateResult } from "../services/pyannote.js";
import { makeConfig } from "./helpers.js";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const good = (over = {}) => ({
  provider: "pyannote-community-1", model: "pyannote/speaker-diarization-community-1", speakers: ["SPEAKER_00", "SPEAKER_01"],
  regular: [{ startMs: 300, endMs: 1500, speaker: "SPEAKER_00" }, { startMs: 2000, endMs: 3500, speaker: "SPEAKER_01" }],
  exclusive: [{ startMs: 300, endMs: 1500, speaker: "SPEAKER_00" }, { startMs: 2000, endMs: 3500, speaker: "SPEAKER_01" }],
  audioDurationMs: 4000, loadTimeMs: 10, inferenceTimeMs: 20, processingTimeMs: 40, device: "cpu", versions: { "pyannote.audio": "x" }, ...over,
});

describe("validateResult", () => {
  test("accepts a well-formed result and returns a clean copy", () => {
    const r = validateResult(good(), { durationMs: 4000 });
    assert.equal(r.speakers.length, 2);
    assert.equal(r.exclusive[0].endMs, 1500);
  });
  test("an error document from the worker becomes that error", () => {
    assert.throws(() => validateResult({ error: "MODEL_ACCESS_DENIED" }), (e) => e instanceof PyannoteError && e.code === "MODEL_ACCESS_DENIED");
  });
  for (const [name, mutate] of [
    ["not an object", () => "nope"],
    ["wrong provider", () => good({ provider: "other" })],
    ["a list that is not a list", () => good({ exclusive: "x" })],
    ["a negative start", () => good({ exclusive: [{ startMs: -5, endMs: 10, speaker: "SPEAKER_00" }] })],
    ["end before start", () => good({ exclusive: [{ startMs: 500, endMs: 500, speaker: "SPEAKER_00" }] })],
    ["a fractional time", () => good({ regular: [{ startMs: 1.5, endMs: 9, speaker: "SPEAKER_00" }] })],
    ["an unlisted speaker", () => good({ regular: [{ startMs: 0, endMs: 100, speaker: "SPEAKER_09" }] })],
    ["duplicate speakers", () => good({ speakers: ["SPEAKER_00", "SPEAKER_00"] })],
    ["unsorted intervals", () => good({ regular: [{ startMs: 2000, endMs: 3000, speaker: "SPEAKER_00" }, { startMs: 100, endMs: 500, speaker: "SPEAKER_00" }] })],
    ["overlapping exclusive intervals", () => good({ exclusive: [{ startMs: 0, endMs: 2000, speaker: "SPEAKER_00" }, { startMs: 1000, endMs: 3000, speaker: "SPEAKER_01" }] })],
    ["intervals past the end of the audio (a timeline mismatch)", () => good({ exclusive: [{ startMs: 0, endMs: 900_000, speaker: "SPEAKER_00" }] })],
  ]) {
    test(`rejects ${name}`, () => {
      assert.throws(() => validateResult(mutate(), { durationMs: 4000 }), (e) => e instanceof PyannoteError && e.code === "PYANNOTE_BAD_OUTPUT");
    });
  }
  test("an empty result (no speech) is valid", () => {
    const r = validateResult(good({ speakers: [], regular: [], exclusive: [] }), { durationMs: 4000 });
    assert.deepEqual(r.exclusive, []);
  });
  test("overlapping regular intervals are allowed (that is what 'regular' means)", () => {
    const r = validateResult(good({ regular: [{ startMs: 0, endMs: 2000, speaker: "SPEAKER_00" }, { startMs: 1000, endMs: 3000, speaker: "SPEAKER_01" }] }), { durationMs: 4000 });
    assert.equal(r.regular.length, 2);
  });
});

/** A fake worker: `body` is shell code that runs with $OUT (the --output path), $IN (the audio) and $@ (all arguments). */
async function fixture({ body, cached = true, overrides = {} } = {}) {
  const env = await makeConfig({ pyannoteEnabled: true, ...overrides });
  cleanups.push(env.cleanup);
  await mkdir(env.tmpDir, { recursive: true });
  const worker = path.join(env.root, "fake-worker");
  const code = typeof body === "function" ? body(env.root) : body;
  await writeFile(worker, `#!/bin/sh\nARGS="$*"\nwhile [ $# -gt 0 ]; do case "$1" in --output) OUT="$2"; shift;; --input) IN="$2"; shift;; esac; shift; done\n${code}\n`);
  await chmod(worker, 0o755);
  const cache = path.join(env.root, "hub");
  if (cached) await mkdir(path.join(cache, "models--pyannote--speaker-diarization-community-1", "snapshots", "abc123"), { recursive: true });
  Object.assign(env.config, { pyannotePython: worker, pyannoteScript: worker, pyannoteModelCache: cache });
  const wav = path.join(env.tmpDir, "job", "a.wav");
  await mkdir(path.dirname(wav), { recursive: true });
  await writeFile(wav, "RIFF....WAVE");
  return { ...env, worker, wav, service: createPyannote(env.config, { logger: { error() {}, warn() {}, log() {} } }) };
}
const writes = (json) => `printf '%s' '${JSON.stringify(json)}' > "$OUT"`;
const leftovers = async (tmpDir) => (await readdir(tmpDir)).filter((n) => n.startsWith("pyannote-"));

describe("availability", () => {
  test("available only when enabled, installed and the model is in the local cache", async () => {
    const f = await fixture({ body: "exit 0" });
    assert.equal(await f.service.available(), true);
    const disabled = await fixture({ body: "exit 0", overrides: { pyannoteEnabled: false } });
    assert.equal(await disabled.service.available(), false);
    const uncached = await fixture({ body: "exit 0", cached: false });
    assert.equal(await uncached.service.available(), false);
    const missing = await fixture({ body: "exit 0" });
    missing.config.pyannotePython = "/nonexistent/python";
    assert.equal(await createPyannote(missing.config).available(), false);
  });
  test("status reports what is installed without running the model or reading a token", async () => {
    const f = await fixture({ body: "exit 0" });
    assert.deepEqual(await f.service.status(), { enabled: true, python: true, script: true, modelCached: true, device: "cpu" });
  });
  test("the Hugging Face cache location follows huggingface_hub's rules", () => {
    assert.equal(hubCacheDir({ pyannoteModelCache: "/x/cache" }, {}), "/x/cache");
    assert.equal(hubCacheDir({ pyannoteModelCache: "" }, { HF_HUB_CACHE: "/y" }), "/y");
    assert.equal(hubCacheDir({ pyannoteModelCache: "" }, { HF_HOME: "/z" }), "/z/hub");
    assert.equal(modelCached({ pyannoteModelCache: "/definitely/not/here" }, {}), false);
  });
  test("diarize refuses to run when unavailable", async () => {
    const f = await fixture({ body: "exit 0", cached: false });
    await assert.rejects(f.service.diarize(f.wav), (e) => e.code === "PYANNOTE_UNAVAILABLE");
  });
});

describe("running the worker", () => {
  test("returns the validated result and removes its temporary directory", async () => {
    const f = await fixture({ body: writes(good()) });
    const r = await f.service.diarize(f.wav, { durationSeconds: 4 });
    assert.deepEqual(r.speakers, ["SPEAKER_00", "SPEAKER_01"]);
    assert.equal(r.exclusive.length, 2);
    assert.deepEqual(await leftovers(f.tmpDir), []);
  });

  test("the worker gets an argument array (the speaker count only when known), the device, and offline mode once the model is cached", async () => {
    const f = await fixture({ body: (root) => `printf '%s|%s|%s' "$ARGS" "$HF_HUB_OFFLINE" "$PYANNOTE_DEVICE" > "${root}/args.txt"; ${writes(good())}` });
    await f.service.diarize(f.wav, { durationSeconds: 4, numSpeakers: 2 });
    const captured = await readFile(`${f.root}/args.txt`, "utf8");
    assert.match(captured, /--num-speakers 2/);
    assert.match(captured, /\|1\|cpu$/, "offline mode is on and the device is passed");
    await f.service.diarize(f.wav, { durationSeconds: 4 });
    assert.ok(!/--num-speakers/.test(await readFile(`${f.root}/args.txt`, "utf8")), "no speaker count is invented");
  });

  test("a path with spaces and shell characters is passed as data and no shell ever runs", async () => {
    const f = await fixture({ body: `printf '%s' "$IN" > "$OUT.in"; ${writes(good())}` });
    const evil = path.join(f.tmpDir, "job", "a b; touch PWNED $(touch PWNED2).wav");
    await writeFile(evil, "RIFF....WAVE");
    await f.service.diarize(evil, { durationSeconds: 4 });
    const names = await readdir(path.join(f.tmpDir, "job"));
    assert.ok(!names.includes("PWNED") && !names.includes("PWNED2"), "nothing was executed");
  });

  test("audio outside the job directory, a missing file and a relative path are all refused before anything runs", async () => {
    const f = await fixture({ body: writes(good()) });
    await assert.rejects(f.service.diarize("/etc/hosts"), (e) => e.code === "BAD_INPUT");
    await assert.rejects(f.service.diarize(path.join(f.tmpDir, "job", "missing.wav")), (e) => e.code === "BAD_INPUT");
    await assert.rejects(f.service.diarize("job/a.wav"), (e) => e.code === "BAD_INPUT");
    await assert.rejects(f.service.diarize(path.join(f.tmpDir, "job", "..", "..", "hosts")), (e) => e.code === "BAD_INPUT");
    await assert.rejects(f.service.diarize(f.tmpDir), (e) => e.code === "BAD_INPUT", "a directory is not audio");
  });

  test("a symlink out of the job directory is refused", async () => {
    const f = await fixture({ body: writes(good()) });
    const { symlink } = await import("node:fs/promises");
    const link = path.join(f.tmpDir, "job", "link.wav");
    await symlink("/etc/hosts", link);
    await assert.rejects(f.service.diarize(link), (e) => e.code === "BAD_INPUT");
  });

  test("the worker's own error code (for example gated model access) reaches the caller", async () => {
    const f = await fixture({ body: `printf '%s' '{"error":"MODEL_ACCESS_DENIED"}' > "$OUT"; exit 2` });
    await assert.rejects(f.service.diarize(f.wav), (e) => e instanceof PyannoteError && e.code === "MODEL_ACCESS_DENIED");
    assert.deepEqual(await leftovers(f.tmpDir), []);
  });

  test("a crash that leaves no output is a failure, and a kill is reported as a crash", async () => {
    const failed = await fixture({ body: "exit 3" });
    await assert.rejects(failed.service.diarize(failed.wav), (e) => e.code === "PYANNOTE_FAILED");
    const killed = await fixture({ body: "kill -9 $$" });
    await assert.rejects(killed.service.diarize(killed.wav), (e) => e.code === "PYANNOTE_CRASHED");
  });

  test("a worker that exits cleanly but writes garbage, or nothing, is a bad output, never a made-up result", async () => {
    const garbage = await fixture({ body: `printf 'not json' > "$OUT"` });
    await assert.rejects(garbage.service.diarize(garbage.wav), (e) => e.code === "PYANNOTE_BAD_OUTPUT");
    const nothing = await fixture({ body: "exit 0" });
    await assert.rejects(nothing.service.diarize(nothing.wav), (e) => e.code === "PYANNOTE_BAD_OUTPUT");
    const wrongShape = await fixture({ body: writes(good({ exclusive: [{ startMs: 5, endMs: 1, speaker: "SPEAKER_00" }] })) });
    await assert.rejects(wrongShape.service.diarize(wrongShape.wav), (e) => e.code === "PYANNOTE_BAD_OUTPUT");
  });

  test("the recording's length must match the intervals: a timeline mismatch is rejected", async () => {
    const f = await fixture({ body: writes(good({ exclusive: [{ startMs: 0, endMs: 600_000, speaker: "SPEAKER_00" }], regular: [{ startMs: 0, endMs: 600_000, speaker: "SPEAKER_00" }] })) });
    await assert.rejects(f.service.diarize(f.wav, { durationSeconds: 4 }), (e) => e.code === "PYANNOTE_BAD_OUTPUT");
  });

  test("a timeout kills the worker and cleans up", async () => {
    const f = await fixture({ body: "sleep 10", overrides: { pyannoteTimeoutMinMs: 300, pyannoteTimeoutFactor: 0 } });
    const started = Date.now();
    await assert.rejects(f.service.diarize(f.wav, { durationSeconds: 4 }), (e) => e.code === "PYANNOTE_TIMEOUT");
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(await leftovers(f.tmpDir), []);
  });

  test("the timeout grows with the recording, within its minimum and maximum", async () => {
    const f = await fixture({ body: "exit 0", overrides: { pyannoteTimeoutMinMs: 60_000, pyannoteTimeoutFactor: 0.5, pyannoteTimeoutMaxMs: 1_000_000 } });
    assert.equal(f.service.timeoutFor(10), 60_000);
    assert.equal(f.service.timeoutFor(1200), 600_000);
    assert.equal(f.service.timeoutFor(7200), 1_000_000);
    assert.equal(f.service.timeoutFor(null), 60_000);
  });

  test("a client that disconnects cancels the work", async () => {
    const f = await fixture({ body: "sleep 10" });
    const controller = new AbortController();
    const pending = f.service.diarize(f.wav, { durationSeconds: 4, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(pending, (e) => e.aborted === true || e.code === "REQUEST_CANCELLED" || e.status === 499 || /cancel/i.test(e.message));
    assert.deepEqual(await leftovers(f.tmpDir), []);
  });

  test("only one worker runs at a time by default (the model needs gigabytes)", async () => {
    const f = await fixture({ body: (root) => `echo start >> "${root}/order.log"; sleep 0.4; echo end >> "${root}/order.log"; ${writes(good())}` });
    await Promise.all([f.service.diarize(f.wav, { durationSeconds: 4 }), f.service.diarize(f.wav, { durationSeconds: 4 })]);
    assert.deepEqual((await readFile(`${f.root}/order.log`, "utf8")).trim().split("\n"), ["start", "end", "start", "end"]);
  });

  test("the concurrency limit is configurable", async () => {
    const f = await fixture({ body: (root) => `echo start >> "${root}/order.log"; sleep 0.4; echo end >> "${root}/order.log"; ${writes(good())}`, overrides: { pyannoteMaxConcurrent: 2 } });
    await Promise.all([f.service.diarize(f.wav, { durationSeconds: 4 }), f.service.diarize(f.wav, { durationSeconds: 4 })]);
    assert.deepEqual((await readFile(`${f.root}/order.log`, "utf8")).trim().split("\n"), ["start", "start", "end", "end"]);
  });

  test("a failed run releases its slot: the next recording is not blocked forever", async () => {
    const f = await fixture({ body: "exit 3" });
    await assert.rejects(f.service.diarize(f.wav));
    await assert.rejects(f.service.diarize(f.wav));
    await assert.rejects(f.service.diarize(f.wav));
  });
});
