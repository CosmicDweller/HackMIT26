# Progress

## Current milestone
Project setup / interface definition. No application code written yet.

## Completed features
- None yet.

## Remaining prioritized tasks
1. Define full API contract for the core pipeline (audio intake, voice profiling,
   transcription, LLM extraction, SOAP note generation) — only the TTS endpoint
   (`API_contract.md`) is specified so far.
2. Scaffold frontend (React + Tailwind + shadcn/ui) and backend (Express + TypeScript).
3. Implement audio input and voice profile generation.
4. Implement live transcription with speaker labeling (Doctor | Patient).
5. Implement LLM extraction pipeline and SOAP note generation.
6. Link SOAP note claims to transcript chunk ids.
7. Deploy to Vercel.

## Architectural decisions
- Node.js/Express/TypeScript backend, React/Tailwind/shadcn frontend, Supabase only
  if persistent storage is needed, Python for the voice-to-document ML model.
- Frontend and backend are being built by separate collaborating agents,
  coordinating via API contract docs and GitHub issue #3.

## Known bugs and blockers
- API contract only covers text-to-speech; the audio-in/transcript/SOAP-note
  interface (the core product flow) is not yet defined.

## Test and deployment status
- No tests written. No deployment yet.

## Next specific action
Agree on and document the API contract for the transcription and SOAP note
pipeline, then begin scaffolding frontend/backend implementations.

## Backend status (lz, speech-to-text)
- `server/` implements `POST /api/transcribe` and `GET /api/health` per `docs/API_CONTRACT.md`
  (Express + FFmpeg + whisper.cpp `base.en`, real inference verified; ~0.6 s for a 55 s clip on M4 Pro).
- 26 tests pass (`cd server && npm test`), including 2 real-inference tests.
- Setup: `brew install ffmpeg whisper-cpp`, then `cd server && npm install && npm run setup:model`. See `server/README.md`.
- Proposed contract details (HTTP status codes, CORS, silence -> 422) await frontend confirmation on issue #3.
- Not merged or deployed. Vercel cannot run whisper.cpp; the backend needs a host with FFmpeg, whisper-cli and the model.
