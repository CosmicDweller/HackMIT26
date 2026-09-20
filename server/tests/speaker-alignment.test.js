// Word-to-speaker alignment: pure logic, deterministic, no models. It never reads what a word says and never touches its text or time.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { alignmentSummary, alignWords, overlapSpans } from "../services/speakerAlignment.js";

const word = (start, end, extra = {}) => ({ text: "w", start, end, valid: true, ...extra });
const turn = (startMs, endMs, speaker) => ({ startMs, endMs, speaker });
const diar = (exclusive, regular = exclusive) => ({ exclusive, regular });
const A = "SPEAKER_00";
const B = "SPEAKER_01";

describe("overlapSpans (simultaneous speech from the regular diarization)", () => {
  test("touching turns are not overlap", () => {
    assert.deepEqual(overlapSpans([turn(0, 1000, A), turn(1000, 2000, B)]), []);
  });
  test("two speakers talking at once give one span", () => {
    assert.deepEqual(overlapSpans([turn(0, 3000, A), turn(2000, 4000, B)]), [{ startMs: 2000, endMs: 3000 }]);
  });
  test("adjacent overlaps merge; a turn inside another is overlap for its whole length", () => {
    assert.deepEqual(overlapSpans([turn(0, 10000, A), turn(1000, 2000, B), turn(2000, 3000, B)]), [{ startMs: 1000, endMs: 3000 }]);
  });
  test("no turns, no overlap", () => assert.deepEqual(overlapSpans([]), []));
});

describe("alignWords", () => {
  test("a word inside one speaker's turn takes that speaker with full confidence", () => {
    const r = alignWords([word(1.1, 1.5)], diar([turn(1000, 2000, A)]));
    assert.deepEqual(r.labels[0], { speaker: A, status: "clear", share: 1, confidence: 1, overlap: false, review: false });
  });

  test("every word gets exactly one label, in order: none lost, none duplicated", () => {
    const words = Array.from({ length: 20 }, (_, i) => word(i * 0.5, i * 0.5 + 0.4));
    const r = alignWords(words, diar([turn(0, 5000, A), turn(5000, 10000, B)]));
    assert.equal(r.labels.length, words.length);
    assert.deepEqual(r.labels.map((l) => l.speaker), [...Array(10).fill(A), ...Array(10).fill(B)]);
  });

  test("a word straddling a change takes the speaker covering most of it, and a lopsided straddle is not flagged", () => {
    const r = alignWords([word(1.8, 2.2)], diar([turn(0, 2000, A), turn(2000, 4000, B)])); // 200 ms in A, 200 ms in B: a tie
    assert.equal(r.labels[0].status, "ambiguous");
    assert.equal(r.labels[0].review, true);
    const lopsided = alignWords([word(1.9, 2.2)], diar([turn(0, 2000, A), turn(2000, 4000, B)])); // 100 ms vs 200 ms
    assert.equal(lopsided.labels[0].speaker, B);
    assert.ok(lopsided.labels[0].share > 0.6);
  });

  test("a tie is broken deterministically (the lower speaker label)", () => {
    const a = alignWords([word(1.8, 2.2)], diar([turn(0, 2000, B), turn(2000, 4000, A)]));
    const b = alignWords([word(1.8, 2.2)], diar([turn(0, 2000, B), turn(2000, 4000, A)]));
    assert.equal(a.labels[0].speaker, A);
    assert.deepEqual(a, b);
  });

  test("a word with no turn under it is unassigned (speaker null), not dropped, and flagged for review", () => {
    const r = alignWords([word(5, 5.4)], diar([turn(0, 2000, A), turn(8000, 9000, B)]));
    assert.deepEqual(r.labels[0], { speaker: null, status: "none", share: 0, confidence: null, overlap: false, review: true });
  });

  test("a short gap between two turns of the SAME speaker is bridged, a gap between different speakers is not", () => {
    const same = alignWords([word(2.1, 2.3)], diar([turn(0, 2000, A), turn(2400, 4000, A)]));
    assert.equal(same.labels[0].speaker, A);
    assert.equal(same.labels[0].status, "bridged");
    const different = alignWords([word(2.1, 2.3)], diar([turn(0, 2000, A), turn(2400, 4000, B)]));
    assert.equal(different.labels[0].speaker, null);
    const longGap = alignWords([word(3, 3.2)], diar([turn(0, 2000, A), turn(4000, 6000, A)]));
    assert.equal(longGap.labels[0].speaker, null, "a 2 s gap is silence or a missed speaker, not a bridge");
  });

  test("words in simultaneous speech are flagged and keep a low confidence", () => {
    const regular = [turn(0, 4000, A), turn(1000, 3000, B)];
    const exclusive = [turn(0, 1000, A), turn(1000, 3000, B), turn(3000, 4000, A)];
    const r = alignWords([word(1.5, 2.5), word(0.1, 0.5)], diar(exclusive, regular));
    assert.equal(r.labels[0].status, "overlap");
    assert.equal(r.labels[0].overlap, true);
    assert.equal(r.labels[0].review, true);
    assert.ok(r.labels[0].confidence <= 0.4);
    assert.equal(r.labels[1].status, "clear", "a word before the interruption is unaffected");
  });

  test("a word without usable timing is never given a speaker or a time", () => {
    const r = alignWords([{ text: "x", start: 0, end: 0, valid: false }, { text: "y", start: NaN, end: NaN, valid: true }], diar([turn(0, 5000, A)]));
    assert.deepEqual(r.labels.map((l) => [l.speaker, l.status]), [[null, "untimed"], [null, "untimed"]]);
  });

  test("speakers are listed in order of first appearance (recording-wide, stable)", () => {
    const r = alignWords([word(0.1, 0.4), word(2.1, 2.4), word(4.1, 4.4)], diar([turn(0, 1000, B), turn(2000, 3000, A), turn(4000, 5000, B)]));
    assert.deepEqual(r.speakers, [B, A], "the label numbering does not decide the order, appearance does");
  });

  test("a returning speaker keeps their label after a long gap", () => {
    const r = alignWords([word(1, 1.4), word(3600, 3600.4)], diar([turn(0, 5000, A), turn(3599_000, 3601_000, A)]));
    assert.deepEqual(r.labels.map((l) => l.speaker), [A, A]);
  });

  test("empty diarization leaves every word unassigned without failing", () => {
    const r = alignWords([word(1, 1.4), word(2, 2.4)], diar([]));
    assert.deepEqual(r.labels.map((l) => l.speaker), [null, null]);
    assert.deepEqual(r.speakers, []);
  });

  test("a very short word (zero length) is still placed", () => {
    const r = alignWords([word(1.5, 1.5)], diar([turn(1000, 2000, A)]));
    assert.equal(r.labels[0].speaker, A);
  });

  test("it does not depend on the text of a word: same times, different text, same answer", () => {
    const d = diar([turn(0, 2000, A), turn(2000, 4000, B)]);
    const one = alignWords([word(0.5, 0.9, { text: "doctor" }), word(2.5, 2.9, { text: "patient" })], d);
    const two = alignWords([word(0.5, 0.9, { text: "hello" }), word(2.5, 2.9, { text: "again" })], d);
    assert.deepEqual(one, two);
  });

  test("summary counts by status", () => {
    const r = alignWords([word(0.1, 0.4), word(9, 9.4)], diar([turn(0, 1000, A)]));
    assert.deepEqual(alignmentSummary(r.labels), { clear: 1, none: 1 });
  });
});
