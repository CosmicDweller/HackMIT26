// Analysis-only timing and memory check for a LONG recording (default two hours), with no Deepgram call and no cost:
// the fixture conversation is repeated to the requested length, its known words are used in place of a transcript, and the real
// pipeline (real segmentation model, real ECAPA embeddings, real clustering, doctor verification) runs on the real audio.
// Usage: node scripts/probe-voice-long.mjs [--minutes 120] [--fixture dpdp] [--doctor ralph] [--deepgram-correct]
// (--deepgram-correct: the stand-in transcript carries the true speakers, as when Deepgram separates them; otherwise all words are one speaker, as when it merges them)
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeSpeakers } from "../services/voice/analysis.js";
import { normalizedFromWords, realEnvironment, wordsFromTruth } from "./probe-voice-scenarios.mjs";

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const minutes = Number(arg("minutes", 120));
const fixture = arg("fixture", "dpdp");
const doctor = arg("doctor", "ralph");
const correct = process.argv.includes("--deepgram-correct");
const F = new URL("../tests/fixtures/voice/", import.meta.url).pathname;

const truth = JSON.parse(readFileSync(`${F}${fixture}.truth.json`, "utf8"));
const unitMs = Math.ceil(truth.durationMs / 1000) * 1000 + 2000; // each repetition padded by silence, like a pause between visits
const reps = Math.ceil((minutes * 60_000) / unitMs);
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-long-"));
const env = await realEnvironment();

const unitWav = `${dir}/unit.wav`;
let r = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", `${F}${fixture}.flac`, "-af", `apad=whole_dur=${unitMs / 1000}`, "-ac", "1", "-ar", "16000", unitWav]);
if (r.status !== 0) throw new Error(String(r.stderr));
const wav = `${dir}/long.wav`;
r = spawnSync("ffmpeg", ["-y", "-v", "error", "-stream_loop", String(reps - 1), "-i", unitWav, "-c", "copy", wav]);
if (r.status !== 0) throw new Error(String(r.stderr));
console.log(`recording: ${reps} repetitions, ${(statSync(wav).size / 1e6).toFixed(0)} MB WAV, ${((reps * unitMs) / 60000).toFixed(0)} minutes`);

const words = [];
for (let i = 0; i < reps; i++) for (const w of wordsFromTruth(truth, correct ? (t) => (t.speaker === "D" ? 0 : 1) : () => 0)) words.push({ ...w, start: w.start + (i * unitMs) / 1000, end: w.end + (i * unitMs) / 1000 });
const normalized = normalizedFromWords(words);

// peak resident memory of the voice model process, sampled while the analysis runs
let peakKb = 0;
const sampler = setInterval(() => {
  const ps = spawnSync("ps", ["-axo", "rss=,command="]).stdout.toString().split("\n").filter((l) => /voice\/embed\.py|diarize|sherpa/.test(l));
  for (const l of ps) peakKb = Math.max(peakKb, Number(l.trim().split(/\s+/)[0]) || 0);
}, 1000);
const t0 = Date.now();
const result = await analyzeSpeakers({ normalized, wavPath: wav, references: env.refs[doctor], config: env.config, embedder: env.embedder });
clearInterval(sampler);
const seconds = (Date.now() - t0) / 1000;

const out = result.normalized;
const perSpeaker = new Map();
for (const w of out.groups.flat()) perSpeaker.set(w.speaker, (perSpeaker.get(w.speaker) ?? 0) + 1);
let backwards = 0;
const flat = out.groups.flat();
for (let i = 1; i < flat.length; i++) if (flat[i].start < flat[i - 1].start) backwards++;
console.log(JSON.stringify({
  minutes, analysisSeconds: Math.round(seconds), speakersFound: out.speakerIndices.length, source: result.source, voiceStatus: result.voiceStatus,
  identification: [...result.identification.entries()].map(([s, v]) => ({ speaker: s, status: v.status, regions: v.regions, speechSeconds: v.speechSeconds })),
  wordsIn: words.length, wordsOut: flat.length, wordsPerSpeaker: Object.fromEntries(perSpeaker), timestampsGoingBackwards: backwards,
  lastWordSeconds: Math.round(flat.at(-1).end), nodeRssMb: Math.round(process.memoryUsage().rss / 1e6), modelProcessPeakRssMb: Math.round(peakKb / 1024), warnings: result.warnings.map((w) => w.code),
}, null, 1));
process.exit(0);
