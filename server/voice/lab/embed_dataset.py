#!/usr/bin/env python3
"""Embed every file of the synthetic dataset with the chosen model and save lab/embeddings-<model>.npz.
Usage: voice/.venv/bin/python lab/embed_dataset.py ecapa      |   diarization/.venv/bin/python lab/embed_dataset.py wespeaker
"""
import json
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
model = sys.argv[1]
manifest = json.loads((DATA / "manifest.json").read_text())


def read(path):
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


if model == "ecapa":
    sys.path.insert(0, str(HERE.parent))
    import embed
    clf = embed.load_classifier()
    def emb(samples):
        return embed.embed_samples(clf, samples)
else:
    import sherpa_onnx
    cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(HERE.parent.parent / "diarization/models/wespeaker_en_voxceleb_resnet34_LM.onnx"), num_threads=2)
    ext = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
    def emb(samples):
        stream = ext.create_stream()
        stream.accept_waveform(sample_rate=16000, waveform=samples)
        stream.input_finished()
        v = np.array(ext.compute(stream), dtype=np.float32)
        return v / np.linalg.norm(v)

keys, vectors, t0 = [], [], time.time()
for vid, entry in manifest["voices"].items():
    for item in entry["enroll"] + entry.get("enrollAug", []) + entry["tests"]:
        v = emb(read(DATA / item["file"]))
        keys.append(item["file"])
        vectors.append(v)
print(f"{model}: {len(keys)} files embedded in {time.time() - t0:.1f}s ({(time.time() - t0) / len(keys) * 1000:.0f} ms per file)")
np.savez(HERE / f"embeddings-{model}.npz", keys=np.array(keys), vectors=np.stack(vectors))
