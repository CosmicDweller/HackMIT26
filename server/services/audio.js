import { open, stat } from "node:fs/promises";
import { run } from "../lib/exec.js";
import { invalidAudio, requestCancelled, serviceUnavailable, transcriptionFailed } from "../lib/errors.js";

// Output format is fixed: 16 kHz, mono, signed 16-bit PCM = 32,000 bytes per second.
const BYTES_PER_SECOND = 16000 * 2;
// Recorders often overshoot a "60 second" recording by a few milliseconds.
const DURATION_GRACE_SECONDS = 0.5;

/** Duration in seconds of a canonical PCM WAV file, from its `data` chunk size. */
export async function wavDurationSeconds(wavPath) {
  const { size: fileSize } = await stat(wavPath);
  const handle = await open(wavPath, "r");
  try {
    const header = Buffer.alloc(Math.min(fileSize, 4096));
    await handle.read(header, 0, header.length, 0);
    let offset = 12; // skip "RIFF" <size> "WAVE"
    while (offset + 8 <= header.length) {
      const id = header.toString("ascii", offset, offset + 4);
      const chunkSize = header.readUInt32LE(offset + 4);
      if (id === "data") {
        const dataBytes = chunkSize === 0xffffffff ? fileSize - (offset + 8) : chunkSize;
        return dataBytes / BYTES_PER_SECOND;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    throw new Error("WAV data chunk not found");
  } finally {
    await handle.close();
  }
}

/**
 * Decode any FFmpeg-readable audio into 16 kHz mono PCM16 WAV.
 * Output is capped just above the duration limit so a hostile file cannot make FFmpeg
 * write unbounded data. Returns { durationSeconds }.
 */
export async function convertToWav(inputPath, outputPath, config, timeoutMs, signal) {
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    // The input is a file we wrote ourselves; refuse to follow network or other protocol references inside it.
    "-protocol_whitelist", "file",
    "-i", inputPath,
    "-vn",
    "-t", String(config.maxDurationSeconds + 1),
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    "-f", "wav",
    "-y", outputPath,
  ];

  try {
    await run(config.ffmpegBin, args, { timeoutMs, signal });
  } catch (error) {
    if (error.aborted) throw requestCancelled();
    if (error.notFound) throw serviceUnavailable("Audio processing is not available on the server.");
    if (error.timedOut) throw transcriptionFailed("Audio processing timed out.", 504);
    // Non-zero exit: FFmpeg could not decode the upload (not audio, corrupt, no audio stream).
    throw invalidAudio("The file is not valid audio or is in an unsupported format.");
  }

  let durationSeconds;
  try {
    durationSeconds = await wavDurationSeconds(outputPath);
  } catch {
    throw invalidAudio("The file is not valid audio or is in an unsupported format.");
  }

  if (durationSeconds <= 0) throw invalidAudio("The audio file contains no audio.");
  if (durationSeconds > config.maxDurationSeconds + DURATION_GRACE_SECONDS) {
    throw invalidAudio(`The audio is too long. The maximum length is ${config.maxDurationSeconds} seconds.`);
  }
  return { durationSeconds: Math.round(durationSeconds * 100) / 100 };
}
