import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { AppError, notFound } from "../lib/errors.js";
import { alignSegments } from "./align.js";
import { DeepgramError, deepgramConfigured, minorSpeakers, normalizeDeepgramResponse, requestDeepgram } from "./deepgram.js";
import { makeWorkDir, prepareRecording, RecordingError, toWav } from "./recording.js";
import { analyzeSpeakers } from "./voice/analysis.js";

// ---------------------------------------------------------------------------------------------
// Persistent transcription jobs.
//
//   queued -> preparing -> uploading -> transcribing -> completed | failed
//
// State lives in SQLite, so it survives restarts. The original upload is a file on disk (never held in
// memory) and is deleted the moment the job completes; failed jobs keep it until their retention
// deadline so they can be retried without another upload.
//
// Money safety: a recording is never resubmitted to Deepgram automatically once it may have been
// processed. Only rate limiting and refused connections (nothing reached Deepgram) are retried, a
// bounded number of times. Timeouts, restarts and every other failure wait for an explicit retry.
// ---------------------------------------------------------------------------------------------

/** Safe, user-facing text for every job error code. No provider details, paths or credentials. */
export const JOB_ERRORS = {
  INVALID_AUDIO: "The recording could not be read as audio.",
  RECORDING_TOO_LONG: "The recording is longer than the maximum allowed length.",
  NO_SPEECH: "No speech was detected in the recording.",
  PROVIDER_NOT_CONFIGURED: "Speech transcription is not configured on the server.",
  PROVIDER_AUTH_FAILED: "The speech service rejected the server's credentials.",
  PROVIDER_ACCOUNT_LIMIT: "The speech service account has reached a usage limit.",
  PROVIDER_MODEL_UNAVAILABLE: "The speech model is not available.",
  PROVIDER_RATE_LIMITED: "The speech service is busy. Try again shortly.",
  PROVIDER_TIMEOUT: "The speech service took too long. The recording is kept so you can retry.",
  PROVIDER_UNAVAILABLE: "The speech service is temporarily unavailable.",
  PROVIDER_BAD_AUDIO: "The speech service could not process this audio.",
  PROVIDER_MALFORMED_RESPONSE: "The speech service returned an unexpected result.",
  LONG_RECORDING_NEEDS_CALLBACK: "Recordings this long need asynchronous processing, which is not configured on this server.",
  INTERRUPTED: "Processing was interrupted by a server restart. Retry to submit the recording again.",
  CALLBACK_TIMEOUT: "The speech service did not deliver a result in time.",
  TRANSCRIPTION_TIMEOUT: "Transcription took too long.",
  SERVICE_UNAVAILABLE: "Transcription is temporarily unavailable.",
  INTERNAL: "Something went wrong while processing the recording.",
};

/** HTTP status and public error code for a failed job, for the synchronous route. */
export function httpErrorForJob(code) {
  const message = JOB_ERRORS[code] ?? JOB_ERRORS.INTERNAL;
  if (["INVALID_AUDIO", "RECORDING_TOO_LONG", "PROVIDER_BAD_AUDIO"].includes(code)) return new AppError("INVALID_AUDIO", 400, message);
  if (code === "NO_SPEECH") return new AppError("TRANSCRIPTION_FAILED", 422, message);
  if (["PROVIDER_TIMEOUT", "TRANSCRIPTION_TIMEOUT", "CALLBACK_TIMEOUT"].includes(code)) return new AppError("TRANSCRIPTION_FAILED", 504, message);
  if (["PROVIDER_MALFORMED_RESPONSE", "INTERRUPTED", "INTERNAL"].includes(code)) return new AppError("TRANSCRIPTION_FAILED", 500, message);
  return new AppError("SERVICE_UNAVAILABLE", 503, message, code === "PROVIDER_RATE_LIMITED" ? { retryAfterSeconds: 10 } : undefined);
}

// Failures where the stored audio can never succeed, so it is deleted immediately.
const UNRETRYABLE = new Set(["INVALID_AUDIO", "RECORDING_TOO_LONG", "NO_SPEECH", "PROVIDER_BAD_AUDIO"]);
const TERMINAL = new Set(["completed", "failed"]);
const sha256 = (value) => createHash("sha256").update(value).digest();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createJobManager({ config, store, pipeline, voice = null, embedder = null, logger = console }) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const queue = [];
  let running = 0;
  let sweeper = null;

  const now = () => new Date().toISOString();
  const later = (ms) => new Date(Date.now() + ms).toISOString();
  const retentionMs = () => config.audioRetentionHours * 3_600_000;
  const callbackEnabled = () => Boolean(config.deepgramCallbackBaseUrl);

  const view = (job) => ({
    jobId: job.id,
    status: job.status,
    progressPercent: null, // no real progress source exists: never fabricated
    transcriptionId: job.transcription_id ?? null,
    error: job.error_code ? { code: job.error_code, message: JOB_ERRORS[job.error_code] ?? JOB_ERRORS.INTERNAL } : null,
  });

  const removeAudio = async (job) => {
    if (job.audio_path) await rm(job.audio_path, { force: true });
  };

  function finish(jobId) {
    events.emit(`done:${jobId}`);
  }

  /** Mark a job failed. Unretryable failures delete the audio now; others keep it until the deadline. */
  async function fail(job, code) {
    const keep = !UNRETRYABLE.has(code);
    if (!keep) await removeAudio(job);
    store.updateJob(job.id, {
      status: "failed", error_code: code, audio_path: keep ? job.audio_path : null, expires_at: keep ? later(retentionMs()) : null,
    });
    logger.error(`job ${job.id} failed: ${code}`); // codes only: never audio, transcript text or provider bodies
    finish(job.id);
  }

  const setStatus = (jobId, status) => store.updateJob(jobId, { status });

  // ---- building the stored transcript --------------------------------------------------------

  function fromDeepgram(normalized, { model, mode, fallbackModelUsed, voiceResult = null }) {
    // Speakers with almost no speech are probably a diarization artefact: flag, never reassign.
    const minor = minorSpeakers(normalized.segments);
    const minorSet = new Set(minor.map((entry) => entry.speaker));
    for (const segment of normalized.segments) if (minorSet.has(segment.providerSpeaker)) segment.needsReview = true;

    const identification = voiceResult?.identification ?? new Map();
    const speakers = normalized.speakerIndices.map((index) => {
      const found = identification.get(index);
      return {
        id: `speaker_${index}`, label: `Speaker ${index + 1}`,
        role: "unassigned", // only the doctor confirms roles
        identificationStatus: found ? found.status : "unavailable",
        suggestedRole: found?.suggestedRole ?? null,
      };
    });
    const uncertain = new Set(speakers.filter((sp) => sp.identificationStatus === "uncertain").map((sp) => sp.id));
    const segments = normalized.segments.map((segment, index) => {
      const speakerId = segment.providerSpeaker === null ? null : `speaker_${segment.providerSpeaker}`;
      return {
        id: `segment_${index + 1}`,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        speakerId,
        // insufficient or ambiguous voice evidence for this speaker => the doctor should look
        needsReview: segment.needsReview || (speakerId !== null && uncertain.has(speakerId)),
        providerSpeaker: segment.providerSpeaker,
        confidence: segment.confidence,
        speakerConfidence: segment.speakerConfidence,
      };
    });
    const fromVoice = voiceResult?.source === "independent";
    return {
      engine: "deepgram",
      speakers,
      segments,
      diarizationStatus: normalized.diarizationStatus === "failed" ? "failed" : "ok",
      diarizationResult: normalized.diarizationStatus,
      speakerSource: voiceResult?.source ?? "deepgram",
      voiceStatus: voiceResult?.voiceStatus ?? "not_enrolled",
      providerMeta: {
        ...normalized.meta, requestedModel: model, mode, processedAt: now(),
        voice: voiceResult ? { source: voiceResult.source, status: voiceResult.voiceStatus, ...voiceResult.internal, speakers: Object.fromEntries([...identification].map(([k, v]) => [k, v])) } : null,
      },
      warnings: [
        ...(fallbackModelUsed
          ? [{ code: "FALLBACK_MODEL_USED", message: `The general model (${model}) was used because the medical model was unavailable. It is not tuned for medical vocabulary: review carefully.` }]
          : []),
        ...minor.map((entry) => ({
          code: "MINOR_SPEAKER_DETECTED",
          message: `Speaker ${entry.speaker + 1} has only ${entry.segments} short segment${entry.segments === 1 ? "" : "s"} (${Math.round(entry.seconds)} s of speech). This may be a speaker-detection error: check those segments and reassign them if needed.`,
        })),
        ...(voiceResult?.warnings ?? []),
        ...(fromVoice ? [] : []),
      ],
    };
  }

  /**
   * Independent speaker analysis and doctor identification for one Deepgram result, when there is something to do: an enrolled
   * doctor, or a single Deepgram speaker that independent evidence might split. Any failure leaves Deepgram's result as it was.
   */
  async function voiceAnalysis(job, normalized, getWav) {
    if (!voice || !embedder || !config.voiceEnabled) return null;
    try {
      const profile = await voice.status(job.owner_id);
      const references = profile.status === "enrolled" ? await voice.loadReferences(job.owner_id) : null;
      const dgSpeakers = new Set(normalized.groups.flat().map((w) => w.speaker).filter((sp) => sp !== null)).size;
      if (!(await embedder.available())) {
        return references ? { normalized, source: "deepgram", voiceStatus: "unavailable", identification: new Map(), warnings: [], internal: {} } : null;
      }
      if (!references && dgSpeakers > 1) {
        return profile.status === "needs_reenrollment" ? { normalized, source: "deepgram", voiceStatus: "needs_reenrollment", identification: new Map(), warnings: [], internal: {} } : null;
      }
      const wavPath = await getWav();
      const result = await analyzeSpeakers({ normalized, wavPath, references, config, embedder });
      if (!references && profile.status === "needs_reenrollment") result.voiceStatus = "needs_reenrollment";
      return result;
    } catch (error) {
      logger.error(`voice analysis skipped: ${error?.name} ${error?.code ?? ""}`); // class only: never audio or embeddings
      return null;
    }
  }

  function fromLocal(result) {
    const { speakers, segments } = alignSegments(
      result.segments.map((segment) => ({ startMs: Math.round(segment.start * 1000), endMs: Math.round(segment.end * 1000), text: segment.text })),
      result.diarization.intervals,
    );
    const ok = result.diarization.status === "ok";
    return {
      engine: "local",
      speakers,
      segments: segments.map((segment) => ({ ...segment, needsReview: segment.speakerId === null })),
      diarizationStatus: result.diarization.status,
      diarizationResult: ok ? "completed" : "failed",
      providerMeta: { processedAt: now(), mode: "local" },
      warnings: [],
    };
  }

  /** Save the transcript, delete the retained recording, and only THEN announce completion (so nothing outlives the answer). */
  async function complete(job, prepared, durationSeconds) {
    const transcription = store.completeJob(job.owner_id, job.id, { durationSeconds, ...prepared });
    await removeAudio(job);
    finish(job.id);
    return transcription;
  }

  // ---- running a job -------------------------------------------------------------------------

  async function runDeepgram(job, workDir) {
    setStatus(job.id, "preparing");
    const prepared = await prepareRecording(job.audio_path, workDir, config);
    store.updateJob(job.id, { duration_seconds: prepared.durationSeconds });

    if (!deepgramConfigured(config)) throw new DeepgramError("PROVIDER_NOT_CONFIGURED");
    const useCallback = callbackEnabled() && prepared.durationSeconds > config.deepgramSyncMaxSeconds;
    if (!useCallback && prepared.durationSeconds > config.deepgramSyncMaxSeconds) {
      // Rejected BEFORE any audio is sent: a synchronous request over 10 minutes would time out, cost
      // money and lose the result (Deepgram does not store transcripts).
      throw new DeepgramError("LONG_RECORDING_NEEDS_CALLBACK");
    }

    let callbackUrl;
    if (useCallback) {
      const secret = randomBytes(32).toString("hex");
      const url = new URL(`${config.deepgramCallbackBaseUrl.replace(/\/+$/, "")}/deepgram-callback/${job.id}`);
      url.username = "deepgram";
      url.password = secret;
      callbackUrl = url.toString();
      store.updateJob(job.id, { callback_secret_hash: sha256(secret).toString("hex"), mode: "callback" });
    } else {
      store.updateJob(job.id, { mode: "sync" });
    }

    let model = config.deepgramModel;
    let fallbackModelUsed = false;
    let attempts = job.attempts;
    for (;;) {
      attempts += 1;
      // From here the recording may reach Deepgram: submitted_at marks the point of no silent resubmission.
      store.updateJob(job.id, { status: "uploading", attempts, submitted_at: now() });
      try {
        const result = await requestDeepgram(prepared.path, config, {
          contentType: prepared.contentType, callbackUrl, model,
          timeoutMs: useCallback ? 60 * 60_000 : config.deepgramTimeoutMs,
          onBodySent: () => setStatus(job.id, "transcribing"),
        });

        if (useCallback) {
          // Deepgram answered with a request id and will POST the transcript to our callback endpoint.
          store.updateJob(job.id, {
            status: "transcribing", provider_request_id: typeof result?.request_id === "string" ? result.request_id : null,
            expires_at: later(config.callbackDeadlineMs),
          });
          return "waiting";
        }
        const normalized = normalizeDeepgramResponse(result, { reviewWordConfidence: config.reviewWordConfidence, reviewSpeakerConfidence: config.reviewSpeakerConfidence });
        if (normalized.empty) throw new DeepgramError("NO_SPEECH");
        const voiceResult = await voiceAnalysis(job, normalized, () => toWav(prepared.path, path.join(workDir, "analysis.wav"), config));
        await rm(workDir, { recursive: true, force: true }); // working files go before completion is announced
        await complete(job, fromDeepgram(voiceResult?.normalized ?? normalized, { model, mode: "sync", fallbackModelUsed, voiceResult }), prepared.durationSeconds);
        return "completed";
      } catch (error) {
        if (!(error instanceof DeepgramError)) throw error;
        // Explicit, never silent: try the configured fallback model once if the primary is unavailable.
        if (error.code === "PROVIDER_MODEL_UNAVAILABLE" && config.deepgramFallbackModel && !fallbackModelUsed) {
          model = config.deepgramFallbackModel;
          fallbackModelUsed = true;
          continue;
        }
        // Only failures where nothing was processed are retried automatically, and only a few times.
        if (error.autoRetry && attempts - job.attempts < config.maxSubmitAttempts) {
          await sleep(Math.min(30_000, 500 * 2 ** (attempts - job.attempts)));
          continue;
        }
        throw error;
      }
    }
  }

  async function runLocal(job) {
    setStatus(job.id, "preparing");
    setStatus(job.id, "transcribing");
    const file = { path: job.audio_path, size: job.audio_bytes };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await pipeline.process(file, new AbortController().signal, { diarize: true, expectedSpeakers: job.expected_speakers ?? undefined });
        store.updateJob(job.id, { duration_seconds: result.durationSeconds, mode: "local" });
        await complete(job, fromLocal(result), result.durationSeconds);
        return;
      } catch (error) {
        // The local pipeline has its own small concurrency limit; wait briefly if it is momentarily full.
        if (error instanceof AppError && error.retryAfterSeconds && attempt < 5) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }
  }

  /** Translate any thrown error into a stable job error code. */
  function codeFor(error) {
    if (error instanceof DeepgramError) return error.code;
    if (error instanceof RecordingError) return error.jobCode;
    if (error instanceof AppError) {
      if (error.code === "INVALID_AUDIO") return "INVALID_AUDIO";
      if (error.code === "TRANSCRIPTION_FAILED") return error.status === 422 ? "NO_SPEECH" : error.status === 504 ? "TRANSCRIPTION_TIMEOUT" : "INTERNAL";
      if (error.code === "SERVICE_UNAVAILABLE") return "SERVICE_UNAVAILABLE";
    }
    return "INTERNAL";
  }

  async function runJob(jobId) {
    let job = store.jobById(jobId);
    if (!job || TERMINAL.has(job.status)) return;
    let workDir;
    try {
      if (config.sttEngine === "local") {
        await runLocal(job);
      } else {
        workDir = await makeWorkDir(config);
        await runDeepgram(job, workDir);
      }
    } catch (error) {
      job = store.jobById(jobId);
      if (job && !TERMINAL.has(job.status)) {
        if (codeFor(error) === "INTERNAL") logger.error(`job ${jobId} internal error: ${error?.name} ${error?.code ?? ""}`);
        await fail(job, codeFor(error));
      }
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  function pump() {
    while (running < config.maxConcurrentJobs && queue.length > 0) {
      const jobId = queue.shift();
      running += 1;
      runJob(jobId).catch((error) => logger.error(`job ${jobId} crashed: ${error?.name}`)).finally(() => {
        running -= 1;
        pump();
      });
    }
  }

  function enqueue(jobId) {
    if (!queue.includes(jobId)) queue.push(jobId);
    pump();
  }

  // ---- public operations ---------------------------------------------------------------------

  /** Create a job for an uploaded file. `file` is a stored, file-backed upload owned by this job now. */
  function create(ownerId, { audioPath, audioBytes, expectedSpeakers }) {
    const job = store.createJob(ownerId, { audioPath, audioBytes, expectedSpeakers, expiresAt: later(retentionMs()) });
    enqueue(job.id);
    return job;
  }

  /** Wait until the job reaches a final state, or `ms` elapses. Returns the current job. */
  function waitFor(jobId, ms) {
    return new Promise((resolve) => {
      const current = () => store.jobById(jobId);
      if (TERMINAL.has(current()?.status)) return resolve(current());
      const timer = setTimeout(() => {
        events.off(`done:${jobId}`, onDone);
        resolve(current());
      }, ms);
      const onDone = () => {
        clearTimeout(timer);
        resolve(current());
      };
      events.once(`done:${jobId}`, onDone);
    });
  }

  /** Explicit retry of a failed job whose audio is still stored. Never automatic (it can cost money again). */
  function retry(ownerId, jobId) {
    const job = store.getJob(ownerId, jobId);
    if (job.status !== "failed" || !job.audio_path) {
      throw new AppError("INVALID_REQUEST", 409, "Only a failed job whose recording is still stored can be retried.");
    }
    store.updateJob(job.id, { status: "queued", error_code: null, submitted_at: null, provider_request_id: null, callback_secret_hash: null, expires_at: later(retentionMs()) });
    enqueue(job.id);
    return store.jobById(job.id);
  }

  async function discard(ownerId, jobId) {
    const job = store.getJob(ownerId, jobId);
    if (!TERMINAL.has(job.status)) throw new AppError("INVALID_REQUEST", 409, "The job is still running.");
    await removeAudio(job);
    store.deleteJob(ownerId, jobId);
  }

  // ---- callbacks -----------------------------------------------------------------------------

  /**
   * Handle Deepgram's callback for a long recording. Returns an HTTP status for the callback server.
   * Authentication: a per-job random secret carried as the Basic-auth password in the callback URL
   * (compared in constant time against a stored hash). Deepgram's dg-token header is documented as not
   * guaranteed, so it is never relied on. Duplicate deliveries are acknowledged without effect.
   */
  async function handleCallback(jobId, authorization, body) {
    const job = /^job_[0-9a-f-]{36}$/.test(jobId) ? store.jobById(jobId) : null;
    // One indistinguishable answer for "no such job" and "wrong secret".
    const denied = 401;
    if (!job || !job.callback_secret_hash) return denied;
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization ?? "");
    if (!match) return denied;
    const [user, ...rest] = Buffer.from(match[1], "base64").toString("utf8").split(":");
    const presented = sha256(rest.join(":"));
    const expected = Buffer.from(job.callback_secret_hash, "hex");
    if (user !== "deepgram" || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return denied;

    if (TERMINAL.has(job.status)) return 200; // duplicate delivery: idempotent
    if (job.mode !== "callback" || job.status !== "transcribing") return 409; // not ready yet: Deepgram retries
    const requestId = body?.metadata?.request_id;
    if (job.provider_request_id && requestId && requestId !== job.provider_request_id) return 400;

    const cleanupDirs = [];
    try {
      const normalized = normalizeDeepgramResponse(body, { reviewWordConfidence: config.reviewWordConfidence, reviewSpeakerConfidence: config.reviewSpeakerConfidence });
      if (normalized.empty) {
        await fail(job, "NO_SPEECH");
        return 200;
      }
      // the recording is re-verified from the retained original: the callback arrives long after the upload's working files are gone
      const voiceResult = await voiceAnalysis(job, normalized, async () => {
        const dir = await makeWorkDir(config);
        cleanupDirs.push(dir);
        const prepared = await prepareRecording(job.audio_path, dir, config);
        return toWav(prepared.path, path.join(dir, "analysis.wav"), config);
      });
      for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
      await complete(job, fromDeepgram(voiceResult?.normalized ?? normalized, { model: config.deepgramModel, mode: "callback", fallbackModelUsed: false, voiceResult }), job.duration_seconds);
    } catch (error) {
      await fail(store.jobById(jobId), error instanceof DeepgramError ? error.code : "INTERNAL");
    } finally {
      for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    }
    return 200;
  }

  // ---- start-up recovery and retention -------------------------------------------------------

  /**
   * After a restart. Jobs that never reached the provider are simply queued again. A job that may already
   * have been sent to Deepgram is NOT resubmitted (it could be billed twice and the result is lost): it is
   * failed as INTERRUPTED and can be retried explicitly. A callback job still waiting for its result keeps waiting.
   */
  async function recover() {
    for (const job of store.jobsInStatus(["queued", "preparing", "uploading", "transcribing"])) {
      const local = config.sttEngine === "local" || job.mode === "local";
      const waitingForCallback = job.status === "transcribing" && job.mode === "callback" && job.provider_request_id;
      if (waitingForCallback) continue;
      if (local || !job.submitted_at) {
        store.updateJob(job.id, { status: "queued" });
        enqueue(job.id);
      } else {
        await fail(job, "INTERRUPTED");
      }
    }
  }

  /** Enforce retention: expired callback waits fail, and stored audio past its deadline is deleted. */
  async function sweep() {
    for (const job of store.expiredJobs(now())) {
      if (job.status === "transcribing" && job.mode === "callback") {
        await fail(job, "CALLBACK_TIMEOUT");
      } else if (job.audio_path) {
        await removeAudio(job);
        store.updateJob(job.id, { audio_path: null, expires_at: null });
      } else {
        store.updateJob(job.id, { expires_at: null });
      }
    }
  }

  async function start() {
    mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });
    await recover();
    await sweep();
    sweeper = setInterval(() => sweep().catch(() => {}), 10 * 60_000);
    sweeper.unref();
  }

  const stop = () => clearInterval(sweeper);

  return { view, create, waitFor, retry, discard, handleCallback, recover, sweep, start, stop, enqueue };
}

export { notFound };
