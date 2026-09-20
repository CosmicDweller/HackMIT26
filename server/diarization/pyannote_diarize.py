#!/usr/bin/env python3
"""Speaker diarization with pyannote/speaker-diarization-community-1 ("who spoke when"). Isolated inference worker called from Node.

  pyannote_diarize.py --input recording.wav --output result.json [--num-speakers N] [--min-speakers N] [--max-speakers N]
  pyannote_diarize.py --check            # load the model and report readiness, no audio needed

Input : a 16 kHz mono 16-bit PCM WAV (the backend already normalizes recordings to that). Anything else is rejected, not guessed at.
Output: ONE JSON document, written to --output (stdout only carries a one-line status, all diagnostics go to stderr):

  {"provider": "pyannote-community-1", "model": "pyannote/speaker-diarization-community-1", "speakerCount": 2,
   "speakers": ["SPEAKER_00", "SPEAKER_01"],
   "regular":   [{"startMs": 300, "endMs": 1579, "speaker": "SPEAKER_00"}, ...],   # overlaps preserved
   "exclusive": [{"startMs": 300, "endMs": 1579, "speaker": "SPEAKER_00"}, ...],   # never overlaps: simplest to align words with
   "audioDurationMs": 6727, "loadTimeMs": 2100, "inferenceTimeMs": 3400, "processingTimeMs": 5600, "device": "cpu", "versions": {...}}

Speaker labels are cluster ids that are consistent inside this one recording only. They are not identities and mean nothing across
recordings. On failure the exit code is non-zero and --output holds {"error": "<code>", ...}: never a fabricated result.

Model access: the model is gated on Hugging Face. It is downloaded once (after the account accepted its conditions and logged in with
`hf auth login`) and then runs from the local cache; PYANNOTE_OFFLINE=1 (set by the backend once the cache exists) forbids any network use.
Model licence: CC-BY-4.0 (pyannote.ai / Hervé Bredin et al.). No token is ever read, printed or logged by this file: huggingface_hub finds it.
"""
import argparse
import json
import os
import platform
import sys
import time
import wave
from pathlib import Path

MODEL = "pyannote/speaker-diarization-community-1"
PROVIDER = "pyannote-community-1"
RATE = 16000


def write_result(path, payload):
    if not path:
        print(json.dumps(payload))
        return
    tmp = f"{path}.tmp"
    with open(tmp, "w") as handle:
        json.dump(payload, handle)
    os.replace(tmp, path)


def fail(output, code, detail=""):
    """Explicit error: an error document, a stderr note, a non-zero exit. Never a made-up result."""
    write_result(output, {"error": code})
    print(f"pyannote_diarize error {code}" + (f": {detail}" if detail else ""), file=sys.stderr)
    print(json.dumps({"status": "error", "error": code}))
    sys.exit(2)


def ensure_ffmpeg_libraries():
    """TorchCodec (used by pyannote for decoding when given a file path) needs FFmpeg's dylibs on macOS. dyld reads the fallback path at
    process start, so when it is missing the worker re-executes itself once with it set. Inference below does not rely on it (the
    waveform is loaded here), but pyannote imports TorchCodec and a broken load prints a long warning."""
    if platform.system() != "Darwin" or os.environ.get("_PYANNOTE_REEXEC"):
        return
    for candidate in ("/opt/homebrew/lib", "/usr/local/lib"):
        if Path(candidate, "libavutil.dylib").exists():
            current = os.environ.get("DYLD_FALLBACK_LIBRARY_PATH", "")
            if candidate not in current.split(":"):
                env = dict(os.environ, DYLD_FALLBACK_LIBRARY_PATH=f"{candidate}:{current}" if current else candidate, _PYANNOTE_REEXEC="1")
                os.execve(sys.executable, [sys.executable, *sys.argv], env)
            return


def read_wav(path, output):
    """Load a 16 kHz mono 16-bit PCM WAV as a float32 (1, samples) tensor. Reads the file itself, so it needs no FFmpeg at run time."""
    import numpy as np
    import torch
    try:
        with wave.open(str(path), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != RATE:
                fail(output, "BAD_INPUT", f"expected 16 kHz mono 16-bit PCM, got {wav.getframerate()} Hz, {wav.getnchannels()} ch, {wav.getsampwidth() * 8} bit")
            frames = wav.getnframes()
            raw = wav.readframes(frames)
    except (wave.Error, EOFError, FileNotFoundError) as error:
        fail(output, "BAD_INPUT", str(error))
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if len(samples) == 0:
        fail(output, "BAD_INPUT", "empty audio")
    return torch.from_numpy(samples)[None, :], len(samples) * 1000 // RATE


def load_pipeline(output, device):
    try:
        from pyannote.audio import Pipeline
    except ImportError as error:
        fail(output, "DEPENDENCY_MISSING", str(error))
    started = time.perf_counter()
    try:
        pipeline = Pipeline.from_pretrained(MODEL)
    except Exception as error:  # noqa: BLE001 - classify, never leak a token (huggingface_hub does not put it in messages)
        text = f"{type(error).__name__}: {error}"
        lowered = text.lower()
        if any(key in lowered for key in ("401", "403", "gated", "access to model", "restricted", "not authorized", "token")):
            fail(output, "MODEL_ACCESS_DENIED", "accept the model's conditions on Hugging Face and run `hf auth login` (see diarization/README.md)")
        if any(key in lowered for key in ("offline", "not found in", "couldn't connect", "cannot find", "localentrynotfound", "connection")):
            fail(output, "MODEL_MISSING", text[:300])
        fail(output, "MODEL_FAILED", text[:300])
    if pipeline is None:  # older huggingface_hub versions return None for a gated model instead of raising
        fail(output, "MODEL_ACCESS_DENIED", "the model could not be loaded (gated: accept its conditions and log in)")
    if device != "cpu":
        import torch
        try:
            pipeline.to(torch.device(device))
        except Exception as error:  # noqa: BLE001
            fail(output, "DEVICE_UNAVAILABLE", f"{device}: {error}")
    return pipeline, int((time.perf_counter() - started) * 1000)


def versions():
    import importlib.metadata as md
    out = {"python": platform.python_version()}
    for name in ("pyannote.audio", "pyannote.core", "torch", "torchaudio", "torchcodec", "numpy", "huggingface_hub"):
        try:
            out[name] = md.version(name)
        except md.PackageNotFoundError:
            out[name] = None
    return out


def intervals(annotation):
    """[{startMs, endMs, speaker}] sorted by time. Works with the Annotation API of pyannote.core 5/6 (itertracks)."""
    rows = []
    for segment, _track, label in annotation.itertracks(yield_label=True):
        start, end = round(segment.start * 1000), round(segment.end * 1000)
        if end > start:
            rows.append({"startMs": start, "endMs": end, "speaker": str(label)})
    rows.sort(key=lambda r: (r["startMs"], r["endMs"], r["speaker"]))
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--check", action="store_true", help="only load the model and report readiness")
    parser.add_argument("--num-speakers", type=int, default=None, help="exact speaker count, when known")
    parser.add_argument("--min-speakers", type=int, default=None)
    parser.add_argument("--max-speakers", type=int, default=None)
    parser.add_argument("--device", default=os.environ.get("PYANNOTE_DEVICE", "cpu"), choices=["cpu", "mps", "cuda"])
    parser.add_argument("--threads", type=int, default=int(os.environ.get("PYANNOTE_THREADS", "0")))
    args = parser.parse_args()
    if not args.check and not (args.input and args.output):
        fail(args.output, "BAD_INPUT", "--input and --output are required")
    for value in (args.num_speakers, args.min_speakers, args.max_speakers):
        if value is not None and not 1 <= value <= 20:
            fail(args.output, "BAD_INPUT", "speaker counts must be between 1 and 20")

    started = time.perf_counter()
    try:
        import torch
    except ImportError as error:
        fail(args.output, "DEPENDENCY_MISSING", str(error))
    if args.threads > 0:
        torch.set_num_threads(args.threads)

    waveform = duration_ms = None
    if not args.check:
        waveform, duration_ms = read_wav(args.input, args.output)  # validate the input before paying for the model

    pipeline, load_ms = load_pipeline(args.output, args.device)
    if args.check:
        write_result(args.output, {"provider": PROVIDER, "model": MODEL, "ready": True, "loadTimeMs": load_ms, "device": args.device, "versions": versions()})
        print(json.dumps({"status": "ready", "loadTimeMs": load_ms}))
        return

    options = {k: v for k, v in (("num_speakers", args.num_speakers), ("min_speakers", args.min_speakers), ("max_speakers", args.max_speakers)) if v is not None}
    inferred = time.perf_counter()
    try:
        with torch.no_grad():
            result = pipeline({"waveform": waveform, "sample_rate": RATE}, **options)
    except MemoryError:
        fail(args.output, "OUT_OF_MEMORY")
    except RuntimeError as error:
        fail(args.output, "OUT_OF_MEMORY" if "out of memory" in str(error).lower() else "INFERENCE_FAILED", str(error)[:300])
    except Exception as error:  # noqa: BLE001
        fail(args.output, "INFERENCE_FAILED", f"{type(error).__name__}: {str(error)[:300]}")
    inference_ms = int((time.perf_counter() - inferred) * 1000)

    try:
        regular = intervals(result.speaker_diarization)
        exclusive = intervals(result.exclusive_speaker_diarization)
    except AttributeError as error:
        fail(args.output, "OUTPUT_SHAPE", f"unexpected pipeline output ({error})")
    speakers = sorted({row["speaker"] for row in regular} | {row["speaker"] for row in exclusive})
    write_result(args.output, {
        "provider": PROVIDER, "model": MODEL, "speakerCount": len(speakers), "speakers": speakers,
        "regular": regular, "exclusive": exclusive,
        "audioDurationMs": duration_ms, "loadTimeMs": load_ms, "inferenceTimeMs": inference_ms,
        "processingTimeMs": int((time.perf_counter() - started) * 1000), "device": args.device,
        "requested": {"numSpeakers": args.num_speakers, "minSpeakers": args.min_speakers, "maxSpeakers": args.max_speakers},
        "versions": versions(),
    })
    print(json.dumps({"status": "ok", "speakerCount": len(speakers)}))


if __name__ == "__main__":
    ensure_ffmpeg_libraries()
    main()
