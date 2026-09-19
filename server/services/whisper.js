import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileExists, run } from "../lib/exec.js";
import { requestCancelled, serviceUnavailable, transcriptionFailed } from "../lib/errors.js";

/** Remove whisper's non-speech markers such as [BLANK_AUDIO] or [MUSIC]. */
function cleanTranscript(segments) {
  return segments
    .map((segment) => segment.text ?? "")
    .join(" ")
    .replace(/\[[A-Z_ ]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Run whisper.cpp on a 16 kHz mono WAV and return the transcript text.
 * Reads whisper's structured JSON output rather than parsing terminal logs.
 * `workDir` must be a directory private to this request.
 */
export async function transcribeWav(wavPath, workDir, config, timeoutMs, signal) {
  const outputPrefix = path.join(workDir, "result");
  const args = [
    "-m", config.whisperModel,
    "-f", wavPath,
    "-l", config.whisperLanguage,
    "-t", String(config.whisperThreads),
    "-sns",
    "-np",
    "-oj",
    "-of", outputPrefix,
  ];
  if (config.whisperVadModel && (await fileExists(config.whisperVadModel))) {
    args.push("--vad", "-vm", config.whisperVadModel);
  }

  try {
    await run(config.whisperBin, args, { timeoutMs, signal });
  } catch (error) {
    if (error.aborted) throw requestCancelled();
    if (error.notFound) throw serviceUnavailable("Speech recognition is not available on the server.");
    if (error.timedOut) throw transcriptionFailed("Transcription timed out.", 504);
    console.error("whisper-cli failed:", error.message, (error.stderr ?? "").slice(-500));
    throw transcriptionFailed();
  }

  let segments;
  try {
    const result = JSON.parse(await readFile(`${outputPrefix}.json`, "utf8"));
    segments = result.transcription;
    if (!Array.isArray(segments)) throw new Error("missing transcription array");
  } catch (error) {
    console.error("could not read whisper output:", error.message);
    throw transcriptionFailed();
  }

  const text = cleanTranscript(segments);
  if (!text) throw transcriptionFailed("No speech was detected in the recording.", 422);
  return text;
}
