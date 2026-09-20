import { relabelSpeakers } from "../deepgram.js";
import { diarizeWav } from "../diarization.js";
import { calibration } from "./calibration.js";
import { clusterAverageLinkage, decideDoctor, meanUnit, scoreAgainstProfile, dot } from "./vecmath.js";

// Speaker analysis for one recording. Three independent jobs, deliberately kept apart:
//   A. transcription      Deepgram Nova-3 Medical decides WHAT was said (never changed here).
//   B. diarization        who spoke when: Deepgram's speaker labels, or, when it merged voices, independent acoustic evidence
//                         (segmentation model turn boundaries + ECAPA embeddings + clustering).
//   C. doctor verification does a speaker's speech resemble the enrolled doctor? Applied to each speaker's own speech regions,
//                         never to a whole mixed recording.
// Anything that cannot be decided reliably stays "uncertain"; no speaker is invented and no role is assumed.

const C = calibration;
const MIN_REGION_MS = 1000;
const MAX_REGION_MS = 20_000;
const WINDOW_EDGE_MS = 10_000; // the segmentation model works in 10 s windows and splits turns at their edges
const WINDOW_TOLERANCE_MS = 150;
const MAX_CLUSTER_ITEMS = 300; // agglomerative clustering is cubic: cluster a spread of regions, assign the rest
const MAX_REGIONS_PER_SPEAKER = 60;
const WORD_REGION_GAP_MS = 800;

/** Turn the segmentation model's segments into speech regions to embed. Re-joins turns it cut at its own window edges. */
export function regionsFromIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged = [];
  for (const seg of sorted) {
    const last = merged.at(-1);
    const atWindowEdge = last && Math.abs(last.endMs % WINDOW_EDGE_MS) < WINDOW_TOLERANCE_MS || last && Math.abs((last.endMs % WINDOW_EDGE_MS) - WINDOW_EDGE_MS) < WINDOW_TOLERANCE_MS;
    if (last && atWindowEdge && seg.startMs - last.endMs <= 120 && seg.startMs >= last.endMs - 5) last.endMs = seg.endMs;
    else merged.push({ startMs: seg.startMs, endMs: seg.endMs });
  }
  // long regions are cut into bounded pieces (bounded memory, and one speaker rarely talks for more than that uninterrupted)
  return merged.flatMap((r) => {
    const pieces = [];
    for (let s = r.startMs; s < r.endMs; s += MAX_REGION_MS) pieces.push({ startMs: s, endMs: Math.min(r.endMs, s + MAX_REGION_MS) });
    return pieces;
  });
}

/** Contiguous words with the same speaker become regions to embed for that speaker. */
export function speakerRegionsFromWords(words) {
  const bySpeaker = new Map();
  let current = null;
  for (const w of words) {
    if (w.speaker === null || !w.valid) {
      current = null;
      continue;
    }
    const startMs = Math.round(w.start * 1000);
    const endMs = Math.round(w.end * 1000);
    if (current && current.speaker === w.speaker && startMs - current.endMs <= WORD_REGION_GAP_MS && endMs - current.startMs <= MAX_REGION_MS) {
      current.endMs = endMs;
    } else {
      current = { speaker: w.speaker, startMs, endMs };
      if (!bySpeaker.has(w.speaker)) bySpeaker.set(w.speaker, []);
      bySpeaker.get(w.speaker).push(current);
    }
  }
  return bySpeaker;
}

const seconds = (regions) => regions.reduce((sum, r) => sum + (r.endMs - r.startMs), 0) / 1000;

/**
 * Independent speaker clusters from acoustic evidence. Returns { clusters: number of qualifying voices,
 * labelOf(word) -> cluster index | null, evidence } or null when it cannot run.
 */
export async function independentSpeakers({ wavPath, config, embedder, signal }) {
  const seg = await diarizeWav(wavPath, { ...config, diarizationThreshold: 0.001 }, { timeoutMs: config.diarizationTimeoutMs, signal });
  if (seg.status !== "ok") return null;
  const regions = regionsFromIntervals(seg.intervals).filter((r) => r.endMs - r.startMs >= MIN_REGION_MS);
  if (regions.length === 0) return { clusters: 0, labelOf: () => null, evidence: [] };
  const embeddings = await embedder.embedRegions(wavPath, regions, { signal });
  const usable = regions.map((r, i) => ({ ...r, vec: embeddings[i] })).filter((r) => r.vec);
  if (usable.length === 0) return null;

  // cluster a spread of the longest regions, then place every other region by nearest centroid
  const seed = usable.length <= MAX_CLUSTER_ITEMS ? usable : [...usable].sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs)).slice(0, MAX_CLUSTER_ITEMS);
  const labels = clusterAverageLinkage(seed.map((r) => ({ vec: r.vec, weight: r.endMs - r.startMs })), C.clustering.distanceThreshold);
  const k = Math.max(...labels) + 1;
  const centroid = (c) => meanUnit(seed.filter((_, i) => labels[i] === c).map((r) => r.vec), seed.filter((_, i) => labels[i] === c).map((r) => r.endMs - r.startMs));
  const centroids = Array.from({ length: k }, (_, c) => centroid(c));
  const assigned = usable.map((r) => {
    const idx = seed.indexOf(r);
    if (idx >= 0) return labels[idx];
    const sims = centroids.map((cen) => dot(cen, r.vec));
    const best = sims.indexOf(Math.max(...sims));
    return 1 - sims[best] < C.clustering.distanceThreshold ? best : -1;
  });

  // a voice qualifies only with enough real evidence: several regions and enough speech
  const evidence = Array.from({ length: k }, (_, c) => {
    const mine = usable.filter((_, i) => assigned[i] === c);
    return { regions: mine.length, speechSeconds: seconds(mine) };
  });
  const qualifies = evidence.map((e) => e.regions >= C.clustering.minClusterRegions && e.speechSeconds >= C.clustering.minClusterSpeechSeconds);
  // renumber the qualifying clusters 0..n-1 by first appearance; regions of non-qualifying clusters stay unassigned
  const order = [];
  usable.forEach((_, i) => { if (assigned[i] >= 0 && qualifies[assigned[i]] && !order.includes(assigned[i])) order.push(assigned[i]); });
  const rename = new Map(order.map((c, n) => [c, n]));
  const placed = usable.map((r, i) => ({ startMs: r.startMs, endMs: r.endMs, label: assigned[i] >= 0 && rename.has(assigned[i]) ? rename.get(assigned[i]) : null }));

  // a word takes the label of the region containing its middle (or one within 0.6 s, for short gaps between regions)
  const labelOf = (word) => {
    const mid = ((word.start + word.end) / 2) * 1000;
    const hit = placed.find((r) => mid >= r.startMs && mid <= r.endMs) ?? placed.find((r) => mid >= r.startMs - 600 && mid <= r.endMs + 600);
    return hit ? hit.label : null;
  };
  return { clusters: order.length, labelOf, evidence: order.map((c) => evidence[c]) };
}

/**
 * The analysis for one Deepgram result. `references` are the doctor's decrypted profile embeddings (or null when not enrolled).
 * Returns { normalized (possibly relabelled), source, voiceStatus, identification: Map(speaker -> {...}), warnings, internal }.
 */
export async function analyzeSpeakers({ normalized, wavPath, references, config, embedder, signal }) {
  const warnings = [];
  const flat = normalized.groups.flat();
  const dgSpeakers = new Set(flat.map((w) => w.speaker).filter((s) => s !== null));
  const wantIdentification = Boolean(references);
  let result = normalized;
  let source = "deepgram";
  const internal = { deepgramSpeakers: dgSpeakers.size };

  // ---- B. diarization: is Deepgram's speaker count consistent with independent acoustic evidence? ----
  // (Only when the voice model is installed, and only when it could change the outcome: a single Deepgram speaker, or an enrolled doctor.)
  let independent = null;
  if ((await embedder.available()) && (dgSpeakers.size <= 1 || wantIdentification)) {
    try {
      independent = await independentSpeakers({ wavPath, config, embedder, signal });
    } catch (error) {
      if (error.aborted || error.status === 499) throw error;
      warnings.push({ code: "VOICE_ANALYSIS_FAILED", message: "Independent voice analysis failed, so Deepgram's speaker labels were used without a second check." });
    }
  }
  if (independent) {
    internal.independentClusters = independent.clusters;
    if (dgSpeakers.size <= 1 && independent.clusters >= 2) {
      // Deepgram merged voices that independent evidence separates: use the independent labels.
      result = relabelSpeakers(normalized, (word) => independent.labelOf(word));
      source = "independent";
      warnings.push({
        code: "SPEAKERS_FROM_VOICE_ANALYSIS",
        message: `Deepgram detected ${dgSpeakers.size === 1 ? "a single speaker" : "no speaker labels"}, but independent voice analysis found ${independent.clusters} distinct voices. Please review the speaker labels.`,
      });
    } else if (dgSpeakers.size >= 2 && independent.clusters > dgSpeakers.size) {
      warnings.push({ code: "POSSIBLE_MISSED_SPEAKER", message: `Voice analysis found ${independent.clusters} distinct voices where Deepgram found ${dgSpeakers.size}. Deepgram's labels were kept: please review.` });
    }
  }

  // ---- C. doctor verification, per speaker, on that speaker's own speech ----
  const identification = new Map();
  let voiceStatus = wantIdentification ? "completed" : "not_enrolled";
  const finalWords = result.groups.flat();
  const speakers = [...new Set(finalWords.map((w) => w.speaker).filter((s) => s !== null))].sort((a, b) => a - b);
  if (wantIdentification && (await embedder.available())) {
    try {
      const regionsBySpeaker = speakerRegionsFromWords(finalWords);
      const entries = [];
      for (const speaker of speakers) {
        const regions = (regionsBySpeaker.get(speaker) ?? []).filter((r) => r.endMs - r.startMs >= MIN_REGION_MS)
          .sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs)).slice(0, MAX_REGIONS_PER_SPEAKER);
        entries.push({ speaker, regions });
      }
      const flatRegions = entries.flatMap((e) => e.regions);
      const vectors = await embedder.embedRegions(wavPath, flatRegions, { signal });
      let cursor = 0;
      const clusters = entries.map((e) => {
        const vecs = e.regions.map(() => vectors[cursor++]);
        const good = e.regions.map((r, i) => ({ r, v: vecs[i] })).filter((x) => x.v);
        if (good.length === 0) return { speaker: e.speaker, score: null, regions: 0, speechSeconds: 0 };
        const proto = meanUnit(good.map((x) => x.v), good.map((x) => x.r.endMs - x.r.startMs));
        return { speaker: e.speaker, score: scoreAgainstProfile(proto, references), regions: good.length, speechSeconds: seconds(good.map((x) => x.r)) };
      });
      const decisions = decideDoctor(clusters, C.decision);
      clusters.forEach((c, i) => identification.set(c.speaker, {
        status: decisions[i].status, reason: decisions[i].reason, suggestedRole: decisions[i].status === "matched" ? "doctor" : null,
        // internal only: the score is a cosine similarity, NOT a probability, and is never sent to a client
        score: c.score === null ? null : Math.round(c.score * 1000) / 1000, regions: c.regions, speechSeconds: Math.round(c.speechSeconds),
      }));
    } catch (error) {
      if (error.aborted || error.status === 499) throw error;
      voiceStatus = "unavailable";
      warnings.push({ code: "VOICE_IDENTIFICATION_FAILED", message: "The doctor's voice could not be identified for this recording. Speaker roles are unassigned." });
    }
  } else if (wantIdentification) {
    voiceStatus = "unavailable";
  }
  return { normalized: result, source, voiceStatus, identification, warnings, internal };
}
