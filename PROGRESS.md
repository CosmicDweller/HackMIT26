# Progress

## Current milestone
Frontend (`client/`) functionally complete against a mock backend. Waiting on
the real Express/whisper.cpp backend (branch `lz`) to connect to.

## Completed features
- `client/`: Vite + React + TypeScript + Tailwind v4 + shadcn/ui.
- Full speech-to-text user journey, working end-to-end against an in-browser
  mock: record (real mic capture via MediaRecorder, 60s cap, MIME
  auto-detected via `isTypeSupported`) or upload (drag-drop + picker, 10MB
  limit, type validation) → audio preview → transcribe → editable transcript
  with copy / download-as-.txt / new-transcription.
- All required app states implemented: idle, recording, audio-ready,
  transcribing, success, error — including mic-permission-denied, unsupported
  file, oversized file, network failure, and duplicate-submission guarding,
  each with a clear message and a retry path.
- `services/transcribeApi.ts` implements the real contract (`POST
  /api/transcribe`, `GET /api/health`); `services/mockTranscribeApi.ts` is an
  isolated, clearly-labeled mock (output is always prefixed
  `[MOCK TRANSCRIPT — backend not connected]`) used while `VITE_USE_MOCK_API`
  is unset/true. Switch to the real backend by setting
  `VITE_USE_MOCK_API=false` in `client/.env.local` (see `client/.env.example`).
- Vite dev server proxies `/api/*` to `http://localhost:3001`.
- Verified in Chrome: full upload → transcribe → copy journey works, no
  console errors, production build (`tsc -b && vite build`) and lint
  (`oxlint`) both pass.

## Note: product direction changed
This branch previously scaffolded a different product (a doctor/patient
SOAP-note app per the original CLAUDE.md). That work was replaced —
`frontend/` was migrated and rebuilt into `client/` as a speech-to-text app
per updated direction from the user. Root `CLAUDE.md` still describes the old
SOAP-note product and has not been updated; flagging this so it doesn't
mislead the backend agent or a future session.

## Remaining prioritized tasks
1. Backend agent to confirm `POST /api/transcribe` / `GET /api/health` match
   what's implemented here (error codes: INVALID_AUDIO, FILE_TOO_LARGE,
   TRANSCRIPTION_FAILED, SERVICE_UNAVAILABLE).
2. Once backend is up on port 3001, set `VITE_USE_MOCK_API=false` and verify
   the real journey end-to-end.
3. Mobile-width layout not manually verified yet.
4. Deploy to Vercel.

## Architectural decisions
- `client/` owned by the frontend agent (this branch, `kv`); backend owned by
  the agent on branch `lz`. Coordinating via GitHub issue #3.
- Frontend built independently against a mock so it doesn't block on the
  backend; mock is isolated behind one flag/module for an easy swap.

## Known bugs and blockers
- None currently blocking. Backend not yet available to integrate against.

## Test and deployment status
- No automated tests. Manually verified in Chrome (upload → mock transcribe →
  copy, no console errors). Lint and build both pass. No deployment yet.

## Next specific action
Coordinate with the backend agent on issue #3 to confirm the API contract,
then flip `VITE_USE_MOCK_API=false` and verify against the real backend.

## Backend status (lz)
- v1 (`POST /api/transcribe`, `GET /api/health`) is merged and unchanged. See `docs/API_CONTRACT.md`.
- v2 (proposed on issue #3, on branch `lz`): speaker diarization (local sherpa-onnx), Supabase Auth JWT
  verification, and per-doctor transcript storage (local SQLite) with speaker roles, segment corrections, history
  and deletion. 120 backend tests pass (1 live Deepgram test skipped without a key), including real diarization and a real end-to-end run on synthetic
  two-voice conversations (8/8 turns correct; overlapping speech is a known weak spot).
- Setup: `cd server && npm install && npm run setup:model && npm run setup:diarization && npm run doctor`.
- Optional Deepgram cloud engine (STT_ENGINE=deepgram, off by default, tested only against a stub; sends audio to a third party).
- Review confirmation (`POST /api/transcriptions/:id/review`) is implemented (frontend agreed on #3).
- Not done / needs decisions: an end-to-end test with a real signed-in user's token, pyannote Community-1 benchmark (gated model), deployment (laptop + tunnel). Synthetic data only.
