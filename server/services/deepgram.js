// OPT-IN cloud speech-to-text + diarization via Deepgram (STT_ENGINE=deepgram).
//
// PRIVACY: this sends the (FFmpeg-normalized) audio to Deepgram's servers. It is off by default and
// only used by the authenticated /api/transcriptions route, never by the public /api/transcribe.
// Every request sets mip_opt_out=true. Use synthetic data only unless a Business Associate Agreement
// and the other approvals in docs/API_CONTRACT.md ("Privacy and security") are in place.
//
// The API key is read from the environment, never logged, and never returned to clients.
// Request/response shapes follow Deepgram's pre-recorded API reference. They have been tested only
// against a stub server built from that reference, not against the live service.
import { readFile } from "node:fs/promises";
import { requestCancelled, transcriptionFailed } from "../lib/errors.js";

// A run of words becomes its own segment when the speaker changes or people pause this long.
export const MAX_GAP_SECONDS = 1.0;
// Runs whose mean speaker confidence is below this are left unassigned (speakerId null).
export const MIN_SPEAKER_CONFIDENCE = 0.5;

export class DeepgramError extends Error {}

/**
 * Turn Deepgram's per-word output into transcript segments and speaker intervals.
 * `diarizeRan` is true when the response carries diarization metadata. Without it no speaker
 * is ever invented. Returns { segments: [{start, end, text}] (seconds), intervals: [{speaker, startMs, endMs}] }.
 */
export function wordsToSegments(words, { diarizeRan }) {
  const ordered = [...words].filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end)).sort((a, b) => a.start - b.start);
  // Diarization ran but no word has a label: Deepgram omits labels for single-speaker audio.
  const singleSpeaker = diarizeRan && ordered.length > 0 && ordered.every((word) => word.speaker === undefined);

  const runs = [];
  for (const word of ordered) {
    const speaker = singleSpeaker ? 0 : typeof word.speaker === "number" ? word.speaker : null;
    const last = runs.at(-1);
    if (last && last.speaker === speaker && word.start - last.end < MAX_GAP_SECONDS) {
      last.words.push(word);
      last.end = word.end;
    } else {
      runs.push({ speaker, start: word.start, end: word.end, words: [word] });
    }
  }

  const segments = [];
  const intervals = [];
  for (const run of runs) {
    const text = run.words.map((word) => word.punctuated_word ?? word.word).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    segments.push({ start: run.start, end: run.end, text });
    if (diarizeRan && run.speaker !== null) {
      const confidences = run.words.map((word) => word.speaker_confidence).filter(Number.isFinite);
      const mean = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 1;
      if (mean >= MIN_SPEAKER_CONFIDENCE) {
        intervals.push({ speaker: run.speaker, startMs: Math.round(run.start * 1000), endMs: Math.round(run.end * 1000) });
      }
    }
  }
  return { segments, intervals };
}

/** Names of the model(s) Deepgram reports having used, from the response metadata. */
export function reportedModels(result) {
  const info = result?.metadata?.model_info;
  if (!info || typeof info !== "object") return [];
  return Object.values(info).map((model) => [model?.name, model?.version].filter(Boolean).join(" ")).filter(Boolean);
}

export function deepgramConfigured(config) {
  return config.sttEngine === "deepgram" && Boolean(config.deepgramApiKey);
}

/**
 * Transcribe and diarize a 16 kHz mono WAV with Deepgram.
 * Throws DeepgramError for any service problem (the caller falls back to the local engine),
 * requestCancelled when the client disconnects, and a 422 transcriptionFailed for "no speech".
 */
export async function deepgramTranscribe(wavPath, config, { timeoutMs, signal } = {}) {
  const result = await requestDeepgram(wavPath, config, { timeoutMs, signal });
  return parseDeepgramResult(result);
}

/** POST the WAV to Deepgram and return the parsed JSON response. Throws DeepgramError / requestCancelled. */
export async function requestDeepgram(wavPath, config, { timeoutMs, signal } = {}) {
  // The medical model only supports English; anything else goes to the local engine instead.
  if (/medical/.test(config.deepgramModel) && !/^en(-|$)/.test(config.whisperLanguage)) {
    throw new DeepgramError("the medical model supports English only");
  }
  const params = new URLSearchParams({
    model: config.deepgramModel,
    punctuate: "true",
    diarize_model: "latest",
    mip_opt_out: "true",
  });
  if (config.whisperLanguage === "auto") params.set("detect_language", "true");
  else params.set("language", config.whisperLanguage);

  const body = await readFile(wavPath);
  let response;
  try {
    response = await fetch(`${config.deepgramBaseUrl.replace(/\/+$/, "")}/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${config.deepgramApiKey}`, "Content-Type": "audio/wav" },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))].filter(Boolean)),
    });
  } catch (error) {
    if (signal?.aborted) throw requestCancelled();
    throw new DeepgramError(error?.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!response.ok) throw new DeepgramError(`http ${response.status}`); // never include the body: it may echo input

  try {
    return await response.json();
  } catch {
    throw new DeepgramError("unparseable response");
  }
}

function parseDeepgramResult(result) {
  const alternative = result?.results?.channels?.[0]?.alternatives?.[0];
  if (!alternative || !Array.isArray(alternative.words)) throw new DeepgramError("unexpected response shape");

  const diarizeRan = Boolean(result.metadata?.diarize_info);
  const { segments, intervals } = wordsToSegments(alternative.words, { diarizeRan });
  if (segments.length === 0) throw transcriptionFailed("No speech was detected in the recording.", 422);

  return {
    text: segments.map((segment) => segment.text).join(" "),
    segments,
    models: reportedModels(result),
    diarization: {
      // Diarization that did not run is reported as failed, never as a normal-looking result.
      status: diarizeRan ? "ok" : "failed",
      speakerCount: new Set(intervals.map((interval) => interval.speaker)).size,
      intervals,
    },
  };
}
