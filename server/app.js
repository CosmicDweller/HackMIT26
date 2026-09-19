import express from "express";
import { cors, errorHandler } from "./middleware/errors.js";
import { createHealthRouter } from "./routes/health.js";
import { createTranscribeRouter } from "./routes/transcribe.js";

/** Build the Express app. Takes a config object so tests can inject their own. */
export function createApp(config) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors(config.corsOrigin));
  app.use("/api", createHealthRouter(config));
  app.use("/api", createTranscribeRouter(config));
  app.use(errorHandler);
  return app;
}
