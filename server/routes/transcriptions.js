import { rm } from "node:fs/promises";
import express, { Router } from "express";
import { invalidRequest, notFound } from "../lib/errors.js";
import { createUploadMiddleware } from "../middleware/upload.js";
import { alignSegments } from "../services/align.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EXPECTED_SPEAKERS = 6;

/**
 * Contract v2: speaker-aware transcriptions owned by the authenticated doctor.
 * Mounted at /api/transcriptions. Every route requires a verified session, and every store call
 * is scoped to req.user.id, which comes from the verified token and nothing else.
 */
export function createTranscriptionsRouter(config, pipeline, store, authenticate) {
  const router = Router();
  const upload = createUploadMiddleware(config);

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

  router.post("/", upload, async (req, res, next) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    let resource;
    let failure;
    try {
      let expectedSpeakers;
      if (req.body?.expectedSpeakers !== undefined) {
        expectedSpeakers = Number(req.body.expectedSpeakers);
        if (!Number.isInteger(expectedSpeakers) || expectedSpeakers < 1 || expectedSpeakers > MAX_EXPECTED_SPEAKERS) {
          throw invalidRequest(`expectedSpeakers must be a whole number from 1 to ${MAX_EXPECTED_SPEAKERS}.`);
        }
      }

      const result = await pipeline.process(req.file, controller.signal, { diarize: true, expectedSpeakers });
      const { speakers, segments } = alignSegments(
        result.segments.map((segment) => ({
          startMs: Math.round(segment.start * 1000),
          endMs: Math.round(segment.end * 1000),
          text: segment.text,
        })),
        result.diarization.intervals,
      );
      resource = store.createTranscription(req.user.id, {
        durationSeconds: result.durationSeconds,
        diarizationStatus: result.diarization.status,
        engine: result.engine,
        speakers,
        segments,
      });
    } catch (error) {
      failure = error;
    }
    // Raw audio is never kept: delete the upload before responding.
    if (req.file) await rm(req.file.path, { force: true });

    if (failure) return next(failure);
    res.status(201).location(`/api/transcriptions/${resource.id}`).json(resource);
  });

  router.get("/", handle((req, res) => res.json({ transcriptions: store.list(req.user.id) })));

  router.get("/:id", handle((req, res) => res.json(store.get(req.user.id, requireId(req.params.id)))));

  router.delete("/:id", handle((req, res) => {
    store.delete(req.user.id, requireId(req.params.id));
    res.status(204).end();
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
