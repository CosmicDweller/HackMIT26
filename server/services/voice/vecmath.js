// Vector math, clustering and the doctor-decision policy. Pure functions (no I/O), unit-tested.
// All embeddings are L2-normalised, so the dot product is the cosine similarity. A cosine score is NOT a
// probability of identity: it is compared with thresholds calibrated on held-out audio (voice/calibration.json).

export const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

export function normalize(v) {
  const n = Math.sqrt(dot(v, v));
  return n > 0 ? v.map((x) => x / n) : v;
}

/** Weighted mean of vectors, re-normalised (the "prototype" of a group of regions). */
export function meanUnit(vectors, weights = vectors.map(() => 1)) {
  const out = new Array(vectors[0].length).fill(0);
  vectors.forEach((vec, i) => {
    for (let d = 0; d < out.length; d++) out[d] += vec[d] * weights[i];
  });
  return normalize(out);
}

/**
 * Agglomerative clustering, average linkage on cosine distance (1 - cosine), cut at `distanceThreshold`.
 * `items`: [{ vec, weight }] (weight = speech duration, so long regions count more). Returns an array of cluster
 * indices, one per item, numbered by first appearance. O(n^3) worst case: callers pass at most a few hundred items.
 */
export function clusterAverageLinkage(items, distanceThreshold) {
  const n = items.length;
  if (n === 0) return [];
  let clusters = items.map((item, i) => ({ members: [i], weight: item.weight }));
  const dist = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => 1 - dot(items[i].vec, items[j].vec)));
  const linkage = (a, b) => {
    let num = 0;
    let den = 0;
    for (const i of a.members) for (const j of b.members) {
      const w = items[i].weight * items[j].weight;
      num += dist[i][j] * w;
      den += w;
    }
    return den > 0 ? num / den : Infinity;
  };
  for (;;) {
    let best = { d: Infinity, a: -1, b: -1 };
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const d = linkage(clusters[a], clusters[b]);
        if (d < best.d) best = { d, a, b };
      }
    }
    if (best.d >= distanceThreshold || best.a < 0) break;
    clusters[best.a] = { members: [...clusters[best.a].members, ...clusters[best.b].members], weight: clusters[best.a].weight + clusters[best.b].weight };
    clusters = clusters.filter((_, i) => i !== best.b);
  }
  const labels = new Array(n).fill(-1);
  clusters.sort((x, y) => Math.min(...x.members) - Math.min(...y.members)).forEach((cluster, index) => cluster.members.forEach((m) => { labels[m] = index; }));
  return labels;
}

/** Score of a cluster against the doctor's profile references: the best (max) cosine. */
export const scoreAgainstProfile = (clusterVec, references) => Math.max(...references.map((ref) => dot(ref, clusterVec)));

/**
 * The doctor decision for every speaker cluster of one recording.
 *   clusters: [{ score | null, regions, speechSeconds }]
 * A cluster is "matched" only if it has enough evidence, reaches tMatch, is the ONLY cluster that reaches tMatch, and beats
 * every other cluster by `margin`. Two clusters reaching tMatch (near-identical voices, or one voice split in two) are
 * both left "uncertain". Below tReject is "unknown" (a reliable non-match). Anything without enough evidence is "uncertain".
 * Returns [{ status, reason }] with status matched | unknown | uncertain.
 */
export function decideDoctor(clusters, policy) {
  const enough = (c) => c.score !== null && c.regions >= policy.minRegions && c.speechSeconds >= policy.minSpeechSeconds;
  const reaching = clusters.map((c, i) => (enough(c) && c.score >= policy.tMatch ? i : -1)).filter((i) => i >= 0);
  return clusters.map((c, i) => {
    if (c.score === null) return { status: "uncertain", reason: "NO_USABLE_SPEECH" };
    if (!enough(c)) return { status: "uncertain", reason: "INSUFFICIENT_SPEECH" };
    if (reaching.includes(i)) {
      if (reaching.length > 1) return { status: "uncertain", reason: "MULTIPLE_CLOSE_MATCHES" };
      const rival = Math.max(-1, ...clusters.filter((_, j) => j !== i && clusters[j].score !== null).map((o) => o.score));
      if (c.score - rival < policy.margin) return { status: "uncertain", reason: "NO_CLEAR_MARGIN" };
      return { status: "matched", reason: "MATCH" };
    }
    if (c.score < policy.tReject) return { status: "unknown", reason: "NO_MATCH" };
    return { status: "uncertain", reason: "BORDERLINE" };
  });
}
