// Deterministic alignment of Deepgram's words with pyannote speaker intervals. Purely timestamp-based: it never looks at what a word
// says, never assigns Doctor/Patient, never drops or duplicates a word, and never invents a timestamp. Every word keeps its text,
// punctuation and time; only its speaker label (and a review flag) is decided here.
//
//   exclusive diarization  = the model's speaker turns with overlaps resolved (one speaker at a time): what a word is matched to.
//   regular diarization    = the same turns WITH overlaps kept: used to find genuinely simultaneous speech, whose attribution is uncertain.

export const ALIGNMENT = {
  bridgeGapMs: 500, // a word in a silent gap between two turns of the SAME speaker belongs to that speaker (the model closes small gaps itself)
  ambiguousRatio: 0.6, // the runner-up speaker overlaps the word at least this much as the winner: attribution is close to a coin flip
  overlapShare: 0.5, // at least this fraction of the word lies in simultaneous speech
  minTurnShare: 0.5, // a chosen speaker should cover at least this much of the word for the label to count as clear
};

/** Time spans where two or more speakers are active at once, from the regular (overlap-preserving) diarization. Sorted, disjoint. */
export function overlapSpans(regular) {
  const events = [];
  for (const row of regular) events.push([row.startMs, 1], [row.endMs, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // an end before a start at the same instant: touching turns are not overlap
  const spans = [];
  let active = 0;
  let from = null;
  for (const [at, delta] of events) {
    const before = active;
    active += delta;
    if (before < 2 && active >= 2) from = at;
    else if (before >= 2 && active < 2 && from !== null) {
      if (at > from) spans.push({ startMs: from, endMs: at });
      from = null;
    }
  }
  return mergeSpans(spans);
}

function mergeSpans(spans) {
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ ...span });
  }
  return merged;
}

/** Index of the first interval whose end is after `ms` (binary search over sorted, end-ordered non-overlapping intervals). */
function firstEndingAfter(intervals, ms) {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (intervals[mid].endMs > ms) high = mid;
    else low = mid + 1;
  }
  return low;
}

const overlapMs = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/**
 * Decide the speaker of every word.
 * `words`: Deepgram words in order ({ start, end } in seconds, `valid` = has usable timing).
 * `diarization`: a validated pyannote result ({ regular, exclusive } in integer milliseconds on the same timeline as the words).
 * Returns { labels: [...one entry per word], speakers: [pyannote labels in order of first appearance] } where an entry is
 *   { speaker: pyannote label | null, status, share, confidence, overlap, review }
 * status: "clear" | "straddles" | "ambiguous" | "overlap" | "bridged" | "none" | "untimed".
 */
export function alignWords(words, diarization, options = {}) {
  const A = { ...ALIGNMENT, ...options };
  const exclusive = diarization.exclusive;
  const overlaps = overlapSpans(diarization.regular);
  const labels = words.map((word) => {
    if (!word.valid || !Number.isFinite(word.start) || !Number.isFinite(word.end)) {
      return { speaker: null, status: "untimed", share: 0, confidence: null, overlap: false, review: true };
    }
    const startMs = Math.round(word.start * 1000);
    const endMs = Math.max(Math.round(word.end * 1000), startMs + 1);
    const duration = endMs - startMs;

    // overlap of the word with each speaker's exclusive turns
    const per = new Map();
    let total = 0;
    for (let i = firstEndingAfter(exclusive, startMs); i < exclusive.length && exclusive[i].startMs < endMs; i++) {
      const amount = overlapMs(startMs, endMs, exclusive[i].startMs, exclusive[i].endMs);
      if (amount > 0) {
        per.set(exclusive[i].speaker, (per.get(exclusive[i].speaker) ?? 0) + amount);
        total += amount;
      }
    }

    // simultaneous speech: how much of the word is covered by spans where several speakers talk at once
    let simultaneous = 0;
    for (let i = firstEndingAfter(overlaps, startMs); i < overlaps.length && overlaps[i].startMs < endMs; i++) {
      simultaneous += overlapMs(startMs, endMs, overlaps[i].startMs, overlaps[i].endMs);
    }
    const overlap = simultaneous / duration >= A.overlapShare;

    if (total === 0) {
      // no turn overlaps the word: assign it only when it sits in a short gap between two turns of the same speaker
      const next = firstEndingAfter(exclusive, startMs);
      const before = exclusive[next - 1];
      const after = exclusive[next];
      if (before && after && before.speaker === after.speaker && after.startMs - before.endMs <= A.bridgeGapMs && startMs >= before.endMs && endMs <= after.startMs) {
        return { speaker: before.speaker, status: "bridged", share: 0, confidence: 0.7, overlap: false, review: false };
      }
      return { speaker: null, status: "none", share: 0, confidence: null, overlap: false, review: true };
    }

    const ranked = [...per.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)); // deterministic on ties
    const [best, bestMs] = ranked[0];
    const secondMs = ranked[1]?.[1] ?? 0;
    const share = bestMs / duration;
    const ambiguous = secondMs > 0 && secondMs >= A.ambiguousRatio * bestMs;
    const status = overlap ? "overlap" : ambiguous ? "ambiguous" : share < A.minTurnShare ? "straddles" : "clear";
    // A confidence in 0..1 for the LABEL (not the words): how much of the word the chosen speaker covers, lowered when the choice was close.
    const confidence = overlap || ambiguous ? Math.min(0.4, share) : Math.min(1, Math.max(share, 0.5));
    return { speaker: best, status, share: Math.round(share * 1000) / 1000, confidence: Math.round(confidence * 1000) / 1000, overlap, review: overlap || ambiguous };
  });

  const speakers = [];
  for (const entry of labels) if (entry.speaker !== null && !speakers.includes(entry.speaker)) speakers.push(entry.speaker);
  return { labels, speakers };
}

/** Counts by status, for diagnostics (never text). */
export function alignmentSummary(labels) {
  const counts = {};
  for (const entry of labels) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return counts;
}
