// Combines whisper.cpp transcript segments with diarization intervals.
//
// Strategy (also documented in docs/API_CONTRACT.md):
//  - The unit is the whisper segment. Word-level timestamps are NOT used: with VAD enabled
//    whisper.cpp leaves token timings on the VAD-compressed timeline, so they are unreliable
//    and this module never invents them. Segments are therefore never split.
//  - A segment is assigned to the speaker cluster whose speech overlaps it the most.
//  - It stays unassigned (speakerId null) when the evidence is weak: less than MIN_OVERLAP_MS of
//    detected speech overlaps it, or the winner holds less than MIN_SHARE of the overlapping
//    speech (mixed / interrupted / overlapping speech).
//  - Unassigned is never turned into a guess from what the sentence says.
//  - Stable ids: speakers are numbered by the first segment they own (speaker_1, speaker_2, ...).
//    The numbering says nothing about roles; the first speaker is not assumed to be the doctor.

export const MIN_OVERLAP_MS = 200;
export const MIN_SHARE = 0.6;

const overlapMs = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/**
 * @param {{ startMs: number, endMs: number, text: string }[]} whisperSegments
 * @param {{ speaker: number, startMs: number, endMs: number }[]} intervals  diarization speech intervals
 * @returns {{ speakers: {id, label, role}[], segments: {id, startMs, endMs, text, speakerId}[] }}
 */
export function alignSegments(whisperSegments, intervals = []) {
  const ordered = [...whisperSegments]
    .filter((segment) => segment.text?.trim())
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const assigned = ordered.map((segment) => {
    const perSpeaker = new Map();
    for (const interval of intervals) {
      const overlap = overlapMs(segment.startMs, segment.endMs, interval.startMs, interval.endMs);
      if (overlap > 0) perSpeaker.set(interval.speaker, (perSpeaker.get(interval.speaker) ?? 0) + overlap);
    }
    const total = [...perSpeaker.values()].reduce((sum, value) => sum + value, 0);
    let cluster = null;
    if (total >= MIN_OVERLAP_MS) {
      const [best, bestOverlap] = [...perSpeaker.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (bestOverlap / total >= MIN_SHARE) cluster = best;
    }

    let { startMs, endMs } = segment;
    if (cluster !== null) {
      // Trim whisper's window (which stretches across silence) to the detected speech of that speaker.
      const own = intervals.filter(
        (interval) => interval.speaker === cluster && overlapMs(startMs, endMs, interval.startMs, interval.endMs) > 0,
      );
      startMs = Math.max(startMs, Math.min(...own.map((interval) => interval.startMs)));
      endMs = Math.min(endMs, Math.max(...own.map((interval) => interval.endMs)));
    }
    return { startMs: Math.round(startMs), endMs: Math.round(endMs), text: segment.text.trim(), cluster };
  });

  // speaker_1, speaker_2, ... by first appearance among assigned segments
  const speakerIds = new Map();
  for (const segment of assigned) {
    if (segment.cluster !== null && !speakerIds.has(segment.cluster)) {
      speakerIds.set(segment.cluster, `speaker_${speakerIds.size + 1}`);
    }
  }

  return {
    speakers: [...speakerIds.values()].map((id, index) => ({ id, label: `Speaker ${index + 1}`, role: "unassigned" })),
    segments: assigned.map((segment, index) => ({
      id: `segment_${index + 1}`,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      speakerId: segment.cluster === null ? null : speakerIds.get(segment.cluster),
    })),
  };
}
