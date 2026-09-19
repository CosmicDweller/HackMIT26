# API Contract: Speech-to-Text

Canonical contract between the frontend (branch `kv`, `client/`) and the backend
(branch `lz`, `server/`). Owned by the backend agent. Changes require agreement on
GitHub issue #3 before either side implements them.

Status: **v1**. The parts marked _(proposed)_ fill gaps in the agreed API and need
frontend confirmation on issue #3. Everything else is the agreed contract.

> This replaces the earlier placeholder text-to-speech contract (`POST /api/tts`), which
> has been removed. This project does speech recognition, not speech synthesis.

Base URL (dev): `http://localhost:3001`. The server listens on port `3001` by default.

## POST /api/transcribe

Transcribes a recorded audio clip. Transcription happens after recording stops;
there is no streaming.

### Request

`Content-Type: multipart/form-data`

| Field   | Type | Required | Notes                                                                  |
| ------- | ---- | -------- | ---------------------------------------------------------------------- |
| `audio` | file | yes      | Browser-recorded audio (WebM, MP4/M4A, Ogg, WAV, MP3...). One file only. |

The backend converts the audio itself (to 16 kHz mono 16-bit PCM WAV), so the
frontend sends the recording as-is. Do not set the `Content-Type` header manually
when using `FormData`; the browser adds the multipart boundary.

### Limits

| Limit                       | Value       |
| --------------------------- | ----------- |
| Maximum upload size         | 10 MB       |
| Maximum audio duration      | 60 seconds  |
| Processing timeout          | 120 seconds |

### Success response

`200 OK`, `Content-Type: application/json`

```json
{
  "text": "Recognized speech here.",
  "durationSeconds": 4.2
}
```

- `text` (string): the recognized speech, trimmed. Never empty on success (see errors).
- `durationSeconds` (number | null): length of the submitted audio in seconds, or
  `null` if the backend could not determine it.

### Error response

`Content-Type: application/json`

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE"
}
```

`error` is safe to show to the user. It never contains filesystem paths or
environment details.

| `code`                  | HTTP _(proposed)_ | When                                                                                              |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `INVALID_AUDIO`         | 400               | No `audio` field, empty file, undecodable audio, or audio longer than 60 seconds.                 |
| `FILE_TOO_LARGE`        | 413               | Upload exceeds 10 MB.                                                                             |
| `TRANSCRIPTION_FAILED`  | 500               | Inference failed, exceeded the 120 s timeout (504), or found no speech (422).                     |
| `SERVICE_UNAVAILABLE`   | 503               | FFmpeg, the whisper.cpp executable, or the model is missing, or the server is at its concurrency limit. |

Notes on the proposed HTTP statuses:

- The frontend should branch on `code`, not on the HTTP status.
- Silence / no recognizable speech returns `TRANSCRIPTION_FAILED` (422) with the message
  "No speech was detected in the recording." rather than a `200` with empty `text`.
- When the server is busy it returns `SERVICE_UNAVAILABLE` (503) with a `Retry-After`
  header; the client may retry.

## GET /api/health

Reports whether transcription can currently run (FFmpeg, whisper.cpp executable and
model all found).

- Ready: `200 OK`, `{ "status": "ok" }`
- Not ready: `503 Service Unavailable` _(proposed status)_, `{ "status": "unavailable" }`

## CORS _(proposed)_

The backend allows cross-origin requests from `http://localhost:5173` (the Vite dev
server) by default; configurable via `CORS_ORIGIN`. The frontend may instead use a Vite
dev-server proxy for `/api` to `http://localhost:3001`, which needs no CORS.

## MVP scope

- No authentication and no persistent storage.
- Temporary audio is deleted after each request, on success or failure.
- No continuous streaming transcription.
- English only initially (`small.en` model).

## Example

```bash
curl -X POST http://localhost:3001/api/transcribe -F "audio=@recording.webm"
```

```js
const form = new FormData();
form.append("audio", blob, "recording.webm");
const res = await fetch("/api/transcribe", { method: "POST", body: form });
const data = await res.json(); // { text, durationSeconds } or { error, code }
```
