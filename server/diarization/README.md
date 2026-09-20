# Speaker diarization

Two local diarizers live here. **Deepgram still does all transcription** (what was said); these say *who spoke when*.

| | Folder files | Purpose |
| --- | --- | --- |
| **pyannote Community-1** (this document) | `pyannote_diarize.py`, `pyannote_smoke_test.py`, `setup-pyannote.sh`, `pyannote-requirements.txt` | Primary speaker diarization for Deepgram transcripts. Isolated venv `server/.venv-diarization` (Python 3.12). |
| sherpa-onnx (older) | `diarize.py`, `requirements.txt`, `models/` | The `STT_ENGINE=local` (whisper.cpp) engine, and segmentation for the older independent check. Venv `server/diarization/.venv`. |

```
Consultation audio -> Deepgram Nova-3 Medical -> words + timestamps ----+
                  \-> pyannote Community-1   -> speaker turns ---------+-> timestamp alignment -> speaker-labelled words
                                                                              -> doctor voice matching (ECAPA, unchanged) -> stored transcript
```

## Setup (macOS, tested on Apple Silicon, macOS 26, FFmpeg 9.0.2, Python 3.12)

```bash
cd server
npm run setup:pyannote        # = sh diarization/setup-pyannote.sh
```

The script is safe to re-run. It checks the machine, finds Python 3.12 (`python3.12` on PATH, Homebrew's `python@3.12`, or `uv python find 3.12`),
checks FFmpeg, creates `server/.venv-diarization`, installs the pinned `pyannote-requirements.txt`, verifies imports, `pip check` and TorchCodec, checks Hugging Face
access (without printing a token), downloads/loads the model and runs a readiness check. It never uses `sudo` and never touches the system Python, Node packages or any
credential file. Exit code `0` = ready, `3` = installed but the account still needs to accept the model's conditions, `1` = a step failed.

If Python 3.12 or FFmpeg is missing: `brew install python@3.12 ffmpeg` (or `uv python install 3.12`).

### One-time account step (only you can do this): the model is gated

1. Open <https://huggingface.co/pyannote/speaker-diarization-community-1> while signed in and accept the access conditions ("Agree and access repository").
2. Log in from a terminal: `server/.venv-diarization/bin/hf auth login` and choose **Log in with your browser**. The token is stored in Hugging Face's own cache
   (`~/.cache/huggingface/`), never in this repository, `.env` or Git, and this code never reads, prints or logs it. Do not paste a token into chat, an issue or a commit.

After the first download the model runs from the local cache and the backend sets `HF_HUB_OFFLINE=1` for the worker: no network, no token. Cache location:
`~/.cache/huggingface/hub/models--pyannote--speaker-diarization-community-1` (or `PYANNOTE_MODEL_CACHE`). Verified: a fresh process loads it offline in about 0.4 s.

### Verify

```bash
server/.venv-diarization/bin/python server/diarization/pyannote_smoke_test.py     # real audio, ground truth, both num_speakers=2 and automatic
cd server && npm test                                                             # real-inference tests run when the model is installed
```

## What the worker does

`pyannote_diarize.py --input rec.wav --output result.json [--num-speakers N]` takes a **16 kHz mono 16-bit PCM WAV** (the backend already produces that; anything else is
refused with `BAD_INPUT`, never guessed at) and writes one JSON file:

```json
{ "provider": "pyannote-community-1", "model": "pyannote/speaker-diarization-community-1", "speakerCount": 2, "speakers": ["SPEAKER_00", "SPEAKER_01"],
  "regular":   [{ "startMs": 300, "endMs": 1579, "speaker": "SPEAKER_00" }],
  "exclusive": [{ "startMs": 300, "endMs": 1579, "speaker": "SPEAKER_00" }],
  "audioDurationMs": 6727, "loadTimeMs": 700, "inferenceTimeMs": 250, "processingTimeMs": 950, "device": "cpu", "versions": { "...": "..." } }
```

- **regular** keeps the model's overlaps (two people talking at once); **exclusive** resolves them to one speaker at a time and is what words are aligned to.
- Times are integer milliseconds from the start of the file. Labels (`SPEAKER_00`) are meaningful only inside one recording.
- On failure the exit code is non-zero and the file holds `{"error": CODE}`: `BAD_INPUT`, `DEPENDENCY_MISSING`, `MODEL_ACCESS_DENIED`, `MODEL_MISSING`, `MODEL_FAILED`,
  `DEVICE_UNAVAILABLE`, `OUT_OF_MEMORY`, `INFERENCE_FAILED`, `OUTPUT_SHAPE`. Never a made-up result. Diagnostics go to stderr; stdout is a one-line status.
- The worker loads the WAV itself and passes the waveform to pyannote, so inference does not depend on TorchCodec/FFmpeg libraries.

## Node integration

`services/pyannote.js` starts the worker with an **argument array (no shell)**, only for regular files inside the backend's own work directory (symlinks out of it are
refused), **one at a time** (`PYANNOTE_MAX_CONCURRENT_JOBS`), with a timeout of `max(PYANNOTE_TIMEOUT_MIN_MS, audio length x PYANNOTE_TIMEOUT_FACTOR)` capped by
`PYANNOTE_TIMEOUT_MAX_MS`. It validates the answer (integer milliseconds, sorted, exclusive turns never overlap, nothing past the end of the audio, speakers listed) and removes its
temporary directory on every path. `services/speakerAlignment.js` aligns words; `services/voice/analysis.js` combines everything.

### Alignment (deterministic, timestamp-only)

For every Deepgram word: overlap with each speaker's **exclusive** turns is summed and the best-covered speaker wins (ties: the lower label, so it is reproducible).
- No turn under the word: `speakerId = null`, the word is **kept**, its segment is flagged `needsReview` (a word inside a short gap of at most 0.5 s between two turns of the *same* speaker is bridged).
- The runner-up covers at least 60% as much as the winner: ambiguous, flagged. At least half the word inside simultaneous speech (from the *regular* diarization): flagged, and that word is left out of doctor voice matching.
- Text, punctuation, word order and timestamps are never changed; nothing is dropped or duplicated; the meaning of a word is never consulted; no speaker is ever assumed to be Doctor or Patient.
- Speaker ids `speaker_0, speaker_1, ...` are numbered by first appearance in the whole recording (one clustering over the whole file, so a returning speaker keeps their id).
- Deepgram's original speaker runs and pyannote's turns are stored internally for diagnostics (never returned to a client).

### Configuration (`server/.env`, all optional; see `.env.example`)

`PYANNOTE_ENABLED`, `PYANNOTE_PYTHON`, `PYANNOTE_DEVICE` (`cpu` verified), `PYANNOTE_POLICY` (`always` | `when-merged`), `PYANNOTE_MAX_CONCURRENT_JOBS`,
`PYANNOTE_TIMEOUT_MIN_MS`, `PYANNOTE_TIMEOUT_FACTOR`, `PYANNOTE_TIMEOUT_MAX_MS`, `PYANNOTE_MODEL_CACHE`. (`DIARIZATION_*` configures the older sherpa module.)
No secrets belong here.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `GatedRepoError` / worker error `MODEL_ACCESS_DENIED` | Accept the model conditions on Hugging Face and run `hf auth login` (above). The setup script prints this and exits `3`. |
| `Could not load libtorchcodec ... Library not loaded: @rpath/libavutil.61.dylib` | TorchCodec cannot find FFmpeg's libraries on macOS. The worker re-executes itself with `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` (or `/usr/local/lib`) and reads the WAV itself, so it is not needed for inference. To use TorchCodec yourself: `DYLD_FALLBACK_LIBRARY_PATH="$(brew --prefix)/lib"`. Needs `brew install ffmpeg`. |
| Setup: `Python 3.12 not found` | `brew install python@3.12` or `uv python install 3.12`, re-run. The venv must be 3.12: if `server/.venv-diarization` exists with another version, delete it (it only holds downloaded packages) and re-run. |
| `MODEL_MISSING` while offline | The model was never downloaded on this machine: run the setup script once with network access. |
| `pip check` conflicts | Re-run the setup script (it installs the pinned set). Do not mix this venv with the voice venv (`voice/.venv`, torch 2.8 + speechbrain) or the sherpa venv: they are separate on purpose. |
| Timeouts | Raise `PYANNOTE_TIMEOUT_FACTOR` (CPU inference measured at roughly 0.4 to 0.5 x real time on an M4 Pro; see the benchmark section). |
| Out of memory (`OUT_OF_MEMORY` / `PYANNOTE_CRASHED`) | The worker holds the whole recording as float32 (about 115 MB for 30 minutes) plus the model. Keep `PYANNOTE_MAX_CONCURRENT_JOBS=1`. |

`pyannoteai-sdk` is installed as a dependency of pyannote.audio 4. **It is not used**: this integration runs only the local open-source pipeline and never calls the paid
pyannoteAI cloud API (no API key exists or is read).

## Licence and attribution

- Model: **pyannote/speaker-diarization-community-1**, released under the **Creative Commons Attribution 4.0 (CC-BY-4.0)** licence by pyannoteAI (Hervé Bredin and contributors). Weights are downloaded by each installation from Hugging Face after the account accepts the conditions; they are **not** redistributed in this repository.
- Software: pyannote.audio (MIT), PyTorch (BSD-3-Clause), TorchCodec (BSD-3-Clause), Hugging Face Hub (Apache-2.0).
