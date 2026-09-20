#!/usr/bin/env python3
"""Standalone smoke test of the pyannote Community-1 worker on REAL audio with ground truth (no Node, no Deepgram).

  .venv-diarization/bin/python diarization/pyannote_smoke_test.py [--audio a.wav --truth a.truth.json]

Default input: tests/fixtures/synthetic/aba.wav, a synthetic (text-to-speech) two-voice conversation:
    A: "Are you eating regularly?"   B: "I eat two meals per day."   A: "Have you noticed any weight changes?"
Passing means, for BOTH runs (num_speakers=2 and automatic speaker detection):
  * the worker exited cleanly and wrote valid JSON with regular AND exclusive diarization, in integer milliseconds;
  * exclusive turns never overlap and lie inside the recording;
  * the speakers found match the ground truth: A -> B -> A, i.e. the first and third turn are the SAME speaker and the middle turn
    is a DIFFERENT one (judged by which speaker covers most of each true turn, not merely by the speaker count).
It prints what it measured and exits 0 only if everything held.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent


def run_worker(audio, num_speakers):
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "result.json")
        cmd = [sys.executable, str(HERE / "pyannote_diarize.py"), "--input", audio, "--output", out]
        if num_speakers:
            cmd += ["--num-speakers", str(num_speakers)]
        started = __import__("time").time()
        proc = subprocess.run(cmd, capture_output=True, text=True)
        wall = __import__("time").time() - started
        if proc.returncode != 0:
            detail = ""
            try:
                detail = json.load(open(out)).get("error", "")
            except Exception:  # noqa: BLE001
                pass
            return None, f"worker failed (exit {proc.returncode}, {detail or 'no error file'}): {proc.stderr.strip()[-400:]}", wall
        return json.load(open(out)), None, wall


def overlap(a0, a1, b0, b1):
    return max(0, min(a1, b1) - max(a0, b0))


def covering_speaker(exclusive, start, end):
    per = defaultdict(int)
    for row in exclusive:
        per[row["speaker"]] += overlap(start, end, row["startMs"], row["endMs"])
    return max(per.items(), key=lambda kv: kv[1])[0] if per and max(per.values()) > 0 else None


def check(result, truth, label):
    problems = []
    for key in ("regular", "exclusive"):
        rows = result.get(key)
        if not isinstance(rows, list) or not rows:
            problems.append(f"{key} diarization is missing or empty")
            continue
        for row in rows:
            if not (isinstance(row["startMs"], int) and isinstance(row["endMs"], int) and row["endMs"] > row["startMs"] >= 0):
                problems.append(f"{key}: bad interval {row}")
                break
    excl = result.get("exclusive", [])
    for a, b in zip(excl, excl[1:]):
        if b["startMs"] < a["endMs"] - 1:
            problems.append("exclusive turns overlap")
            break
    if excl and excl[-1]["endMs"] > result["audioDurationMs"] + 1500:
        problems.append("intervals run past the end of the audio")

    turns = truth["turns"]
    who = [covering_speaker(excl, t["startMs"], t["endMs"]) for t in turns]
    by_true = defaultdict(set)
    for t, w in zip(turns, who):
        by_true[t["speaker"]].add(w)
    if None in who:
        problems.append(f"a true turn has no speaker at all: {who}")
    for true, found in by_true.items():
        if len(found) != 1:
            problems.append(f"true speaker {true} was split across {sorted(map(str, found))} (returning speaker not kept)")
    distinct = {next(iter(f)) for f in by_true.values() if len(f) == 1}
    if len(distinct) != len(by_true):
        problems.append(f"{len(by_true)} true speakers were merged into {len(distinct)}")
    print(f"  {label}: speakerCount={result['speakerCount']}  turn->speaker: {[f'{t['speaker']}:{w}' for t, w in zip(turns, who)]}  "
          f"regular={len(result['regular'])} exclusive={len(excl)}")
    return problems


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", default=str(SERVER / "tests/fixtures/synthetic/aba.wav"))
    parser.add_argument("--truth", default=None)
    args = parser.parse_args()
    truth_path = args.truth or str(Path(args.audio).with_suffix("")) + ".truth.json"
    truth = json.load(open(truth_path))
    print(f"audio: {args.audio}\ntruth: {[(t['speaker'], t['startMs'], t['endMs']) for t in truth['turns']]}")

    failures = []
    for label, n in (("num_speakers=2", 2), ("automatic  ", None)):
        result, error, wall = run_worker(args.audio, n)
        if error:
            failures.append(f"{label.strip()}: {error}")
            continue
        print(f"  {label}: model {result['loadTimeMs']} ms + inference {result['inferenceTimeMs']} ms (wall {wall:.1f} s), device {result['device']}")
        failures += [f"{label.strip()}: {p}" for p in check(result, truth, label)]
    if failures:
        print("\nFAILED:\n - " + "\n - ".join(failures))
        sys.exit(1)
    print("\nOK: real audio, valid regular + exclusive diarization, A -> B -> A recovered with a stable speaker for the returning voice.")


if __name__ == "__main__":
    main()
