import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { prepareRecording } from "./services/recording.js";
import { requestDeepgram, normalizeDeepgramResponse } from "./services/deepgram.js";
import { wordAttribution, truthTurns } from "./tests/eval.js";
process.loadEnvFile(".env");
const config = loadConfig(process.env);
const dir = "tests/.generated/repro";
const names = readdirSync(dir).filter((f) => f.endsWith(".truth.json")).map((f) => f.replace(".truth.json", ""));
const variant = process.argv[2] ?? "wav";
console.log(`variant: ${variant}  (model ${config.deepgramModel}, diarize_model ${config.deepgramDiarizeModel})`);
console.log("recording                  ranDiarizer  raw-word-speakers  utt-speakers(sets)  normalized  word->spk  flac/orig dur");
for (const name of names) {
  const truth = JSON.parse(readFileSync(`${dir}/${name}.truth.json`, "utf8"));
  let input = `${dir}/${name}.wav`;
  if (variant === "opus") { input = `${dir}/${name}.lossy.webm`; spawnSync("ffmpeg", ["-y", "-v", "error", "-i", `${dir}/${name}.wav`, "-c:a", "libopus", "-b:a", "16k", input]); }
  const work = mkdtempSync(path.join(os.tmpdir(), "repro-"));
  const prepared = await prepareRecording(input, work, config);
  const raw = await requestDeepgram(prepared.path, config, { contentType: prepared.contentType, timeoutMs: 120000 });
  const words = raw.results.channels[0].alternatives[0].words;
  const utts = raw.results.utterances ?? [];
  const norm = normalizeDeepgramResponse(raw);
  const rawSp = [...new Set(words.map((w) => w.speaker))].sort();
  const uttSets = utts.map((u) => `${u.speaker}:[${[...new Set(u.words.map((w) => w.speaker))]}]`).join(" ");
  const attr = wordAttribution(truthTurns({ turns: truth.turns.map((t) => ({ speaker: t.speaker, startMs: t.startMs, endMs: t.endMs })) }), words.map((w) => ({ speaker: w.speaker, startMs: w.start * 1000, endMs: w.end * 1000 })));
  console.log(`${name.padEnd(26)} ${String(Boolean(raw.metadata.diarize_info)).padEnd(11)}  ${JSON.stringify(rawSp).padEnd(17)}  ${uttSets.padEnd(19)} ${String(norm.speakerIndices.length).padEnd(10)}  ${(attr.accuracy * 100).toFixed(0).padStart(3)}%       ${prepared.durationSeconds.toFixed(2)}/${(truth.durationMs / 1000).toFixed(2)}`);
}
