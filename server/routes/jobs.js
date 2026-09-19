import { rm } from "node:fs/promises";
import { Router } from "express";
import { invalidRequest, notFound } from "../lib/errors.js";
import { createUploadMiddleware } from "../middleware/upload.js";

const ID_PATTERN = /^job_[0-9a-f-]{36}$/;

/**
 * Asynchronous transcription jobs for recordings of any supported length (up to two hours).
 * Every route requires a verified session and is scoped to that doctor.
 */
export function createJobsRouter(config, jobs, store, authenticate) {
  const router = Router();
  // File-backed upload straight into the private upload directory: the file is never held in memory.
  const upload = createUploadMiddleware(config, { maxBytes: config.maxRecordingBytes, dir: config.uploadDir });

  router.use(authenticate);

  const jobId = (value) => {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) throw notFound();
    return value;
  };
  const handle = (work) => async (req, res, next) => {
    try {
      await work(req, res);
    } catch (error) {
      next(error);
    }
  };

  router.post("/", upload, async (req, res, next) => {
    try {
      if (!req.file) throw invalidRequest("Send the recording as multipart/form-data in the 'audio' field.");
      if (req.file.size === 0) {
        await rm(req.file.path, { force: true });
        throw invalidRequest("The recording is empty.");
      }
      const job = jobs.create(req.user.id, { audioPath: req.file.path, audioBytes: req.file.size });
      res.status(202).location(`/api/transcription-jobs/${job.id}`).json(jobs.view(job));
    } catch (error) {
      if (req.file) await rm(req.file.path, { force: true });
      next(error);
    }
  });

  router.get("/", handle((req, res) => {
    res.json({ jobs: store.listJobs(req.user.id).map((job) => ({ ...jobs.view(job), createdAt: job.created_at })) });
  }));

  router.get("/:id", handle((req, res) => res.json(jobs.view(store.getJob(req.user.id, jobId(req.params.id))))));

  // Explicit retry of a failed job (it can bill the speech service again, so it is never automatic).
  router.post("/:id/retry", handle((req, res) => {
    res.status(202).json(jobs.view(jobs.retry(req.user.id, jobId(req.params.id))));
  }));

  router.delete("/:id", handle(async (req, res) => {
    await jobs.discard(req.user.id, jobId(req.params.id));
    res.status(204).end();
  }));

  return router;
}
