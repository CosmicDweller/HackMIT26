import { rm } from "node:fs/promises";
import express, { Router } from "express";
import { invalidAudio, invalidRequest, notFound } from "../lib/errors.js";
import { createUploadMiddleware } from "../middleware/upload.js";
import { httpErrorForJob } from "../services/jobs.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EXPECTED_SPEAKERS = 6;

/**
 * Contract v2: speaker-aware transcriptions owned by the authenticated doctor.
 * Mounted at /api/transcriptions. Every route requires a verified session, and every store call
 * is scoped to req.user.id, which comes from the verified token and nothing else.
 */
export function createTranscriptionsRouter(config, jobs, store, authenticate) {
  const router = Router();
  // The original 10 MB upload limit of this route is kept. Uploads land in the private, file-backed upload directory.
  const upload = createUploadMiddleware(config, { dir: config.uploadDir });

  router.use(authenticate);
  router.use(express.json({ limit: "64kb" }));

  // Ids are validated before touching the database; malformed ones look like any missing resource.
  const requireId = (value) => {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) throw notFound();
    return value;
  };
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const handle = (work) => (req, res, next) => {
    try {
      work(req, res);
    } catch (error) {
      next(error);
    }
  };

  // Convenience route: creates a job like POST /api/transcription-jobs and waits for it, so short
  // recordings keep working with a single request. Long ones answer 202 with the job to poll.
  router.post("/", upload, async (req, res, next) => {
    let job;
    try {
      let expectedSpeakers;
      if (req.body?.expectedSpeakers !== undefined) {
        expectedSpeakers = Number(req.body.expectedSpeakers);
        if (!Number.isInteger(expectedSpeakers) || expectedSpeakers < 1 || expectedSpeakers > MAX_EXPECTED_SPEAKERS) {
          throw invalidRequest(`expectedSpeakers must be a whole number from 1 to ${MAX_EXPECTED_SPEAKERS}.`);
        }
      }
      if (!req.file) throw invalidAudio("No audio file was provided. Send it in the 'audio' field.");
      if (req.file.size === 0) throw invalidAudio("The audio file is empty.");

      // The job now owns the stored file (it is deleted when processing finishes).
      job = jobs.create(req.user.id, { audioPath: req.file.path, audioBytes: req.file.size, expectedSpeakers });
      const done = await jobs.waitFor(job.id, config.syncWaitMs);

      if (done.status === "completed") {
        const resource = store.get(req.user.id, done.transcription_id);
        return res.status(201).location(`/api/transcriptions/${resource.id}`).json(resource);
      }
      if (done.status === "failed") {
        const error = httpErrorForJob(done.error_code);
        error.extra = { jobId: done.id };
        throw error;
      }
      // Still processing: hand back the job so the client can poll it.
      return res.status(202).location(`/api/transcription-jobs/${job.id}`).json(jobs.view(done));
    } catch (error) {
      // A file that never became a job is deleted here; a job's file is managed by the job.
      if (!job && req.file) await rm(req.file.path, { force: true });
      next(error);
    }
  });

  router.get("/", handle((req, res) => res.json({ transcriptions: store.list(req.user.id) })));

  router.get("/:id", handle((req, res) => res.json(store.get(req.user.id, requireId(req.params.id)))));

  router.delete("/:id", handle((req, res) => {
    store.delete(req.user.id, requireId(req.params.id));
    res.status(204).end();
  }));

  // Deliberate, explicit action (no body). Saving labels or edits never marks a transcript reviewed.
  router.post("/:id/review", handle((req, res) => {
    res.json(store.markReviewed(req.user.id, requireId(req.params.id)));
  }));

  router.patch("/:id/speakers", handle((req, res) => {
    const id = requireId(req.params.id);
    if (!isObject(req.body) || typeof req.body.speakerId !== "string" || typeof req.body.role !== "string") {
      throw invalidRequest("Send { speakerId, role } as JSON.");
    }
    res.json(store.setSpeakerRole(req.user.id, id, req.body.speakerId, req.body.role));
  }));

  router.patch("/:id/segments/:segmentId", handle((req, res) => {
    const id = requireId(req.params.id);
    const segmentId = requireId(req.params.segmentId);
    if (!isObject(req.body)) throw invalidRequest("Send { text?, speakerId? } as JSON.");
    const { text, speakerId } = req.body;
    const changes = {};
    if (text !== undefined) changes.text = text;
    if (speakerId !== undefined) changes.speakerId = speakerId;
    res.json(store.updateSegment(req.user.id, id, segmentId, changes));
  }));

  return router;
}
