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
