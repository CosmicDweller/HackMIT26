# Progress

## Current milestone
`client/` extended into a doctor-accounts + speaker-diarization workspace,
built and fully demoable against in-memory mocks. Waiting on the backend
agent to build the proposed `/api/transcriptions*` endpoints and confirm the
auth provider (both proposed on issue #3).

## Completed features
- Original single-speaker quick-transcribe flow (`/`) preserved unchanged —
  record/upload → transcribe → edit/copy/download, still against
  `POST /api/transcribe` (real or mock via `VITE_USE_MOCK_API`).
- New doctor workspace, added alongside it:
  - Auth: sign up, sign in, password reset request, sign out, loading state,
    protected routes (redirect to `/login`, return to original destination
    after sign-in). Provider-agnostic (`services/auth/authProvider.ts`)
    behind a mock (`VITE_USE_MOCK_AUTH`) — in-memory only, session does not
    survive a page reload (documented limitation of the mock, not the real
    provider). Supabase Auth proposed on issue #3 as the real provider.
  - Dashboard shell: sidebar (Dashboard / New transcription / Transcript
    history / Account / Sign out), responsive (collapses to a top bar on
    mobile).
  - New transcription: reuses the existing record/upload components against
    a new `transcriptions` service; recording-consent reminder shown before
    every capture.
  - Speaker-separated transcript viewer: colored per-speaker labels,
    timestamps, "Who's who?" mapping (Doctor/Patient/Other/Unassigned per
    speaker, updates every segment for that speaker), per-segment speaker
    reassignment, inline segment text editing (autosave on blur + explicit
    Save, saving/saved indicators, `beforeunload` guard while a segment is
    dirty), review-status badge, unreviewed-content warning.
  - Transcript history: list with date/duration/review status, open, delete
    with confirmation.
  - Export as `.txt` in the `Doctor [mm:ss]` / text format from the spec;
    warns (via confirm) before exporting an unreviewed transcript.
  - `services/transcriptions/`: real client matching the endpoints proposed
    on issue #3, and an isolated mock (`VITE_USE_MOCK_TRANSCRIPTIONS`) that
    always returns the same clearly-labeled synthetic consultation fixture —
    never analyzes real audio content, so it can't be mistaken for a real
    diarization result.
- Fixed on backend agent's request: `ErrorBanner` now shows the server's
  actual message prominently instead of a generic line burying it.
- Verified in Chrome end-to-end: sign up → dashboard → new transcription
  (upload) → speaker mapping → segment edit (autosave) → review status
  flips to Reviewed → history list → sign out → protected-route redirect →
  password-reset page. No console errors. Lint and production build both
  pass.

## Remaining prioritized tasks
1. Backend agent to confirm/build `/api/transcriptions*` (create, list, get,
   delete, PATCH speakers, PATCH segments) and the Supabase Auth proposal —
   posted on issue #3, awaiting reply.
2. Once confirmed: wire `services/auth` to real Supabase, set
   `VITE_USE_MOCK_AUTH=false` and `VITE_USE_MOCK_TRANSCRIPTIONS=false`,
   verify against the real backend.
3. Mobile-width layout not manually verified (same known limitation as
   before — browser automation here can't reliably resize the viewport).
4. Deploy to Vercel.

## Architectural decisions
- `client/` owned by the frontend agent (branch `kv`); backend owned by the
  agent on branch `lz`. Coordinating via issue #3.
- Original quick-transcribe flow kept as-is at `/`, not merged into the new
  authenticated flow, per "preserve existing functionality" — the new
  dashboard flow is additive, not a replacement.
- Auth and the new transcriptions API each sit behind their own
  provider-agnostic service + mock flag (`VITE_USE_MOCK_AUTH`,
  `VITE_USE_MOCK_TRANSCRIPTIONS`), same pattern as the existing
  `VITE_USE_MOCK_API`, so real backends swap in without UI changes.

## Known bugs and blockers
- Mock auth session is in-memory only (resets on page reload) — acceptable
  for the mock, but real Supabase will persist sessions properly.
- Not a blocker, but noted: the real `/api/transcriptions*` endpoints don't
  exist on the backend yet, so this whole feature runs on mocks until issue
  #3 is resolved.

## Test and deployment status
- No automated tests. Manually verified in Chrome per the flow above. Lint
  (`oxlint`) and build (`tsc -b && vite build`) both pass. No deployment yet.

## Next specific action
Wait for the backend agent's reply on issue #3 (auth provider +
`/api/transcriptions*` contract), then wire the real implementations behind
the existing mock flags.

## Backend status (lz, speech-to-text)
- `server/` implements `POST /api/transcribe` and `GET /api/health` per `docs/API_CONTRACT.md`
  (Express + FFmpeg + whisper.cpp `small.en`, real inference verified; ~1.4 s for a 55 s clip on M4 Pro).
- 32 tests pass (`cd server && npm test`), including 5 real-inference tests (WAV, WebM, header-less WebM, silence, noise). Also: VAD stops phantom text on silence, jobs are cancelled on client disconnect, `npm run doctor` preflight/warm-up, optional `?segments=1` timestamps (proposed on #3; default response unchanged).
- Setup: `brew install ffmpeg whisper-cpp`, then `cd server && npm install && npm run setup:model`. See `server/README.md`.
- Proposed contract details (HTTP status codes, CORS, silence -> 422) await frontend confirmation on issue #3.
- Backend PR #5 is open, not merged or deployed. Vercel cannot run whisper.cpp; demo plan is the backend on a laptop behind an HTTPS tunnel (see `server/README.md`).
