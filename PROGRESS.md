# Progress

## Current milestone
`client/` aligned with the agreed v2 contract (`docs/API_CONTRACT.md` on
`lz`, PR #6). Real Supabase Auth is wired up in code but not yet turned on —
waiting on the Supabase project URL/anon key from the owner.

## Completed features
- Original single-speaker quick-transcribe flow (`/`) preserved unchanged —
  record/upload → transcribe → edit/copy/download, still against
  `POST /api/transcribe` (real or mock via `VITE_USE_MOCK_API`).
- Blue brand palette applied via design tokens (`client/src/index.css`) —
  Egyptian Blue / Sapphire Sky / Glaucous / Baby Blue Ice / Pale Sky. Every
  component already used semantic tokens (`bg-primary`, `ring-ring`, etc.),
  so no component files needed changes. Status colors (amber/emerald) and
  the multi-hue speaker palette were kept as-is — they're functional
  signals, not brand styling.
- Doctor workspace (dashboard, new transcription, speaker-separated
  transcript viewer, history, export) — see prior entries; unchanged in
  shape, now fixed to match the real backend contract:
  - **List envelope**: `list()` now unwraps `{ transcriptions: [...] }`
    instead of expecting a bare array.
  - **204 on delete**: the request helper no longer tries to parse a body
    for a 204 response (previously `remove()` would throw on every
    successful delete).
  - **Error codes**: renamed `UNAUTHORIZED` → `UNAUTHENTICATED` to match the
    backend; added `INVALID_REQUEST` and `SERVER_ERROR`. On
    `UNAUTHENTICATED` the client now calls `signOut()`, which flips auth
    state and lets `ProtectedRoute` redirect to `/login` automatically.
  - **Review status is no longer client-derived.** Previously the mock
    flipped `reviewStatus` to `reviewed` automatically once every speaker
    had a role — the real backend never does this. Added an explicit
    "Mark as reviewed" button (`POST /api/transcriptions/:id/review`, no
    body) and removed the auto-derivation from the mock so it matches.
  - **`diarization.status`**: new field on the transcription resource
    (`ok` | `failed` | `unavailable`). When not `ok`, the client shows
    "speaker detection unavailable/failed — assign speakers manually"
    instead of an empty or misleadingly-normal speaker view.
  - **`expectedSpeakers`**: the new-transcription flow now sends
    `expectedSpeakers=2` with the upload (a consultation is doctor +
    patient by default), per the backend's note that it improves speaker
    counting.
  - Mock (`mockTranscriptionsApi.ts`) updated to match all of the above so
    it still behaves like the real backend.
- Real Supabase Auth provider added (`services/auth/supabaseAuthProvider.ts`,
  `@supabase/supabase-js`), implementing the same `AuthProvider` interface
  as the mock — sign up/in/out, password reset, session, and the access
  token attached as `Authorization: Bearer` by the transcriptions API
  client. Selected automatically when `VITE_USE_MOCK_AUTH=false`. **Not
  testable yet** — needs `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from
  the Supabase project the backend agent configured; asked for these on
  issue #3.
- Verified in Chrome (mock mode) after all the above: sign up → new
  transcription → assign both speakers → review status correctly stays
  "Needs review" (confirms the derivation bug is fixed) → "Mark as
  reviewed" flips it → no console errors. Lint and production build pass.

## Remaining prioritized tasks
1. Get `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from the owner, set
   `VITE_USE_MOCK_AUTH=false`, verify real sign-in end to end.
2. Once backend PR #6 is merged/running locally, set
   `VITE_USE_MOCK_TRANSCRIPTIONS=false` and verify the full flow against
   the real diarization backend.
3. Reply on issue #3: confirm the list-envelope shape (agreed — no change
   needed), confirm wanting `POST /api/transcriptions/:id/review`
   (implemented client-side already).
4. Mobile-width layout not manually verified (same known limitation as
   before).
5. Deploy to Vercel.

## Architectural decisions
- `client/` owned by the frontend agent (branch `kv`); backend owned by the
  agent on branch `lz`. Coordinating via issue #3.
- Original quick-transcribe flow kept as-is at `/`, not merged into the new
  authenticated flow, per "preserve existing functionality."
- Auth and the transcriptions API each sit behind their own
  provider-agnostic service + mock flag (`VITE_USE_MOCK_AUTH`,
  `VITE_USE_MOCK_TRANSCRIPTIONS`), same pattern as the existing
  `VITE_USE_MOCK_API` — real backends swap in without UI changes. Real
  Supabase provider is written but gated on missing credentials.

## Known bugs and blockers
- Real Supabase auth is implemented but unverified — blocked on project
  credentials (asked for on issue #3).
- `/api/transcriptions*` v2 is built on `lz`/PR #6 but not merged into
  `main`; client still defaults to mocks for this feature.

## Test and deployment status
- No automated tests. Manually verified in Chrome per the flow above. Lint
  (`oxlint`) and build (`tsc -b && vite build`) both pass. No deployment yet.

## Next specific action
Reply on issue #3 with the two open answers (list envelope, review
endpoint) and ask for Supabase credentials; then verify against the real
backend once both are available.

## Backend status (lz, speech-to-text)
- `server/` implements `POST /api/transcribe` and `GET /api/health` per `docs/API_CONTRACT.md`
  (Express + FFmpeg + whisper.cpp `small.en`, real inference verified; ~1.4 s for a 55 s clip on M4 Pro).
- 32 tests pass (`cd server && npm test`), including 5 real-inference tests (WAV, WebM, header-less WebM, silence, noise). Also: VAD stops phantom text on silence, jobs are cancelled on client disconnect, `npm run doctor` preflight/warm-up, optional `?segments=1` timestamps (proposed on #3; default response unchanged).
- Setup: `brew install ffmpeg whisper-cpp`, then `cd server && npm install && npm run setup:model`. See `server/README.md`.
- Proposed contract details (HTTP status codes, CORS, silence -> 422) await frontend confirmation on issue #3.
- Backend PR #5 is open, not merged or deployed. Vercel cannot run whisper.cpp; demo plan is the backend on a laptop behind an HTTPS tunnel (see `server/README.md`).
