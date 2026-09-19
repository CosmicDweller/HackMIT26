# API Contract: Speech-to-Text

Canonical contract between the frontend (branch `kv`, `client/`) and the backend
(branch `lz`, `server/`). Owned by the backend agent. Changes require agreement on
GitHub issue #3 before either side implements them.

Status:
- **v1** (`POST /api/transcribe`, `GET /api/health`): agreed and implemented. Unchanged.
- **v2** (accounts, speaker-aware transcriptions, everything under "Contract v2" below): **proposed**,
  posted to issue #3 for frontend agreement. Nothing in v2 changes v1.

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

### Optional timestamps _(proposed, additive)_

`POST /api/transcribe?segments=1` adds a `segments` array to the success response. Without
the query parameter the response is exactly the shape above, so existing clients are unaffected.

```json
{
  "text": "And so, my fellow Americans, ask not what your country can do for you.",
  "durationSeconds": 11,
  "segments": [
    { "start": 0.29, "end": 3.08, "text": "And so, my fellow Americans," },
    { "start": 3.08, "end": 8.1, "text": "ask not what your country can do for you." }
  ]
}
```

`start` and `end` are seconds from the beginning of the submitted audio. Segments are ordered,
never empty, and joining their `text` with a space gives `text`. The frontend does not need
this today; it exists for a future timestamped transcript.

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

---

# Contract v2 (proposed): doctor accounts and speaker-aware transcriptions

Everything below is **proposed** until the frontend agent confirms it on issue #3. v1 above is unchanged and
stays public (no authentication) so existing clients keep working.

> **Prototype for synthetic data only.** Use synthetic conversations for tests and demos. Authentication does
> not make this HIPAA compliant. See "Privacy and security" before any real patient information is processed.

## Authentication

Accounts are managed by **Supabase Auth**. The frontend talks to Supabase directly (`supabase-js`) for:
sign-up or invitation, login, logout and password reset. The backend has no password endpoints and never sees
passwords. To call any v2 endpoint, send the Supabase access token:

```
Authorization: Bearer <access_token>
```

The backend verifies every token against the project's published signing keys (signature, expiry, issuer,
audience, asymmetric algorithms only). The doctor's id is taken **only** from the verified token; an
`ownerId` in a request body, query or header is ignored. Anonymous or non-`authenticated` tokens are rejected.

Recommended Supabase settings: use asymmetric JWT signing keys (the default for new projects), and disable open
sign-ups (invite-only) if only known clinicians should get accounts. A self-registered account is **not**
verified medical credentials, and no field in this API claims it is.

Backend configuration: `SUPABASE_URL` (the project URL). No server-only Supabase key is needed or used, and none
is ever sent to the frontend.

### GET /api/me

Session verification. `200`:

```json
{ "id": "3f6c...", "email": "doctor@example.org", "displayName": "Dr Example", "credentialsVerified": false }
```

`credentialsVerified` is always `false`. `401 UNAUTHENTICATED` when the token is missing, invalid or expired
(the client should send the user to sign in again).

## Resources

IDs: `id` is `tr_<uuid>` (unguessable, but ownership is always checked). `speaker_1`, `speaker_2`... and
`segment_1`, `segment_2`... are unique **within one transcription** (routes always include the transcription id).
Speaker ids do not carry over between recordings.

### Transcription

```json
{
  "id": "tr_3d1f0c5e-7a2b-4c6e-9d3a-0b1c2d3e4f50",
  "text": "Are you eating regularly? I eat two meals per day.",
  "durationSeconds": 8.5,
  "createdAt": "2026-09-19T18:04:11.532Z",
  "reviewStatus": "needs_review",
  "diarization": { "status": "ok", "speakerCount": 2 },
  "speakers": [
    { "id": "speaker_1", "label": "Speaker 1", "role": "unassigned" },
    { "id": "speaker_2", "label": "Speaker 2", "role": "unassigned" }
  ],
  "segments": [
    { "id": "segment_1", "startMs": 1000, "endMs": 3500, "text": "Are you eating regularly?", "speakerId": "speaker_1" },
    { "id": "segment_2", "startMs": 4000, "endMs": 8500, "text": "I eat two meals per day.", "speakerId": "speaker_2" }
  ]
}
```

| Field | Notes |
| --- | --- |
| `text` | The segments' text joined with a space, kept consistent when a segment is edited. |
| `durationSeconds` | Length of the submitted audio. |
| `reviewStatus` | `needs_review` (default) or `reviewed`. Only an explicit review action can change it (see below). Editing text, changing a speaker or assigning a role never changes it. |
| `diarization.status` | `ok`, `failed` (speaker detection ran and errored or timed out) or `unavailable` (not installed or disabled). |
| `diarization.speakerCount` | Number of speakers that own at least one segment. |
| `speakers[].id` | Stable within this transcription; numbered by first appearance. **Speaker 1 is not assumed to be the doctor.** |
| `speakers[].role` | `doctor`, `patient`, `other` or `unassigned`. Set by the doctor; never inferred from what was said. |
| `segments[].startMs/endMs` | Milliseconds from the start of the audio. Ordered, `endMs > startMs`. |
| `segments[].speakerId` | A speaker id from `speakers`, or `null` when the speaker is unknown or ambiguous. |

The role lives on the speaker; segments keep referencing the internal speaker id. Showing "Doctor" for
`speaker_1` is the client's job: look up `speakers[].role`.

### Diarization fallback (decided)

Speaker detection is best-effort. When it fails or is unavailable the request still **succeeds** with the
transcript, but honestly marked: `diarization.status` is `failed` or `unavailable`, `speakers` is `[]` and every
`segments[].speakerId` is `null`. Labels are never fabricated. The client should show something like "Speaker
detection unavailable" and let the doctor assign speakers manually with the segment PATCH. `reviewStatus` is
still `needs_review`.

## Endpoints (all require `Authorization: Bearer`)

### POST /api/transcriptions

`multipart/form-data`. Field `audio` (file, same limits as v1: 10 MB, 60 s). Optional text field
`expectedSpeakers` (whole number 1-6): if you know how many people are talking (a consultation is usually 2),
send it; otherwise the count is estimated. Returns `201 Created` with a `Location` header and the full
**Transcription**. Audio is processed and then deleted; raw audio is never stored.

Errors: `401 UNAUTHENTICATED`; `400 INVALID_AUDIO` / `413 FILE_TOO_LARGE` / `TRANSCRIPTION_FAILED` (422 no speech, 504
timeout, 500) / `503 SERVICE_UNAVAILABLE` exactly as in v1; `400 INVALID_REQUEST` for a bad `expectedSpeakers`.
Authentication is checked before the upload is read.

### GET /api/transcriptions

Only the caller's own transcriptions, newest first (at most 200).

```json
{
  "transcriptions": [
    { "id": "tr_...", "createdAt": "2026-09-19T18:04:11.532Z", "durationSeconds": 8.5, "reviewStatus": "needs_review" }
  ]
}
```

### GET /api/transcriptions/:id

The full **Transcription**. `404 NOT_FOUND` if it does not exist **or belongs to another doctor** (indistinguishable
on purpose, so ids cannot be probed).

### PATCH /api/transcriptions/:id/speakers

```json
{ "speakerId": "speaker_1", "role": "doctor" }
```

Roles: `doctor`, `patient`, `other`, `unassigned`. Persists the mapping and returns the full **Transcription**.
Roles are independent: assigning `doctor` to one speaker does not change another speaker. `400 INVALID_REQUEST` for
an unknown role or a speaker that is not in this transcription; `404 NOT_FOUND` for a missing or foreign transcription.

### PATCH /api/transcriptions/:id/segments/:segmentId

```json
{ "text": "Corrected transcript text", "speakerId": "speaker_1" }
```

Either field or both. `speakerId` may be `null` (mark as unknown). Timestamps are never changed and audio is never
re-transcribed. `text` must be 1-10,000 characters (surrounding whitespace is trimmed). Applied atomically; on
any error nothing changes. Returns the full **Transcription** (with `text` recomputed).
`400 INVALID_REQUEST` (bad text, or a speaker that belongs to no speaker of this transcription); `404 NOT_FOUND`.

### DELETE /api/transcriptions/:id

`204 No Content` with an empty body. Removes the transcription with its speakers and segments (no audio exists to
remove). `404 NOT_FOUND` for a missing or foreign transcription. Deleting twice returns `404`.

### Review confirmation: NOT implemented (needs frontend agreement)

Nothing in v2 marks a transcript as reviewed. If wanted, the proposal is `POST /api/transcriptions/:id/review` with
no body, an explicit action that returns the full **Transcription** with `reviewStatus: "reviewed"`. It would never
be triggered by saving labels or edits. The storage column and status values already exist.

## Errors (additions)

Same shape as v1: `{ "error": "...", "code": "..." }`.

| `code` | HTTP | When |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Missing, malformed, expired or otherwise invalid token. |
| `NOT_FOUND` | 404 | Unknown id, malformed id, or another doctor's data. |
| `INVALID_REQUEST` | 400 (413 for an oversized body) | Bad JSON, bad field values, or a cross-transcription speaker reference. |
| `SERVER_ERROR` | 500 | Unexpected failure on a transcript-management route (for example a database error). |
| `SERVICE_UNAVAILABLE` | 503 | Also when sign-in is not configured or Supabase's keys cannot be fetched. |

## How speakers are assigned (limitations)

1. `whisper.cpp` produces timestamped **segments** (one per stretch of speech; usually one per turn when people
   pause). A separate local model (**diarization**: pyannote-segmentation-3.0 + WeSpeaker embeddings, CPU) produces
   "who spoke when" intervals with anonymous, recording-local speaker clusters. It does **not** identify anyone.
2. Each segment gets the speaker whose detected speech overlaps it most. It stays `speakerId: null` if less than
   200 ms of detected speech overlaps it or the winner holds under 60% of the overlapping speech (mixed or
   interrupted segment).
3. Segment `startMs/endMs` are trimmed to that speaker's detected speech (real model output, not invented).
4. **Segments are never split at word level.** With voice-activity detection on, whisper.cpp leaves word timestamps
   on a compressed timeline, so they are not reliable enough. A segment containing two speakers is therefore
   `speakerId: null`, not split.
5. Speakers are numbered by first appearance. Speaker ids are not comparable across recordings, and no voiceprint
   database exists.

Measured on synthetic two-voice conversations (no patient data): 8/8 turns correct with stable ids on
alternating turns, including a one-word reply; a single speaker gives 1 speaker. Known weaknesses:
- Overlapping speech: a short reply that overlaps the other person's last words can be attributed to the wrong
  speaker with high apparent confidence (7/8 turns correct on the overlap sample).
- Voices that sound alike (for example two speakers of the same sex on a poor microphone) can be merged into one
  cluster, or one person split into two. Passing `expectedSpeakers` helps; the doctor can also fix labels per segment.
- Backchannels ("mm-hm"), noise and music may be attributed to a speaker or dropped.
- Tuned only on synthetic text-to-speech voices; real microphone recordings have not been evaluated.

## Privacy and security

- Transcripts are stored in a local SQLite file on the backend machine, not in Supabase or any third-party service.
  Supabase Auth only holds account credentials and email. Audio and transcripts are not sent to any external
  provider. The diarization and speech models run locally.
- Raw audio is never persisted. Temporary files are deleted before the response is sent.
- Audio, transcript text and tokens are not logged.
- Every query is scoped by the verified owner id; another doctor's data returns `404`.
- The database file is not encrypted by the application. Use disk encryption (for example FileVault) and restrict
  access to the machine.
- **Before real patient information is processed**, all of the following must be identified and approved:
  patient recording consent, privacy and access controls, approved (HIPAA-eligible) infrastructure and any business
  associate agreements, encryption at rest and in transit, audit logging, a data-retention and deletion policy,
  secure deployment, and an incident-response process. Authentication alone is not compliance.
