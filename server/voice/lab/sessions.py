#!/usr/bin/env python3
"""Session-level decision policy calibration and evaluation (SYNTHETIC identities).

A "session" is one recording: 1-2 non-doctor people, optionally the enrolled doctor, all captured under ONE microphone
condition (as in a real consultation). Each speaker's evidence is the mean of k utterance embeddings (their cluster).
Policy (per session): a cluster is "matched" only if its score >= T_MATCH, it is the ONLY cluster that reaches T_MATCH,
and it beats every other cluster by >= MARGIN. Two clusters reaching T_MATCH (for example two near-identical voices)
are both left "uncertain". score < T_REJECT -> "unknown". Everything else -> "uncertain". A cluster with fewer than
MIN_REGIONS regions is never matched.

Thresholds are chosen on the CALIBRATION identities only, then applied unchanged to the HELD-OUT identities.
Usage: python3 lab/sessions.py <ecapa|wespeaker>   (writes lab/calibration-<model>.json)
"""
import itertools
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
model = sys.argv[1]
MODE = sys.argv[2] if len(sys.argv) > 2 else "clean"   # clean: 3 clean enrollment samples | multicond: plus degraded variants
manifest = json.loads((HERE / "data" / "manifest.json").read_text())
npz = np.load(HERE / f"embeddings-{model}.npz")
emb = {k: v for k, v in zip(npz["keys"], npz["vectors"])}
conditions = manifest["conditions"]
sets = {"calibration": [], "heldout": []}
for vid, e in manifest["voices"].items():
    sets[e["set"]].append(vid)
similar = {frozenset(p) for p in manifest["similar"]}
unit = lambda v: v / np.linalg.norm(v)
MIN_REGIONS = 3


def profile(vid):
    entry = manifest["voices"][vid]
    items = entry["enroll"] + (entry.get("enrollAug", []) if MODE == "multicond" else [])
    return np.stack([emb[e["file"]] for e in items])  # "multi": keep every reference, score = max cosine


def cluster_vec(vid, cond, rng, k):
    files = [t["file"] for t in manifest["voices"][vid]["tests"] if t["condition"] == cond]
    pick = rng.choice(len(files), size=min(k, len(files)), replace=False)
    return unit(np.mean([emb[files[j]] for j in pick], axis=0))


def decide(scores, regions, t_match, t_reject, margin):
    hits = [i for i, s in enumerate(scores) if s >= t_match]
    out = []
    for i, s in enumerate(scores):
        if regions[i] < MIN_REGIONS:
            out.append("uncertain")
        elif i in hits and len(hits) == 1 and all(s - scores[j] >= margin for j in range(len(scores)) if j != i):
            out.append("matched")
        elif s < t_reject:
            out.append("unknown")
        else:
            out.append("uncertain")
    return out


def make_sessions(members, n, seed):
    rng = np.random.default_rng(seed)
    sessions = []
    for _ in range(n):
        d = members[rng.integers(len(members))]
        others = [m for m in members if m != d]
        kind = rng.choice(["DP", "DPN", "PN"])  # doctor + patient, doctor + patient + nurse, doctor absent
        cond = conditions[rng.integers(3)]
        who = {"DP": [d, others[rng.integers(len(others))]], "DPN": [d, *rng.choice(others, 2, replace=False)], "PN": list(rng.choice(others, 2, replace=False))}[kind]
        rng.shuffle(who)
        ks = [int(rng.integers(3, 9)) for _ in who]
        clusters = [cluster_vec(w, cond, rng, k) for w, k in zip(who, ks)]
        prof = profile(d)
        scores = [float(np.max(prof @ c)) for c in clusters]
        sessions.append({"doctor": d, "who": who, "kind": str(kind), "cond": cond, "scores": scores, "regions": ks})
    return sessions


def evaluate(sessions, t_match, t_reject, margin):
    far = frr = unc = present = absent = patient_as_doc = 0
    doc_seen = false_seen = 0
    similar_conf = 0
    for s in sessions:
        res = decide(s["scores"], s["regions"], t_match, t_reject, margin)
        for who, r in zip(s["who"], res):
            if who == s["doctor"]:
                doc_seen += 1
                frr += r == "unknown"
                unc += r == "uncertain"
                present += r == "matched"
            else:
                false_seen += 1
                if r == "matched":
                    patient_as_doc += 1
                    similar_conf += frozenset((who, s["doctor"])) in similar
    return {"doctorMatched": present / max(1, doc_seen), "doctorUncertain": unc / max(1, doc_seen), "doctorUnknown": frr / max(1, doc_seen),
            "falseDoctorMatchRate": patient_as_doc / max(1, false_seen), "falseDoctorMatches": patient_as_doc, "nonDoctorClusters": false_seen,
            "falseMatchesFromSimilarVoices": similar_conf, "doctorClusters": doc_seen}


cal = make_sessions(sets["calibration"], 4000, 1)
held = make_sessions(sets["heldout"], 4000, 2)

# choose T_MATCH and MARGIN on calibration: no false doctor match allowed, then maximise doctor recall
best = None
for t_match, margin in itertools.product(np.arange(0.50, 0.95, 0.01), [0.0, 0.03, 0.06, 0.10, 0.15]):
    r = evaluate(cal, t_match, 0.0, margin)
    key = (r["falseDoctorMatches"] > 0, -r["doctorMatched"], -t_match)
    if best is None or key < best[0]:
        best = (key, float(t_match), float(margin), r)
_, T_MATCH, MARGIN, cal_res = best
# T_REJECT: below this a genuine doctor cluster occurs in <= 1% of calibration sessions
gen_scores = np.array([s_ for s in cal for w, s_ in zip(s["who"], s["scores"]) if w == s["doctor"]])
T_REJECT = float(min(np.quantile(gen_scores, 0.01), T_MATCH))
cal_res = evaluate(cal, T_MATCH, T_REJECT, MARGIN)
held_res = evaluate(held, T_MATCH, T_REJECT, MARGIN)

by_cond = {c: evaluate([s for s in held if s["cond"] == c], T_MATCH, T_REJECT, MARGIN) for c in conditions}
by_kind = {k: evaluate([s for s in held if s["kind"] == k], T_MATCH, T_REJECT, MARGIN) for k in ("DP", "DPN", "PN")}
naive = evaluate(held, T_MATCH, T_REJECT, 0.0)  # what a plain threshold (no exclusivity/margin) would do
plain_t = evaluate([{**s} for s in held], T_MATCH, -1, -1)  # same threshold, ignoring exclusivity by huge negative margin

result = {"model": model, "profileMode": MODE, "policy": {"tMatch": round(T_MATCH, 3), "tReject": round(T_REJECT, 3), "margin": MARGIN, "minRegions": MIN_REGIONS},
          "calibration": cal_res, "heldout": held_res, "heldoutByCondition": by_cond, "heldoutByKind": by_kind,
          "heldoutWithoutMarginRule": naive}
print(json.dumps(result, indent=1))
(HERE / f"calibration-{model}-{MODE}.json").write_text(json.dumps(result, indent=1) + "\n")
