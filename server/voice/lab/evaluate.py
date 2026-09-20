#!/usr/bin/env python3
"""Speaker-verification evaluation on the SYNTHETIC dataset (see make_dataset.py for the split).

Protocol
  * Identities are split into two DISJOINT sets: "calibration" (thresholds and the profile representation are chosen
    here) and "heldout" (used only to report the final numbers with the thresholds frozen from calibration).
  * For each enrolled doctor d in a set: genuine trials = d's test utterances; impostor trials = the test utterances of
    every OTHER identity in the same set. The profile is built from d's three enrollment samples only, never from
    the test utterances.
  * Score = cosine similarity between an utterance embedding and the profile. It is NOT a probability of identity.
  * Decision policy (frozen from calibration): score >= T_match -> "matched"; score < T_reject -> "unknown";
    otherwise "uncertain". T_match is the smallest threshold with calibration impostor false-accept rate <= FAR_TARGET;
    T_reject is the largest threshold with calibration genuine rejection <= REJECT_TARGET.
  * Reported on held-out: false-accept rate (impostor scored "matched"), false-reject rate (genuine scored "unknown"),
    the uncertain share, EER, per condition and per duration, and the similar-voice pairs separately.

Usage: python3 lab/evaluate.py ecapa|wespeaker [json-output]
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
model = sys.argv[1]
manifest = json.loads((HERE / "data" / "manifest.json").read_text())
npz = np.load(HERE / f"embeddings-{model}.npz")
emb = {k: v for k, v in zip(npz["keys"], npz["vectors"])}
FAR_TARGET = 0.001  # 0.1% of impostor trials may be accepted as the doctor (false doctor matches are the costly error)
REJECT_TARGET = 0.01  # 1% of genuine trials may fall below the "unknown" line
similar = {frozenset(p) for p in manifest["similar"]}


def unit(v):
    return v / np.linalg.norm(v)


def profile(vid, kind):
    refs = np.stack([emb[e["file"]] for e in manifest["voices"][vid]["enroll"]])
    if kind == "mean":
        return unit(refs.mean(axis=0))[None, :]
    if kind == "multi":
        return refs  # keep the individual reference embeddings; score = max cosine
    if kind == "single":
        return refs[:1]  # only the first sample (baseline: does using 3 help?)
    raise ValueError(kind)


def score(vec, prof):
    return float(np.max(prof @ vec))


def trials(members, kind):
    """Yield (score, genuine, doctor, speaker, condition, seconds) for every trial inside one identity set."""
    for d in members:
        prof = profile(d, kind)
        for other in members:
            for t in manifest["voices"][other]["tests"]:
                yield score(emb[t["file"]], prof), other == d, d, other, t["condition"], t["seconds"]


def eer(gen, imp):
    ts = np.sort(np.concatenate([gen, imp]))
    best = (1.0, 0.0)
    for t in ts:
        far, frr = float((imp >= t).mean()), float((gen < t).mean())
        if abs(far - frr) < best[0]:
            best = (abs(far - frr), (far + frr) / 2, t)
    return best[1], best[2]


def thresholds(gen, imp):
    # smallest threshold whose calibration FAR <= target; largest threshold whose genuine rejection <= target
    cand = np.unique(np.concatenate([gen, imp]))
    t_match = next((t for t in cand if (imp >= t).mean() <= FAR_TARGET), float(imp.max()) + 1e-6)
    t_reject = max([t for t in cand if (gen < t).mean() <= REJECT_TARGET] or [float(gen.min())])
    return float(t_match), float(min(t_reject, t_match))


sets = defaultdict(list)
for vid, entry in manifest["voices"].items():
    sets[entry["set"]].append(vid)

report = {"model": model, "identities": {k: len(v) for k, v in sets.items()}, "targets": {"far": FAR_TARGET, "reject": REJECT_TARGET}}

# 1) choose the profile representation on the calibration set
rep = {}
for kind in ("single", "mean", "multi"):
    rows = list(trials(sets["calibration"], kind))
    gen = np.array([r[0] for r in rows if r[1]])
    imp = np.array([r[0] for r in rows if not r[1]])
    e, t = eer(gen, imp)
    rep[kind] = {"eer": e, "eerThreshold": t, "genuineMean": float(gen.mean()), "impostorMax": float(imp.max()), "impostorMean": float(imp.mean()), "trials": [int(gen.size), int(imp.size)]}
report["representation(calibration)"] = rep
chosen = min(rep, key=lambda k: (rep[k]["eer"], -rep[k]["genuineMean"] + rep[k]["impostorMax"]))
report["chosenRepresentation"] = chosen

# 2) freeze thresholds on calibration
rows = list(trials(sets["calibration"], chosen))
gen = np.array([r[0] for r in rows if r[1]])
imp = np.array([r[0] for r in rows if not r[1]])
t_match, t_reject = thresholds(gen, imp)
report["thresholds"] = {"match": t_match, "reject": t_reject, "calibrationFAR": float((imp >= t_match).mean()), "calibrationRejectedGenuine": float((gen < t_reject).mean())}

# 3) report on held-out only
rows = list(trials(sets["heldout"], chosen))
G = [r for r in rows if r[1]]
I = [r for r in rows if not r[1]]
gs = np.array([r[0] for r in G])
is_ = np.array([r[0] for r in I])
e, _ = eer(gs, is_)


def outcome(s):
    return "matched" if s >= t_match else ("unknown" if s < t_reject else "uncertain")


def summarize(g, i):
    gs_, is2 = np.array([r[0] for r in g]), np.array([r[0] for r in i])
    if not len(gs_) or not len(is2):
        return None
    return {
        "genuineTrials": len(g), "impostorTrials": len(i),
        "falseAcceptRate": float(np.mean([outcome(s) == "matched" for s in is2])),
        "falseRejectRate": float(np.mean([outcome(s) == "unknown" for s in gs_])),
        "genuineUncertain": float(np.mean([outcome(s) == "uncertain" for s in gs_])),
        "impostorUncertain": float(np.mean([outcome(s) == "uncertain" for s in is2])),
        "genuineMatched": float(np.mean([outcome(s) == "matched" for s in gs_])),
        "genuineMean": float(gs_.mean()), "impostorMean": float(is2.mean()), "impostorMax": float(is2.max()),
    }


report["heldout"] = {"overall": summarize(G, I), "eer": e}
report["heldout"]["byCondition"] = {c: summarize([r for r in G if r[4] == c], [r for r in I if r[4] == c]) for c in manifest["conditions"]}
report["heldout"]["byDuration"] = {
    label: summarize([r for r in G if lo <= r[5] < hi], [r for r in I if lo <= r[5] < hi])
    for label, (lo, hi) in {"<2.5s": (0, 2.5), "2.5-3.5s": (2.5, 3.5), "3.5-5s": (3.5, 5), ">=5s": (5, 99)}.items()
}
sim_I = [r for r in I if frozenset((r[2], r[3])) in similar]
non_sim_I = [r for r in I if frozenset((r[2], r[3])) not in similar]
report["heldout"]["similarPairsImpostors"] = summarize(G, sim_I)
report["heldout"]["dissimilarImpostors"] = summarize(G, non_sim_I)
report["heldout"]["similarPairScores"] = {"/".join(sorted(p)): float(np.mean([r[0] for r in I if frozenset((r[2], r[3])) == p])) for p in similar if all(x in sets["heldout"] for x in p)}

# 4) cluster-level evidence: several regions of ONE speaker averaged, as in a real consultation (heldout)
rng = np.random.default_rng(7)
cluster = {}
for k in (1, 2, 3, 5, 8):
    far_hits = far_n = frr_hits = frr_n = unc_g = 0
    for d in sets["heldout"]:
        prof = profile(d, chosen)
        for other in sets["heldout"]:
            files = [t["file"] for t in manifest["voices"][other]["tests"]]
            for _ in range(20):
                pick = rng.choice(len(files), size=min(k, len(files)), replace=False)
                s = score(unit(np.mean([emb[files[j]] for j in pick], axis=0)), prof)
                if other == d:
                    frr_n += 1
                    frr_hits += outcome(s) == "unknown"
                    unc_g += outcome(s) == "uncertain"
                else:
                    far_n += 1
                    far_hits += outcome(s) == "matched"
    cluster[str(k)] = {"regions": k, "falseAcceptRate": far_hits / far_n, "falseRejectRate": frr_hits / frr_n, "genuineUncertain": unc_g / frr_n, "impostorClusters": far_n}
report["heldout"]["clusterLevel"] = cluster

out = json.dumps(report, indent=1)
if len(sys.argv) > 2:
    Path(sys.argv[2]).write_text(out + "\n")
print(out)
