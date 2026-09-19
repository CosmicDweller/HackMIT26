import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { invalidAudio, requestCancelled, serviceUnavailable } from "../lib/errors.js";
import { createUploadMiddleware } from "../middleware/upload.js";
import { convertToWav } from "../services/audio.js";
import { createLimiter } from "../services/limiter.js";
import { checkReadiness } from "../services/readiness.js";
import { transcribeWav } from "../services/whisper.js";

export function createTranscribeRouter(config) {
  const router = Router();
  const limiter = createLimiter(config.maxConcurrent);
  const upload = createUploadMiddleware(config);

  async function transcribeUpload(file, signal) {
    if (!file) throw invalidAudio("No audio file was provided. Send it in the 'audio' field.");
    if (file.size === 0) throw invalidAudio("The audio file is empty.");

    const { ready, missing } = await checkReadiness(config);
    if (!ready) {
      console.error(`transcription unavailable, missing: ${missing.join(", ")}`);
      throw serviceUnavailable("Transcription is not available on the server.");
    }

    const release = limiter.tryAcquire();
    if (!release) {
      throw serviceUnavailable("The server is busy. Please try again in a few seconds.", {
        retryAfterSeconds: 5,
      });
    }

    let workDir;
    try {
      workDir = await mkdtemp(path.join(config.tmpDir, "job-"));
      const deadline = Date.now() + config.processTimeoutMs;
      const remainingMs = () => Math.max(1, deadline - Date.now());

      const wavPath = path.join(workDir, "audio.wav");
      const { durationSeconds } = await convertToWav(file.path, wavPath, config, remainingMs(), signal);
      if (signal.aborted) throw requestCancelled();
      const text = await transcribeWav(wavPath, workDir, config, remainingMs(), signal);
      return { text, durationSeconds };
    } finally {
      release();
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  router.post("/transcribe", upload, async (req, res, next) => {
    // If the client goes away before we respond, stop FFmpeg/whisper instead of finishing for nobody.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    let result;
    let failure;
    try {
      result = await transcribeUpload(req.file, controller.signal);
    } catch (error) {
      failure = error;
    }
    // Delete the upload before responding so nothing outlives the request.
    if (req.file) await rm(req.file.path, { force: true });

    if (failure) return next(failure);
    res.json(result);
  });

  return router;
}
