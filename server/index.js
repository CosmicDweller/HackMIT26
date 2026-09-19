import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { fileExists } from "./lib/exec.js";
import { diarizationSetup } from "./services/diarization.js";
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
    console.warn("STT_ENGINE=deepgram: audio from authenticated transcriptions is sent to Deepgram (mip_opt_out=true). Synthetic data only unless a BAA and other approvals are in place.");
  } else {
    console.warn("STT_ENGINE=deepgram but DEEPGRAM_API_KEY is empty: the local engine is used.");
  }
}

const server = app.listen(config.port, () => {
  console.log(`Speech-to-text server listening on http://localhost:${config.port}`);
});

// Give in-flight transcriptions a chance to finish, then exit.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), config.processTimeoutMs).unref();
  });
}
