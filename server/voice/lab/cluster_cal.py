#!/usr/bin/env python3
"""Calibrate the ECAPA clustering distance threshold (average linkage on cosine distance) on SYNTHETIC sessions.

Sessions: 1, 2 or 3 speakers; each contributes 3-8 utterance-regions, all in ONE microphone condition.
Chosen on the CALIBRATION identities: the centre of the plateau where 1-, 2- and 3-speaker counting are all >= 99%, then evaluated unchanged on the HELD-OUT
identities. Lower threshold = more clusters.
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage

HERE = Path(__file__).resolve().parent
manifest = json.loads((HERE / "data" / "manifest.json").read_text())
npz = np.load(HERE / "embeddings-ecapa.npz")
emb = {k: v for k, v in zip(npz["keys"], npz["vectors"])}
sets = {"calibration": [], "heldout": []}
for vid, e in manifest["voices"].items():
    sets[e["set"]].append(vid)
similar = {frozenset(p) for p in manifest["similar"]}
conditions = manifest["conditions"]
FALSE_SPLIT_TARGET = 0.01


def sessions(members, n, seed):
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        k = int(rng.integers(1, 4))
        while True:
            who = list(rng.choice(members, k, replace=False))
            # sibling voices (same underlying voice) are excluded from the counting task: they are not separable by ANY model
            if not any(frozenset((a, b)) in similar for a in who for b in who if a != b):
                break
        cond = conditions[rng.integers(3)]
        vecs, labels = [], []
        for w in who:
            files = [t["file"] for t in manifest["voices"][w]["tests"] if t["condition"] == cond]
            for j in rng.choice(len(files), int(rng.integers(3, 9)), replace=False):
                vecs.append(emb[files[j]])
                labels.append(w)
        out.append((np.stack(vecs), labels, k, cond))
    return out


def count(vecs, thr):
    if len(vecs) < 2:
        return 1, np.zeros(len(vecs), dtype=int)
    z = linkage(vecs, method="average", metric="cosine")
    lab = fcluster(z, t=thr, criterion="distance")
    return len(set(lab)), lab


def evaluate(ss, thr):
    res = {1: [0, 0], 2: [0, 0], 3: [0, 0]}
    pure = tot = 0
    for vecs, labels, k, _ in ss:
        n, lab = count(vecs, thr)
        res[k][0] += n == k
        res[k][1] += 1
        if n == k:
            pure += 1
    return {f"{k}spk_correct": res[k][0] / max(1, res[k][1]) for k in res} | {"n": {k: res[k][1] for k in res}}


cal, held = sessions(sets["calibration"], 1500, 11), sessions(sets["heldout"], 1500, 12)
grid = np.round(np.arange(0.25, 0.95, 0.025), 3)
table = {float(t): evaluate(cal, t) for t in grid}
# Operating point = the CENTRE of the plateau where all of 1/2/3-speaker counting is >= 99% on CALIBRATION voices.
# (Choosing the edge of the plateau was measured to transfer badly to held-out voices, so it is not used.)
plateau = [t for t in grid if min(table[float(t)][f"{k}spk_correct"] for k in (1, 2, 3)) >= 0.99]
THR = float(np.median(plateau)) if plateau else float(grid.max())
print("threshold sweep on CALIBRATION (correct speaker count): thr  1spk  2spk  3spk")
for t in grid[::2]:
    r = table[float(t)]
    print(f"   {t:5.3f}  {r['1spk_correct']*100:5.1f} {r['2spk_correct']*100:5.1f} {r['3spk_correct']*100:5.1f}")
h = evaluate(held, THR)
c = table[THR]
print(f"\nplateau (calibration >= 99%): {min(plateau):.3f} .. {max(plateau):.3f}")
print(f"CHOSEN distance threshold {THR} (calibration false-split {(1-c['1spk_correct'])*100:.2f}%)")
print(f"calibration: 1 speaker {c['1spk_correct']*100:.1f}% | 2 speakers {c['2spk_correct']*100:.1f}% | 3 speakers {c['3spk_correct']*100:.1f}%")
print(f"HELD-OUT   : 1 speaker {h['1spk_correct']*100:.1f}% | 2 speakers {h['2spk_correct']*100:.1f}% | 3 speakers {h['3spk_correct']*100:.1f}%   n={h['n']}")
for cond in conditions:
    hc = evaluate([s for s in held if s[3] == cond], THR)
    print(f"   held-out {cond:6s}: 1spk {hc['1spk_correct']*100:5.1f}%  2spk {hc['2spk_correct']*100:5.1f}%  3spk {hc['3spk_correct']*100:5.1f}%")
json.dump({"clusterDistanceThreshold": THR, "falseSplitTarget": FALSE_SPLIT_TARGET, "calibration": c, "heldout": h}, open(HERE / "cluster-calibration.json", "w"), indent=1)
