#!/bin/sh
# Downloads the whisper.cpp model and the Silero VAD model into server/models/ (git-ignored).
# Usage: sh scripts/download-model.sh [model-name]   (default: small.en)
set -eu

MODEL="${1:-small.en}"
DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
mkdir -p "$DEST_DIR"

download() {
  name="$1"
  url="$2"
  dest="$DEST_DIR/$name"
  if [ -s "$dest" ]; then
    echo "Already present: $dest"
    return
  fi
  echo "Downloading $name from $url"
  curl -L --fail --progress-bar -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
  echo "Saved $dest"
}

download "ggml-$MODEL.bin" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
# Voice activity detection: prevents phantom text such as "you" on silent recordings.
download "ggml-silero-v5.1.2.bin" "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
