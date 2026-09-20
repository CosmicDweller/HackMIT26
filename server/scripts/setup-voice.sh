#!/bin/sh
# Sets up local doctor voice recognition: a Python 3.12 virtualenv with pinned torch + speechbrain, and the pretrained
# ECAPA-TDNN model (speechbrain/spkrec-ecapa-voxceleb, Apache-2.0, about 85 MB). Everything runs locally; nothing is sent anywhere.
# Needs `uv` (https://docs.astral.sh/uv/). The environment (about 500 MB) and the model are git-ignored.
set -eu
DIR="$(cd "$(dirname "$0")/../voice" && pwd)"
if [ ! -x "$DIR/.venv/bin/python" ]; then
  uv venv --python 3.12 "$DIR/.venv"
fi
uv pip install --python "$DIR/.venv/bin/python" -r "$DIR/requirements.txt"
mkdir -p "$DIR/models"
"$DIR/.venv/bin/python" - <<PY
import sys, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, "$DIR")
import embed
embed.load_classifier()   # downloads the model on first use
print("Voice model ready.")
PY
echo "Voice recognition ready. Set VOICE_PROFILE_KEY in server/.env (openssl rand -base64 32) and run: npm run doctor"
