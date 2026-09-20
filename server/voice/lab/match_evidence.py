#!/usr/bin/env python3
"""Doctor-match reliability vs the number of regions per speaker (multi-condition profile, thresholds FROZEN from calibration).
Cluster = mean of k utterance embeddings. Held-out identities only. Sibling voices (same underlying voice) are reported separately."""
import json
from pathlib import Path
import numpy as np
H = Path(__file__).resolve().parent
man = json.loads((H / "data/manifest.json").read_text()); z = np.load(H / "embeddings-ecapa.npz"); emb = dict(zip(z["keys"], z["vectors"]))
cal = json.loads((H.parent / "calibration.json").read_text())["decision"]; TM, TR = cal["tMatch"], cal["tReject"]
sib = {frozenset(p) for p in man["similar"]}; conds = man["conditions"]
held = [v for v, e in man["voices"].items() if e["set"] == "heldout"]
unit = lambda v: v / np.linalg.norm(v)
def prof(v):
    e = man["voices"][v]; return np.stack([emb[x["file"]] for x in e["enroll"] + e["enrollAug"]])
rng = np.random.default_rng(9)
def cluster(v, c, k):
    f = [t["file"] for t in man["voices"][v]["tests"] if t["condition"] == c]
    return unit(np.mean([emb[f[j]] for j in rng.choice(len(f), min(k, len(f)), replace=False)], axis=0))
print(f"frozen thresholds: match {TM}, reject {TR}")
print(" k regions | doctor: matched / uncertain / unknown | non-doctor (dissimilar voices): matched / uncertain / unknown | siblings matched")
for k in (1, 2, 3, 5, 8):
    dm = du = dk = nm = nu = nk = sm = sn = dn = 0
    for d in held:
        p = prof(d)
        for _ in range(60):
            c = conds[rng.integers(3)]; s = float(np.max(p @ cluster(d, c, k))); dn += 1
            dm += s >= TM; dk += s < TR; du += TR <= s < TM
        for o in held:
            if o == d: continue
            for _ in range(20):
                c = conds[rng.integers(3)]; s = float(np.max(p @ cluster(o, c, k)))
                if frozenset((d, o)) in sib: sn += 1; sm += s >= TM
                else: nm += s >= TM; nk += s < TR; nu += TR <= s < TM
    tot = nm + nu + nk
    print(f"   {k:2d}      | {dm/dn*100:5.1f}% / {du/dn*100:5.1f}% / {dk/dn*100:5.1f}%      |   {nm/tot*100:5.2f}% / {nu/tot*100:5.1f}% / {nk/tot*100:5.1f}%   (n={tot})   | {sm/max(1,sn)*100:5.1f}% of {sn}")
