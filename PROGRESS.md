# Progress

## Current milestone
**Full stack verified end-to-end against the real backend.** PR #6 (backend
v2: diarization, Supabase Auth, per-doctor transcripts) is merged into
`main`. `kv` is merged with `main`, `VITE_USE_MOCK_AUTH=false` and
`VITE_USE_MOCK_TRANSCRIPTIONS=false`, and the whole doctor workspace was run
for real — real sign-in, real whisper.cpp transcription, real local
diarization — with zero console errors.

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
1. Mobile-width layout not manually verified (browser automation here
   can't reliably resize the viewport).
2. Deploy to Vercel (client) + decide on backend hosting (laptop + tunnel
   per backend's plan, since Vercel can't run whisper.cpp).
3. Optional: surface `GET /api/me` somewhere (not required by any current
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
  long as `server/` is running with models set up.

## Test and deployment status
- No automated tests on the client. Full manual pass against the real
  backend today (see above) plus the earlier real-auth-only pass. Lint
  (`oxlint`) and build (`tsc -b && vite build`) both pass. No deployment
  yet.

## Next specific action
Decide on deployment: client to Vercel, backend to a machine that can run
whisper.cpp + the diarization venv (per backend's tunnel plan).

## Backend status (lz)
- v1 (`POST /api/transcribe`, `GET /api/health`) is merged and unchanged. See `docs/API_CONTRACT.md`.
- v2 (agreed on issue #3): speaker diarization (local sherpa-onnx), Supabase Auth JWT
  verification, and per-doctor transcript storage (local SQLite) with speaker roles, segment corrections, history
  and deletion. 120 backend tests pass (1 live Deepgram test skipped without a key), including real diarization and a real end-to-end run on synthetic
  two-voice conversations (8/8 turns correct; overlapping speech is a known weak spot).
- Setup: `cd server && npm install && npm run setup:model && npm run setup:diarization && npm run doctor`.
- Optional Deepgram cloud engine (STT_ENGINE=deepgram, model nova-3-medical, verified live with synthetic audio; sends audio to a third party).
- Review confirmation (`POST /api/transcriptions/:id/review`) is implemented (frontend agreed on #3).
- **Merged into `main` (593bb45).** Contract v2 marked agreed in `docs/API_CONTRACT.md`.
- Not done / needs decisions: pyannote Community-1 benchmark (gated model), deployment (laptop + tunnel). Synthetic data only.
