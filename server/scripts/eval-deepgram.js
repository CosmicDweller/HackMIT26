// `npm run eval:deepgram [names...]`: scores the live Deepgram engine on the SYNTHETIC recordings against
// hand-known ground truth (WER, diarization error rate, word-to-speaker accuracy, speaker-count error).
// Sends synthetic audio to Deepgram (billed per audio minute). Never prints the API key.
import { loadConfig } from "../config.js";
import { evaluate, pct } from "../tests/live-eval.js";

const config = loadConfig();
if (!config.deepgramApiKey) {
  console.error("DEEPGRAM_API_KEY is empty (server/.env).");
  process.exit(2);
}
const names = process.argv.slice(2).length ? process.argv.slice(2) : ["aba", "two-speaker", "three-speaker", "medical", "single-speaker", "overlap"];

console.log(`Model ${config.deepgramModel}, diarize_model=${config.deepgramDiarizeModel}. Synthetic audio only.\n`);
console.log("recording        audio  time  spk(true/found)  WER    DER   word->spk  review  mixed-utt  diarizer");
for (const name of names) {
  try {
    const r = await evaluate(name, config);
    console.log(
      `${name.padEnd(15)} ${String(r.audioSeconds?.toFixed(0) ?? "?").padStart(5)}s ${r.requestSeconds.toFixed(1).padStart(4)}s  ` +
      `${r.trueSpeakers}/${r.detectedSpeakers} (err ${r.speakerCountError})`.padEnd(16) +
      ` ${pct(r.wer)} ${pct(r.der)}  ${pct(r.wordAttribution)}   ${String(r.needsReview).padStart(2)}/${String(r.segments).padEnd(3)}  ${String(r.mixedUtterances).padStart(2)}/${String(r.utterances).padEnd(3)}     ${r.diarizer} ${r.diarizationStatus}`,
    );
  } catch (error) {
    console.log(`${name.padEnd(15)} FAILED: ${error.code ?? error.message}`);
  }
}
