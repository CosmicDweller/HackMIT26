import express from "express";
import { cors, errorHandler } from "./middleware/errors.js";
import { createHealthRouter } from "./routes/health.js";
import { openStore } from "./db/store.js";
import { createAuthenticator } from "./middleware/auth.js";
import { createTranscribeRouter } from "./routes/transcribe.js";
import { createTranscriptionsRouter } from "./routes/transcriptions.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createJobManager } from "./services/jobs.js";
import { createPipeline } from "./services/pipeline.js";

/**
 * Build the Express app. Takes a config object so tests can inject their own.
 * `overrides.jwks` injects a signing-key set (tests); `overrides.store` injects a database.
 */
export function createApp(config, overrides = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors(config.corsOrigin));
  app.use("/api", createHealthRouter(config));
  const pipeline = createPipeline(config);
  app.use("/api", createTranscribeRouter(config, pipeline));

  const store = overrides.store ?? openStore(config.dbPath);
  const authenticate = createAuthenticator(config, { jwks: overrides.jwks, store });
  // Every authenticated recording goes through the persistent job system.
  const jobs = createJobManager({ config, store, pipeline });
  app.use("/api/transcriptions", createTranscriptionsRouter(config, jobs, store, authenticate));
  app.use("/api/transcription-jobs", createJobsRouter(config, jobs, store, authenticate));
  app.get("/api/me", authenticate, (req, res) => {
    res.json({ id: req.user.id, email: req.user.email, displayName: req.user.displayName, credentialsVerified: false });
  });
  app.use(errorHandler);
  app.locals.store = store;
  app.locals.jobs = jobs;
  return app;
}
