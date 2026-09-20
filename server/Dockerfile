# Backend image for a container host (Render/Railway/Fly).
#
# Deliberately node-only. The voice profile (ECAPA-TDNN) and pyannote diarization are Python subprocesses backed by a ~700 MB torch
# virtualenv; shipping them would push the image past 2 GB and past the RAM of a small instance. They are disabled by env below, and
# the app boots without them. Deepgram (speech) and Gemini (SOAP notes) are plain HTTPS calls, so the demo's main path is intact.
#
# ffmpeg/ffprobe stay: the job pipeline probes duration and normalises audio before sending it to Deepgram.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source-only change does not reinstall them.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Written at runtime and must outlive a deploy, so both live on the mounted disk (see render.yaml).
ENV DB_PATH=/data/transcripts.sqlite \
    UPLOAD_DIR=/data/uploads \
    STT_ENGINE=deepgram \
    VOICE_ENABLED=false \
    PYANNOTE_ENABLED=false \
    DIARIZATION_ENABLED=false \
    NODE_ENV=production

EXPOSE 3001
CMD ["node", "index.js"]
