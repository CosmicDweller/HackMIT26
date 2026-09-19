import { executableExists, fileExists } from "../lib/exec.js";

/**
 * Checks that FFmpeg, the whisper.cpp executable and the model file are present.
 * Nothing is executed, so this is cheap enough to call from the health endpoint.
 * Returns { ready, missing } where `missing` lists names for server-side logs only.
 */
export async function checkReadiness(config) {
  const [ffmpeg, whisper, model] = await Promise.all([
    executableExists(config.ffmpegBin),
    executableExists(config.whisperBin),
    fileExists(config.whisperModel),
  ]);
  const missing = [];
  if (!ffmpeg) missing.push("ffmpeg");
  if (!whisper) missing.push("whisper executable");
  if (!model) missing.push("whisper model");
  return { ready: missing.length === 0, missing };
}
