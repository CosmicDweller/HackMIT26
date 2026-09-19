# Speech-to-Text Server

Express backend that turns a recorded audio clip into text using FFmpeg and
[whisper.cpp](https://github.com/ggml-org/whisper.cpp). The API is defined in
[`docs/API_CONTRACT.md`](../docs/API_CONTRACT.md).

```
browser recording ─▶ POST /api/transcribe ─▶ FFmpeg (16 kHz mono WAV) ─▶ whisper-cli ─▶ JSON
```

## Requirements

- Node.js 22.9 or newer (developed on 24)
- FFmpeg
- whisper.cpp (`whisper-cli`)
- A whisper.cpp model file (`base.en`, about 148 MB)

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
npm run setup:model      # downloads models/ggml-base.en.bin (git-ignored)
```

`setup:model` accepts another model name: `sh scripts/download-model.sh small.en`
(then set `WHISPER_MODEL=models/ggml-small.en.bin`). Model files are never committed.

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
| `WHISPER_MODEL`        | `models/ggml-base.en.bin`   | Model file, relative to `server/`                    |
| `WHISPER_LANGUAGE`     | `en`                        | Language code (`auto` needs a multilingual model)    |
| `WHISPER_THREADS`      | `4`                         | CPU threads for whisper                              |
| `MAX_UPLOAD_BYTES`     | `10485760`                  | Upload size limit (10 MB)                            |
| `MAX_DURATION_SECONDS` | `60`                        | Audio length limit                                   |
| `PROCESS_TIMEOUT_MS`   | `120000`                    | Total conversion + inference budget per request      |
| `MAX_CONCURRENT`       | `2`                         | Simultaneous transcriptions; extra requests get 503  |
| `STT_TMP_DIR`          | OS temp dir + `/stt-server` | Where temporary audio lives                          |

## Tests

```bash
npm test
```

- `tests/api.test.js`: validation, limits, error codes, timeouts, concurrency, cleanup.
  Several of these swap whisper for a small fake shell script to exercise subprocess
  failures deterministically. **Those tests do not prove speech recognition works.**
- `tests/real-inference.test.js`: runs the real FFmpeg + whisper.cpp + `base.en` model on
  `tests/fixtures/jfk.wav` (public-domain sample from the whisper.cpp repo), as WAV and
  as WebM/Opus, and asserts the actual transcript. These are reported as skipped if
  FFmpeg, whisper.cpp or the model is missing.

## Inference command (verified)

The server runs the equivalent of this, after converting the upload to 16 kHz mono PCM16 WAV:

```bash
ffmpeg -i upload -vn -t 61 -ac 1 -ar 16000 -c:a pcm_s16le -f wav audio.wav
whisper-cli -m models/ggml-base.en.bin -f audio.wav -l en -t 4 -sns -np -oj -of result
# result.json -> transcription[].text
```

Measured on an Apple M4 Pro (Metal GPU, `base.en`): an 11 s clip transcribes in about
0.3 s, and a 55 s WebM/Opus upload completes end to end in about 0.6-0.7 s. The very
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
  scripts/              download-model.sh
  tests/
```

## Security notes

- Subprocesses run with argument arrays and no shell. Uploads are stored under random
  names in a private temp dir; the client filename is never used as a path.
- FFmpeg is run with `-protocol_whitelist file` so an uploaded playlist cannot make it
  fetch network resources.
- Temporary files are deleted before each response, on success and on failure.
- Errors returned to clients never contain filesystem paths, stderr, or environment values.
  Details are logged on the server only.

## Known limitations

- English only by default (`base.en`). Multilingual needs a multilingual model and `WHISPER_LANGUAGE`.
- Transcription runs after recording stops; there is no streaming.
- No speaker labels, timestamps, authentication, or persistence.
- Durations up to 60.5 s are accepted, since recorders often overshoot 60 s slightly.
- If a client disconnects mid-request, the job still runs to completion before its files are removed.
- When `MAX_CONCURRENT` jobs are running, new requests are rejected with 503 rather than queued.
- An unclean server kill (SIGKILL, crash) can leave files in the temp dir; they are safe to delete.
