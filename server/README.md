# Speech-to-Text Server

Express backend that turns a recorded audio clip into text using FFmpeg and
[whisper.cpp](https://github.com/ggml-org/whisper.cpp), and (contract v2) into a **speaker-labelled transcript
saved under a doctor's account**. The API is defined in [`docs/API_CONTRACT.md`](../docs/API_CONTRACT.md).

```
browser recording ─▶ POST /api/transcribe ─▶ FFmpeg (16 kHz mono WAV) ─▶ whisper-cli ─▶ JSON
```

## Requirements

- Node.js 22.9 or newer (developed on 24)
- FFmpeg
- whisper.cpp (`whisper-cli`)
- A whisper.cpp model file (`small.en`, about 488 MB)

## Setup

macOS (Homebrew):

```bash
brew install ffmpeg whisper-cpp
```

Homebrew's `whisper-cpp` formula installs the official whisper.cpp `whisper-cli` binary.
On Linux or Windows, install FFmpeg from your package manager and build whisper.cpp
following its [documentation](https://github.com/ggml-org/whisper.cpp#quick-start)
(`cmake -B build && cmake --build build -j --config Release`, giving
`build/bin/whisper-cli`), then set `WHISPER_BIN` to that path.

Then, from the repository root:

```bash
cd server
npm install
npm run setup:model      # downloads models/ggml-small.en.bin + the VAD model (git-ignored)
```

`setup:model` accepts another model name: `sh scripts/download-model.sh base.en`
(then set `WHISPER_MODEL=models/ggml-base.en.bin`). `base.en` (148 MB) is faster and
lighter but less accurate on accents, noise and medical terms. Model files are never committed.

## Speaker diarization and doctor accounts (contract v2)

```bash
npm run setup:diarization     # Python venv + two small local models (about 30 MB), all git-ignored
```

- **Diarization** (who spoke when) runs locally through `diarization/diarize.py` (sherpa-onnx with
  pyannote-segmentation-3.0, MIT, and WeSpeaker embeddings, Apache-2.0). No audio leaves the machine. It is
  best-effort: if it is not installed or fails, transcripts are still returned with `speakerId: null` and
  `diarization.status` set to `unavailable` or `failed`. Segments are aligned to speakers by timestamp overlap
  (see the contract for the strategy and limitations). Roles (doctor/patient) are assigned by the doctor, never inferred.
- **Accounts** use Supabase Auth. Set `SUPABASE_URL` in `.env`; the backend verifies each Bearer token against the
  project's public signing keys. Transcripts are stored in a local SQLite file (`DB_PATH`, default
  `data/transcripts.sqlite`, git-ignored) scoped to the verified doctor. Requires Node 24+ (`node:sqlite`, which
  prints an "experimental" notice at startup).
- **Speech engine: Deepgram Nova-3 Medical (primary).** Signed-in recordings are transcribed AND diarized by Deepgram in one
  request (`model=nova-3-medical`, `diarize_model=latest` = the batch diarizer, `utterances`, `smart_format`, `language=en`,
  `mip_opt_out=true`). **This sends audio to a third party** (the app runs locally on your Mac; Deepgram is a remote hosted
  API). Set `DEEPGRAM_API_KEY` in `.env` (git-ignored). There is no automatic fallback: a Deepgram failure is a failed job.
  The whisper.cpp + sherpa-onnx engine is a separate optional fallback (`STT_ENGINE=local`; short recordings only), and the
  public `/api/transcribe` always uses it. Whisper text is never mixed with Deepgram speakers. Synthetic data only until a BAA
  and the other approvals in the contract exist.
- **Recordings and jobs.** Every authenticated recording is a persistent job (`POST /api/transcription-jobs`, poll
  `GET /api/transcription-jobs/:id`; `POST /api/transcriptions` is the wait-for-it convenience). Up to 2 hours / 1 GiB,
  written to disk (never held in memory), verified by decoding the whole file, sent to Deepgram as FLAC streamed from disk.
  Recordings over `DEEPGRAM_SYNC_MAX_SECONDS` (default 2 h; a real 2-hour recording finished in 29 s) need a callback URL, which is off by default and needs a public
  endpoint (it cannot reach localhost); without it they are rejected before any audio is sent. Timeouts and restarts never
  trigger an automatic resubmission (you would be billed twice). See the contract for statuses, errors and retention.
- **Evaluating it.** `npm run eval:deepgram` scores the live engine on the synthetic recordings (WER, diarization error rate,
  word-to-speaker accuracy, speaker count) and `npm run check-deepgram` prints exactly what Deepgram reports (model, `diarize_info`).
  Live end-to-end tests run only with `DEEPGRAM_LIVE_TEST=1` (they upload synthetic audio and cost a few cents). Long synthetic
  recordings: `python3 scripts/make-long-recording.py medical 30 tests/.generated/medical-30min.wav` (git-ignored).
- **Checking a real sign-in:** with `SUPABASE_URL` set, sign in through the app, copy the session's access token
  and run `pbpaste | npm run check-token`. It reads the token from stdin, verifies it exactly like the API does and
  prints only the verified identity (never the token). The backend needs no Supabase key: only the public
  project URL. The anon/publishable keys belong in the frontend, not here, and a service-role key must never be used.
- **Synthetic test audio** in `tests/fixtures/synthetic/` is generated from text-to-speech voices by
  `scripts/make-synthetic-conversations.py` (macOS). Never use real patient recordings as fixtures.
- **Not evaluated:** pyannote's `speaker-diarization-community-1` (CC-BY-4.0) is gated behind accepting its
  conditions on Hugging Face with a personal token, so it was not benchmarked. It can be added behind the same
  JSON interface as `diarize.py`.

## Preflight check and warm-up

```bash
npm run doctor
```

Checks FFmpeg, `whisper-cli`, both model files and the port, prints a fix for anything
missing, then runs a real transcription of a bundled clip. Run it before a demo: it also
warms up the GPU (the first whisper run after install can take about 15 s).

## Run

```bash
npm run dev      # auto-restart on changes
npm start        # production mode
```

The server listens on `http://localhost:3001`. Check it:

```bash
curl http://localhost:3001/api/health          # {"status":"ok"}
curl -X POST http://localhost:3001/api/transcribe -F "audio=@recording.webm"
# {"text":"And so my fellow Americans, ...","durationSeconds":11}
```

Add `?segments=1` to also get timestamped segments (see the contract); the default response
is unchanged.

If anything is missing at startup the server still starts, logs what is missing, and
`/api/health` returns `{"status":"unavailable"}` (HTTP 503).

## Configuration

Copy `.env.example` to `.env` to override any of these. All are optional.

| Variable               | Default                     | Meaning                                              |
| ---------------------- | --------------------------- | ---------------------------------------------------- |
| `PORT`                 | `3001`                      | Listen port                                          |
| `CORS_ORIGIN`          | `http://localhost:5173`     | Browser origin allowed to call the API (`*` for any) |
| `FFMPEG_BIN`           | `ffmpeg`                    | FFmpeg executable (name on PATH or absolute path)    |
| `WHISPER_BIN`          | `whisper-cli`               | whisper.cpp executable                               |
| `WHISPER_MODEL`        | `models/ggml-small.en.bin`   | Model file, relative to `server/`                    |
| `WHISPER_VAD_MODEL`    | `models/ggml-silero-v5.1.2.bin` | Voice activity detection model (empty value disables) |
| `WHISPER_LANGUAGE`     | `en`                        | Language code (`auto` needs a multilingual model)    |
| `WHISPER_THREADS`      | `4`                         | CPU threads for whisper                              |
| `MAX_UPLOAD_BYTES`     | `10485760`                  | Upload size limit (10 MB)                            |
| `MAX_DURATION_SECONDS` | `60`                        | Audio length limit                                   |
| `PROCESS_TIMEOUT_MS`   | `120000`                    | Total conversion + inference budget per request      |
| `MAX_CONCURRENT`       | `2`                         | Simultaneous transcriptions; extra requests get 503  |
| `STT_TMP_DIR`          | OS temp dir + `/stt-server` | Where temporary audio lives                          |

## Demo hosting: laptop + tunnel

The deployed frontend (Vercel) cannot run whisper.cpp or FFmpeg, so the demo runs this
server on a laptop and exposes it through an HTTPS tunnel:

1. Start the server: `npm start`.
2. Start a tunnel to port 3001 with a tool of your choice, for example
   `cloudflared tunnel --url http://localhost:3001` or `ngrok http 3001`.
3. Set `CORS_ORIGIN` in `.env` to the deployed frontend's origin (for example
   `https://your-app.vercel.app`) and restart. Point the frontend's API base URL at the
   tunnel URL. A browser blocks an `https` page from calling plain `http`, so use the
   tunnel's `https` URL.
4. Keep the laptop awake and plugged in. Warm the model with one request before the demo
   (the first run after boot is slower).

Tunnel URLs are public. There is no authentication in the MVP, so share the URL only
for the demo and stop the tunnel afterwards.

## Tests

```bash
npm test
```

- `tests/api.test.js`: validation, limits, error codes, timeouts, concurrency, cleanup.
  Several of these swap whisper for a small fake shell script to exercise subprocess
  failures deterministically. **Those tests do not prove speech recognition works.**
- `tests/align.test.js`: alignment logic (ordering, ids, null speakers, ambiguity).
- `tests/transcriptions.test.js`: v2 endpoints, JWT verification (expired, wrong key/issuer, alg confusion),
  cross-doctor isolation, persistence, roles, corrections, history, deletion. Uses stand-in whisper/diarizer
  scripts and a locally generated key set, so it verifies the API and data layer only.
- `tests/real-diarization.test.js`: real diarization and the full real pipeline (whisper.cpp + diarizer + auth +
  database) on synthetic two-voice conversations. Skipped if diarization is not installed.
- `tests/normalize.test.js`: turning real Deepgram responses (saved in `tests/fixtures/deepgram/`) into segments.
- `tests/deepgram.test.js`: the Deepgram client against a stub (exact parameters, streaming, error classification, no key leakage).
- `tests/jobs.test.js`: the job system against a stub that replays real responses (lifecycle, retries, duplicate-charge safety,
  restart recovery, retention, callbacks, ownership, a real 7200 s boundary).
- `tests/real-deepgram.test.js`: LIVE Deepgram through the full stack; skipped unless `DEEPGRAM_LIVE_TEST=1` and a key are set.
- `tests/real-inference.test.js`: runs the real FFmpeg + whisper.cpp + `small.en` model on
  `tests/fixtures/jfk.wav` (public-domain sample from the whisper.cpp repo), as WAV,
  WebM/Opus and header-less streamed WebM (what browsers record), asserts the actual
  transcript, and checks that silence and quiet noise report no speech. These are reported as skipped if
  FFmpeg, whisper.cpp or the model is missing.

## Silence handling

Whisper alone invents text ("you", "Thank you.") for silent or noisy-but-empty audio.
The server enables whisper.cpp's built-in Silero voice activity detection (`--vad`,
a 0.9 MB model downloaded by `setup:model`), so those recordings return
`TRANSCRIPTION_FAILED` (422, "No speech was detected in the recording."). Without the VAD
model file the server still works but logs a warning at startup and may hallucinate on silence.

## Inference command (verified)

The server runs the equivalent of this, after converting the upload to 16 kHz mono PCM16 WAV:

```bash
ffmpeg -i upload -vn -t 61 -ac 1 -ar 16000 -c:a pcm_s16le -f wav audio.wav
whisper-cli -m models/ggml-small.en.bin -f audio.wav -l en -t 4 -sns -np --vad -vm models/ggml-silero-v5.1.2.bin -oj -of result
# result.json -> transcription[].text
```

Measured on an Apple M4 Pro (Metal GPU): with `small.en`, an 11 s clip transcribes in
about 0.45 s and a 55 s clip in about 1.4 s (whisper only). `base.en` is about 2-3x
faster (55 s WebM/Opus upload end to end in 0.6-0.7 s). The very
first whisper run after install can take about 15 s while Metal shaders compile; later
runs are fast. CPU-only machines will be slower; use a smaller model or raise
`PROCESS_TIMEOUT_MS` if needed.

## Layout

```
server/
  index.js              start the server
  app.js                Express app factory (used by tests)
  config.js             environment -> config
  routes/               health.js, transcribe.js
  services/             audio.js (FFmpeg), whisper.js, limiter.js, readiness.js
  middleware/           upload.js (multer), errors.js (CORS + error handler)
  lib/                  errors.js, exec.js (spawn without a shell)
  scripts/              download-model.sh, doctor.js
  tests/
```

## Security notes

- Subprocesses run with argument arrays and no shell. Uploads are stored under random
  names in a private temp dir; the client filename is never used as a path.
- FFmpeg is run with `-protocol_whitelist file` so an uploaded playlist cannot make it
  fetch network resources.
- Temporary files are deleted before each response, on success and on failure. If the client
  disconnects mid-request, FFmpeg/whisper are killed and the files removed.
- Errors returned to clients never contain filesystem paths, stderr, or environment values.
  Details are logged on the server only.

## Known limitations

- English only by default (`small.en`). Multilingual needs a multilingual model and `WHISPER_LANGUAGE`.
- Transcription runs after recording stops; there is no streaming.
- Speaker labels are best-effort (see the contract's limitations); overlapping speech and similar voices are weak spots.
- The legacy `POST /api/transcribe` is unauthenticated and stores nothing. Timestamps are opt-in there (`?segments=1`).
- Transcripts are stored unencrypted in SQLite (use disk encryption); not approved for real patient data.
- Durations up to 60.5 s are accepted, since recorders often overshoot 60 s slightly.
- When `MAX_CONCURRENT` jobs are running, new requests are rejected with 503 rather than queued.
- An unclean server kill (SIGKILL, crash) can leave files in the temp dir; they are safe to delete.
