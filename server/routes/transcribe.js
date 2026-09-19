import { rm } from "node:fs/promises";
import { Router } from "express";
import { createUploadMiddleware } from "../middleware/upload.js";

/** Legacy public endpoint (contract v1): POST /api/transcribe. Unchanged behavior. */
export function createTranscribeRouter(config, pipeline) {
  const router = Router();
  const upload = createUploadMiddleware(config);

  router.post("/transcribe", upload, async (req, res, next) => {
    // If the client goes away before we respond, stop FFmpeg/whisper instead of finishing for nobody.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    let result;
    let failure;
    try {
      result = await pipeline.process(req.file, controller.signal);
    } catch (error) {
      failure = error;
    }
    // Delete the upload before responding so nothing outlives the request.
    if (req.file) await rm(req.file.path, { force: true });

    if (failure) return next(failure);
    // `segments` (timestamps) is opt-in via ?segments=1 so the default response matches the contract exactly.
    const { segments, ...base } = result;
    const wantSegments = req.query.segments === "1" || req.query.segments === "true";
    res.json(wantSegments ? { ...base, segments } : base);
  });

  return router;
}
