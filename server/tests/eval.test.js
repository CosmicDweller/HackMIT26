// The evaluation metrics themselves, checked against hand-computed answers.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { der, spokenTokens, speakerCountError, wer, wordAttribution } from "./eval.js";

const turn = (speaker, startMs, endMs) => ({ speaker, startMs, endMs });

describe("spoken-form normalization", () => {
  test("digits, decimals, percent and mg are compared as spoken", () => {
    assert.deepEqual(spokenTokens("500 mg twice daily"), ["five", "hundred", "milligrams", "twice", "daily"]);
    assert.deepEqual(spokenTokens("A1c was 7.2%."), ["a1c", "was", "seven", "point", "two", "percent"]);
    assert.deepEqual(spokenTokens("forty"), ["forty"]);
    assert.deepEqual(spokenTokens("40"), ["forty"]);
    assert.deepEqual(spokenTokens("A1c"), ["a1c"], "digits inside a word are left alone");
  });
});

describe("wer", () => {
  test("identical text is 0", () => assert.equal(wer("a b c", "a b c").wer, 0));
  test("one substitution in four words is 0.25", () => assert.equal(wer("a b c d", "a x c d").wer, 0.25));
  test("a deletion and an insertion are each one error", () => {
    assert.equal(wer("a b c d", "a b d").distance, 1);
    assert.equal(wer("a b c d", "a b c x d").distance, 1);
  });
  test("smart formatting is not an error", () => assert.equal(wer("metformin five hundred milligrams", "metformin 500 mg").wer, 0));
  test("empty hypothesis is total error", () => assert.equal(wer("a b", "").wer, 1));
});

describe("der", () => {
  const reference = [turn("A", 0, 2000), turn("B", 2000, 4000)];
  test("a perfect result scores 0 even when speaker ids are swapped", () => {
    assert.equal(der(reference, [turn(1, 0, 2000), turn(0, 2000, 4000)]).der, 0);
  });
  test("one wrongly labelled turn: confusion is that turn (outside the collars)", () => {
    const result = der(reference, [turn(0, 0, 2000), turn(0, 2000, 4000)], { collarMs: 0 });
    assert.equal(result.confusionMs, 2000);
    assert.equal(Math.round(result.der * 100), 50);
  });
  test("missed speech and false alarms are counted", () => {
    const missed = der(reference, [turn(0, 0, 2000)], { collarMs: 0 });
    assert.equal(missed.missMs, 2000);
    const extra = der([turn("A", 0, 1000)], [turn(0, 0, 1000), turn(1, 1000, 2000)], { collarMs: 0 });
    assert.equal(extra.falseAlarmMs, 1000);
  });
  test("the collar ignores boundary jitter", () => {
    assert.equal(der(reference, [turn(0, 0, 2100), turn(1, 2100, 4000)]).der, 0);
    assert.ok(der(reference, [turn(0, 0, 2100), turn(1, 2100, 4000)], { collarMs: 0 }).der > 0);
  });
  test("uses the best speaker mapping with three speakers", () => {
    const ref = [turn("A", 0, 1000), turn("B", 1000, 2000), turn("C", 2000, 3000)];
    assert.equal(der(ref, [turn(2, 0, 1000), turn(0, 1000, 2000), turn(1, 2000, 3000)]).der, 0);
  });
});

describe("word attribution and speaker count", () => {
  test("counts words whose speaker matches the reference after mapping", () => {
    const ref = [turn("A", 0, 2000), turn("B", 2000, 4000)];
    const words = [
      { speaker: 5, startMs: 100, endMs: 500 }, { speaker: 5, startMs: 600, endMs: 900 },
      { speaker: 9, startMs: 2100, endMs: 2500 }, { speaker: 5, startMs: 2600, endMs: 3000 },
    ];
    const result = wordAttribution(ref, words, { toleranceMs: 0 });
    assert.equal(result.total, 4);
    assert.equal(result.correct, 3);
  });
  test("speaker count error", () => {
    assert.equal(speakerCountError(2, 3), 1);
    assert.equal(speakerCountError(2, 2), 0);
  });
});
