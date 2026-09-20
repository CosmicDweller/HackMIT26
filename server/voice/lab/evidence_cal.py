#!/usr/bin/env python3
"""How much evidence does independent clustering need before a split can be trusted? (SYNTHETIC sessions, threshold 0.475.)
For 1-speaker sessions with n regions: false-split rate. For 2-speaker sessions where the smaller voice has m regions: correct-split rate."""
import json
from pathlib import Path
import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
H = Path(__file__).resolve().parent
man = json.loads((H / "data/manifest.json").read_text()); z = np.load(H / "embeddings-ecapa.npz"); emb = dict(zip(z["keys"], z["vectors"]))
sib = {frozenset(p) for p in man["similar"]}; conds = man["conditions"]; THR = 0.475
sets = {s: [v for v, e in man["voices"].items() if e["set"] == s] for s in ("calibration", "heldout")}
rng = np.random.default_rng(21)
def utts(v, cond, n):
    f = [t["file"] for t in man["voices"][v]["tests"] if t["condition"] == cond]
    return [emb[f[j]] for j in rng.choice(len(f), min(n, len(f)), replace=False)]
def nclusters(vs): return len(set(fcluster(linkage(np.stack(vs), "average", metric="cosine"), THR, "distance"))) if len(vs) > 1 else 1
print("regions of ONE speaker -> false split (fabricated 2nd speaker):")
for s, members in sets.items():
    row = []
    for n in (2, 3, 4, 6, 8):
        bad = tot = 0
        for _ in range(1500):
            v = members[rng.integers(len(members))]; c = conds[rng.integers(3)]
            bad += nclusters(utts(v, c, n)) > 1; tot += 1
        row.append(f"n={n}: {bad/tot*100:.2f}%")
    print(f"  {s:11s}", "  ".join(row))
print("two speakers, the SMALLER voice has m regions (the other has 4) -> correct split:")
for s, members in sets.items():
    row = []
    for m in (1, 2, 3, 4):
        ok = tot = 0
        for _ in range(1500):
            a, b = rng.choice(members, 2, replace=False)
            if frozenset((a, b)) in sib: continue
            c = conds[rng.integers(3)]
            ok += nclusters(utts(a, c, 4) + utts(b, c, m)) == 2; tot += 1
        row.append(f"m={m}: {ok/tot*100:.1f}%")
    print(f"  {s:11s}", "  ".join(row))
