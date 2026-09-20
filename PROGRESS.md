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
Frontend: the SOAP contract is confirmed and implemented on `lz` (issue #3) — swap
`VITE_USE_MOCK_SOAP` off once `lz` merges. Backend: run the real-Gemini tests (needs
`GEMINI_API_KEY` in `server/.env`), then open the PR.

## Backend status (lz)
- v1 (`/api/transcribe`, `/api/health`) and v2 (accounts, `/api/transcriptions*`) are merged on `main` and unchanged in shape.
- v3 (branch `lz`): **Deepgram Nova-3 Medical + the latest batch diarizer is the primary engine**, with a persistent job system
  (`/api/transcription-jobs*`), file-backed recordings up to **30 minutes each** (limit lowered from 2 hours on 2026-09-20; the frontend's recorder still says 2 h: see Contract v5), `needsReview` flags, `diarizationStatus`, and a secured (off by
  default) callback listener for long recordings. whisper.cpp remains an optional fallback (`STT_ENGINE=local`).
- Verified live with synthetic audio: exact request, model `medical-nova-3`, diarizer v2, A-B-A / 3-speaker / 5-minute recordings
  through the full stack, including 30-minute and (before the limit was lowered) 2-hour recordings (2 h: 29 s end to end, WER 0.73%, DER 0.63%, server memory +110 MB). Known flaws: the 3-speaker case
  misattributes a sentence, and the 2-hour recording produced a spurious 3rd speaker (0.08% of speech; now flagged with a warning, not reassigned).
  Synchronous limit default is now 30 min (equal to the recording maximum). **Not verified:** callbacks against the real service (not needed at these speeds), real microphones/patients.
- v4 (branch `lz`, not yet merged): **doctor voice enrollment and identification** (`/api/me/voice-profile`), local SpeechBrain ECAPA-TDNN, independent speaker check when Deepgram finds <=1 speaker, `identificationStatus` / `suggestedRole` on speakers (suggestion only; `role` stays the doctor's). Encrypted profiles, explicit consent. Measured on SYNTHETIC voices only: 0/162 false doctor matches with the doctor absent; recovers 3 of 11 Deepgram merges at the conservative setting; thresholds must be re-measured with real consenting speakers. See docs/VOICE_EVALUATION.md and Contract v4. Setup: `npm run setup:voice`, set `VOICE_PROFILE_KEY`.
- v5 (branch `lz`, not merged): **pyannote Community-1 diarization** (local, gated model, `npm run setup:pyannote`). Deepgram still transcribes; pyannote decides who spoke when and its turns are aligned to Deepgram's words. Default policy `more-speakers` (adopt pyannote only when it hears MORE speakers): measured on 162 synthetic recordings it recovers 5 of 11 Deepgram merges with 0 regressions and 0 false splits, where "always" would have broken 32 of 151. Measured limit: one short exchange (7 s) is heard as one speaker.
- v6 (branch `lz`, not merged): **SOAP notes via Gemini 2.5 Flash.** Two-stage generation (facts with sources, then composition) from the FINAL STORED transcript, deterministic grounding checks against that transcript, review flags, doctor editing with optimistic concurrency, explicit approval that locks the note, PDF/TXT export. One note per consultation, never regenerated. `docs/SOAP_API_CONTRACT.md` (frontend's proposed contract adopted as-is). Real-Gemini tests written; **NOT yet run — needs GEMINI_API_KEY**.
- Setup: `cd server && npm install && npm run setup:model && npm run setup:diarization && npm run doctor` (set `DEEPGRAM_API_KEY` in `server/.env`).
- Synthetic data only. Not approved for real patient information (Deepgram BAA, consent, retention, encryption, audit logging all pending).
