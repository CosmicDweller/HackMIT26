// Evaluation metrics for transcription and diarization (used by the live evaluation and unit-tested in eval.test.js).

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function integerWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${integerWords(n % 100)}` : ""}`;
  return String(n);
}

/**
 * Spoken-form normalization so that smart formatting ("500 mg", "7.2%") is compared fairly with a reference
 * written as spoken ("five hundred milligrams", "seven point two percent"). Deliberately small: numbers up
 * to 999, decimals, %, mg. Everything else is lowercased and stripped of punctuation.
 */
export function spokenTokens(text) {
  return text
    .toLowerCase()
    .replace(/\b(\d+)\.(\d+)\b/g, (_m, a, b) => ` ${integerWords(Number(a))} point ${[...b].map((d) => ONES[Number(d)]).join(" ")} `)
    .replace(/\b\d+\b/g, (m) => ` ${integerWords(Number(m))} `)
    .replace(/%/g, " percent ")
    .replace(/\bmg\b/g, " milligrams ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate: (substitutions + deletions + insertions) / reference words. */
export function wer(referenceText, hypothesisText) {
  const ref = spokenTokens(referenceText);
  const hyp = spokenTokens(hypothesisText);
  const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)]);
  for (let j = 1; j <= hyp.length; j++) d[0][j] = j;
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
  }
  return { wer: ref.length ? d[ref.length][hyp.length] / ref.length : hyp.length ? 1 : 0, distance: d[ref.length][hyp.length], referenceWords: ref.length, hypothesisWords: hyp.length };
}

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

/**
 * Frame-based diarization error rate.
 *   reference: [{ speaker, startMs, endMs }]   (ground truth)
 *   hypothesis: [{ speaker, startMs, endMs }]  (system output; speaker ids are arbitrary)
 * Reference and hypothesis speakers are matched with the mapping that minimises error. Frames within
 * `collarMs` of a reference boundary are not scored (the usual 250 ms collar). Overlapping hypothesis
 * segments are resolved by keeping the later-starting one. Returns { der, missMs, falseAlarmMs, confusionMs, speechMs }.
 */
export function der(reference, hypothesis, { collarMs = 250, frameMs = 10 } = {}) {
  const end = Math.max(0, ...reference.map((r) => r.endMs), ...hypothesis.map((h) => h.endMs));
  const frames = Math.ceil(end / frameMs);
  const ref = new Array(frames).fill(null);
  const hyp = new Array(frames).fill(null);
  const paint = (arr, list) => {
    for (const { speaker, startMs, endMs } of [...list].sort((a, b) => a.startMs - b.startMs)) {
      for (let f = Math.floor(startMs / frameMs); f < Math.min(frames, Math.ceil(endMs / frameMs)); f++) arr[f] = speaker;
    }
  };
  paint(ref, reference);
  paint(hyp, hypothesis);

  const skip = new Array(frames).fill(false);
  for (const { startMs, endMs } of reference) {
    for (const boundary of [startMs, endMs]) {
      for (let f = Math.max(0, Math.floor((boundary - collarMs) / frameMs)); f < Math.min(frames, Math.ceil((boundary + collarMs) / frameMs)); f++) skip[f] = true;
    }
  }
  const refSpeakers = [...new Set(reference.map((r) => r.speaker))];
  const hypSpeakers = [...new Set(hypothesis.map((h) => h.speaker))];

  let best = null;
  const padded = [...hypSpeakers];
  while (padded.length < refSpeakers.length) padded.push(Symbol("none"));
  for (const order of permutations(padded)) {
    const map = new Map(refSpeakers.map((speaker, i) => [speaker, order[i]]));
    let miss = 0, falseAlarm = 0, confusion = 0;
    for (let f = 0; f < frames; f++) {
      if (skip[f]) continue;
      if (ref[f] !== null && hyp[f] === null) miss += 1;
      else if (ref[f] === null && hyp[f] !== null) falseAlarm += 1;
      else if (ref[f] !== null && map.get(ref[f]) !== hyp[f]) confusion += 1;
    }
    if (!best || miss + falseAlarm + confusion < best.total) best = { miss, falseAlarm, confusion, total: miss + falseAlarm + confusion };
  }
  let speech = 0;
  for (let f = 0; f < frames; f++) if (!skip[f] && ref[f] !== null) speech += 1;
  const ms = (frameCount) => frameCount * frameMs;
  return {
    der: speech ? best.total / speech : 0,
    missMs: ms(best.miss), falseAlarmMs: ms(best.falseAlarm), confusionMs: ms(best.confusion), speechMs: ms(speech),
  };
}

/**
 * Word-to-speaker attribution: for each recognised word, is its speaker the one the reference says was
 * talking at that moment (after the best speaker mapping)? Words outside every reference turn (±toleranceMs) are ignored.
 *   words: [{ speaker, startMs, endMs }]
 */
export function wordAttribution(referenceTurns, words, { toleranceMs = 300 } = {}) {
  const scored = words
    .map((word) => {
      const mid = (word.startMs + word.endMs) / 2;
      const turn = referenceTurns.find((t) => mid >= t.startMs - toleranceMs && mid <= t.endMs + toleranceMs);
      return turn ? { truth: turn.speaker, hyp: word.speaker } : null;
    })
    .filter(Boolean);
  const truthSpeakers = [...new Set(scored.map((w) => w.truth))];
  const hypSpeakers = [...new Set(scored.map((w) => w.hyp))];
  const padded = [...hypSpeakers];
  while (padded.length < truthSpeakers.length) padded.push(Symbol("none"));
  let best = 0;
  for (const order of permutations(padded)) {
    const map = new Map(truthSpeakers.map((speaker, i) => [speaker, order[i]]));
    best = Math.max(best, scored.filter((w) => map.get(w.truth) === w.hyp).length);
  }
  return { accuracy: scored.length ? best / scored.length : 1, correct: best, total: scored.length };
}

export const speakerCountError = (trueCount, detectedCount) => Math.abs(trueCount - detectedCount);

/** Reference turns from a fixture's truth.json into { speaker, startMs, endMs }. */
export const truthTurns = (truth) => truth.turns.map(({ speaker, startMs, endMs }) => ({ speaker, startMs, endMs }));
export const truthText = (truth) => truth.turns.map((t) => t.text).join(" ");
