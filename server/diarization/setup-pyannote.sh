#!/bin/sh
# Reproducible setup for pyannote/speaker-diarization-community-1 (local speaker diarization). Safe to run more than once.
#
#   npm run setup:pyannote                 (from server/)
#
# It: checks the machine, finds Python 3.12 and FFmpeg, creates an isolated virtualenv (server/.venv-diarization), installs the pinned
# dependencies, verifies imports, `pip check` and TorchCodec, checks Hugging Face access (never printing a token), downloads and loads
# the gated model, and runs a model-readiness check. It never uses sudo, never touches the system Python or the Node dependencies,
# and never writes credentials anywhere.
#
# Exit codes: 0 ready | 1 a step failed | 3 everything is installed but the account still needs to accept the model's conditions / log in.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
server=$(dirname "$here")
venv="${PYANNOTE_VENV:-$server/.venv-diarization}"
requirements="$here/pyannote-requirements.txt"
step() { printf '\n== %s\n' "$1"; }
ok() { printf '   ok: %s\n' "$1"; }
die() { printf '   FAILED: %s\n' "$1" >&2; exit 1; }

step "1. Machine"
os=$(uname -s); arch=$(uname -m)
printf '   %s %s' "$os" "$arch"; [ "$os" = Darwin ] && printf ' (macOS %s)' "$(sw_vers -productVersion)"; printf '\n'
[ "$os" = Darwin ] || [ "$os" = Linux ] || die "unsupported operating system $os"
if [ "$os" = Darwin ]; then
  ram=$(( $(sysctl -n hw.memsize) / 1073741824 )); printf '   %s GB RAM, ' "$ram"; df -h "$server" | awk 'NR==2 {print $4 " free disk"}'
  [ "$ram" -ge 8 ] || printf '   warning: under 8 GB of RAM; long recordings may not fit\n'
fi

step "2. Python 3.12"
find_python() {
  if command -v python3.12 >/dev/null 2>&1; then command -v python3.12; return 0; fi
  if command -v brew >/dev/null 2>&1; then
    prefix=$(brew --prefix python@3.12 2>/dev/null || true)
    if [ -n "$prefix" ] && [ -x "$prefix/bin/python3.12" ]; then echo "$prefix/bin/python3.12"; return 0; fi
  fi
  if command -v uv >/dev/null 2>&1; then
    found=$(uv python find 3.12 2>/dev/null || true)
    if [ -n "$found" ] && [ -x "$found" ]; then echo "$found"; return 0; fi
  fi
  return 1
}
if [ -x "$venv/bin/python" ] && "$venv/bin/python" -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)'; then
  py="$venv/bin/python"; ok "reusing the existing environment ($("$py" --version 2>&1))"
else
  [ -x "$venv/bin/python" ] && die "$venv exists but is not Python 3.12. Remove it (rm -rf) and re-run; it holds only downloaded packages."
  base=$(find_python) || die "Python 3.12 not found. Install it (macOS: 'brew install python@3.12', or 'uv python install 3.12') and re-run."
  ok "$("$base" --version 2>&1) at $base"
fi

step "3. FFmpeg"
command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg not found (macOS: 'brew install ffmpeg')"
ok "$(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f1-3)"

step "4. Isolated virtual environment ($venv)"
if [ ! -x "$venv/bin/python" ]; then
  "$base" -m venv "$venv" || die "could not create the virtual environment"
  ok "created"
else
  ok "exists"
fi
py="$venv/bin/python"

step "5. Python dependencies"
"$py" -m pip install --quiet --upgrade pip || die "pip upgrade failed"
"$py" -m pip install --quiet -r "$requirements" || die "dependency installation failed (see the error above; see diarization/README.md, Troubleshooting)"
ok "installed from $(basename "$requirements")"

step "6. Verify imports and dependency consistency"
"$py" -c "import torch; from pyannote.audio import Pipeline; print('   ok: torch', torch.__version__, '| pyannote.audio import')" || die "pyannote.audio does not import"
"$py" -m pip check >/dev/null || { "$py" -m pip check; die "pip check found conflicting dependencies"; }
ok "pip check: no broken requirements"

step "7. TorchCodec with the system FFmpeg"
lib=""
for candidate in "$(brew --prefix 2>/dev/null || true)/lib" /opt/homebrew/lib /usr/local/lib; do
  [ -f "$candidate/libavutil.dylib" ] || [ -f "$candidate/libavutil.so" ] && { lib="$candidate"; break; }
done
if DYLD_FALLBACK_LIBRARY_PATH="${lib}:${DYLD_FALLBACK_LIBRARY_PATH:-}" "$py" -c "import torchcodec; from torchcodec.decoders import AudioDecoder" 2>/dev/null; then
  ok "TorchCodec loads FFmpeg's libraries (via DYLD_FALLBACK_LIBRARY_PATH=$lib; the worker sets this itself)"
else
  printf '   note: TorchCodec could not load FFmpeg libraries. The worker does not need them (it reads the WAV itself), so this is not fatal.\n'
fi

step "8. Hugging Face access (token is never printed)"
if "$venv/bin/hf" auth whoami >/dev/null 2>&1; then
  ok "logged in as $("$venv/bin/hf" auth whoami 2>/dev/null | sed 's/^user=//' | head -1)"
else
  printf '   not logged in.\n'
fi

step "9. Load / download the model (pyannote/speaker-diarization-community-1) and check readiness"
out=$(mktemp "${TMPDIR:-/tmp}/pyannote-check.XXXXXX")
trap 'rm -f "$out"' EXIT
if "$py" "$here/pyannote_diarize.py" --check --output "$out" >/dev/null 2>"$out.err"; then
  ok "model loaded from the local cache: $(cat "$out" | "$py" -c 'import json,sys; d=json.load(sys.stdin); print("load", d["loadTimeMs"], "ms on", d["device"], "| pyannote.audio", d["versions"]["pyannote.audio"])')"
  rm -f "$out.err"
  printf '\nReady. Run the smoke test:  %s %s/pyannote_smoke_test.py\n' "$py" "$here"
  exit 0
fi
code=$("$py" -c 'import json,sys; print(json.load(open(sys.argv[1])).get("error","UNKNOWN"))' "$out" 2>/dev/null || echo UNKNOWN)
rm -f "$out.err"
case "$code" in
  MODEL_ACCESS_DENIED)
    cat <<MSG

   The dependencies are installed, but Hugging Face refuses the model files. The model is gated. Two account steps (only you can do them):
     1. Open https://huggingface.co/pyannote/speaker-diarization-community-1 and accept the access conditions ("Agree and access repository").
     2. Log in:   $venv/bin/hf auth login      (choose "Log in with your browser"; the token stays in Hugging Face's own cache, never in this repo)
   Then re-run this script: it continues from here and downloads the model.
MSG
    exit 3 ;;
  *) die "the model could not be loaded (worker error: $code)" ;;
esac
