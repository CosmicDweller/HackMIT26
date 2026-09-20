import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestCancelled } from "../lib/errors.js";
import { fileExists, run } from "../lib/exec.js";

// pyannote/speaker-diarization-community-1 as a local worker process. It answers "who spoke when" and nothing else: Deepgram still
// says what was said. The worker is a separate Python program in its own virtual environment; this file starts it, bounds it
// (one at a time, a timeout in proportion to the recording's length), validates what comes back and cleans up after it.

export const PROVIDER = "pyannote-community-1";
export const MODEL = "pyannote/speaker-diarization-community-1";
const CACHE_DIR = "models--pyannote--speaker-diarization-community-1";
const MAX_INTERVALS = 200_000; // sanity bound on a worker's answer (two hours is a few thousand)
const DURATION_TOLERANCE_MS = 1500;

export class PyannoteError extends Error {
  constructor(code, detail = "") {
    super(code);
    this.name = "PyannoteError";
    this.code = code; // PYANNOTE_UNAVAILABLE, PYANNOTE_TIMEOUT, MODEL_ACCESS_DENIED, ... : safe to log, never contains audio or a token
    this.detail = detail;
  }
}

/** Where Hugging Face keeps downloaded models (same rules as huggingface_hub). */
export function hubCacheDir(config, env = process.env) {
  if (config.pyannoteModelCache) return config.pyannoteModelCache;
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return path.join(env.HF_HOME, "hub");
  return path.join(env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "huggingface", "hub");
}

/** True when the model's files are in the local cache (a cheap check: the model is not loaded). */
export function modelCached(config, env = process.env) {
  try {
    const snapshots = path.join(hubCacheDir(config, env), CACHE_DIR, "snapshots");
    return existsSync(snapshots) && readdirSync(snapshots).length > 0;
  } catch {
    return false;
  }
}

/**
 * Check the worker's answer before anything trusts it. Throws PyannoteError("PYANNOTE_BAD_OUTPUT") for anything malformed.
 * Exported for tests.
 */
export function validateResult(result, { durationMs = null } = {}) {
  const bad = (why) => new PyannoteError("PYANNOTE_BAD_OUTPUT", why);
  if (!result || typeof result !== "object") throw bad("not an object");
  if (typeof result.error === "string") throw new PyannoteError(result.error);
  if (result.provider !== PROVIDER) throw bad("unexpected provider");
  for (const key of ["regular", "exclusive", "speakers"]) if (!Array.isArray(result[key])) throw bad(`${key} is not a list`);
  if (result.regular.length > MAX_INTERVALS || result.exclusive.length > MAX_INTERVALS) throw bad("too many intervals");
  const known = new Set(result.speakers);
  if (known.size !== result.speakers.length || result.speakers.some((s) => typeof s !== "string" || !s)) throw bad("speaker list");
  const limit = durationMs === null ? Infinity : durationMs + DURATION_TOLERANCE_MS;
  for (const [name, list] of [["regular", result.regular], ["exclusive", result.exclusive]]) {
    let previousStart = -1;
    for (const row of list) {
      const ok = Number.isInteger(row?.startMs) && Number.isInteger(row?.endMs) && typeof row?.speaker === "string";
      if (!ok || row.startMs < 0 || row.endMs <= row.startMs) throw bad(`${name} interval`);
      if (!known.has(row.speaker)) throw bad(`${name} names an unlisted speaker`);
      if (row.endMs > limit) throw bad(`${name} interval past the end of the audio`); // a timeline mismatch would misalign every word
      if (row.startMs < previousStart) throw bad(`${name} not sorted`);
      previousStart = row.startMs;
    }
  }
  // exclusive diarization never overlaps: it is what words are aligned against
  let end = 0;
  for (const row of result.exclusive) {
    if (row.startMs < end - 1) throw bad("exclusive intervals overlap");
    end = Math.max(end, row.endMs);
  }
  return {
    provider: PROVIDER, model: result.model ?? MODEL, speakers: [...result.speakers],
    regular: result.regular.map(({ startMs, endMs, speaker }) => ({ startMs, endMs, speaker })),
    exclusive: result.exclusive.map(({ startMs, endMs, speaker }) => ({ startMs, endMs, speaker })),
    audioDurationMs: Number.isInteger(result.audioDurationMs) ? result.audioDurationMs : null,
    loadTimeMs: Number.isFinite(result.loadTimeMs) ? result.loadTimeMs : null,
    inferenceTimeMs: Number.isFinite(result.inferenceTimeMs) ? result.inferenceTimeMs : null,
    processingTimeMs: Number.isFinite(result.processingTimeMs) ? result.processingTimeMs : null,
    device: typeof result.device === "string" ? result.device : null,
    versions: result.versions && typeof result.versions === "object" ? result.versions : null,
  };
}

export function createPyannote(config, { logger = console } = {}) {
  let ready = null; // { at, value }
  let running = 0;
  const waiting = [];

  async function available() {
    if (!config.pyannoteEnabled) return false;
    if (ready && Date.now() - ready.at < 30_000) return ready.value;
    const value = (await fileExists(config.pyannotePython)) && (await fileExists(config.pyannoteScript)) && modelCached(config);
    ready = { at: Date.now(), value };
    return value;
  }

  /** What is installed, for the health/doctor checks. Never runs the model and never reads a token. */
  async function status() {
    return {
      enabled: config.pyannoteEnabled,
      python: await fileExists(config.pyannotePython),
      script: await fileExists(config.pyannoteScript),
      modelCached: modelCached(config),
      device: config.pyannoteDevice,
    };
  }

  // one worker at a time by default: the model needs gigabytes, and two at once would only slow each other down
  const acquire = () => (running < config.pyannoteMaxConcurrent ? (running++, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)));
  const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

  /** Only regular files the backend itself created for this recording may be handed to the worker. */
  async function checkedPath(wavPath) {
    if (typeof wavPath !== "string" || !path.isAbsolute(wavPath) || wavPath.includes("\0")) throw new PyannoteError("BAD_INPUT", "path");
    let real;
    try {
      real = await realpath(wavPath);
      if (!(await stat(real)).isFile()) throw new Error("not a file");
    } catch {
      throw new PyannoteError("BAD_INPUT", "audio file not found");
    }
    const root = await realpath(config.tmpDir).catch(() => path.resolve(config.tmpDir));
    if (real !== root && !real.startsWith(root + path.sep)) throw new PyannoteError("BAD_INPUT", "audio outside the job directory");
    return real;
  }

  const timeoutFor = (durationSeconds) =>
    Math.min(config.pyannoteTimeoutMaxMs, Math.max(config.pyannoteTimeoutMinMs, Math.round((durationSeconds ?? 0) * 1000 * config.pyannoteTimeoutFactor)));

  function workerEnv() {
    const env = { PYANNOTE_DEVICE: config.pyannoteDevice, PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false" };
    // once the model is cached it runs from the cache: no network, no token, no chance of a surprise download in production
    if (modelCached(config)) env.HF_HUB_OFFLINE = "1";
    if (config.pyannoteModelCache) env.HF_HUB_CACHE = config.pyannoteModelCache;
    if (config.pyannoteDevice === "mps") env.PYTORCH_ENABLE_MPS_FALLBACK = "1";
    return env;
  }

  /**
   * Diarize one 16 kHz mono WAV. Resolves with the validated result; rejects with a PyannoteError whose `code` says why. `durationSeconds`
   * (the recording's length, when known) scales the timeout. `numSpeakers` is passed only when the speaker count is actually known.
   */
  async function diarize(wavPath, { durationSeconds = null, numSpeakers = null, signal } = {}) {
    if (!(await available())) throw new PyannoteError("PYANNOTE_UNAVAILABLE");
    const input = await checkedPath(wavPath);
    await acquire();
    const dir = await mkdtemp(path.join(config.tmpDir, "pyannote-"));
    try {
      if (signal?.aborted) throw requestCancelled();
      const output = path.join(dir, "result.json");
      const args = [config.pyannoteScript, "--input", input, "--output", output, "--device", config.pyannoteDevice];
      if (Number.isInteger(numSpeakers) && numSpeakers > 0) args.push("--num-speakers", String(numSpeakers));
      try {
        await run(config.pyannotePython, args, { timeoutMs: timeoutFor(durationSeconds), signal, env: workerEnv(), maxBuffer: 1024 * 1024 });
      } catch (error) {
        if (error.aborted) throw requestCancelled();
        if (error.notFound) throw new PyannoteError("PYANNOTE_UNAVAILABLE");
        if (error.timedOut) throw new PyannoteError("PYANNOTE_TIMEOUT");
        // the worker reports its own failure class in the output file; a killed process (memory) leaves none
        let code = error.signal === "SIGKILL" || error.signal === "SIGABRT" ? "PYANNOTE_CRASHED" : "PYANNOTE_FAILED";
        try {
          const reported = JSON.parse(await readFile(output, "utf8")).error;
          if (typeof reported === "string") code = reported;
        } catch { /* keep the class above */ }
        throw new PyannoteError(code);
      }
      let parsed;
      try {
        parsed = JSON.parse(await readFile(output, "utf8"));
      } catch {
        throw new PyannoteError("PYANNOTE_BAD_OUTPUT", "not JSON");
      }
      return validateResult(parsed, { durationMs: durationSeconds === null ? null : Math.round(durationSeconds * 1000) });
    } finally {
      release();
      await rm(dir, { recursive: true, force: true });
    }
  }

  return { available, status, diarize, timeoutFor, invalidate: () => { ready = null; }, logger };
}
