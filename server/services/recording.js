import { mkdtemp } from "node:fs/promises";
import { stat } from "node:fs/promises";
import path from "node:path";
import { run } from "../lib/exec.js";
import { AppError, invalidAudio, requestCancelled, serviceUnavailable } from "../lib/errors.js";

// A recording may overshoot its nominal length by a few hundred milliseconds.
const DURATION_GRACE_SECONDS = 1;

/** Error with a stable job error code (see JOB_ERRORS in jobs.js). */
export class RecordingError extends AppError {
  constructor(jobCode, status, message) {
    super("INVALID_AUDIO", status, message);
    this.jobCode = jobCode;
  }
}

/** Length of a media file in seconds according to ffprobe, or null when it cannot be determined. */
async function probeDuration(file, config, timeoutMs, signal) {
  try {
    const { stdout } = await run(config.ffprobeBin, ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { timeoutMs, signal });
    const seconds = Number.parseFloat(JSON.parse(stdout)?.format?.duration);
    return Number.isFinite(seconds) ? seconds : null;
  } catch (error) {
    if (error.aborted) throw requestCancelled();
    if (error.notFound) throw serviceUnavailable("Audio processing is not available on the server.");
    return null;
  }
}

/**
 * Verify a stored recording and turn it into a compact, file-backed, provider-ready file.
 *
 *  - Decodes the WHOLE recording with FFmpeg, so corruption is detected here, not by the provider.
 *  - Writes mono 16 kHz FLAC (lossless, roughly 40 KB/s, so a 30-minute recording is under 100 MB on
 *    disk and never held in memory).
 *  - Measures the real decoded duration from the output (browser recordings often have no duration
 *    header, so the input's own metadata is not trusted) and enforces the maximum.
 *  - The FFmpeg output is capped just above the limit, so a hostile file cannot produce unbounded output.
 *
 * Returns { path, contentType, bytes, durationSeconds }. The caller deletes `workDir`.
 */
export async function prepareRecording(inputPath, workDir, config, { signal, timeoutMs = 20 * 60_000 } = {}) {
  const outputPath = path.join(workDir, "recording.flac");
  const args = [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    // The input is a file we stored ourselves; refuse to follow network or other protocol references inside it.
    "-protocol_whitelist", "file",
    "-i", inputPath,
    "-vn", "-t", String(config.maxRecordingSeconds + 10),
    "-ac", "1", "-ar", "16000", "-c:a", "flac",
    "-y", outputPath,
  ];
  try {
    await run(config.ffmpegBin, args, { timeoutMs, signal });
  } catch (error) {
    if (error.aborted) throw requestCancelled();
    if (error.notFound) throw serviceUnavailable("Audio processing is not available on the server.");
    if (error.timedOut) throw new RecordingError("INTERNAL", 500, "Audio processing timed out.");
    throw new RecordingError("INVALID_AUDIO", 400, "The file is not valid audio or is in an unsupported format.");
  }

  const durationSeconds = await probeDuration(outputPath, config, 60_000, signal);
  if (durationSeconds === null || durationSeconds <= 0) {
    throw new RecordingError("INVALID_AUDIO", 400, "The recording contains no audio.");
  }
  if (durationSeconds > config.maxRecordingSeconds + DURATION_GRACE_SECONDS) {
    throw new RecordingError("RECORDING_TOO_LONG", 400, `The recording is longer than the maximum of ${config.maxRecordingSeconds} seconds.`);
  }
  const { size } = await stat(outputPath);
  return { path: outputPath, contentType: "audio/flac", bytes: size, durationSeconds: Math.round(durationSeconds * 100) / 100 };
}

/** A private working directory for one job attempt. */
export const makeWorkDir = (config) => mkdtemp(path.join(config.tmpDir, "rec-"));

/** A 16 kHz mono PCM WAV copy of a prepared recording, read region by region by the voice module (never loaded whole). */
export async function toWav(inputPath, outputPath, config, { signal, timeoutMs = 20 * 60_000 } = {}) {
  try {
    await run(config.ffmpegBin, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", outputPath], { timeoutMs, signal });
  } catch (error) {
    if (error.aborted) throw requestCancelled();
    throw new RecordingError("INTERNAL", 500, "Audio processing failed.");
  }
  return outputPath;
}

