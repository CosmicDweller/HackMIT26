#!/usr/bin/env python3
"""Generate SYNTHETIC test conversations with macOS text-to-speech (`say`) and FFmpeg.

Never uses real patient audio. Output goes to tests/fixtures/synthetic/:
  two-speaker.wav      Speaker A -> B -> A -> B ..., including very short replies
  single-speaker.wav   only speaker A's turns
  overlap.wav          like two-speaker but B starts talking before A finishes
  *.truth.json         ground-truth turns [{speaker, startMs, endMs, text}]

macOS only (needs `say`); the generated files are committed so other platforms don't need it.
"""
import json
import subprocess
import tempfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "synthetic"
VOICES = {"A": "Daniel", "B": "Samantha", "C": "Fred"}  # A: British male, B: US female, C: US robotic male (clearly distinct)
RATE = 16000

# (speaker, text, gap_before_ms)
CONSULT = [
    ("A", "Good morning. What brings you in today?", 300),
    ("B", "I have had a headache for three days.", 700),
    ("A", "Are you eating regularly?", 600),
    ("B", "I eat two meals per day.", 700),
    ("A", "Any fever?", 500),
    ("B", "No.", 500),
    ("A", "Thank you. I will order a blood test.", 600),
    ("B", "Okay, thank you doctor.", 600),
]


def run(*args):
    subprocess.run(args, check=True, capture_output=True)


def speak(text, voice, path):
    with tempfile.TemporaryDirectory() as tmp:
        aiff = Path(tmp) / "t.aiff"
        run("say", "-v", voice, "-o", str(aiff), text)
        run("ffmpeg", "-y", "-v", "error", "-i", str(aiff), "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(path))


def duration_ms(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    return round(float(out) * 1000)


def build(name, turns, overlap_ms=0):
    """Place each turn on a timeline and mix. overlap_ms > 0 makes speaker B start early."""
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        placed, cursor = [], 0
        for i, (speaker, text, gap) in enumerate(turns):
            clip = tmp / f"{i}.wav"
            speak(text, VOICES[speaker], clip)
            length = duration_ms(clip)
            start = max(0, cursor + gap - (overlap_ms if speaker == "B" and overlap_ms else 0))
            placed.append({"speaker": speaker, "text": text, "startMs": start, "endMs": start + length, "clip": clip})
            cursor = start + length
        total = cursor + 400

        cmd = ["ffmpeg", "-y", "-v", "error"]
        for p in placed:
            cmd += ["-i", str(p["clip"])]
        filters = [f"[{i}:a]adelay={p['startMs']}|{p['startMs']}[a{i}]" for i, p in enumerate(placed)]
        mix = "".join(f"[a{i}]" for i in range(len(placed)))
        filters.append(f"{mix}amix=inputs={len(placed)}:normalize=0:duration=longest,apad=whole_dur={total / 1000}[out]")
        cmd += ["-filter_complex", ";".join(filters), "-map", "[out]", "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(OUT / f"{name}.wav")]
        run(*cmd)

    truth = [{k: v for k, v in p.items() if k != "clip"} for p in placed]
    (OUT / f"{name}.truth.json").write_text(json.dumps({"voices": VOICES, "durationMs": total, "turns": truth}, indent=2) + "\n")
    print(f"{name}: {total / 1000:.1f}s, {len(truth)} turns")


ABA = [
    ("A", "Are you eating regularly?", 300),
    ("B", "I eat two meals per day.", 700),
    ("A", "Have you noticed any weight changes?", 700),
]

THREE = [
    ("A", "Good morning. Thank you both for coming in.", 300),
    ("B", "Good morning doctor. I have been very tired lately.", 700),
    ("C", "She has not been sleeping well either.", 600),
    ("A", "How many hours do you sleep each night?", 700),
    ("B", "Maybe four or five hours.", 600),
    ("C", "And she wakes up coughing.", 500),
    ("A", "I will order a sleep study.", 600),
]

# Synthetic medical vocabulary (no real patient data). Numbers are spoken as words.
MEDICAL = [
    ("A", "Good morning. How long have you had the shortness of breath?", 300),
    ("B", "About two weeks, and I feel dizzy when I stand up.", 700),
    ("A", "Are you still taking metformin five hundred milligrams twice daily?", 700),
    ("B", "Yes, and lisinopril ten milligrams once daily.", 700),
    ("A", "Your hemoglobin A1c was seven point two percent. I will increase the atorvastatin to forty milligrams.", 700),
    ("B", "Should I be worried about the chest pain?", 700),
    ("A", "Any chest pain with exertion needs an electrocardiogram today.", 700),
]

SETS = {
    "two-speaker": lambda: build("two-speaker", CONSULT),
    "single-speaker": lambda: build("single-speaker", [t for t in CONSULT if t[0] == "A"]),
    "overlap": lambda: build("overlap", CONSULT, overlap_ms=900),
    "aba": lambda: build("aba", ABA),
    "three-speaker": lambda: build("three-speaker", THREE),
    "medical": lambda: build("medical", MEDICAL),
}

if __name__ == "__main__":
    import sys
    for name in sys.argv[1:] or list(SETS):
        SETS[name]()
