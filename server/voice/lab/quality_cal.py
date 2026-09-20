#!/usr/bin/env python3
"""Calibrate the enrollment 'multiple speakers' check (window minimum similarity) on SYNTHETIC samples.
Single-speaker samples: every enrollment file. Mixed samples: the first half of one voice's sample joined to the second half of another's.
Threshold chosen on CALIBRATION voices, reported on HELD-OUT voices."""
import json, sys, wave, random, tempfile, os
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import embed
HERE = Path(__file__).resolve().parent
man = json.loads((HERE / "data" / "manifest.json").read_text())
clf = embed.load_classifier()
def rd(p):
    with wave.open(str(p)) as w: return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
def wr(p, a):
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(a.astype(np.int16).tobytes())
res = {"calibration": {"single": [], "mixed": []}, "heldout": {"single": [], "mixed": []}}
rng = random.Random(3)
ids = list(man["voices"])
with tempfile.TemporaryDirectory() as tmp:
    for vid, e in man["voices"].items():
        s = e["set"]
        for item in e["enroll"]:
            q = embed.quality(clf, str(HERE / "data" / item["file"]))
            if q["windowMinSimilarity"] is not None: res[s]["single"].append(q["windowMinSimilarity"])
        others = [o for o in ids if man["voices"][o]["set"] == s and o != vid]
        for _ in range(3):
            o = rng.choice(others)
            a = rd(HERE / "data" / e["enroll"][0]["file"]); b = rd(HERE / "data" / man["voices"][o]["enroll"][1]["file"])
            mixed = np.concatenate([a[: len(a) // 2], b[len(b) // 2:]])
            wr(os.path.join(tmp, "m.wav"), mixed)
            q = embed.quality(clf, os.path.join(tmp, "m.wav"))
            if q["windowMinSimilarity"] is not None: res[s]["mixed"].append(q["windowMinSimilarity"])
cal_s, cal_m = np.array(res["calibration"]["single"]), np.array(res["calibration"]["mixed"])
print(f"calibration: single-speaker min-similarity  p1={np.percentile(cal_s,1):.3f} mean={cal_s.mean():.3f} (n={len(cal_s)})   mixed: p99={np.percentile(cal_m,99):.3f} mean={cal_m.mean():.3f} (n={len(cal_m)})")
# The mixed-sample p99 is inflated by sibling voices (same underlying voice), which no model can tell apart, so it is not used to
# set the threshold. Instead: the threshold at which at most 1% of GENUINE calibration samples would be rejected, minus a safety margin,
# so an honest doctor is almost never blocked; the check is a screen for gross mixing, not proof of a single speaker.
thr = float(np.percentile(cal_s, 1) - 0.10)
h_s, h_m = np.array(res["heldout"]["single"]), np.array(res["heldout"]["mixed"])
for t in (0.45, 0.50, 0.55, 0.60, 0.65, thr):
    print(f"   threshold {t:.3f}: held-out genuine wrongly rejected {np.mean(h_s < t)*100:5.1f}% | mixed caught {np.mean(h_m < t)*100:5.1f}%")
print(f"CHOSEN threshold {thr:.3f} (calibration-only rule); HELD-OUT: genuine wrongly rejected {np.mean(h_s < thr)*100:.1f}% (n={len(h_s)}), mixed caught {np.mean(h_m < thr)*100:.1f}% (n={len(h_m)})")
json.dump({"windowMinSimilarity": thr, "calibrationSingleP1": float(np.percentile(cal_s,1)), "heldoutFalseReject": float(np.mean(h_s<thr)), "heldoutCaught": float(np.mean(h_m<thr))}, open(HERE / "quality-calibration.json", "w"), indent=1)
