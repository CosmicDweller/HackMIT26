#!/usr/bin/env python3
"""Build the SYNTHETIC voice-identification dataset (macOS `say` voices + FFmpeg). No real people, no patient data.

Identities are split into two DISJOINT sets so thresholds are calibrated on one and judged on the other:
  calibration: used to choose the decision thresholds and the profile representation
  heldout:     used only for the final evaluation
Voices that share a name (for example "Reed (UK)" and "Reed (US)") are separate synthetic identities with a very
similar timbre: they are the hard "similar-sounding voices" cases.

Per identity: 3 enrollment samples (~12-16 s each, different texts) and 8 test utterances, each rendered in three
conditions: clean, "mic" (band-limited, lossy Opus, light noise: a different microphone) and "noisy" (pink noise).
Output: lab/data/<voice-id>/{enroll_0..2.wav, test_<i>_<condition>.wav} and lab/data/manifest.json.

Usage: python3 lab/make_dataset.py
"""
import json
import subprocess
import tempfile
from pathlib import Path

OUT = Path(__file__).resolve().parent / "data"
RATE = 16000

VOICES = {  # id: (say voice, set)
    "samantha": ("Samantha", "calibration"), "karen": ("Karen", "calibration"), "moira": ("Moira", "calibration"),
    "tessa": ("Tessa", "calibration"), "daniel": ("Daniel", "calibration"), "aman": ("Aman", "calibration"),
    "rishi": ("Rishi", "calibration"),
    "eddy_uk": ("Eddy (English (UK))", "calibration"), "eddy_us": ("Eddy (English (US))", "calibration"),
    "flo_uk": ("Flo (English (UK))", "calibration"), "flo_us": ("Flo (English (US))", "calibration"),
    "tara": ("Tara", "heldout"), "kathy": ("Kathy", "heldout"), "ralph": ("Ralph", "heldout"), "albert": ("Albert", "heldout"),
    "grandma_uk": ("Grandma (English (UK))", "heldout"), "grandma_us": ("Grandma (English (US))", "heldout"),
    "grandpa_uk": ("Grandpa (English (UK))", "heldout"), "grandpa_us": ("Grandpa (English (US))", "heldout"),
    "reed_uk": ("Reed (English (UK))", "heldout"), "reed_us": ("Reed (English (US))", "heldout"),
    "rocko_uk": ("Rocko (English (UK))", "heldout"), "rocko_us": ("Rocko (English (US))", "heldout"),
    "sandy_uk": ("Sandy (English (UK))", "heldout"), "sandy_us": ("Sandy (English (US))", "heldout"),
    "shelley_uk": ("Shelley (English (UK))", "heldout"), "shelley_us": ("Shelley (English (US))", "heldout"),
}
SIMILAR = [("eddy_uk", "eddy_us"), ("flo_uk", "flo_us"), ("grandma_uk", "grandma_us"), ("grandpa_uk", "grandpa_us"),
           ("reed_uk", "reed_us"), ("rocko_uk", "rocko_us"), ("sandy_uk", "sandy_us"), ("shelley_uk", "shelley_us"), ("aman", "rishi")]

ENROLL_TEXTS = [
    "Good morning, my name is not important today. I would like to explain how the visit will work. First we will talk about your symptoms, then I will examine you, and afterwards we will decide on any tests together.",
    "Please tell me when the pain started and whether anything makes it better or worse. It is helpful to describe how often it happens, how long each episode lasts, and whether it wakes you at night.",
    "I will review your medication list next. Some drugs interact with each other, so it is important that I know everything you take, including vitamins, herbal products, and anything you buy without a prescription.",
]
TEST_TEXTS = [
    "Are you eating regularly and drinking enough water?",
    "I have had a dull headache for about three days now.",
    "Have you noticed any changes in your weight recently?",
    "The blood pressure reading today is a little higher than last time.",
    "Let me listen to your chest while you take a deep breath.",
    "I think we should schedule a follow up visit in two weeks.",
    "Yes, that sounds fine to me, thank you very much.",
    "Any allergies to medication that I should be aware of?",
]
RATES = [150, 175, 200, 165, 185, 155, 195, 175]  # varied speaking rate per test utterance


def run(*args):
    subprocess.run(args, check=True, capture_output=True)


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], check=True, capture_output=True, text=True).stdout
    return float(out)


def synth(text, voice, rate, dest):
    with tempfile.TemporaryDirectory() as tmp:
        aiff = Path(tmp) / "t.aiff"
        run("say", "-v", voice, "-r", str(rate), "-o", str(aiff), text)
        run("ffmpeg", "-y", "-v", "error", "-i", str(aiff), "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(dest))


def condition(src, dest, kind):
    if kind == "clean":
        run("ffmpeg", "-y", "-v", "error", "-i", str(src), "-c:a", "pcm_s16le", str(dest))
        return
    d = duration(src)
    if kind == "mic":  # a different microphone: band-limited, lossy, light noise
        chain = "highpass=f=250,lowpass=f=3800[s];[1:a]volume=-38dB[n];[s][n]amix=inputs=2:normalize=0:duration=first"
        with tempfile.TemporaryDirectory() as tmp:
            mixed = Path(tmp) / "m.wav"
            run("ffmpeg", "-y", "-v", "error", "-i", str(src), "-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude=1:r={RATE}:d={d + 1}", "-filter_complex", f"[0:a]{chain}", "-ac", "1", "-ar", str(RATE), str(mixed))
            opus = Path(tmp) / "m.opus"
            run("ffmpeg", "-y", "-v", "error", "-i", str(mixed), "-c:a", "libopus", "-b:a", "24k", str(opus))
            run("ffmpeg", "-y", "-v", "error", "-i", str(opus), "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(dest))
    elif kind == "noisy":
        chain = "[0:a][1:a]amix=inputs=2:normalize=0:duration=first"
        run("ffmpeg", "-y", "-v", "error", "-i", str(src), "-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude=1:r={RATE}:d={d + 1},volume=-22dB", "-filter_complex", chain, "-ac", "1", "-ar", str(RATE), "-c:a", "pcm_s16le", str(dest))


def main():
    manifest = {"voices": {}, "similar": SIMILAR, "conditions": ["clean", "mic", "noisy"]}
    for vid, (voice, split) in VOICES.items():
        folder = OUT / vid
        folder.mkdir(parents=True, exist_ok=True)
        entry = {"voice": voice, "set": split, "enroll": [], "tests": []}
        for i, text in enumerate(ENROLL_TEXTS):
            path = folder / f"enroll_{i}.wav"
            synth(text, voice, 175, path)
            entry["enroll"].append({"file": str(path.relative_to(OUT)), "seconds": round(duration(path), 2)})
        for i, text in enumerate(TEST_TEXTS):
            base = folder / f"test_{i}_base.wav"
            synth(text, voice, RATES[i], base)
            for kind in manifest["conditions"]:
                path = folder / f"test_{i}_{kind}.wav"
                condition(base, path, kind)
                entry["tests"].append({"file": str(path.relative_to(OUT)), "text": i, "condition": kind, "seconds": round(duration(path), 2)})
            base.unlink()
        manifest["voices"][vid] = entry
        print(f"{vid}: {len(entry['enroll'])} enrollment, {len(entry['tests'])} test files")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")


if __name__ == "__main__":
    main()
