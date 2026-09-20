// Deepgram (hosted) speech-to-text + diarization: Nova-3 Medical with the latest BATCH diarizer.
//
// PRIVACY: this sends audio to Deepgram's servers. It is only used by the authenticated
// /api/transcriptions and /api/transcription-jobs routes, never by the public /api/transcribe. Every
// request sets mip_opt_out=true. Use synthetic data unless a Business Associate Agreement and the other
// approvals in docs/API_CONTRACT.md ("Privacy and security") are in place.
//
// The API key comes from the environment, is only ever put in the Authorization header, and is never
// logged or returned. Provider response bodies are never logged (they can echo input).
//
// The request/response shapes were verified against the live service with synthetic audio; the real
// responses are saved in tests/fixtures/deepgram/.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream";
import { requestCancelled } from "../lib/errors.js";

// Upper bound for a provider response held in memory (a 30-minute transcript is a few MB).
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;

/**
 * A classified provider failure. `code` is safe to show; `retriable` says whether an explicit retry can
 * help; `autoRetry` says it is safe to resubmit automatically because the audio was not processed
 * (rate limiting or a connection that never reached Deepgram). Timeouts are never auto-retried, since
 * Deepgram may have processed (and billed) the request.
 */
export class DeepgramError extends Error {
  constructor(code, { status, retriable = false, autoRetry = false } = {}) {
    super(code);
    this.name = "DeepgramError";
    this.code = code;
    this.status = status;
    this.retriable = retriable;
    this.autoRetry = autoRetry;
  }
}

export function deepgramConfigured(config) {
  return Boolean(config.deepgramApiKey);
}

/**
 * Exact query for the prerecorded API: model, diarize_model (never diarize=true), utterances,
 * smart_format and language, plus mip_opt_out for privacy. No `keywords` (unsupported by Nova-3):
 * optional `keyterm` prompting is only added when configured.
 */
export function buildQuery(config, { callbackUrl, model = config.deepgramModel } = {}) {
  const params = new URLSearchParams();
  params.set("model", model);
  params.set("diarize_model", config.deepgramDiarizeModel);
  params.set("utterances", "true");
  params.set("smart_format", "true");
  params.set("language", config.deepgramLanguage);
  params.set("mip_opt_out", "true");
  for (const term of config.deepgramKeyterms) params.append("keyterm", term);
  if (callbackUrl) params.set("callback", callbackUrl);
  return params;
}

function classifyHttpError(status, bodyText) {
  const body = bodyText.toLowerCase();
  if (status === 401 || status === 403) {
    // A 403 can also mean the model is not enabled for the account.
    if (status === 403 && /model/.test(body)) return new DeepgramError("PROVIDER_MODEL_UNAVAILABLE", { status });
    return new DeepgramError("PROVIDER_AUTH_FAILED", { status });
  }
  if (status === 402) return new DeepgramError("PROVIDER_ACCOUNT_LIMIT", { status });
  if (status === 429) return new DeepgramError("PROVIDER_RATE_LIMITED", { status, retriable: true, autoRetry: true });
  if (status === 408 || status === 504) return new DeepgramError("PROVIDER_TIMEOUT", { status, retriable: true });
  if (status === 413 || status === 415) return new DeepgramError("PROVIDER_BAD_AUDIO", { status });
  if (status === 400 || status === 404 || status === 422) {
    if (/model/.test(body) && /(not|unavailable|invalid|unknown|access)/.test(body)) {
      return new DeepgramError("PROVIDER_MODEL_UNAVAILABLE", { status });
    }
    return new DeepgramError("PROVIDER_BAD_AUDIO", { status });
  }
  return new DeepgramError("PROVIDER_UNAVAILABLE", { status, retriable: true });
}

/**
 * POST a file to Deepgram, streaming it from disk with backpressure: the file is never held in memory
 * (node:http/https is used rather than fetch, whose stream bodies were measured to buffer whole files).
 * Resolves with the parsed JSON body. With `callbackUrl`, Deepgram answers immediately with
 * { request_id } and delivers the transcript to that URL later.
 * `onBodySent` fires when the whole file has been flushed to the network: from then on we are waiting
 * for Deepgram to process it.
 * Throws DeepgramError, or requestCancelled if `signal` aborts.
 */
export async function requestDeepgram(filePath, config, { contentType, timeoutMs, signal, callbackUrl, model, onBodySent } = {}) {
  if (!deepgramConfigured(config)) throw new DeepgramError("PROVIDER_NOT_CONFIGURED");

  const { size } = await stat(filePath);
  const url = new URL(`${config.deepgramBaseUrl.replace(/\/+$/, "")}/v1/listen?${buildQuery(config, { callbackUrl, model })}`);
  const transport = url.protocol === "http:" ? http : https;
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs ?? config.deepgramTimeoutMs));
  const combined = AbortSignal.any([signal, timeout].filter(Boolean));

  const response = await new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "POST",
      headers: { Authorization: `Token ${config.deepgramApiKey}`, "Content-Type": contentType, "Content-Length": size },
      signal: combined,
    });
    req.once("finish", () => onBodySent?.());
    req.once("response", resolve);
    req.once("error", reject);
    pipeline(createReadStream(filePath), req, () => {});
  }).catch((error) => {
    if (signal?.aborted) throw requestCancelled();
    if (timeout.aborted) throw new DeepgramError("PROVIDER_TIMEOUT", { retriable: true });
    // A refused/unreachable connection never reached Deepgram, so resubmitting cannot double-bill.
    const refused = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(error?.code);
    throw new DeepgramError("PROVIDER_UNAVAILABLE", { retriable: true, autoRetry: refused });
  });

  // Read the answer (size-capped). A failure here happens after the audio was sent.
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of response) {
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES) throw new DeepgramError("PROVIDER_MALFORMED_RESPONSE");
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal?.aborted) throw requestCancelled();
    if (error instanceof DeepgramError) throw error;
    throw new DeepgramError(timeout.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE", { retriable: true });
  }
  const text = Buffer.concat(chunks).toString("utf8");

  if (response.statusCode < 200 || response.statusCode >= 300) {
    // The body is used only to classify the error; it is never logged or returned.
    throw classifyHttpError(response.statusCode, text.slice(0, 2000));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DeepgramError("PROVIDER_MALFORMED_RESPONSE");
  }
}

// ----------------------------------------------------------------------------------------------
// Normalization: Deepgram JSON -> our segments.
// ----------------------------------------------------------------------------------------------

// Adjacent same-speaker segments are re-joined across a pause shorter than this when the earlier one
// did not end a sentence. Also the pause that starts a new group when no utterances are available.
const MERGE_GAP_MS = 1000;
const SENTENCE_END = /[.?!]["')\]]*$/;
// Review flag rule (an advisory heuristic, tuned only on tiny synthetic data): a word below the review
// confidence flags its segment only when it is long enough to carry content (drug names, terms), because
// short function words such as "and" often score low without being wrong (flagging them marked ~60% of
// segments in a five-minute test). A very uncertain word always flags.
const REVIEW_MIN_WORD_LENGTH = 5;
const REVIEW_ALWAYS_BELOW = 0.5;

const validTime = (word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start;
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const round = (value, places = 4) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);

/** Names and version of the model(s) Deepgram reports having used. */
export function reportedModels(result) {
  const info = result?.metadata?.model_info;
  if (!info || typeof info !== "object") return [];
  return Object.values(info).map((model) => [model?.name, model?.version].filter(Boolean).join(" ")).filter(Boolean);
}

/**
 * Turn a Deepgram prerecorded response into speaker-labelled segments.
 *
 *  - The channel `words` are the source of truth for text, timestamps and speakers. Utterances only
 *    provide boundaries, and only when their words add up exactly to the channel words.
 *  - An utterance whose words carry different speakers is SPLIT at the word boundary (real responses do
 *    this: a patient's answer and the doctor's next question arrive as one utterance).
 *  - Small adjacent same-speaker fragments are re-joined when the earlier one did not end a sentence.
 *  - Speaker ids are never invented: if `metadata.diarize_info` is absent every speaker is null and the
 *    result is `failed`; a word without a speaker index stays null.
 *  - No word is dropped or duplicated, and no timestamp is made up. A segment's times come from its own
 *    valid words only.
 *
 * Returns { empty, segments, speakerIndices, diarizationStatus, meta }. `empty` means no speech.
 * Throws DeepgramError("PROVIDER_MALFORMED_RESPONSE") when required data is missing.
 */
/**
 * Group words into segments: split each utterance group at every change of speaker, re-join same-speaker fragments that split
 * mid-sentence after a short pause, then time each segment from its own valid words. Used by the normalizer and again after
 * speaker labels are reassigned from independent voice analysis (every word and timestamp is preserved either way).
 */
export function segmentsFromWords(groups, { reviewWordConfidence = 0.85, reviewSpeakerConfidence = 0.6 } = {}) {
  // 2. Split every group at each change of speaker.
  const runs = [];
  groups.forEach((group, groupIndex) => {
    for (const word of group) {
      const last = runs.at(-1);
      if (last && last.groupIndex === groupIndex && last.speaker === word.speaker) last.words.push(word);
      else runs.push({ speaker: word.speaker, words: [word], groupIndex });
    }
  });

  // 3. Re-join adjacent same-speaker fragments that split mid-sentence after a short pause.
  const extent = (run) => {
    const valid = run.words.filter((word) => word.valid);
    return valid.length ? { start: valid[0].start, end: valid.at(-1).end } : null;
  };
  const merged = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (previous && previous.speaker === run.speaker) {
      const a = extent(previous);
      const b = extent(run);
      // A fragment with no usable time cannot stand alone (it would need an invented timestamp), so it
      // always stays with the same speaker's neighbouring words.
      const untimed = !a || !b;
      const gapMs = untimed ? 0 : (b.start - a.end) * 1000;
      if (untimed || (gapMs < MERGE_GAP_MS && !SENTENCE_END.test(previous.words.at(-1).text))) {
        previous.words.push(...run.words);
        continue;
      }
    }
    merged.push({ speaker: run.speaker, words: [...run.words] });
  }

  // 4. Build segments. Times come only from the segment's own valid words.
  const segments = merged.map((run) => {
    const timed = run.words.filter((word) => word.valid);
    if (timed.length === 0) throw new DeepgramError("PROVIDER_MALFORMED_RESPONSE");
    const wordConfidences = run.words.map((word) => word.confidence).filter((value) => value !== null);
    const speakerConfidences = run.words.map((word) => word.speakerConfidence).filter((value) => value !== null);
    const meanSpeaker = mean(speakerConfidences);
    const needsReview =
      run.speaker === null ||
      timed.length !== run.words.length ||
      run.words.some((word) => word.reviewSpeaker === true) ||
      run.words.some((word) => word.confidence !== null && (
        word.confidence < REVIEW_ALWAYS_BELOW ||
        (word.confidence < reviewWordConfidence && word.text.replace(/[^a-z0-9]/gi, "").length >= REVIEW_MIN_WORD_LENGTH)
      )) ||
      (meanSpeaker !== null && meanSpeaker < reviewSpeakerConfidence);
    return {
      startMs: Math.round(timed[0].start * 1000),
      endMs: Math.round(timed.at(-1).end * 1000),
      text: run.words.map((word) => word.text).join(" "),
      providerSpeaker: run.speaker,
      needsReview,
      confidence: round(mean(wordConfidences)),
      speakerConfidence: round(meanSpeaker),
    };
  });

  return segments;
}

export function normalizeDeepgramResponse(result, { reviewWordConfidence = 0.85, reviewSpeakerConfidence = 0.6 } = {}) {
  const alternative = result?.results?.channels?.[0]?.alternatives?.[0];
  if (!alternative || !Array.isArray(alternative.words)) throw new DeepgramError("PROVIDER_MALFORMED_RESPONSE");

  const diarizeInfo = result.metadata?.diarize_info;
  const diarizeRan = Boolean(diarizeInfo);
  const meta = {
    requestId: typeof result.metadata?.request_id === "string" ? result.metadata.request_id : null,
    models: reportedModels(result),
    diarizeModel: diarizeRan ? { arch: diarizeInfo.arch ?? null, modelUuid: diarizeInfo.model_uuid ?? null } : null,
    providerDurationSeconds: Number.isFinite(result.metadata?.duration) ? result.metadata.duration : null,
  };

  const toWord = (raw) => ({
    text: String(raw.punctuated_word ?? raw.word ?? "").trim(),
    start: raw.start,
    end: raw.end,
    valid: validTime(raw),
    // Never assign a speaker unless the diarizer actually ran.
    speaker: diarizeRan && Number.isInteger(raw.speaker) && raw.speaker >= 0 ? raw.speaker : null,
    speakerConfidence: Number.isFinite(raw.speaker_confidence) ? raw.speaker_confidence : null,
    confidence: Number.isFinite(raw.confidence) ? raw.confidence : null,
  });

  const words = alternative.words.map(toWord).filter((word) => word.text);
  if (words.length === 0) {
    return { empty: true, segments: [], speakerIndices: [], diarizationStatus: diarizeRan ? "completed" : "failed", meta };
  }

  // 1. Utterance groups (boundaries only). Use them only when they account for exactly the channel words.
  let groups;
  const utterances = result.results?.utterances;
  if (Array.isArray(utterances) && utterances.length > 0) {
    const fromUtterances = utterances.map((utterance) => (Array.isArray(utterance.words) ? utterance.words.map(toWord).filter((word) => word.text) : []));
    if (fromUtterances.flat().length === words.length) groups = fromUtterances.filter((group) => group.length > 0);
  }
  // No usable utterances: group the words by pauses instead.
  groups ??= words.reduce((acc, word) => {
    const last = acc.at(-1)?.at(-1);
    // A word without a usable time cannot start a new group: it stays with its neighbours.
    if (!last || (last.valid && word.valid && (word.start - last.end) * 1000 >= MERGE_GAP_MS)) acc.push([word]);
    else acc.at(-1).push(word);
    return acc;
  }, []);

  const segments = segmentsFromWords(groups, { reviewWordConfidence, reviewSpeakerConfidence });

  const labelled = words.filter((word) => word.speaker !== null).length;
  let diarizationStatus;
  if (!diarizeRan || labelled === 0) diarizationStatus = "failed";
  else if (labelled < words.length) diarizationStatus = "partial";
  else diarizationStatus = "completed"; // includes a genuine single-speaker recording

  return {
    empty: false,
    segments,
    speakerIndices: [...new Set(segments.map((segment) => segment.providerSpeaker).filter((speaker) => speaker !== null))].sort((a, b) => a - b),
    diarizationStatus,
    meta,
    // The word-level source data, for re-labelling speakers without touching any word: [[word]] utterance groups.
    groups,
  };
}

// A speaker with less than this share of the speech (and under MINOR_SPEAKER_MAX_SECONDS) is suspicious: in a real
// two-hour test a third "speaker" of 10 one-word segments (0.08% of the speech) appeared in a two-person recording.
const MINOR_SPEAKER_SHARE = 0.01;
const MINOR_SPEAKER_MAX_SECONDS = 60;

/**
 * Speakers that own almost none of the speech, which are often a diarization artefact. Nothing is reassigned
 * (that would silently override the provider): the caller flags their segments for review and warns the doctor.
 * Only speaker numbers and counts are reported, never transcript text.
 * Returns [{ speaker, segments, seconds }].
 */
export function minorSpeakers(segments) {
  const perSpeaker = new Map();
  let total = 0;
  for (const segment of segments) {
    const seconds = (segment.endMs - segment.startMs) / 1000;
    total += seconds;
    if (segment.providerSpeaker === null) continue;
    const entry = perSpeaker.get(segment.providerSpeaker) ?? { speaker: segment.providerSpeaker, segments: 0, seconds: 0 };
    entry.segments += 1;
    entry.seconds += seconds;
    perSpeaker.set(segment.providerSpeaker, entry);
  }
  if (perSpeaker.size < 3) return []; // a second speaker with little speech is normal (a short answer), so require 3+
  return [...perSpeaker.values()].filter((entry) => total > 0 && entry.seconds / total < MINOR_SPEAKER_SHARE && entry.seconds < MINOR_SPEAKER_MAX_SECONDS);
}

/**
 * Re-label every word's speaker with `speakerOf(word)` (a speaker number or null) and rebuild the segments. Words, text,
 * punctuation and timestamps are untouched: nothing is dropped or duplicated, only the speaker changes.
 */
export function relabelSpeakers(normalized, speakerOf, options = {}) {
  // `speakerOf` returns a speaker number or null, or { speaker, confidence, overlap, review } (alignment with a diarizer): the extra fields
  // become the word's speaker confidence and the flags that make a segment "needs review". No word's text or time is ever touched.
  const groups = normalized.groups.map((group) => group.map((word) => {
    const label = speakerOf(word);
    if (label !== null && typeof label === "object") {
      return { ...word, speaker: label.speaker, speakerConfidence: label.confidence ?? null, overlap: Boolean(label.overlap), reviewSpeaker: Boolean(label.review) };
    }
    return { ...word, speaker: label, speakerConfidence: null };
  }));
  const flat = groups.flat();
  const segments = segmentsFromWords(groups, options);
  const labelled = flat.filter((word) => word.speaker !== null).length;
  return {
    ...normalized,
    groups,
    segments,
    speakerIndices: [...new Set(segments.map((s) => s.providerSpeaker).filter((speaker) => speaker !== null))].sort((a, b) => a - b),
    diarizationStatus: labelled === 0 ? "failed" : labelled < flat.length ? "partial" : "completed",
  };
}

