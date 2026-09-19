import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { fileExists } from "./lib/exec.js";
import { diarizationSetup } from "./services/diarization.js";
import { createCallbackApp } from "./routes/callback.js";
import { checkReadiness } from "./services/readiness.js";

const config = loadConfig();
const app = createApp(config);

const { ready, missing } = await checkReadiness(config);
if (!ready) {
  console.warn(`Not ready: missing ${missing.join(", ")}. See server/README.md. /api/health will report "unavailable".`);
}

if (config.whisperVadModel && !(await fileExists(config.whisperVadModel))) {
  console.warn("VAD model not found: silent recordings may produce phantom text. Run `npm run setup:model`.");
}

const diarization = await diarizationSetup(config);
if (config.diarizationEnabled && !(diarization.python && diarization.script && diarization.models)) {
  console.warn("Speaker diarization is not installed: transcriptions will be returned without speaker labels. Run `npm run setup:diarization`.");
}
if (!config.supabaseUrl) {
  console.warn("SUPABASE_URL is not set: /api/transcriptions and /api/me will reject every request until it is configured.");
}

if (config.sttEngine === "deepgram") {
  if (config.deepgramApiKey) {
    console.warn(`Speech engine: Deepgram (${config.deepgramModel}, diarize_model=${config.deepgramDiarizeModel}). Audio from authenticated recordings is sent to Deepgram (mip_opt_out=true). Synthetic data only unless a BAA and other approvals are in place.`);
  } else {
    console.warn("STT_ENGINE is deepgram (the default) but DEEPGRAM_API_KEY is empty: recordings will fail with PROVIDER_NOT_CONFIGURED. Set the key, or STT_ENGINE=local for the whisper.cpp engine.");
  }
}

// Durable jobs: resume queued work, fail anything that may already have been sent to Deepgram, sweep retention.
await app.locals.jobs.start();

// Optional, and only when explicitly configured: a separate tiny listener that serves ONLY Deepgram's callback.
let callbackServer = null;
if (config.deepgramCallbackBaseUrl) {
  callbackServer = createCallbackApp(app.locals.jobs).listen(config.callbackPort, "127.0.0.1", () => {
    console.warn(`Deepgram callback listener on 127.0.0.1:${config.callbackPort} (only /deepgram-callback/:jobId). It is reachable from the internet only if YOU expose that port, for example with a tunnel to ${config.deepgramCallbackBaseUrl}.`);
  });
}

const server = app.listen(config.port, () => {
  console.log(`Speech-to-text server listening on http://localhost:${config.port}`);
});

// Give in-flight transcriptions a chance to finish, then exit.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    app.locals.jobs.stop();
    callbackServer?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), config.processTimeoutMs).unref();
  });
}
