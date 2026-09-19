// Live check of the Deepgram engine: `npm run check-deepgram [recording-name]`.
// Sends ONE synthetic test recording (tests/fixtures/synthetic/<name>.wav, default: aba) to Deepgram with the
// exact production parameters, and prints what Deepgram reports: the model, whether the batch diarizer ran
// (metadata.diarize_info), and the speakers and segments after normalization. Never prints the API key.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { buildQuery, normalizeDeepgramResponse, requestDeepgram } from "../services/deepgram.js";

const config = loadConfig();
const name = process.argv[2] ?? "aba";
const clip = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "synthetic", `${name}.wav`);

console.log("Deepgram live check (sends 1 synthetic recording; no patient data)");
console.log(`  engine setting  : ${config.sttEngine}`);
console.log(`  request         : POST /v1/listen?${buildQuery(config)}`);
console.log(`  API key         : ${config.deepgramApiKey ? `set (${config.deepgramApiKey.length} characters)` : "NOT SET"}`);
if (!config.deepgramApiKey) {
  console.error("\nDEEPGRAM_API_KEY is empty. Add it to server/.env (never to chat or code).");
  process.exit(2);
}
if (config.sttEngine !== "deepgram") {
  console.log("  note            : STT_ENGINE is not 'deepgram', so the server will NOT use it.");
}

try {
  const started = Date.now();
  const result = await requestDeepgram(clip, config, { contentType: "audio/wav", timeoutMs: config.deepgramTimeoutMs });
  const ms = Date.now() - started;
  const normalized = normalizeDeepgramResponse(result);
  const { models, diarizeModel } = normalized.meta;
  console.log(`\nResponse in ${ms} ms`);
  console.log(`  model reported by Deepgram : ${models.join(", ") || "(none in response)"}`);
  console.log(`  diarizer (diarize_info)    : ${diarizeModel ? `ran, arch ${diarizeModel.arch}` : "ABSENT: the diarizer did not run"}`);
  console.log(`  diarization status         : ${normalized.diarizationStatus}`);
  console.log(`  speakers                   : ${normalized.speakerIndices.map((i) => `speaker_${i}`).join(", ") || "none"}`);
  console.log(`  segments                   : ${normalized.segments.length}`);
  for (const s of normalized.segments) {
    console.log(`    [${(s.startMs / 1000).toFixed(2)}-${(s.endMs / 1000).toFixed(2)}] speaker_${s.providerSpeaker ?? "?"}${s.needsReview ? " (needs review)" : ""}: ${s.text}`);
  }
  process.exit(diarizeModel && normalized.diarizationStatus === "completed" ? 0 : 1);
} catch (error) {
  console.error(`\nDeepgram request failed: ${error.code ?? error.message}`);
  process.exit(1);
}
