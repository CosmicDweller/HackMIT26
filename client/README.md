# client

Speech-to-text frontend. React + Vite + TypeScript + Tailwind CSS.

## Development

```bash
npm install
npm run dev
```

Requests to `/api/*` proxy to `http://localhost:3001` (the backend), configured in `vite.config.ts`.

By default the app runs against an in-browser mock transcription service (see
`src/services/mockTranscribeApi.ts`) so the UI is fully testable before the
backend exists. Mock output is always prefixed so it's never mistaken for a
real transcript. To use the real backend, copy `.env.example` to `.env.local`
and set `VITE_USE_MOCK_API=false`.

## Structure

```
src/
  components/   UI components
  hooks/        useAudioRecorder, useTranscription
  services/     API client, mock backend, mode config
  types/        shared types
```

## Checks

```bash
npm run lint
npm run build
```
