// Unit tests for the pure timestamp-alignment logic (no models involved).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { alignSegments, MIN_OVERLAP_MS } from "../services/align.js";

const seg = (startMs, endMs, text) => ({ startMs, endMs, text });
const turn = (speaker, startMs, endMs) => ({ speaker, startMs, endMs });

describe("alignSegments", () => {
  test("assigns each segment to the speaker whose speech overlaps it, with stable ids by first appearance", () => {
    // Cluster numbers 7 and 3 are arbitrary; ids follow who speaks first.
    const { speakers, segments } = alignSegments(
      [seg(0, 2000, "Are you eating regularly?"), seg(2500, 4500, "I eat two meals per day."), seg(5000, 6000, "Good.")],
      [turn(7, 100, 1900), turn(3, 2600, 4400), turn(7, 5100, 5900)],
    );
    assert.deepEqual(segments.map((s) => s.speakerId), ["speaker_1", "speaker_2", "speaker_1"]);
    assert.deepEqual(speakers, [
      { id: "speaker_1", label: "Speaker 1", role: "unassigned" },
      { id: "speaker_2", label: "Speaker 2", role: "unassigned" },
    ]);
  });

  test("never assumes the first speaker is the doctor", () => {
    const { speakers } = alignSegments([seg(0, 1000, "Hi")], [turn(0, 0, 1000)]);
    assert.ok(speakers.every((s) => s.role === "unassigned"));
  });

  test("keeps text and returns segments in time order with unique ids", () => {
    const { segments } = alignSegments(
      [seg(4000, 5000, "third"), seg(0, 1000, "first"), seg(2000, 3000, "second")],
      [turn(0, 0, 5000)],
    );
    assert.deepEqual(segments.map((s) => s.text), ["first", "second", "third"]);
    assert.deepEqual(segments.map((s) => s.id), ["segment_1", "segment_2", "segment_3"]);
    for (let i = 1; i < segments.length; i++) assert.ok(segments[i].startMs >= segments[i - 1].endMs);
  });

  test("trims whisper's window to the detected speech and keeps timestamps valid", () => {
    // Whisper's window stretches across silence; the speaker only talks from 3400 to 5200.
    const { segments } = alignSegments([seg(2750, 5540, "I have had a headache.")], [turn(1, 3400, 5200)]);
    assert.equal(segments[0].startMs, 3400);
    assert.equal(segments[0].endMs, 5200);
  });

  test("returns a null speaker when no detected speech overlaps the segment", () => {
    const { segments, speakers } = alignSegments([seg(0, 1000, "Hello")], [turn(0, 5000, 6000)]);
    assert.equal(segments[0].speakerId, null);
    assert.deepEqual(speakers, []);
    assert.deepEqual([segments[0].startMs, segments[0].endMs], [0, 1000]); // untouched
  });

  test("returns a null speaker when the overlap is too small to be evidence", () => {
    const { segments } = alignSegments([seg(0, 2000, "Hello")], [turn(0, 2000 - (MIN_OVERLAP_MS - 50), 3000)]);
    assert.equal(segments[0].speakerId, null);
  });

  test("returns a null speaker for a segment split between two speakers (no clear winner)", () => {
    const { segments } = alignSegments([seg(0, 4000, "Yes. No.")], [turn(0, 0, 2000), turn(1, 2000, 4000)]);
    assert.equal(segments[0].speakerId, null);
  });

  test("a clear majority wins even when a short interruption overlaps", () => {
    const { segments } = alignSegments([seg(0, 4000, "Long answer")], [turn(0, 0, 3600), turn(1, 3600, 4000)]);
    assert.equal(segments[0].speakerId, "speaker_1");
  });

  test("handles a one-speaker recording", () => {
    const { speakers, segments } = alignSegments([seg(0, 1000, "a"), seg(1500, 2500, "b")], [turn(4, 0, 2500)]);
    assert.equal(speakers.length, 1);
    assert.deepEqual(segments.map((s) => s.speakerId), ["speaker_1", "speaker_1"]);
  });

  test("handles unexpected additional speakers", () => {
    const { speakers, segments } = alignSegments(
      [seg(0, 1000, "a"), seg(1500, 2500, "b"), seg(3000, 4000, "c")],
      [turn(0, 0, 1000), turn(1, 1500, 2500), turn(2, 3000, 4000)],
    );
    assert.equal(speakers.length, 3);
    assert.deepEqual(segments.map((s) => s.speakerId), ["speaker_1", "speaker_2", "speaker_3"]);
  });

  test("silence: no segments and no speakers", () => {
    assert.deepEqual(alignSegments([], []), { speakers: [], segments: [] });
  });

  test("diarization failure: every speaker is null, nothing is fabricated", () => {
    const { speakers, segments } = alignSegments([seg(0, 1000, "Hello"), seg(1200, 2000, "there")], []);
    assert.deepEqual(speakers, []);
    assert.ok(segments.every((s) => s.speakerId === null));
  });

  test("every speakerId refers to a listed speaker or is null", () => {
    const { speakers, segments } = alignSegments(
      [seg(0, 1000, "a"), seg(1100, 2100, "b"), seg(2200, 3200, "c")],
      [turn(0, 0, 1000), turn(1, 1100, 2100)],
    );
    const ids = new Set(speakers.map((s) => s.id));
    assert.ok(segments.every((s) => s.speakerId === null || ids.has(s.speakerId)));
  });

  test("blank segments are dropped", () => {
    const { segments } = alignSegments([seg(0, 1000, "  "), seg(1000, 2000, "Real")], [turn(0, 0, 2000)]);
    assert.deepEqual(segments.map((s) => s.text), ["Real"]);
  });
});
