#!/usr/bin/env python3
"""Add multi-condition ENROLLMENT variants to the dataset (manifest key "enrollAug").

The degradations here deliberately differ from the ones used to make the TEST conditions in make_dataset.py
(different band limits, bitrates and noise levels), so an improvement cannot come from memorising the test conditions.
"""
import json
import subprocess
import tempfile
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"
manifest = json.loads((DATA / "manifest.json").read_text())


def run(*a):
    subprocess.run(a, check=True, capture_output=True)


def dur(p):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(p)], check=True, capture_output=True, text=True).stdout)


VARIANTS = {
    # lossy, narrower band, light noise (a laptop / phone style microphone)
    "aug_a": lambda src, dst, d, tmp: (
        run("ffmpeg", "-y", "-v", "error", "-i", str(src), "-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude=1:r=16000:d={d + 1}", "-filter_complex", "[0:a]highpass=f=300,lowpass=f=3400[s];[1:a]volume=-33dB[n];[s][n]amix=inputs=2:normalize=0:duration=first", "-ac", "1", "-ar", "16000", str(tmp / "a.wav")),
        run("ffmpeg", "-y", "-v", "error", "-i", str(tmp / "a.wav"), "-c:a", "libopus", "-b:a", "16k", str(tmp / "a.opus")),
        run("ffmpeg", "-y", "-v", "error", "-i", str(tmp / "a.opus"), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst))),
    # noisy room, full bandwidth
    "aug_b": lambda src, dst, d, tmp: run("ffmpeg", "-y", "-v", "error", "-i", str(src), "-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude=1:r=16000:d={d + 1},volume=-27dB", "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0:duration=first", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst)),
}
for vid, entry in manifest["voices"].items():
    entry["enrollAug"] = []
    for i, e in enumerate(entry["enroll"]):
        src = DATA / e["file"]
        d = dur(src)
        for name, fn in VARIANTS.items():
            dst = DATA / vid / f"enroll_{i}_{name}.wav"
            with tempfile.TemporaryDirectory() as tmp:
                fn(src, dst, d, Path(tmp))
            entry["enrollAug"].append({"file": str(dst.relative_to(DATA)), "of": i, "variant": name})
(DATA / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
print("added", sum(len(v["enrollAug"]) for v in manifest["voices"].values()), "augmented enrollment files")
