#!/bin/sh
# Downloads a whisper.cpp model into server/models/ (git-ignored).
# Usage: sh scripts/download-model.sh [model-name]   (default: base.en)
set -eu

MODEL="${1:-base.en}"
DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
DEST="$DEST_DIR/ggml-$MODEL.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"

mkdir -p "$DEST_DIR"
if [ -s "$DEST" ]; then
  echo "Model already present: $DEST"
  exit 0
fi

echo "Downloading $MODEL from $URL"
curl -L --fail --progress-bar -o "$DEST.part" "$URL"
mv "$DEST.part" "$DEST"
echo "Saved $DEST"
