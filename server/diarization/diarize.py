#!/usr/bin/env python3
"""Local speaker diarization: "who spoke when". Isolated inference module called from Node.

Input : a 16 kHz mono 16-bit PCM WAV (the backend already normalizes uploads to this).
Output: one JSON document on stdout (nothing else is printed there):

  {"engine": "sherpa-onnx", "numSpeakers": 2, "durationSeconds": 17.1,
   "segments": [{"speaker": 0, "start": 0.31, "end": 2.71}, ...]}

Speaker numbers are cluster ids that are consistent within this one recording only. They are not
identities and are not comparable across recordings. On failure the exit code is non-zero and
stdout is {"error": "<code>"}; details go to stderr.

Engine: sherpa-onnx running pyannote-segmentation-3.0 (MIT) for speech/speaker-change detection and
a speaker-embedding model (WeSpeaker ResNet34) for clustering. Everything runs locally on CPU.
"""
import argparse
import json
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent


def fail(code, detail=""):
    print(json.dumps({"error": code}))
    if detail:
        print(detail, file=sys.stderr)
    sys.exit(2)


def read_wav(path):
    import numpy as np

    try:
        with wave.open(str(path), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                fail("BAD_INPUT", "expected mono 16-bit PCM")
            rate = wav.getframerate()
            frames = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError) as error:
        fail("BAD_INPUT", str(error))
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, rate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--segmentation-model", default=str(HERE / "models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"))
    parser.add_argument("--embedding-model", default=str(HERE / "models/wespeaker_en_voxceleb_resnet34_LM.onnx"))
    parser.add_argument("--num-speakers", type=int, default=-1, help="-1 = estimate from the audio")
    parser.add_argument("--threshold", type=float, default=0.5, help="clustering threshold when estimating; higher = fewer speakers")
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()

    for model in (args.segmentation_model, args.embedding_model):
        if not Path(model).is_file():
            fail("MODEL_MISSING", f"missing model file: {Path(model).name}")

    try:
        import sherpa_onnx
    except ImportError as error:
        fail("DEPENDENCY_MISSING", str(error))

    samples, rate = read_wav(args.input)
    if len(samples) == 0:
        fail("BAD_INPUT", "empty audio")

    try:
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=args.segmentation_model),
                num_threads=args.threads,
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=args.embedding_model, num_threads=args.threads),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=args.num_speakers, threshold=args.threshold),
            min_duration_on=0.2,
            min_duration_off=0.4,
        )
        if not config.validate():
            fail("MODEL_INVALID", "sherpa-onnx rejected the configuration")
        diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)
        if rate != diarizer.sample_rate:
            fail("BAD_INPUT", f"expected {diarizer.sample_rate} Hz audio, got {rate}")
        result = diarizer.process(samples).sort_by_start_time()
    except SystemExit:
        raise
    except Exception as error:  # model/runtime failure
        fail("DIARIZATION_FAILED", repr(error))

    segments = [{"speaker": int(r.speaker), "start": round(float(r.start), 3), "end": round(float(r.end), 3)} for r in result]
    print(json.dumps({
        "engine": "sherpa-onnx",
        "numSpeakers": len({s["speaker"] for s in segments}),
        "durationSeconds": round(len(samples) / rate, 3),
        "segments": segments,
    }))


if __name__ == "__main__":
    main()
