#!/bin/sh
# Sets up local speaker diarization: a Python virtualenv with sherpa-onnx and two small model
# files (git-ignored). Everything runs locally; audio is never sent anywhere.
# Segmentation: pyannote-segmentation-3.0 (MIT). Embeddings: WeSpeaker ResNet34 (Apache-2.0).
set -eu

DIR="$(cd "$(dirname "$0")/../diarization" && pwd)"
VENV="$DIR/.venv"
MODELS="$DIR/models"
mkdir -p "$MODELS"

if [ ! -x "$VENV/bin/python" ]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv "$VENV"
  else
    python3 -m venv "$VENV"
  fi
fi
if command -v uv >/dev/null 2>&1; then
  uv pip install --python "$VENV/bin/python" -r "$DIR/requirements.txt"
else
  "$VENV/bin/python" -m pip install -r "$DIR/requirements.txt"
fi

BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download"
if [ ! -s "$MODELS/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" ]; then
  echo "Downloading segmentation model"
  curl -L --fail --progress-bar -o "$MODELS/seg.tar.bz2" "$BASE/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
  tar xjf "$MODELS/seg.tar.bz2" -C "$MODELS"
  rm "$MODELS/seg.tar.bz2"
fi
if [ ! -s "$MODELS/wespeaker_en_voxceleb_resnet34_LM.onnx" ]; then
  echo "Downloading speaker embedding model"
  curl -L --fail --progress-bar -o "$MODELS/emb.part" "$BASE/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx"
  mv "$MODELS/emb.part" "$MODELS/wespeaker_en_voxceleb_resnet34_LM.onnx"
fi
echo "Diarization ready. Try: npm run doctor"
