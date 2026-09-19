import express from "express";

/**
 * A deliberately tiny Express app that serves ONLY Deepgram's callback. It runs on its own port so that
 * exposing it (for example through a tunnel) never exposes the rest of the API.
 */
export function createCallbackApp(jobs) {
  const app = express();
  app.disable("x-powered-by");
  // Long recordings produce large transcripts.
  app.post("/deepgram-callback/:jobId", express.json({ limit: "256mb" }), async (req, res) => {
    try {
      res.sendStatus(await jobs.handleCallback(req.params.jobId, req.headers.authorization, req.body));
    } catch {
      res.sendStatus(500);
    }
  });
  // Everything else, including malformed bodies, gets an empty answer.
  app.use((_req, res) => res.sendStatus(404));
  // eslint-disable-next-line no-unused-vars
  app.use((_error, _req, res, _next) => res.sendStatus(400));
  return app;
}
