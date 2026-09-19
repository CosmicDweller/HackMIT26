# Progress

## Current milestone
Project setup / interface definition. No application code written yet.

## Completed features
- Frontend scaffold (`frontend/`): Vite + React + TypeScript + Tailwind v4 + shadcn/ui.
- Core UI flow, wired end-to-end against mock data: voice enrollment (real
  in-browser mic recording) → record patient visit (real mic recording) →
  timestamped, speaker-labeled transcript → SOAP note with claims linking back
  to specific transcript chunks.
- Stub API client (`frontend/src/api/client.ts`) isolates the not-yet-defined
  backend calls (enroll voice profile, upload recording, get transcript, get
  SOAP note) so real endpoints can be swapped in without touching UI code.

## Remaining prioritized tasks
1. Define API contract for the core pipeline (voice profiling, transcription,
   LLM extraction, SOAP note generation) — only the unrelated TTS endpoint
   (`API_contract.md`) is specified so far. Open question posted on issue #3.
2. Scaffold backend (Express + TypeScript).
3. Wire real voice profile generation, transcription, and SOAP generation
   behind the existing stub API client.
4. Deploy to Vercel.

## Architectural decisions
- Node.js/Express/TypeScript backend, React/Tailwind/shadcn frontend, Supabase only
  if persistent storage is needed, Python for the voice-to-document ML model.
- Frontend and backend are being built by separate collaborating agents,
  coordinating via API contract docs and GitHub issue #3.

## Known bugs and blockers
- API contract only covers text-to-speech; the audio-in/transcript/SOAP-note
  interface (the core product flow) is not yet defined. Frontend is built
  against mock data in the meantime via a stub API client.
- Mobile-width layout not manually verified (browser automation could not
  resize the viewport this session); UI uses relative/flex-wrap classes only,
  no fixed widths, so it should reflow, but this is unconfirmed.

## Test and deployment status
- No automated tests written. Manually verified in Chrome: enrollment screen
  renders and records via MediaRecorder, SOAP note renders mock data, and
  claim → transcript chunk deep links correctly scroll/highlight. Lint
  (`oxlint`) and typecheck/build (`tsc -b && vite build`) pass. No deployment yet.

## Next specific action
Agree on the API contract for the transcription/SOAP-note pipeline with the
backend agent (tracked on issue #3), then wire the stub API client to real
endpoints.
