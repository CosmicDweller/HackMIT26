import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileExists, run } from "../../lib/exec.js";

// The local speaker-embedding model (SpeechBrain ECAPA-TDNN) runs in an isolated Python process (voice/embed.py). Requests and
// responses are JSON on stdin/stdout: profiles and embeddings never appear on a command line, in a file or in a log.
// One process at a time (each loads a ~1 GB model), so a long recording cannot fan out into many concurrent models.

export const MODEL_NAME = "speechbrain/spkrec-ecapa-voxceleb";
const PACKAGE_VERSION = "speechbrain==1.0.3";

export class VoiceError extends Error {
  constructor(code) {
    super(code);
    this.name = "VoiceError";
    this.code = code;
  }
}

export function createEmbedder(config) {
  let queue = Promise.resolve();
  let cachedVersion = null;

  const serialized = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  async function call(request, { signal, timeoutMs } = {}) {
    if (!(await available())) throw new VoiceError("VOICE_UNAVAILABLE");
    return serialized(async () => {
      try {
        const { stdout } = await run(config.voicePython, [config.voiceScript], {
          input: JSON.stringify(request), timeoutMs: timeoutMs ?? config.voiceTimeoutMs, signal, maxBuffer: 256 * 1024 * 1024,
        });
        return JSON.parse(stdout);
      } catch (error) {
        if (error.aborted) throw error;
        let code = error.timedOut ? "VOICE_TIMEOUT" : "VOICE_FAILED";
        try {
          code = JSON.parse(error.stdout ?? "").error === "MODEL_MISSING" ? "VOICE_UNAVAILABLE" : code;
        } catch {
          // not JSON: keep the generic class
        }
        // Only the failure class is logged: never audio, embeddings or profile data.
        console.error(`voice model ${code}`);
        throw new VoiceError(code);
      }
    });
  }

  async function available() {
    if (!config.voiceEnabled) return false;
    return (await fileExists(config.voicePython)) && (await fileExists(config.voiceScript)) &&
      (await fileExists(path.join(path.dirname(config.voiceScript), "models", "spkrec-ecapa-voxceleb", "embedding_model.ckpt")));
  }

  /** Identifies the exact model files: a profile made with a different model or weights must be re-enrolled. */
  async function modelVersion() {
    if (cachedVersion) return cachedVersion;
    const file = path.join(path.dirname(config.voiceScript), "models", "spkrec-ecapa-voxceleb", "embedding_model.ckpt");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    cachedVersion = `${PACKAGE_VERSION}+embedding_model.ckpt:${hash.digest("hex").slice(0, 16)}`;
    return cachedVersion;
  }

  return {
    available,
    modelVersion,
    /** Embeddings for time regions of a 16 kHz mono WAV. Returns an array aligned with `regions` (null = too short). */
    async embedRegions(wavPath, regions, options) {
      if (regions.length === 0) return [];
      return (await call({ command: "embed", wav: wavPath, regions }, options)).embeddings;
    },
    /** Per-file quality measures plus a whole-file embedding, for enrollment. */
    async quality(wavPaths, options) {
      return (await call({ command: "quality", wavs: wavPaths }, options)).files;
    },
  };
}
