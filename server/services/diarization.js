import path from "node:path";
import { fileExists, run } from "../lib/exec.js";
import { requestCancelled } from "../lib/errors.js";

// Relative to the directory containing diarize.py.
const MODEL_FILES = [
  "models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx",
  "models/wespeaker_en_voxceleb_resnet34_LM.onnx",
];

/** Names of installed/missing pieces for the doctor script. Nothing is executed. */
export async function diarizationSetup(config) {
  const dir = path.dirname(config.diarizationScript);
  return {
    enabled: config.diarizationEnabled,
    python: await fileExists(config.diarizationPython),
    script: await fileExists(config.diarizationScript),
    models: (await Promise.all(MODEL_FILES.map((file) => fileExists(path.join(dir, file))))).every(Boolean),
  };
}

/** True when the Python interpreter and script exist. Missing models are reported by the script itself. */
export async function diarizationAvailable(config) {
  if (!config.diarizationEnabled) return false;
  return (await fileExists(config.diarizationPython)) && (await fileExists(config.diarizationScript));
}

function parseResult(stdout) {
  const result = JSON.parse(stdout);
  if (!Array.isArray(result.segments)) throw new Error("missing segments");
  return result.segments.map((segment) => {
    if (![segment.speaker, segment.start, segment.end].every(Number.isFinite) || segment.end < segment.start) {
      throw new Error("malformed segment");
    }
    return { speaker: segment.speaker, startMs: Math.round(segment.start * 1000), endMs: Math.round(segment.end * 1000) };
  });
}

/**
 * Run speaker diarization on a 16 kHz mono WAV.
 * Never throws for model problems: returns { status, intervals, speakerCount } where status is
 *   "ok"          intervals are real detections (possibly empty for silence)
 *   "unavailable" not installed / disabled
 *   "failed"      it ran and errored or timed out
 * Only a client disconnect throws (requestCancelled).
 */
export async function diarizeWav(wavPath, config, { timeoutMs, signal, expectedSpeakers } = {}) {
  if (!(await diarizationAvailable(config))) return { status: "unavailable", intervals: [], speakerCount: 0 };

  const args = [
    config.diarizationScript,
    "--input", wavPath,
    "--threshold", String(config.diarizationThreshold),
    "--num-speakers", String(expectedSpeakers ?? -1),
  ];
  try {
    const { stdout } = await run(config.diarizationPython, args, { timeoutMs, signal, maxBuffer: 8 * 1024 * 1024 });
    const intervals = parseResult(stdout);
    return { status: "ok", intervals, speakerCount: new Set(intervals.map((interval) => interval.speaker)).size };
  } catch (error) {
    if (error.aborted) throw requestCancelled();
    // The module reports its own failure class as {"error": CODE} on stdout. Log only that code:
    // never audio, paths or transcript content.
    let code = error.timedOut ? "TIMEOUT" : "UNKNOWN";
    try {
      code = JSON.parse(error.stdout ?? "").error ?? code;
    } catch {
      // not JSON: keep the generic class
    }
    console.error(`diarization ${code}`);
    const notInstalled = code === "MODEL_MISSING" || code === "DEPENDENCY_MISSING";
    return { status: notInstalled ? "unavailable" : "failed", intervals: [], speakerCount: 0 };
  }
}
