# Progress

## Current milestone
**Deepgram/job-system migration (Contract v3) is built and verified against
the real, merged backend.** Backend delivered the whole thing in one pass
(job endpoints, 2h/1GiB recordings, `warnings`, `needsReview`,
`diarizationStatus`) — ahead of the coordination proposal below, so the
client caught up to match rather than the other way around.

## Deepgram migration — done
Client now uses `POST /api/transcription-jobs` (not the old synchronous
route) for new-transcription, with real polling
(`queued|preparing|uploading|transcribing|completed|failed`) and
stage-specific copy ("Uploading recording…", "Preparing audio…",
"Transcribing with Deepgram…", "Finalizing transcript…"). Built:
- `services/transcriptions/jobsApi.ts` (+ `mockJobsApi.ts` behind
  `VITE_USE_MOCK_TRANSCRIPTIONS`, simulating the same staged timing) and
  `hooks/useTranscriptionJob.ts` (create, poll, retry, resume).
- `POST .../:jobId/retry` wired to the failure screen's Retry button;
  `GET /api/transcription-jobs` surfaced as a "Processing" section on the
  dashboard so a doctor can reopen an unfinished job after navigating away
  (`/dashboard/new?jobId=...` resumes polling) — "do not pretend an
  unfinished job is complete" is satisfied by literally showing the real
  status, not a guess.
- `ErrorBanner` widened to accept any error code (not just the fixed REST
  `ErrorCode` union) with friendly labels for all documented job error
  codes (`RECORDING_TOO_LONG`, `PROVIDER_TIMEOUT`, etc.) — unrecognized
  future codes still degrade gracefully.
- `Transcription.warnings[]` (e.g. `MINOR_SPEAKER_DETECTED`) and per-segment
  `needsReview` now render — an amber banner and a segment-level "Review"
  badge respectively, advisory only, never presented as verified.
- Upload size limit raised from 10 MB to 1 GiB for the new-transcription
  flow specifically (`UploadPanel`'s limit is now a prop; the legacy
  quick-transcribe page keeps its original 10 MB against the unchanged
  `/api/transcribe`).
- Recording duration bumped 60s → 7200s (2h), `HH:MM:SS` clock, warning in
  the last 5 minutes, "keep this tab open" notice, mic/track-interruption
  handling that preserves whatever was captured.
- 3+ speaker support confirmed with no hardcoded 2-speaker assumption —
  the shared mock fixture now has a third speaker (a nurse stepping in),
  permanently, with a `needsReview`/`MINOR_SPEAKER_DETECTED` demo mirroring
  what the backend actually observed on a real 2-hour recording.

**Real bug found and fixed via this integration testing:** the shared
`apiRequest` helper's success/failure heuristic checked `"error" in
payload`, but a *successful* job response legitimately has an `error` key
(`null` when nothing failed) — so every successful job creation was being
misread as a failure ("SERVER ERROR / null"). Fixed to trust the HTTP
status code only (`services/transcriptions/apiClient.ts`), which is what
the contract actually specifies.

**Verified for real** (not mocks): `STT_ENGINE=local` (no Deepgram key
available in this session — flagged below), real job creation → real
polling → real completion → real `tr_<uuid>` transcript with correct
diarization, through the new job endpoint end to end, zero console errors,
clean server logs throughout.

**Not yet verified:** the actual Deepgram engine (needs `DEEPGRAM_API_KEY`,
which wasn't available this session — only Supabase credentials were
shared). Everything was tested against the `local` whisper.cpp fallback via
the *same* job endpoints Deepgram uses, so the client-side job/polling
mechanics are proven; only the Deepgram-specific response shape (`engine:
"deepgram"`, real `warnings`/`needsReview` from real Deepgram data) is
unverified. Chunked upload was explicitly *not* built — the backend
recommended against it (single multipart POST is reliable on localhost)
and the frontend agreed on issue #3.

## Completed features
- Original single-speaker quick-transcribe flow (`/`) preserved unchanged —
  record/upload → transcribe → edit/copy/download, still against
  `POST /api/transcribe` (real or mock via `VITE_USE_MOCK_API`).
- Blue brand palette applied via design tokens (`client/src/index.css`) —
  Egyptian Blue / Sapphire Sky / Glaucous / Baby Blue Ice / Pale Sky.
- Doctor workspace (dashboard, new transcription, speaker-separated
  transcript viewer, history, export), fully aligned with contract v2:
  list envelope, 204-on-delete, `UNAUTHENTICATED`/`INVALID_REQUEST`/
  `SERVER_ERROR` codes with auto sign-out on session expiry, explicit
  "Mark as reviewed" (no client-derived review status), `diarization.status`
  handling, `expectedSpeakers=2` on upload, and now `engine` ("Processed
  locally" / "Processed by Deepgram (cloud)" shown on the transcript).
- Real Supabase Auth (`services/auth/supabaseAuthProvider.ts`) verified
  end-to-end earlier (signup → real confirmation email → confirm → sign
  in/out).

## Verified for real today (not mocks), against the merged backend
Ran `cd server && npm install && npm run setup:model && npm run
setup:diarization` locally (Node 23.6 — `node:sqlite` and the diarization
Python venv both work fine despite the README's Node 24 recommendation),
`npm run doctor` (all green: FFmpeg, whisper-cli, both models, diarization,
Supabase config, a real transcription, and real diarization on synthetic
audio), then `npm start`.

With the client pointed at it for real:
- Signed in with a real (previously-confirmed) Supabase account.
- Uploaded the backend's own `two-speaker.wav` fixture. Got back a real
  `tr_<uuid>` transcription: accurate whisper.cpp text, and diarization
  correctly alternated every turn between the two speakers.
- Assigned Speaker 1 → Doctor, Speaker 2 → Patient — persisted correctly,
  applied to every segment, `reviewStatus` correctly stayed `needs_review`
  (not auto-flipped — confirms that fix holds against real data).
- "Mark as reviewed" → flipped to `reviewed`. Edited a segment's text →
  **automatically flipped back to `needs_review` and the "Mark as
  reviewed" button reappeared, with zero client-side logic for this** —
  the UI just reflects whatever the backend returns, exactly as designed.
- Export (while reviewed, no confirm-dialog risk in the automated browser).
- Transcript history showed the real transcript with correct duration and
  status.
- Verified `DELETE` directly (via the page's own authenticated `fetch`,
  bypassing the confirm() dialog that automation can't click through):
  real `204` with an empty body, exactly matching the fix from last
  session. Reflected correctly in the UI after reload.
- Server logs stayed clean throughout — no audio, tokens, or transcript
  text logged, matching their stated privacy commitment.
- Zero console errors at any step of the whole session.

## Remaining prioritized tasks
1. Get a `DEEPGRAM_API_KEY` to verify the actual Deepgram engine end to end
   (tested via the local fallback through the same job endpoints so far).
2. Automated test suite (Playwright/Vitest) for the scenarios in the brief
   — deferred until now because the job-workflow contract was still
   changing; it's stable now, so this is a reasonable next step.
3. Mobile-width layout not manually verified (browser automation here
   can't reliably resize the viewport).
4. Deploy to Vercel (client) + decide on backend hosting (laptop + tunnel
   per backend's plan, since Vercel can't run whisper.cpp).
5. Optional: surface `GET /api/me` somewhere (not required by any current
   screen).

## Architectural decisions
- `client/` owned by the frontend agent (branch `kv`); backend owned by the
  agent on branch `lz`. Coordinating via issue #3.
- Original quick-transcribe flow kept as-is at `/`, not merged into the new
  authenticated flow, per "preserve existing functionality."
- Auth and the transcriptions API each sit behind their own
  provider-agnostic service + mock flag (`VITE_USE_MOCK_AUTH`,
  `VITE_USE_MOCK_TRANSCRIPTIONS`) — both now flipped to `false` locally
  since the real backend is verified working.

## Known bugs and blockers
- None currently. Both mock flags can stay `false` for local dev/demo as
  long as `server/` is running with models set up. `server/.env` needs
  `DEEPGRAM_API_KEY` for the real Deepgram engine — without it, set
  `STT_ENGINE=local` to use the whisper.cpp fallback (what this session's
  testing used).

## Test and deployment status
- No automated tests on the client. Full manual pass against the real,
  merged v3 backend today (job creation, polling, completion, warnings,
  needsReview, resume-unfinished-job) plus earlier real-auth and v2 passes.
  Lint (`oxlint`) and build (`tsc -b && vite build`) both pass. No
  deployment yet.

## Next specific action
Get a Deepgram API key to verify the real engine, then decide on
deployment: client to Vercel, backend to a machine that can run
whisper.cpp/Deepgram + the diarization venv (per backend's tunnel plan).

## Backend status (lz)
- v1 (`/api/transcribe`, `/api/health`) and v2 (accounts, `/api/transcriptions*`) are merged on `main` and unchanged in shape.
- v3 (merged into `main`, commit 3eca76d): **Deepgram Nova-3 Medical + the latest batch diarizer is the primary engine**, with a persistent job system
  (`/api/transcription-jobs*`), file-backed recordings up to 2 hours, `needsReview` flags, `diarizationStatus`, and a secured (off by
  default) callback listener for long recordings. whisper.cpp remains an optional fallback (`STT_ENGINE=local`).
- Verified live with synthetic audio: exact request, model `medical-nova-3`, diarizer v2, A-B-A / 3-speaker / 5-minute recordings
  through the full stack, including **30-minute and 2-hour recordings** (2 h: 29 s end to end, WER 0.73%, DER 0.63%, server memory +110 MB). Known flaws: the 3-speaker case
  misattributes a sentence, and the 2-hour recording produced a spurious 3rd speaker (0.08% of speech; now flagged with a warning, not reassigned).
  Synchronous limit default raised to 2 h. **Not verified:** callbacks against the real service (not needed at these speeds), real microphones/patients.
- Setup: `cd server && npm install && npm run setup:model && npm run setup:diarization && npm run doctor` (set `DEEPGRAM_API_KEY` in `server/.env`).
- Synthetic data only. Not approved for real patient information (Deepgram BAA, consent, retention, encryption, audit logging all pending).
