# API Contract: Speech-to-Text

Canonical contract between the frontend (branch `kv`, `client/`) and the backend
(branch `lz`, `server/`). Owned by the backend agent. Changes require agreement on
GitHub issue #3 before either side implements them.

Status:
- **v1** (`POST /api/transcribe`, `GET /api/health`): agreed and implemented. Unchanged.
- **v2** (accounts, speaker-aware transcriptions, everything under "Contract v2" below): agreed with the
  frontend on issue #3 and implemented.

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

| `code`                  | HTTP | When                                                                                              |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `INVALID_AUDIO`         | 400               | No `audio` field, empty file, undecodable audio, or audio longer than 60 seconds.                 |
| `FILE_TOO_LARGE`        | 413               | Upload exceeds 10 MB.                                                                             |
| `TRANSCRIPTION_FAILED`  | 500               | Inference failed, exceeded the 120 s timeout (504), or found no speech (422).                     |
| `SERVICE_UNAVAILABLE`   | 503               | FFmpeg, the whisper.cpp executable, or the model is missing, or the server is at its concurrency limit. |

Notes on the HTTP statuses (confirmed by the frontend on issue #3):

- The frontend should branch on `code`, not on the HTTP status.
- Silence / no recognizable speech returns `TRANSCRIPTION_FAILED` (422) with the message
  "No speech was detected in the recording." rather than a `200` with empty `text`.
- When the server is busy it returns `SERVICE_UNAVAILABLE` (503) with a `Retry-After`
  header; the client may retry.

### Optional timestamps (additive)

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
- Not ready: `503 Service Unavailable` , `{ "status": "unavailable" }`

## CORS

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

# Contract v2: doctor accounts and speaker-aware transcriptions

Everything below was agreed with the frontend agent on issue #3 (list envelope, error codes, review endpoint,
`expectedSpeakers`, `diarization.status`). Further changes need agreement there first. v1 above is unchanged and
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
  "engine": "local",
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
| `reviewStatus` | `needs_review` (default) or `reviewed`. Only `POST .../review` sets `reviewed`; any later edit, speaker change or role change sets it back to `needs_review`. |
| `engine` | Which speech engine produced the transcript: `deepgram` (the primary engine: Nova-3 Medical, audio was sent to Deepgram) or `local` (the whisper.cpp fallback; audio never left the backend machine). Lets the UI and audits tell where audio went. |
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
`expectedSpeakers` (whole number 1-6): honored only by the local whisper.cpp fallback engine; the Deepgram
engine detects speakers automatically and ignores it (Deepgram has no speaker-count parameter, and none is invented). Returns `201 Created` with a `Location` header and the full
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

### POST /api/transcriptions/:id/review

Explicit review confirmation: no request body. Sets `reviewStatus` to `reviewed` and returns the full
**Transcription** (`200`; idempotent). This is the **only** thing that ever sets `reviewed`: saving a role, a speaker
or an edit never does. Any later change to segment text, a segment's speaker or a speaker's role sets the transcript
back to `needs_review`, so "reviewed" never describes content that has since changed. A rejected edit changes
nothing, including an existing review. `404 NOT_FOUND` for a missing or foreign transcription.

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

- **Deepgram is the primary engine.** Audio from authenticated recordings (`/api/transcriptions`,
  `/api/transcription-jobs`) is sent to Deepgram's hosted API (model `nova-3-medical`, always with
  `mip_opt_out=true`) and transcripts record `engine: "deepgram"`. It is NOT a local-only system: audio leaves the
  machine. There is no automatic fallback to the local engine (a Deepgram failure is reported as a failed job);
  the whisper.cpp engine is used only when the backend is configured with `STT_ENGINE=local`. The public
  `POST /api/transcribe` always stays local.
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

---

# Contract v3: Deepgram Nova-3 Medical, recordings and jobs

Additive to v1 and v2 (nothing above was removed). Agreed with the frontend on issue #3 before it becomes a
dependency: see "Open coordination points" at the end.

## Processing model

```
React  ->  Express backend  ->  Deepgram hosted API (audio leaves this machine)
                 |
                 v
        normalize + persist  ->  React transcript viewer
```

- **Speech engine: Deepgram, model `nova-3-medical`**, with the latest **batch diarizer** (`diarize_model=latest`;
  Deepgram reports `metadata.diarize_info.arch`, currently `v2`). Transcription and diarization are ONE request over the
  complete recording, so speaker indices are consistent for the whole recording.
- Exact request: `POST /v1/listen?model=nova-3-medical&diarize_model=latest&utterances=true&smart_format=true&language=en&mip_opt_out=true`.
- Only the backend talks to Deepgram. The API key never reaches the browser and is never logged.
- Whisper text is never combined with Deepgram speaker data. The whisper.cpp engine is a separate, optional
  fallback (`STT_ENGINE=local`; short recordings only) and produces its own speakers.
- Whether diarization really ran is verified from the response (`metadata.diarize_info`), never assumed from the
  presence of text. If it is absent the transcript is kept, every speaker is `null`, and `diarizationStatus` is `failed`.

## Transcription resource: additions

| Field | Meaning |
| --- | --- |
| `status` | Always `completed` on a transcription resource (in-progress work is a *job*). |
| `diarizationStatus` | `completed` (the diarizer ran and labelled every word; a genuine one-speaker recording is `completed`), `partial` (some words unlabelled), or `failed` (the diarizer did not run; every `speakerId` is `null`). `diarization.status` from v2 is kept unchanged for existing clients. |
| `warnings` | `[{ code, message }]`. `FALLBACK_MODEL_USED` when an explicitly configured fallback model replaced the medical model. Empty normally. |
| `segments[].needsReview` | `true` when the text or speaker is doubtful (unknown speaker, a content word below the confidence threshold, invalid timing, or low speaker confidence). Editing a segment clears its flag. **Advisory only** (see limitations). |

**Speaker ids.** With Deepgram, `speaker_N` is Deepgram's own speaker index N (starting at 0) and the label is
`Speaker N+1` (`speaker_0` -> "Speaker 1"). Ids are stable within one transcription, are not comparable across
recordings, and never mean "doctor". The local engine numbers speakers from `speaker_1`; clients must treat ids as
opaque. Roles are assigned by the doctor (`PATCH .../speakers`) and never change the id.

**Segments.** Built from Deepgram's words (source of truth for text, timestamps and speakers), using its utterances
only for boundaries. An utterance that contains words from different speakers is **split at the word boundary**
(this happens often in real responses). Adjacent same-speaker fragments that split mid-sentence are re-joined. No
word is dropped or duplicated, punctuation and smart formatting are preserved verbatim, medical terms are never
"corrected", and no timestamp is invented (a segment is timed only by its own valid words).

Internal only (stored, never returned): Deepgram request id, reported model and version, resolved diarizer version,
processing time, the original speaker index, and word/speaker confidences per segment.

## Jobs

Every authenticated recording is processed as a persistent **job** (SQLite, survives restarts). Statuses:
`queued` -> `preparing` (FFmpeg verifies and normalizes the whole recording) -> `uploading` (streaming the file to
Deepgram) -> `transcribing` (waiting for Deepgram) -> `completed` | `failed`.

Job view (`progressPercent` is always `null`: there is no real progress source and none is fabricated):

```json
{ "jobId": "job_...", "status": "transcribing", "progressPercent": null, "transcriptionId": null, "error": null }
```

On failure `error` is `{ "code": "PROVIDER_TIMEOUT", "message": "..." }` (messages are safe: no provider details, paths or credentials).

### POST /api/transcription-jobs

`multipart/form-data`, field `audio`. Up to **7200 s (2 hours)** and **1 GiB** (`413 FILE_TOO_LARGE` above the size limit; the upload
is written straight to disk, never held in memory). Returns `202` with the job view and `Location`. Duration is
measured from the decoded audio, not from headers (browser recordings often have none). Requires authentication.

### GET /api/transcription-jobs  /  GET /api/transcription-jobs/:jobId

Owner-scoped. The list is `{ "jobs": [ { ...jobView, "createdAt": "..." } ] }` (latest 50). Job views never contain transcript text.
`404 NOT_FOUND` for a missing or foreign job.

### POST /api/transcription-jobs/:jobId/retry

Explicit retry of a `failed` job whose recording is still stored (`202`). Never automatic, because it can bill Deepgram again.
`409 INVALID_REQUEST` otherwise. **Reprocessing never overwrites anything:** a retried job produces a new transcription; existing
transcriptions, corrections and reviews are untouched, and reconciling two versions is a manual, explicit step for the doctor.

### DELETE /api/transcription-jobs/:jobId

`204`. Deletes a finished job and any stored recording. `409` while running.

### POST /api/transcriptions (v2 convenience route, unchanged shape)

Creates a job and waits up to 3 minutes: `201` with the transcription when done, the usual `{ error, code }` (plus
`jobId`) on failure, or `202` with the job view if it is still running. Its 10 MB upload limit is unchanged; its former
60 s limit is relaxed to the 2-hour maximum (only a widening). A client that disconnects does not lose the transcript:
the job finishes and appears in history.

## Job error codes

| `error.code` | Meaning | Recording kept for retry? |
| --- | --- | --- |
| `INVALID_AUDIO` | Not decodable audio. | No (deleted) |
| `RECORDING_TOO_LONG` | Decoded length above 7200 s. | No |
| `NO_SPEECH` | Nothing was recognized. | No |
| `PROVIDER_BAD_AUDIO` | Deepgram could not process the audio. | No |
| `PROVIDER_NOT_CONFIGURED` | No API key on the server. | Yes |
| `PROVIDER_AUTH_FAILED` / `PROVIDER_ACCOUNT_LIMIT` | Key rejected / account limit reached. | Yes |
| `PROVIDER_MODEL_UNAVAILABLE` | Model not enabled for the account. Never swapped silently (see fallback below). | Yes |
| `PROVIDER_RATE_LIMITED` | Rate limited; retried automatically a bounded number of times first. | Yes |
| `PROVIDER_TIMEOUT` / `PROVIDER_UNAVAILABLE` | Deepgram too slow / down. **Never auto-resubmitted** (it may have been billed). | Yes |
| `PROVIDER_MALFORMED_RESPONSE` | Unexpected response. | Yes |
| `LONG_RECORDING_NEEDS_CALLBACK` | Longer than the synchronous limit and callbacks are not configured. Rejected before any audio is sent. | Yes |
| `INTERRUPTED` | The server restarted while the recording may have been at Deepgram. Not resubmitted automatically. | Yes |
| `CALLBACK_TIMEOUT` | The callback never arrived. | Yes |
| `SERVICE_UNAVAILABLE` / `INTERNAL` | Other. | Yes |

Kept recordings are deleted after `AUDIO_RETENTION_HOURS` (default 24). Completed jobs delete the recording immediately.
Duplicate-charge rules: only rate limiting and refused connections (nothing reached Deepgram) are retried automatically, at
most `MAX_SUBMIT_ATTEMPTS` times. After a restart a possibly-sent recording is failed as `INTERRUPTED`, not resubmitted.

## Long recordings and callbacks

Deepgram's synchronous requests return `504` after 10 minutes and it does not store transcripts, so a timed-out request is
paid for and lost. Therefore:
- Recordings up to `DEEPGRAM_SYNC_MAX_SECONDS` (default 1800 s) are sent synchronously.
- Longer ones need an **asynchronous callback**. A callback cannot reach `localhost`: it requires a publicly reachable URL
  (`DEEPGRAM_CALLBACK_BASE_URL`) that forwards to a separate tiny listener (`127.0.0.1:CALLBACK_PORT`) serving **only**
  `POST /deepgram-callback/:jobId`. Exposing that port is a deliberate, separately approved step; nothing else of the server is exposed.
- Callback authentication: a random per-job secret sent as the Basic-auth password in the callback URL (stored only as a hash,
  compared in constant time), the Deepgram `request_id` must match, and duplicate deliveries are acknowledged without effect.
  Deepgram's `dg-token` header is documented as not guaranteed and is not relied on. Only ports 80, 443, 8080 and 8443 are
  allowed by Deepgram; it retries a failed callback up to 10 times, 30 s apart.
- Without a callback URL, over-limit recordings fail immediately with `LONG_RECORDING_NEEDS_CALLBACK` (no audio sent).
- The recording is verified (FFmpeg decodes all of it), normalized to mono 16 kHz FLAC on disk (about 17 KB/s of speech, so ~120 MB
  for two hours), and streamed to Deepgram with backpressure. Timestamps are Deepgram's for the whole file: nothing is chunked, so
  nothing resets and speaker ids are never stitched across separate requests.

## Model fallback

`DEEPGRAM_FALLBACK_MODEL` is empty by default. If set (for example `nova-3-general`) and the medical model is genuinely unavailable,
the same request is retried once with the fallback model and the same diarizer, and the transcription carries a
`FALLBACK_MODEL_USED` warning (the general model is not tuned for medical vocabulary). Whisper is never used as a silent fallback.

## Measured quality (synthetic recordings; no patient data)

Live runs of the production request against ground truth (`npm run eval:deepgram`). Speaker ids matched with the best mapping;
DER uses a 250 ms collar. Every response reported model `medical-nova-3` and diarizer `v2`.

| Recording | Speakers true/found | WER | DER | Word to speaker |
| --- | --- | --- | --- | --- |
| A-B-A (7 s) | 2/2 | 0.0% | 2.6% | 100% |
| Two speakers (17 s) | 2/2 | 0.0% | 0.6% | 100% |
| Three speakers (19 s) | 3/3 | 0.0% | 9.9% | 89.6% |
| Medical vocabulary (31 s) | 2/2 | 1.4% | 1.1% | 100% |
| One speaker (9 s) | 1/1 | 0.0% | 0.4% | 100% |
| Overlapping speech (14 s) | 2/2 | 2.5% | 1.3% | 84.6% |
| Medical, 5 minutes | 2/2 | 0.9% | 0.6% | 100% |
| Silence / pink noise | no words, reported as no speech | | | |

**Failures and limits, honestly:**
- Three speakers: the third voice's last sentence was attributed to the doctor's speaker with **speaker confidence 1.0**, so
  confidence cannot be used to catch attribution errors. `needsReview` is advisory, not a guarantee.
- Overlapping speech: about 15% of words were attributed to the wrong speaker, and a one-word reply was not recognized at all.
- Recognition: "atorvastatin" was transcribed "atavastatin" (word confidence 0.80). It is kept as heard and flagged, never
  silently corrected. No medical term is guaranteed to be transcribed correctly.
- The review flag marked about 40% of segments in the 5-minute medical test (long content words below 0.85 confidence). It is a
  heuristic tuned on tiny synthetic data; the threshold is configurable (`REVIEW_WORD_CONFIDENCE`).
- The evaluation audio is text-to-speech. Real microphones, accents, crosstalk and clinical noise are unevaluated.
- Diarization and transcription accuracy on 30-minute and two-hour recordings has NOT been tested against the real service (see below).

## Verified vs not yet verified

Verified with real Deepgram and synthetic audio: the exact request; the real response shape, `diarize_info`, model reporting;
30 s, A-B-A, three-speaker, single-speaker, overlap, silence, noise and a 5-minute recording through the full stack; job statuses; persistence and reopening.
Verified with a stub (real captured responses): failure handling, retries, restart recovery, retention, callbacks and their authentication.
Verified with real FFmpeg and a stub: a real 7200 s recording is accepted and a 7205 s one is rejected.
**Not verified:** a 30-minute or 2-hour recording against the real service; callbacks against the real service (needs a public URL);
real patient audio. A two-hour recording must not be assumed to work until that test has been run.

## Open coordination points (frontend)

The frontend (`client/`, owned by the frontend agent) currently caps recording at 60 s and uploads at 10 MB, and calls the synchronous
route. Two-hour recordings need client changes (longer recording, chunk-free upload of the finished file to `/api/transcription-jobs`,
and polling `GET /api/transcription-jobs/:jobId`). The existing client keeps working unchanged.
