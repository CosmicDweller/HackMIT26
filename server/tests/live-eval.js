// Scores the live Deepgram engine (through the production request and normalizer) against ground truth.
// Shared by the live test and `npm run eval:deepgram`. Uploads SYNTHETIC audio only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDeepgramResponse, requestDeepgram } from "../services/deepgram.js";
import { der, speakerCountError, truthText, truthTurns, wer, wordAttribution } from "./eval.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "synthetic");
export const generated = path.join(path.dirname(fileURLToPath(import.meta.url)), ".generated");

/** Recording name -> { wav, truth path }. Long generated recordings live in tests/.generated. */
export function locate(name) {
  const base = name.includes("min") ? path.join(generated, name) : path.join(fixtures, name);
  return { wav: `${base}.wav`, truthPath: `${base}.truth.json` };
}

export async function evaluate(name, config, { timeoutMs = 9 * 60_000 } = {}) {
  const { wav, truthPath } = locate(name);
  const truth = JSON.parse(readFileSync(truthPath, "utf8"));
  const turns = truthTurns(truth);
  const trueSpeakers = new Set(turns.map((t) => t.speaker)).size;

  const started = Date.now();
  const raw = await requestDeepgram(wav, config, { contentType: "audio/wav", timeoutMs });
  const seconds = (Date.now() - started) / 1000;
  const normalized = normalizeDeepgramResponse(raw, { reviewWordConfidence: config.reviewWordConfidence, reviewSpeakerConfidence: config.reviewSpeakerConfidence });

  const providerWords = raw.results.channels[0].alternatives[0].words.map((w) => ({ speaker: w.speaker, startMs: w.start * 1000, endMs: w.end * 1000 }));
  const hypothesis = normalized.segments.filter((s) => s.providerSpeaker !== null).map((s) => ({ speaker: s.providerSpeaker, startMs: s.startMs, endMs: s.endMs }));
  const text = normalized.segments.map((s) => s.text).join(" ");

  return {
    name,
    audioSeconds: raw.metadata?.duration ?? null,
    requestSeconds: seconds,
    model: normalized.meta.models.join(", "),
    diarizer: normalized.meta.diarizeModel ? `${normalized.meta.diarizeModel.arch}` : "ABSENT",
    diarizationStatus: normalized.diarizationStatus,
    empty: normalized.empty,
    trueSpeakers,
    detectedSpeakers: normalized.speakerIndices.length,
    speakerCountError: speakerCountError(trueSpeakers, normalized.speakerIndices.length),
    wer: wer(truthText(truth), text).wer,
    der: normalized.empty ? null : der(turns, hypothesis).der,
    wordAttribution: normalized.empty ? null : wordAttribution(turns, providerWords).accuracy,
    segments: normalized.segments.length,
    needsReview: normalized.segments.filter((s) => s.needsReview).length,
    mixedUtterances: (raw.results.utterances ?? []).filter((u) => new Set(u.words.map((w) => w.speaker)).size > 1).length,
    utterances: (raw.results.utterances ?? []).length,
    text,
  };
}

export const pct = (value) => (value === null ? "  n/a" : `${(value * 100).toFixed(1)}%`.padStart(6));
