import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));

function intFromEnv(env, name, fallback) {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Build the runtime config from environment variables. Relative paths resolve against server/. */
export function loadConfig(env = process.env) {
  return {
    // Speech engine for authenticated transcriptions: "deepgram" (primary: Nova-3 Medical + batch
    // diarization) or "local" (the previous whisper.cpp + sherpa-onnx engine, kept as an optional
    // fallback; short recordings only). There is NO automatic fallback between them: a Deepgram failure
    // is reported as a failure. The public /api/transcribe is always local.
    sttEngine: env.STT_ENGINE === "local" ? "local" : "deepgram",
    deepgramApiKey: env.DEEPGRAM_API_KEY ?? "",
    deepgramModel: env.DEEPGRAM_MODEL ?? "nova-3-medical",
    // "latest" resolves to Deepgram's batch diarizer (v2 as of 2026-09). Never combined with diarize=true.
    deepgramDiarizeModel: env.DEEPGRAM_DIARIZE_MODEL ?? "latest",
    deepgramLanguage: env.DEEPGRAM_LANGUAGE ?? "en",
    // Optional Nova-3 keyterm prompting (comma separated medical terms). Empty by default.
    deepgramKeyterms: (env.DEEPGRAM_KEYTERMS ?? "").split(",").map((term) => term.trim()).filter(Boolean),
    // Optional, explicit, never silent: a different model to try when the primary is unavailable.
    deepgramFallbackModel: env.DEEPGRAM_FALLBACK_MODEL ?? "",
    deepgramBaseUrl: env.DEEPGRAM_BASE_URL ?? "https://api.deepgram.com",
    // Deepgram returns 504 for synchronous requests over 10 minutes; stay below that.
    deepgramTimeoutMs: intFromEnv(env, "DEEPGRAM_TIMEOUT_MS", 9 * 60_000),
    // Recordings longer than this need a callback (async) request; without one they are rejected up
    // front (before any audio is sent) rather than risking a 10-minute timeout that loses the result.
    // Default = the recording maximum: a real 2-hour recording was processed in 29 s (10 s at Deepgram).
    // Lower it on a slow uplink: the whole upload must finish inside DEEPGRAM_TIMEOUT_MS.
    deepgramSyncMaxSeconds: intFromEnv(env, "DEEPGRAM_SYNC_MAX_SECONDS", 7200),
    // Public URL that Deepgram can POST results to (for long recordings). Empty = callbacks disabled.
    deepgramCallbackBaseUrl: env.DEEPGRAM_CALLBACK_BASE_URL ?? "",
    callbackPort: intFromEnv(env, "CALLBACK_PORT", 8443),
    callbackDeadlineMs: intFromEnv(env, "CALLBACK_DEADLINE_MS", 6 * 60 * 60_000),
    // Segments below these confidences are flagged needsReview (advisory only).
    reviewWordConfidence: Number.parseFloat(env.REVIEW_WORD_CONFIDENCE ?? "") || 0.85,
    reviewSpeakerConfidence: Number.parseFloat(env.REVIEW_SPEAKER_CONFIDENCE ?? "") || 0.6,
    // Recordings (jobs): original uploads are file-backed under uploadDir.
    maxRecordingSeconds: intFromEnv(env, "MAX_RECORDING_SECONDS", 7200),
    maxRecordingBytes: intFromEnv(env, "MAX_RECORDING_BYTES", 1024 * 1024 * 1024),
    ffprobeBin: env.FFPROBE_BIN ?? "ffprobe",
    uploadDir: path.resolve(serverDir, env.UPLOAD_DIR ?? "data/uploads"),
    // Failed jobs keep their audio this long so they can be retried; completed jobs delete it at once.
    audioRetentionHours: intFromEnv(env, "AUDIO_RETENTION_HOURS", 24),
    maxConcurrentJobs: intFromEnv(env, "MAX_CONCURRENT_JOBS", 2),
    maxSubmitAttempts: intFromEnv(env, "MAX_SUBMIT_ATTEMPTS", 3),
    // How long POST /api/transcriptions (the synchronous convenience route) waits before answering 202.
    syncWaitMs: intFromEnv(env, "SYNC_WAIT_MS", 180_000),
    port: intFromEnv(env, "PORT", 3001),
    corsOrigin: env.CORS_ORIGIN ?? "http://localhost:5173",
    ffmpegBin: env.FFMPEG_BIN ?? "ffmpeg",
    whisperBin: env.WHISPER_BIN ?? "whisper-cli",
    whisperModel: path.resolve(serverDir, env.WHISPER_MODEL ?? "models/ggml-small.en.bin"),
    // Voice activity detection stops whisper hallucinating text ("you", "Thank you.") on silence.
    // Enabled when the model file exists; set WHISPER_VAD_MODEL= (empty) to disable.
    whisperVadModel:
      env.WHISPER_VAD_MODEL === ""
        ? null
        : path.resolve(serverDir, env.WHISPER_VAD_MODEL ?? "models/ggml-silero-v5.1.2.bin"),
    whisperLanguage: env.WHISPER_LANGUAGE ?? "en",
    whisperThreads: intFromEnv(env, "WHISPER_THREADS", 4),
    maxUploadBytes: intFromEnv(env, "MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
    maxDurationSeconds: intFromEnv(env, "MAX_DURATION_SECONDS", 60),
    processTimeoutMs: intFromEnv(env, "PROCESS_TIMEOUT_MS", 120_000),
    maxConcurrent: intFromEnv(env, "MAX_CONCURRENT", 2),
    // Speaker diarization (local Python module, see diarization/diarize.py).
    diarizationEnabled: env.DIARIZATION_ENABLED !== "false",
    diarizationPython: path.resolve(serverDir, env.DIARIZATION_PYTHON ?? "diarization/.venv/bin/python"),
    diarizationScript: path.join(serverDir, "diarization", "diarize.py"),
    diarizationThreshold: Number.parseFloat(env.DIARIZATION_THRESHOLD ?? "") || 0.4,
    diarizationTimeoutMs: intFromEnv(env, "DIARIZATION_TIMEOUT_MS", 60_000),
    // Transcript database (SQLite). Contains transcripts: keep out of Git and back it up carefully.
    dbPath: path.resolve(serverDir, env.DB_PATH ?? "data/transcripts.sqlite"),
    // Doctor authentication: Supabase Auth JWTs are verified against the project's published keys.
    supabaseUrl: env.SUPABASE_URL ?? "",
    // Doctor voice profiles (biometric): local ECAPA-TDNN embeddings, encrypted at rest with VOICE_PROFILE_KEY.
    voiceEnabled: env.VOICE_ENABLED !== "false",
    voicePython: path.resolve(serverDir, env.VOICE_PYTHON ?? "voice/.venv/bin/python"),
    voiceScript: path.join(serverDir, "voice", "embed.py"),
    voiceProfileKey: env.VOICE_PROFILE_KEY ?? "",
    voiceTimeoutMs: intFromEnv(env, "VOICE_TIMEOUT_MS", 10 * 60_000),
    // The independent speaker check runs the segmentation model over the whole recording. Measured: about 2 minutes for 20 minutes of
    // audio, and much worse than linear (over 10 minutes for two hours). Longer recordings skip it (with a warning); doctor
    // identification, which embeds a bounded number of regions, still runs.
    voiceIndependentMaxSeconds: intFromEnv(env, "VOICE_INDEPENDENT_MAX_SECONDS", 30 * 60),
    // Speaker diarization with pyannote Community-1 (local Python worker, isolated venv). Separate PYANNOTE_* names because DIARIZATION_*
    // already configures the older sherpa-onnx module. Community-1 says who spoke when; Deepgram still says what was said.
    pyannoteEnabled: env.PYANNOTE_ENABLED !== "false",
    pyannotePython: path.resolve(serverDir, env.PYANNOTE_PYTHON ?? ".venv-diarization/bin/python"),
    pyannoteScript: path.join(serverDir, "diarization", "pyannote_diarize.py"),
    pyannoteDevice: env.PYANNOTE_DEVICE ?? "cpu", // cpu | mps | cuda: CPU is the verified baseline
    pyannoteModelCache: env.PYANNOTE_MODEL_CACHE ? path.resolve(serverDir, env.PYANNOTE_MODEL_CACHE) : "", // empty = the Hugging Face default cache
    pyannoteMaxConcurrent: intFromEnv(env, "PYANNOTE_MAX_CONCURRENT_JOBS", 1),
    // A run gets max(PYANNOTE_TIMEOUT_MIN_MS, audio length x PYANNOTE_TIMEOUT_FACTOR), never more than PYANNOTE_TIMEOUT_MAX_MS.
    pyannoteTimeoutMinMs: intFromEnv(env, "PYANNOTE_TIMEOUT_MIN_MS", 120_000),
    pyannoteTimeoutFactor: Number.parseFloat(env.PYANNOTE_TIMEOUT_FACTOR ?? "") || 1,
    pyannoteTimeoutMaxMs: intFromEnv(env, "PYANNOTE_TIMEOUT_MAX_MS", 4 * 60 * 60_000),
    // "always": speakers come from pyannote whenever it runs. "when-merged": only when Deepgram found at most one speaker.
    pyannotePolicy: env.PYANNOTE_POLICY === "when-merged" ? "when-merged" : "always",
    tmpDir: path.resolve(env.STT_TMP_DIR ?? path.join(os.tmpdir(), "stt-server")),
  };
}
