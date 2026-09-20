#!/usr/bin/env python3
"""Regenerate the SYNTHETIC voice test fixtures in tests/fixtures/voice/ (macOS `say` + FFmpeg; committed as FLAC, so other machines don't need it).
Enrollment: 3 samples per voice. Conversations: one per scenario, with ground-truth turns (speaker letters D=doctor, P=patient, N=nurse)."""
import json, subprocess, shutil, sys, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "voice"
LAB = ROOT / "voice" / "lab" / "data"
SYNTH = ROOT / "scripts" / "synth-conversation.py"
V = {"ralph": "Ralph", "kathy": "Kathy", "grandma": "Grandma (English (US))", "albert": "Albert", "reed_uk": "Reed (English (UK))", "reed_us": "Reed (English (US))"}
D = ["Good afternoon, please have a seat and tell me what brings you in today.", "How long have you been feeling this way, and does anything make it better?",
     "I would like to check your blood pressure and listen to your heart now.", "Are you taking any medication regularly, including vitamins or supplements?",
     "That is helpful, thank you. I will order a few tests and we will review them together.", "Please come back in two weeks, or sooner if the symptoms get worse."]
P = ["I have been very tired for about two weeks and I get dizzy when I stand up quickly.", "It comes and goes, mostly in the afternoon, and resting seems to help a little.",
     "I take one tablet for my blood pressure every morning and a vitamin most days.", "No, nothing else, except a glass of wine now and then at the weekend.",
     "Okay, that sounds sensible to me, thank you for explaining everything so clearly.", "Yes, I will book the follow up appointment on my way out."]
N = ["I have taken your weight and temperature, and the results are on the chart.", "Shall I bring in the paperwork for the blood test before you leave today?"]
def turns(seq, voices, gaps=None):
    out = []; count = {"D": 0, "P": 0, "N": 0}
    for i, who in enumerate(seq):
        pool = {"D": D, "P": P, "N": N}[who]
        out.append({"speaker": who, "voice": V[voices[who]], "text": pool[count[who] % len(pool)], "gapMs": (gaps or {}).get(i, 650)}); count[who] += 1
    return out
S = {
 "dpdp": (turns("DPDPDPDP", {"D": "ralph", "P": "kathy"}), None),
 "doctor-absent": (turns("PNPNPNPN", {"P": "kathy", "N": "grandma"}), None),
 "three-speakers": (turns("DPNDPNDP", {"D": "ralph", "P": "kathy", "N": "grandma"}), None),
 "doctor-alone": (turns("DDDDDD", {"D": "ralph"}), None),
 "patient-alone": (turns("PPPPPP", {"P": "kathy"}), None),
 "deepgram-miss": (turns("DPDPDPDP", {"D": "kathy", "P": "albert"}), None),
 "similar-voices": (turns("DPDPDPDP", {"D": "reed_uk", "P": "reed_us"}), None),
 "short-doctor-reply": (turns("PPDPP", {"D": "ralph", "P": "kathy"}), None),
 "long-gap": (turns("DPDPDPDP", {"D": "ralph", "P": "kathy"}, {6: 150000}), None),
 "different-mic": (turns("DPDPDPDP", {"D": "ralph", "P": "kathy"}), {"bandpass": [300, 3400], "noiseDb": -30, "opusKbps": 16}),
}
if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for voice in ("ralph", "kathy", "reed_uk"):
        for i in range(3):
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(LAB / voice / f"enroll_{i}.wav"), "-c:a", "flac", "-compression_level", "8", str(OUT / f"enroll-{voice}-{i}.flac")], check=True)
    for name, (tr, aug) in S.items():
        with tempfile.TemporaryDirectory() as tmp:
            spec = {"out": f"{tmp}/{name}", "turns": tr}
            if aug: spec["augment"] = aug
            Path(f"{tmp}/spec.json").write_text(json.dumps(spec))
            subprocess.run(["python3", str(SYNTH), f"{tmp}/spec.json"], check=True, capture_output=True)
            src = f"{tmp}/{name}.wav"
            if aug and aug.get("opusKbps"):  # the recording as a browser would deliver it: lossy
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", f"{tmp}/{name}.webm", "-ac", "1", "-ar", "16000", f"{tmp}/{name}-lossy.wav"], check=True); src = f"{tmp}/{name}-lossy.wav"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-c:a", "flac", "-compression_level", "8", str(OUT / f"{name}.flac")], check=True)
            shutil.copy(f"{tmp}/{name}.truth.json", OUT / f"{name}.truth.json")
        print(name, round(json.loads((OUT / f"{name}.truth.json").read_text())["durationMs"] / 1000), "s")
