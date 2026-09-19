import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { invalidAudio, requestCancelled, serviceUnavailable } from "../lib/errors.js";
import { convertToWav } from "./audio.js";
import { diarizeWav } from "./diarization.js";
import { createLimiter } from "./limiter.js";
import { checkReadiness } from "./readiness.js";
import { transcribeWav } from "./whisper.js";

/**
 * The shared processing pipeline: validate -> FFmpeg normalize -> whisper.cpp
 * (+ optional speaker diarization in parallel) -> cleanup. One concurrency limiter covers every
 * route so total inference load stays bounded.
 */
export function createPipeline(config) {
  const limiter = createLimiter(config.maxConcurrent);

  /**
   * @param file    multer file ({ path, size })
   * @param signal  aborted when the client disconnects
   * @param options { diarize: boolean, expectedSpeakers?: number }
   * @returns { text, durationSeconds, segments (seconds), diarization?: { status, speakerCount, intervals } }
   */
  async function process(file, signal, { diarize = false, expectedSpeakers } = {}) {
    if (!file) throw invalidAudio("No audio file was provided. Send it in the 'audio' field.");
    if (file.size === 0) throw invalidAudio("The audio file is empty.");

    const { ready, missing } = await checkReadiness(config);
    if (!ready) {
      console.error(`transcription unavailable, missing: ${missing.join(", ")}`);
      throw serviceUnavailable("Transcription is not available on the server.");
    }

    const release = limiter.tryAcquire();
    if (!release) {
      throw serviceUnavailable("The server is busy. Please try again in a few seconds.", { retryAfterSeconds: 5 });
    }

    let workDir;
    try {
      workDir = await mkdtemp(path.join(config.tmpDir, "job-"));
      const deadline = Date.now() + config.processTimeoutMs;
      const remainingMs = () => Math.max(1, deadline - Date.now());

      const wavPath = path.join(workDir, "audio.wav");
      const { durationSeconds } = await convertToWav(file.path, wavPath, config, remainingMs(), signal);
      if (signal.aborted) throw requestCancelled();

      if (!diarize) {
        const { text, segments } = await transcribeWav(wavPath, workDir, config, remainingMs(), signal);
        return { text, durationSeconds, segments };
      }

      // allSettled (not all): if transcription fails, still wait for the diarization process to
      // end so nothing is running when the work directory is deleted.
      const [transcript, speakers] = await Promise.allSettled([
        transcribeWav(wavPath, workDir, config, remainingMs(), signal),
        diarizeWav(wavPath, config, {
          timeoutMs: Math.min(remainingMs(), config.diarizationTimeoutMs),
          signal,
          expectedSpeakers,
        }),
      ]);
      if (transcript.status === "rejected") throw transcript.reason;
      if (speakers.status === "rejected") throw speakers.reason; // only a client disconnect
      return { ...transcript.value, durationSeconds, diarization: speakers.value };
    } finally {
      release();
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  return { process };
}
