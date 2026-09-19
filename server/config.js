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
    tmpDir: path.resolve(env.STT_TMP_DIR ?? path.join(os.tmpdir(), "stt-server")),
  };
}
