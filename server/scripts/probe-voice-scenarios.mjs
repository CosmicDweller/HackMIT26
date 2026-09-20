// Runs every voice fixture scenario (tests/fixtures/voice) through the REAL pipeline: real enrollment, real segmentation, real ECAPA model.
// Words come from the ground-truth turns and Deepgram's speaker labels are deliberately "merged" (all speaker 0), so this exercises the
// independent analysis with no network access. Prints what really happened, including failures.
import { readFileSync, mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { openStore } from "../db/store.js";
import { createEmbedder } from "../services/voice/embedder.js";
import { createVoiceService } from "../services/voice/enrollment.js";
import { analyzeSpeakers } from "../services/voice/analysis.js";
import { toWav } from "../services/recording.js";
import { normalizeDeepgramResponse } from "../services/deepgram.js";

const F = "tests/fixtures/voice";
export const SCENARIOS = [
  ["dpdp", "ralph"], ["doctor-absent", "ralph"], ["three-speakers", "ralph"], ["doctor-alone", "ralph"], ["patient-alone", "ralph"],
  ["deepgram-miss", "kathy"], ["similar-voices", "reed_uk"], ["short-doctor-reply", "ralph"], ["long-gap", "ralph"], ["different-mic", "ralph"],
];

export async function realEnvironment() {
  const config = { ...loadConfig({}), voiceProfileKey: randomBytes(32).toString("base64"), tmpDir: mkdtempSync(path.join(os.tmpdir(), "voice-real-")) };
  const store = openStore(":memory:");
  const embedder = createEmbedder(config);
  const voice = createVoiceService({ config, store, embedder });
  const refs = {};
  for (const name of ["ralph", "kathy", "reed_uk"]) {
    store.upsertDoctor({ id: name });
    await voice.enroll(name, { files: [0, 1, 2].map((i) => ({ path: `${F}/enroll-${name}-${i}.flac` })), consent: "true", consentVersion: voice.consent.version });
    refs[name] = await voice.loadReferences(name);
  }
  return { config, store, embedder, voice, refs };
}

/** Deepgram-shaped words from a fixture's ground-truth turns (every word gets `dg(turn)` as its speaker). */
export function wordsFromTruth(truth, dg = () => 0) {
  return truth.turns.flatMap((t, ti) => {
    const n = Math.max(2, Math.round((t.endMs - t.startMs) / 450));
    return Array.from({ length: n }, (_, i) => {
      const s = (t.startMs + (i * (t.endMs - t.startMs)) / n) / 1000;
      return { word: "w", punctuated_word: "w", start: s, end: s + ((t.endMs - t.startMs) / n / 1000) * 0.85, confidence: 0.99, speaker: dg(t, ti), speaker_confidence: 0.95 };
    });
  });
}
export const normalizedFromWords = (words) =>
  normalizeDeepgramResponse({ metadata: { request_id: "r", duration: 1, model_info: {}, diarize_info: { arch: "v2" } }, results: { channels: [{ alternatives: [{ words }] }] } });

export async function runScenario(env, name, doctor, dg = () => 0) {
  const truth = JSON.parse(readFileSync(`${F}/${name}.truth.json`, "utf8"));
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-scn-"));
  const wav = await toWav(`${F}/${name}.flac`, `${dir}/a.wav`, env.config);
  const t0 = Date.now();
  const result = await analyzeSpeakers({ normalized: normalizedFromWords(wordsFromTruth(truth, dg)), wavPath: wav, references: env.refs[doctor], config: env.config, embedder: env.embedder });
  // which found speaker does each TRUE speaker map to (majority of its words)?
  const map = {};
  for (const id of new Set(truth.turns.map((t) => t.speaker))) {
    const votes = new Map();
    for (const w of result.normalized.groups.flat()) {
      const mid = ((w.start + w.end) / 2) * 1000;
      const t = truth.turns.find((x) => mid >= x.startMs && mid <= x.endMs);
      if (t?.speaker === id && w.speaker !== null) votes.set(w.speaker, (votes.get(w.speaker) ?? 0) + 1);
    }
    const sp = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    map[id] = sp === undefined ? null : { speaker: sp, ...(result.identification.get(sp) ?? { status: "n/a" }) };
  }
  return { truth, result, map, trueSpeakers: new Set(truth.turns.map((t) => t.speaker)).size, foundSpeakers: result.normalized.speakerIndices.length, seconds: (Date.now() - t0) / 1000 };
}

if (process.argv[1].endsWith("probe-voice-scenarios.mjs")) {
  const env = await realEnvironment();
  for (const [name, doctor] of SCENARIOS) {
    const r = await runScenario(env, name, doctor);
    const cells = Object.entries(r.map).map(([id, m]) => `${id}->${m ? `${m.speaker}:${m.status}${m.score != null ? `(${m.score})` : ""}` : "-"}`).join("  ");
    console.log(`${name.padEnd(20)} enrolled=${doctor.padEnd(8)} speakers true ${r.trueSpeakers} -> found ${r.foundSpeakers} (${r.result.source}) | ${cells} | ${r.seconds.toFixed(1)}s`);
  }
}
