#!/usr/bin/env python3
"""Build a long SYNTHETIC recording by repeating a synthetic conversation, with exact ground truth.

Usage: make-long-recording.py <conversation> <minutes> <output.wav>
  <conversation>: a name in tests/fixtures/synthetic (for example: medical)

Writes <output.wav> and <output>.truth.json (same format as the fixtures, with every turn offset).
The output is large (WAV, about 1.9 MB per minute) so it is NOT committed: generate it where needed.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

FIX = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "synthetic"
GAP_MS = 1500


def main():
    name, minutes, out = sys.argv[1], float(sys.argv[2]), Path(sys.argv[3])
    base_wav = FIX / f"{name}.wav"
    truth = json.loads((FIX / f"{name}.truth.json").read_text())
    unit_ms = truth["durationMs"] + GAP_MS
    reps = max(1, round(minutes * 60_000 / unit_ms))

    turns = []
    for i in range(reps):
        offset = i * unit_ms
        for t in truth["turns"]:
            turns.append({**t, "startMs": t["startMs"] + offset, "endMs": t["endMs"] + offset})

    with tempfile.TemporaryDirectory() as tmp:
        gap = Path(tmp) / "gap.wav"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", str(GAP_MS / 1000), "-c:a", "pcm_s16le", str(gap)], check=True)
        listing = Path(tmp) / "list.txt"
        listing.write_text("".join(f"file '{base_wav}'\nfile '{gap}'\n" for _ in range(reps)))
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c:a", "pcm_s16le", str(out)], check=True)

    total_ms = reps * unit_ms
    out.with_suffix(".truth.json").write_text(json.dumps({"voices": truth["voices"], "durationMs": total_ms, "turns": turns}, indent=1) + "\n")
    print(f"{out.name}: {total_ms / 60000:.1f} min, {reps} repetitions, {len(turns)} turns")


if __name__ == "__main__":
    main()
