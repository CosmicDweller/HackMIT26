# Progress

## Current milestone
`client/` aligned with the agreed v2 contract (`docs/API_CONTRACT.md` on
`lz`, PR #6). Real Supabase Auth is wired up and **verified working
end-to-end** (sign up → real confirmation email → confirm → sign in → sign
out → sign back in, zero console errors). `VITE_USE_MOCK_TRANSCRIPTIONS`
still defaults to true since `/api/transcriptions*` (PR #6) isn't merged
into `main` yet.

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
  client. Selected automatically when `VITE_USE_MOCK_AUTH=false`.
  Credentials received from the owner and put in `client/.env.local`
  (gitignored).
  - Found and fixed a real bug during testing: Supabase's project requires
    email confirmation, so `signUp()` succeeds with no session yet — this
    was surfacing as a red error ("Account created — check your email...")
    when it's actually a success case. Changed `AuthProvider.signUp()` to
    return a `{status: "signed_in" | "confirmation_required"}` result
    instead of throwing, so the signup page can show it as a neutral
    notice. Mock provider updated to match the new signature.
  - **Verified for real, not just against the mock**: signed up with a
    disposable test address, received the actual Supabase confirmation
    email, clicked the real confirmation link, landed authenticated on
    `/dashboard`, signed out, signed back in — all against the owner's
    live Supabase project. No console errors at any step.
- Verified in Chrome (mock transcriptions) after the contract fixes: sign
  up → new transcription → assign both speakers → review status correctly
  stays "Needs review" (confirms the derivation bug is fixed) → "Mark as
  reviewed" flips it → no console errors. Lint and production build pass.

## Remaining prioritized tasks
1. Once backend PR #6 is merged/running locally, set
   `VITE_USE_MOCK_TRANSCRIPTIONS=false` and verify the full flow (real auth
   + real diarization) end to end.
2. Mobile-width layout not manually verified (same known limitation as
   before).
3. Deploy to Vercel.

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
- `/api/transcriptions*` v2 is built on `lz`/PR #6 but not merged into
  `main`; client still defaults to mocks for this feature. Real auth is no
  longer blocked — verified working.

## Test and deployment status
- No automated tests. Manually verified in Chrome per the flow above,
  including a real (non-mock) Supabase auth round trip. Lint (`oxlint`) and
  build (`tsc -b && vite build`) both pass. No deployment yet.

## Next specific action
Once backend PR #6 lands, flip `VITE_USE_MOCK_TRANSCRIPTIONS=false` and
verify the full authenticated + diarized flow against the real backend.

## Backend status (lz, speech-to-text)
- `server/` implements `POST /api/transcribe` and `GET /api/health` per `docs/API_CONTRACT.md`
  (Express + FFmpeg + whisper.cpp `small.en`, real inference verified; ~1.4 s for a 55 s clip on M4 Pro).
- 32 tests pass (`cd server && npm test`), including 5 real-inference tests (WAV, WebM, header-less WebM, silence, noise). Also: VAD stops phantom text on silence, jobs are cancelled on client disconnect, `npm run doctor` preflight/warm-up, optional `?segments=1` timestamps (proposed on #3; default response unchanged).
- Setup: `brew install ffmpeg whisper-cpp`, then `cd server && npm install && npm run setup:model`. See `server/README.md`.
- Proposed contract details (HTTP status codes, CORS, silence -> 422) await frontend confirmation on issue #3.
- Backend PR #5 is open, not merged or deployed. Vercel cannot run whisper.cpp; demo plan is the backend on a laptop behind an HTTPS tunnel (see `server/README.md`).
