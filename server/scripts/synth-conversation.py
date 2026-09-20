#!/usr/bin/env python3
"""Synthesize a SYNTHETIC conversation (macOS `say` voices + FFmpeg) from a JSON spec, with ground truth.

Usage: synth-conversation.py spec.json
Spec: {
  "out": "path/without/extension",          # writes <out>.wav and <out>.truth.json
  "leadMs": 300, "tailMs": 400,
  "turns": [ {"speaker": "D", "voice": "Daniel", "text": "...", "gapMs": 600, "overlapMs": 0, "rate": 175}, ... ],
  "augment": { "noiseDb": -20, "bandpass": [300, 3400], "opusKbps": 24 }   # optional, applied to the mix
}
Speaker letters are the ground-truth identities. Never uses real patient audio. macOS only.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

RATE = 16000


def run(*args):
    subprocess.run(args, check=True, capture_output=True)


def speak(text, voice, rate, path):
    with tempfile.TemporaryDirectory() as tmp:
        aiff = Path(tmp) / "t.aiff"
        cmd = ["say", "-v", voice, "-o", str(aiff)]
        if rate:
            cmd += ["-r", str(rate)]
        run(*cmd, text)
        run("ffmpeg", "-y", "-v", "error", "-i", str(aiff), "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(path))


def duration_ms(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], check=True, capture_output=True, text=True).stdout
    return round(float(out) * 1000)


def main():
    spec = json.loads(Path(sys.argv[1]).read_text())
    out = Path(spec["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    cursor = spec.get("leadMs", 300)
    placed = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for i, turn in enumerate(spec["turns"]):
            clip = tmp / f"{i}.wav"
            speak(turn["text"], turn["voice"], turn.get("rate"), clip)
            length = duration_ms(clip)
            start = max(0, cursor + turn.get("gapMs", 600) - turn.get("overlapMs", 0))
            placed.append({"speaker": turn["speaker"], "voice": turn["voice"], "text": turn["text"], "startMs": start, "endMs": start + length, "clip": clip})
            cursor = start + length
        total = cursor + spec.get("tailMs", 400)

        cmd = ["ffmpeg", "-y", "-v", "error"]
        for p in placed:
            cmd += ["-i", str(p["clip"])]
        filters = [f"[{i}:a]adelay={p['startMs']}|{p['startMs']}[a{i}]" for i, p in enumerate(placed)]
        mix = "".join(f"[a{i}]" for i in range(len(placed)))
        chain = f"{mix}amix=inputs={len(placed)}:normalize=0:duration=longest,apad=whole_dur={total / 1000}"
        aug = spec.get("augment") or {}
        if aug.get("bandpass"):
            lo, hi = aug["bandpass"]
            chain += f",highpass=f={lo},lowpass=f={hi}"
        if aug.get("noiseDb") is not None:
            # add pink-ish noise at the given level relative to full scale
            cmd += ["-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude=1:r={RATE}"]
            noise_idx = len(placed)
            filters.append(f"[{noise_idx}:a]volume={aug['noiseDb']}dB[nz]")
            filters.append(f"{chain}[speech];[speech][nz]amix=inputs=2:normalize=0:duration=first[out]")
        else:
            filters.append(f"{chain}[out]")
        wav = out.with_suffix(".wav")
        run(*cmd, "-filter_complex", ";".join(filters), "-map", "[out]", "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(wav))
        if aug.get("opusKbps"):
            # simulate a browser MediaRecorder round trip (lossy) and come back to WAV for scoring/upload
            webm = out.with_suffix(".webm")
            run("ffmpeg", "-y", "-v", "error", "-i", str(wav), "-c:a", "libopus", "-b:a", f"{aug['opusKbps']}k", str(webm))

    truth = [{k: v for k, v in p.items() if k != "clip"} for p in placed]
    out.with_suffix(".truth.json").write_text(json.dumps({"durationMs": total, "turns": truth}, indent=1) + "\n")
    print(f"{out.name}: {total / 1000:.1f}s, {len(truth)} turns")


if __name__ == "__main__":
    main()
