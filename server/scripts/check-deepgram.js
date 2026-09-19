// Live check of the Deepgram engine: `npm run check-deepgram`.
// Sends ONE synthetic two-voice test clip (tests/fixtures/synthetic/two-speaker.wav) to Deepgram and
// prints which model Deepgram says it used, whether diarization ran, and the resulting speakers.
// Never prints the API key. Uses only synthetic audio.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { requestDeepgram, reportedModels, wordsToSegments } from "../services/deepgram.js";

const config = loadConfig();
const clip = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "synthetic", "two-speaker.wav");

console.log("Deepgram live check (sends 1 synthetic clip; no patient data)");
console.log(`  engine setting : ${config.sttEngine}`);
console.log(`  requested model: ${config.deepgramModel}`);
console.log(`  API key        : ${config.deepgramApiKey ? `set (${config.deepgramApiKey.length} characters)` : "NOT SET"}`);
if (!config.deepgramApiKey) {
  console.error("\nDEEPGRAM_API_KEY is empty. Add it to server/.env (never to chat or code).");
  process.exit(2);
}
if (config.sttEngine !== "deepgram") {
  console.log("  note           : STT_ENGINE is not 'deepgram', so the server will NOT use it. Set STT_ENGINE=deepgram in server/.env.");
}

try {
  const started = Date.now();
  const result = await requestDeepgram(clip, config, { timeoutMs: config.deepgramTimeoutMs });
  const ms = Date.now() - started;
  const alternative = result?.results?.channels?.[0]?.alternatives?.[0];
  const models = reportedModels(result);
  const diarizeRan = Boolean(result?.metadata?.diarize_info);
  const { segments, intervals } = wordsToSegments(alternative?.words ?? [], { diarizeRan });
  console.log(`\nResponse in ${ms} ms`);
  console.log(`  model reported by Deepgram: ${models.join(", ") || "(none in response)"}`);
  console.log(`  diarization ran           : ${diarizeRan ? "yes" : "NO"}`);
  console.log(`  speakers found            : ${new Set(intervals.map((i) => i.speaker)).size}`);
  console.log(`  segments                  : ${segments.length}`);
  for (const s of segments) {
    const speaker = intervals.find((i) => i.startMs === Math.round(s.start * 1000))?.speaker;
    console.log(`    [${s.start.toFixed(2)}-${s.end.toFixed(2)}] speaker ${speaker ?? "?"}: ${s.text}`);
  }
  process.exit(diarizeRan && intervals.length > 0 ? 0 : 1);
} catch (error) {
  console.error(`\nDeepgram request failed: ${error.message}`);
  process.exit(1);
}
