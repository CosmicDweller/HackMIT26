import { rm } from "node:fs/promises";
import { Router } from "express";
import { AppError, notFound } from "../lib/errors.js";
import { createSamplesUpload } from "../middleware/upload.js";
import { calibration } from "../services/voice/calibration.js";

/**
 * The doctor's own voice profile. Mounted at /api/me/voice-profile. Every route requires a verified session and touches only
 * the caller's profile (the owner id comes from the verified token, never from the request). Embeddings never leave the server.
 * A voice is NEVER a login credential: these routes sit behind the normal token check like everything else.
 */
export function createVoiceProfileRouter(config, voice, authenticate) {
  const router = Router();
  const upload = createSamplesUpload(config, { count: calibration.enrollment.sampleCount });
  router.use(authenticate);

  router.get("/", async (req, res, next) => {
    try {
      res.json({ ...(await voice.status(req.user.id)), consent: voice.consent, requiredSamples: calibration.enrollment.sampleCount });
    } catch (error) {
      next(error);
    }
  });

  router.post("/enroll", upload, async (req, res, next) => {
    let result;
    let failure;
    try {
      result = await voice.enroll(req.user.id, { files: req.files, consent: req.body?.consent, consentVersion: req.body?.consentVersion });
    } catch (error) {
      failure = error;
    }
    // Raw enrollment audio is never kept, on success or failure, and it is gone before the answer is sent.
    await Promise.all((req.files ?? []).map((file) => rm(file.path, { force: true })));
    if (failure) return next(failure);
    res.status(201).json(result);
  });

  // Deleting a biometric profile is deliberate: the client must send the confirmation header.
  router.delete("/", async (req, res, next) => {
    try {
      if (req.get("X-Confirm") !== "delete-voice-profile") {
        throw new AppError("CONFIRMATION_REQUIRED", 400, "Send the header 'X-Confirm: delete-voice-profile' to delete your voice profile.");
      }
      if (!voice.remove(req.user.id)) throw notFound("You have no voice profile.");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
