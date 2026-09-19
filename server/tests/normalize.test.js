// Normalization of Deepgram responses into speaker-labelled segments.
// Most tests use REAL Deepgram responses (tests/fixtures/deepgram/, synthetic audio only); a few use
// hand-built responses for cases that are hard to provoke on demand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DeepgramError, minorSpeakers, normalizeDeepgramResponse } from "../services/deepgram.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "deepgram");
const load = (name) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8"));
const channelWords = (result) => result.results.channels[0].alternatives[0].words;

const word = (text, start, end, speaker, { confidence = 0.99, speakerConfidence = 0.95 } = {}) => ({
  word: text.toLowerCase().replace(/[^a-z0-9]/g, ""), punctuated_word: text, start, end, confidence,
  ...(speaker === undefined ? {} : { speaker, speaker_confidence: speakerConfidence }),
});
const response = (words, { diarize = true, utterances } = {}) => ({
  metadata: { request_id: "r-1", duration: 10, model_info: { m: { name: "medical-nova-3", version: "1" } }, ...(diarize ? { diarize_info: { arch: "v2", model_uuid: "u-1" } } : {}) },
  results: { channels: [{ alternatives: [{ transcript: words.map((w) => w.punctuated_word).join(" "), words }] }], ...(utterances ? { utterances } : {}) },
});

describe("real Deepgram responses (synthetic audio)", () => {
  test("A-B-A: the returning speaker keeps the same index, and the mixed utterance is split", () => {
    const result = normalizeDeepgramResponse(load("aba"));
    assert.equal(result.diarizationStatus, "completed");
    assert.deepEqual(result.segments.map((s) => s.providerSpeaker), [0, 1, 0]);
    assert.deepEqual(result.segments.map((s) => s.text), [
      "Are you eating regularly?",
      "I eat two meals per day.",
      "Have you noticed any weight changes?",
    ]);
    assert.deepEqual(result.speakerIndices, [0, 1]);
    // Deepgram put the patient's answer and the doctor's next question in ONE utterance; we split it.
    const utterances = load("aba").results.utterances;
    assert.ok(utterances.some((u) => new Set(u.words.map((w) => w.speaker)).size > 1), "fixture really contains a mixed-speaker utterance");
  });

  test("records what the provider reported: request id, model and the batch diarizer version", () => {
    const { meta } = normalizeDeepgramResponse(load("aba"));
    assert.deepEqual(meta.models, ["medical-nova-3 2026-05-18.18466"]);
    assert.equal(meta.diarizeModel.arch, "v2");
    assert.ok(meta.diarizeModel.modelUuid);
    assert.equal(meta.requestId, "scrubbed");
    assert.ok(meta.providerDurationSeconds > 6);
  });

  test("two speakers alternate over the whole conversation", () => {
    const { segments, speakerIndices } = normalizeDeepgramResponse(load("two-speaker"));
    assert.deepEqual(speakerIndices, [0, 1]);
    // A turn can be several sentences (several segments), so compare turns: consecutive same-speaker
    // segments collapsed into one.
    const turns = segments.map((s) => s.providerSpeaker).filter((speaker, i, all) => i === 0 || speaker !== all[i - 1]);
    assert.deepEqual(turns, [0, 1, 0, 1, 0, 1, 0, 1]);
  });

  test("three speakers are supported (indices 0, 1 and 2)", () => {
    const { segments, speakerIndices, diarizationStatus } = normalizeDeepgramResponse(load("three-speaker"));
    assert.deepEqual(speakerIndices, [0, 1, 2]);
    assert.equal(diarizationStatus, "completed");
    assert.ok(segments.some((s) => s.providerSpeaker === 2));
  });

  test("a genuine single-speaker recording is valid, not a failure", () => {
    const { speakerIndices, diarizationStatus, segments } = normalizeDeepgramResponse(load("single-speaker"));
    assert.deepEqual(speakerIndices, [0]);
    assert.equal(diarizationStatus, "completed");
    assert.ok(segments.length > 0 && segments.every((s) => s.providerSpeaker === 0));
  });

  test("silence and background noise produce no speech", () => {
    for (const name of ["silence", "noise"]) {
      const result = normalizeDeepgramResponse(load(name));
      assert.equal(result.empty, true, name);
      assert.deepEqual(result.segments, []);
    }
  });

  test("overlapping speech still yields ordered, valid segments", () => {
    const { segments } = normalizeDeepgramResponse(load("overlap"));
    for (let i = 0; i < segments.length; i++) {
      assert.ok(segments[i].endMs >= segments[i].startMs);
      if (i > 0) assert.ok(segments[i].startMs >= segments[i - 1].startMs, "ordered");
    }
  });

  for (const name of ["aba", "two-speaker", "three-speaker", "medical", "single-speaker", "overlap"]) {
    test(`${name}: no word is omitted or duplicated, and text is preserved exactly`, () => {
      const raw = load(name);
      const expected = channelWords(raw).map((w) => w.punctuated_word ?? w.word);
      const { segments } = normalizeDeepgramResponse(raw);
      assert.deepEqual(segments.flatMap((s) => s.text.split(" ")), expected);
    });

    test(`${name}: timestamps come from real words and never go backwards inside a segment`, () => {
      const raw = load(name);
      const wordTimes = new Set(channelWords(raw).flatMap((w) => [Math.round(w.start * 1000), Math.round(w.end * 1000)]));
      for (const segment of normalizeDeepgramResponse(raw).segments) {
        assert.ok(segment.endMs >= segment.startMs);
        assert.ok(wordTimes.has(segment.startMs) && wordTimes.has(segment.endMs), "invented timestamp");
      }
    });
  }

  test("medical vocabulary is preserved verbatim, never silently 'corrected', and a doubtful drug name is flagged", () => {
    const { segments } = normalizeDeepgramResponse(load("medical"));
    const text = segments.map((s) => s.text).join(" ");
    assert.match(text, /metformin five hundred milligrams/);
    assert.match(text, /lisinopril ten milligrams/);
    assert.match(text, /7\.2%/);
    const suspect = segments.find((s) => /atavastatin/.test(s.text));
    assert.ok(suspect, "the real misrecognition is kept as heard");
    assert.equal(suspect.needsReview, true, "its 0.80 word confidence is below the review threshold");
  });

  test("speaker and word confidences are preserved per segment", () => {
    const { segments } = normalizeDeepgramResponse(load("aba"));
    for (const segment of segments) {
      assert.ok(segment.confidence > 0 && segment.confidence <= 1);
      assert.ok(segment.speakerConfidence > 0 && segment.speakerConfidence <= 1);
    }
  });

  test("does not modify its input", () => {
    const raw = load("medical");
    const copy = structuredClone(raw);
    normalizeDeepgramResponse(raw);
    assert.deepEqual(raw, copy);
  });
});

describe("diarization status and unknown speakers", () => {
  test("metadata.diarize_info absent: the diarizer did not run, so no speaker is assigned (never 'speaker 0 for everyone')", () => {
    const raw = response([word("Hello", 0, 0.5, 0), word("there.", 0.6, 1, 0)], { diarize: false });
    const result = normalizeDeepgramResponse(raw);
    assert.equal(result.diarizationStatus, "failed");
    assert.deepEqual(result.speakerIndices, []);
    assert.ok(result.segments.every((s) => s.providerSpeaker === null && s.needsReview));
    assert.equal(result.segments.map((s) => s.text).join(" "), "Hello there.", "transcript text is still preserved");
  });

  test("some words without a speaker: partial, with those words left unassigned", () => {
    const raw = response([word("Hi", 0, 0.4, 0), word("there.", 0.4, 0.9), word("Hello.", 3, 3.5, 1)]);
    delete raw.results.channels[0].alternatives[0].words[1].speaker;
    const result = normalizeDeepgramResponse(raw);
    assert.equal(result.diarizationStatus, "partial");
    assert.deepEqual(result.segments.map((s) => [s.text, s.providerSpeaker]), [["Hi", 0], ["there.", null], ["Hello.", 1]]);
    assert.ok(result.segments[1].needsReview);
  });

  test("diarizer metadata present but no word labelled: failed, not one big speaker", () => {
    const raw = response([word("Hi", 0, 0.4), word("there.", 0.4, 0.9)]);
    const result = normalizeDeepgramResponse(raw);
    assert.equal(result.diarizationStatus, "failed");
    assert.ok(result.segments.every((s) => s.providerSpeaker === null));
  });

  test("provider speaker indices are kept, not renumbered by order of appearance", () => {
    const raw = response([word("First.", 0, 1, 2), word("Second.", 2, 3, 0)]);
    const result = normalizeDeepgramResponse(raw);
    assert.deepEqual(result.segments.map((s) => s.providerSpeaker), [2, 0]);
    assert.deepEqual(result.speakerIndices, [0, 2]);
  });

  test("low speaker confidence flags the segment for review but keeps Deepgram's speaker", () => {
    const raw = response([word("Maybe.", 0, 1, 1, { speakerConfidence: 0.3 })]);
    const [segment] = normalizeDeepgramResponse(raw).segments;
    assert.equal(segment.providerSpeaker, 1);
    assert.equal(segment.needsReview, true);
    assert.equal(segment.speakerConfidence, 0.3);
  });
});

describe("utterance handling", () => {
  test("an utterance that mixes speakers is split at the word boundary", () => {
    const words = [word("Yes.", 0, 0.5, 1), word("Any", 0.6, 0.9, 0), word("fever?", 0.9, 1.4, 0)];
    const raw = response(words, { utterances: [{ speaker: 1, start: 0, end: 1.4, words }] });
    const { segments } = normalizeDeepgramResponse(raw);
    assert.deepEqual(segments.map((s) => [s.text, s.providerSpeaker]), [["Yes.", 1], ["Any fever?", 0]]);
  });

  test("works when the utterances array is missing (groups by pauses)", () => {
    const raw = response([word("One.", 0, 0.5, 0), word("Two.", 5, 5.5, 0)]);
    assert.equal(normalizeDeepgramResponse(raw).segments.length, 2);
  });

  test("ignores utterances that do not add up to the channel words, instead of duplicating or dropping words", () => {
    const words = [word("Alpha", 0, 0.5, 0), word("beta.", 0.5, 1, 0)];
    const raw = response(words, { utterances: [{ speaker: 0, start: 0, end: 1, words: [words[0]] }] });
    const { segments } = normalizeDeepgramResponse(raw);
    assert.equal(segments.map((s) => s.text).join(" "), "Alpha beta.");
  });

  test("re-joins a same-speaker fragment split mid-sentence, but not across a finished sentence", () => {
    const a = [word("Yes,", 0, 0.4, 1)];
    const b = [word("and", 0.5, 0.7, 1), word("more.", 0.7, 1, 1)];
    const c = [word("Next.", 1.2, 1.6, 1)];
    const raw = response([...a, ...b, ...c], { utterances: [{ words: a }, { words: b }, { words: c }] });
    assert.deepEqual(normalizeDeepgramResponse(raw).segments.map((s) => s.text), ["Yes, and more.", "Next."]);
  });

  test("never re-joins across a change of speaker", () => {
    const raw = response([word("Well,", 0, 0.4, 0), word("okay.", 0.5, 0.9, 1)]);
    assert.equal(normalizeDeepgramResponse(raw).segments.length, 2);
  });
});

describe("invalid or missing provider data", () => {
  test("words with invalid timestamps keep their text; the segment is timed only by its valid words and flagged", () => {
    const raw = response([word("Good", 1, 1.4, 0), { ...word("morning.", 1.5, 2, 0), start: "x" }]);
    const [segment] = normalizeDeepgramResponse(raw).segments;
    assert.equal(segment.text, "Good morning.");
    assert.equal(segment.startMs, 1000);
    assert.equal(segment.endMs, 1400, "the invalid word's time is not invented");
    assert.equal(segment.needsReview, true);
  });

  test("a segment with no valid timestamp at all is a malformed response, not a made-up time", () => {
    const raw = response([{ ...word("Hi.", 0, 1, 0), start: null, end: null }]);
    assert.throws(() => normalizeDeepgramResponse(raw), (e) => e instanceof DeepgramError && e.code === "PROVIDER_MALFORMED_RESPONSE");
  });

  test("negative or reversed timestamps are invalid", () => {
    const raw = response([word("Ok.", 0, 1, 0), word("Bad.", 3, 2, 0)]);
    const { segments } = normalizeDeepgramResponse(raw);
    assert.equal(segments[0].needsReview, true);
    assert.equal(segments[0].endMs, 1000);
  });

  for (const [name, bad] of [["empty object", {}], ["no channels", { results: {} }], ["words not an array", { results: { channels: [{ alternatives: [{ words: "x" }] }] } }], ["null", null]]) {
    test(`malformed response (${name}) is rejected`, () => {
      assert.throws(() => normalizeDeepgramResponse(bad), (e) => e instanceof DeepgramError && e.code === "PROVIDER_MALFORMED_RESPONSE");
    });
  }

  test("an empty word list is 'no speech', not an error", () => {
    assert.equal(normalizeDeepgramResponse(response([])).empty, true);
  });
});

describe("minor speakers (a real two-hour test produced a 3rd 'speaker' of 10 one-word segments)", () => {
  const seg = (speaker, seconds) => ({ providerSpeaker: speaker, startMs: 0, endMs: seconds * 1000 });
  test("a tiny third speaker in a long recording is reported", () => {
    const found = minorSpeakers([...Array(300).fill().map(() => seg(0, 10)), ...Array(150).fill().map(() => seg(1, 10)), seg(2, 1), seg(2, 1)]);
    assert.deepEqual(found, [{ speaker: 2, segments: 2, seconds: 2 }]);
  });
  test("a genuine third speaker with real speech is not reported", () => {
    assert.deepEqual(minorSpeakers([seg(0, 100), seg(1, 100), seg(2, 40)]), []);
  });
  test("a two-speaker recording is never reported (a brief answer is normal)", () => {
    assert.deepEqual(minorSpeakers([seg(0, 1000), seg(1, 1)]), []);
  });
  test("unknown speakers are ignored", () => {
    assert.deepEqual(minorSpeakers([seg(0, 100), seg(1, 100), seg(null, 1)]), []);
  });
});
