#!/usr/bin/env python3
"""Local speaker embeddings and enrollment-sample quality (SpeechBrain ECAPA-TDNN). Isolated inference module.

One JSON request on stdin, one JSON response on stdout (nothing else is printed there). Commands:

  {"command": "embed", "wav": "/path/16k-mono.wav", "regions": [{"startMs": 0, "endMs": 4200}, ...]}
     -> {"model", "dim", "embeddings": [[192 floats, L2-normalised] | null for a region that is too short]}

  {"command": "quality", "wavs": ["/path/a.wav", ...]}
     -> {"model", "dim", "files": [{"durationMs", "voicedMs", "clipRatio", "peak", "embedding": [...],
                                    "windowMinSimilarity": float | null, "windows": int}]}
     Everything an enrollment needs in one process: usable-speech duration, clipping, and an internal-consistency
     check (embeddings of ~3 s voiced windows: a low minimum pairwise similarity suggests more than one speaker).

Regions are embedded one by one, read lazily from disk (a two-hour file is never loaded whole) and capped in length (a
5-minute input needed 5.5 GB of memory). Input must be 16 kHz mono 16-bit PCM WAV (the backend normalises to that).
Embeddings are biometric data: this module never logs or stores them. Errors go to stderr, exit code 2, and
{"error": "<code>"} on stdout.
"""
import json
import os
import sys
import wave
import warnings

warnings.filterwarnings("ignore")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL_NAME = "speechbrain/spkrec-ecapa-voxceleb"
HERE = os.path.dirname(os.path.abspath(__file__))
SAVEDIR = os.path.join(HERE, "models", "spkrec-ecapa-voxceleb")
MIN_REGION_MS = 1000  # ECAPA needs about a second of speech to be meaningful
MAX_REGION_MS = 30_000  # bounded memory
RATE = 16000


def fail(code, detail=""):
    print(json.dumps({"error": code}))
    if detail:
        print(detail, file=sys.stderr)
    sys.exit(2)


def open_wav(path):
    try:
        w = wave.open(path, "rb")
    except (wave.Error, EOFError, FileNotFoundError) as error:
        fail("BAD_INPUT", str(error))
    if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != RATE:
        fail("BAD_INPUT", "expected 16 kHz mono 16-bit PCM")
    return w


def read_region(w, start_ms, end_ms):
    """Samples of [start_ms, end_ms) as float32, read lazily."""
    import numpy as np
    start = max(0, int(start_ms * RATE / 1000))
    end = min(w.getnframes(), int(end_ms * RATE / 1000))
    if end <= start:
        return np.zeros(0, dtype=np.float32)
    w.setpos(start)
    return np.frombuffer(w.readframes(end - start), dtype=np.int16).astype(np.float32) / 32768.0


def load_classifier():
    """Load the pretrained model once (about 3 s warm, 19 s the first time it is downloaded)."""
    import torch
    torch.set_num_threads(int(os.environ.get("VOICE_THREADS", "4")))
    from speechbrain.inference.speaker import EncoderClassifier
    return EncoderClassifier.from_hparams(source=SAVEDIR, savedir=SAVEDIR, run_opts={"device": "cpu"})


def embed_samples(classifier, chunk):
    """L2-normalised embedding of one array of samples, or None if too short/silent."""
    import numpy as np
    import torch
    if len(chunk) < MIN_REGION_MS * RATE / 1000:
        return None
    with torch.no_grad():
        embedding = classifier.encode_batch(torch.from_numpy(chunk)[None, :]).squeeze().cpu().numpy()
    norm = float(np.linalg.norm(embedding))
    return (embedding / norm).astype("float32") if norm > 0 else None


def embed_regions(classifier, wav_path, regions):
    w = open_wav(wav_path)
    try:
        out = []
        for start, end in regions:
            end = min(end, start + MAX_REGION_MS)
            out.append(embed_samples(classifier, read_region(w, start, end)) if end - start >= MIN_REGION_MS else None)
        return out
    finally:
        w.close()


def voiced_frames(samples, frame=320):
    """Energy VAD: frames whose RMS is well above the file's noise floor. Returns a boolean array per 20 ms frame."""
    import numpy as np
    n = len(samples) // frame
    if n == 0:
        return np.zeros(0, dtype=bool)
    rms = np.sqrt((samples[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
    floor = np.percentile(rms, 10)
    peak = np.percentile(rms, 95)
    threshold = max(floor * 3.0, peak * 0.1, 1e-4)
    return rms > threshold


def quality(classifier, path):
    import numpy as np
    w = open_wav(path)
    try:
        samples = read_region(w, 0, w.getnframes() * 1000 // RATE + 1000)
    finally:
        w.close()
    voiced = voiced_frames(samples)
    duration_ms = int(len(samples) * 1000 / RATE)
    voiced_ms = int(voiced.sum() * 20)
    peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    clip_ratio = float((np.abs(samples) >= 0.99).mean()) if len(samples) else 0.0

    embedding = embed_samples(classifier, samples) if voiced_ms >= MIN_REGION_MS else None

    # Internal consistency: embed voiced ~3 s windows and look at the LOWEST pairwise similarity. One speaker keeps every
    # window similar; a second speaker pulls the minimum down.
    min_sim, windows = None, 0
    if voiced_ms >= 6000:
        win = 150  # frames = 3 s
        idx = np.flatnonzero(voiced)
        vecs = []
        for i in range(0, len(idx) - win, win):
            chunk = np.concatenate([samples[j * 320:(j + 1) * 320] for j in idx[i:i + win]])
            v = embed_samples(classifier, chunk)
            if v is not None:
                vecs.append(v)
        windows = len(vecs)
        if windows >= 2:
            m = np.stack(vecs)
            sims = m @ m.T
            min_sim = float(sims[np.triu_indices(windows, 1)].min())
    return {
        "durationMs": duration_ms, "voicedMs": voiced_ms, "clipRatio": round(clip_ratio, 5), "peak": round(peak, 4),
        "embedding": None if embedding is None else [round(float(x), 6) for x in embedding],
        "windowMinSimilarity": None if min_sim is None else round(min_sim, 4), "windows": windows,
    }


def main():
    request = json.load(sys.stdin)
    try:
        import numpy  # noqa: F401
        import torch  # noqa: F401
        from speechbrain.inference.speaker import EncoderClassifier  # noqa: F401
    except ImportError as error:
        fail("DEPENDENCY_MISSING", str(error))
    if not os.path.isdir(SAVEDIR):
        fail("MODEL_MISSING", "run npm run setup:voice")
    try:
        classifier = load_classifier()
    except Exception as error:  # model/runtime failure
        fail("MODEL_FAILED", repr(error))

    command = request.get("command", "embed")
    if command == "embed":
        regions = [(int(r["startMs"]), int(r["endMs"])) for r in request["regions"]]
        embeddings = embed_regions(classifier, request["wav"], regions)
        print(json.dumps({"model": MODEL_NAME, "dim": 192, "embeddings": [None if e is None else [round(float(x), 6) for x in e] for e in embeddings]}))
    elif command == "quality":
        print(json.dumps({"model": MODEL_NAME, "dim": 192, "files": [quality(classifier, p) for p in request["wavs"]]}))
    else:
        fail("BAD_INPUT", f"unknown command {command}")


if __name__ == "__main__":
    main()
