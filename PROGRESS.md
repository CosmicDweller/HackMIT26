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

## Backend status (lz, speech-to-text)
- `server/` implements `POST /api/transcribe` and `GET /api/health` per `docs/API_CONTRACT.md`
  (Express + FFmpeg + whisper.cpp `small.en`, real inference verified; ~1.4 s for a 55 s clip on M4 Pro).
- 32 tests pass (`cd server && npm test`), including 5 real-inference tests (WAV, WebM, header-less WebM, silence, noise). Also: VAD stops phantom text on silence, jobs are cancelled on client disconnect, `npm run doctor` preflight/warm-up, optional `?segments=1` timestamps (proposed on #3; default response unchanged).
- Setup: `brew install ffmpeg whisper-cpp`, then `cd server && npm install && npm run setup:model`. See `server/README.md`.
- Proposed contract details (HTTP status codes, CORS, silence -> 422) await frontend confirmation on issue #3.
- Backend PR #5 is open, not merged or deployed. Vercel cannot run whisper.cpp; demo plan is the backend on a laptop behind an HTTPS tunnel (see `server/README.md`).
