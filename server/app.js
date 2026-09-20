import express from "express";
import { cors, errorHandler } from "./middleware/errors.js";
import { createHealthRouter } from "./routes/health.js";
import { openStore } from "./db/store.js";
import { createAuthenticator } from "./middleware/auth.js";
import { createTranscribeRouter } from "./routes/transcribe.js";
import { createTranscriptionsRouter } from "./routes/transcriptions.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createVoiceProfileRouter } from "./routes/voiceProfile.js";
import { createEmbedder } from "./services/voice/embedder.js";
import { createVoiceService } from "./services/voice/enrollment.js";
import { createJobManager } from "./services/jobs.js";
import { createPyannote } from "./services/pyannote.js";
import { createSoapRouter } from "./routes/soap.js";
import { createSoapProvider } from "./services/soap/gemini.js";
import { createSoapGenerator } from "./services/soap/generate.js";
import { createSoapService } from "./services/soap/service.js";
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
  const embedder = overrides.embedder ?? createEmbedder(config);
  const voice = createVoiceService({ config, store, embedder });
  const pyannote = overrides.pyannote ?? createPyannote(config);
  // SOAP notes: Gemini drafts, deterministic checks validate, the doctor approves.
  const soapProvider = overrides.soapProvider ?? createSoapProvider(config);
  const soap = overrides.soap ?? createSoapService({ config, store, generator: createSoapGenerator({ config, provider: soapProvider }) });
  app.use("/api/me/voice-profile", createVoiceProfileRouter(config, voice, authenticate));
  // Every authenticated recording goes through the persistent job system.
  const jobs = createJobManager({ config, store, pipeline, voice, embedder, pyannote, soap });
  app.use("/api", createSoapRouter(config, soap, store, authenticate));
  app.use("/api/transcriptions", createTranscriptionsRouter(config, jobs, store, authenticate));
  app.use("/api/transcription-jobs", createJobsRouter(config, jobs, store, authenticate));
  app.get("/api/me", authenticate, (req, res) => {
    res.json({ id: req.user.id, email: req.user.email, displayName: req.user.displayName, credentialsVerified: false });
  });
  app.use(errorHandler);
  app.locals.store = store;
  app.locals.pyannote = pyannote;
  app.locals.soap = soap;
  app.locals.jobs = jobs;
  app.locals.voice = voice;
  app.locals.embedder = embedder;
  return app;
}
