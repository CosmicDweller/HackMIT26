#!/usr/bin/env bash
# Production build for a deployed client.
#
# Every VITE_USE_MOCK_* flag defaults to MOCK when unset (the checks read `!== "false"`), so a build that simply forgets one ships
# fixtures to production and says so on the landing page. That is exactly what happened on the first deploy: VITE_USE_MOCK_API was
# absent from .env.local, so the judges' link rendered the mock-mode badge. Setting every flag explicitly here means a real build
# cannot silently fall back, and a newly added flag fails loudly in review rather than quietly in production.
#
# Usage: VITE_API_BASE_URL=https://api.example.com npm run build:prod
set -euo pipefail

if [[ -z "${VITE_API_BASE_URL:-}" ]]; then
  echo "VITE_API_BASE_URL is required: the deployed bundle has no dev proxy, so it needs the backend's origin." >&2
  echo "  Usage: VITE_API_BASE_URL=https://api.example.com npm run build:prod" >&2
  exit 1
fi

export VITE_USE_MOCK_API=false
export VITE_USE_MOCK_AUTH=false
export VITE_USE_MOCK_TRANSCRIPTIONS=false
export VITE_USE_MOCK_VOICE_PROFILE=false
export VITE_USE_MOCK_SOAP=false

echo "Building against ${VITE_API_BASE_URL} with every mock disabled."
npm run build

# A mock that survives the build is worse than a failed build: it looks finished and is not. Fail here rather than in front of a judge.
if grep -rql "Balanced detail across all four sections" dist/assets/*.js; then
  echo "FAILED: mock SOAP fixtures are present in the bundle — a mock flag did not take effect." >&2
  exit 1
fi
if ! grep -rql "${VITE_API_BASE_URL#https://}" dist/assets/*.js; then
  echo "FAILED: ${VITE_API_BASE_URL} is not in the bundle — the API base URL did not take effect." >&2
  exit 1
fi
echo "OK: mocks absent, API origin baked in."
