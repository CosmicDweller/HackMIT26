import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { run } from "../../lib/exec.js";
import { AppError, consentRequired, enrollmentRejected, invalidRequest, serviceUnavailable } from "../../lib/errors.js";
import { calibration, CONSENT_TEXT, CONSENT_VERSION } from "./calibration.js";
import { MODEL_NAME } from "./embedder.js";
import { decryptJson, encryptJson, parseKey } from "./protect.js";
import { dot } from "./vecmath.js";

const E = calibration.enrollment;

// Extra ENROLLMENT copies with mild degradation (a narrower, lossy "laptop or phone" microphone, and a noisy room) so a profile
// made on one microphone still works on another. Measured: the doctor was matched in 86% of held-out sessions with these,
// against 34% without. The parameters deliberately differ from the ones the evaluation used to degrade its TEST audio.
const VARIANTS = [
  { name: "mic", filter: "[0:a]highpass=f=300,lowpass=f=3400[s];[1:a]volume=-33dB[n];[s][n]amix=inputs=2:normalize=0:duration=first", lossy: true },
  { name: "noisy", filter: "[1:a]volume=-27dB[n];[0:a][n]amix=inputs=2:normalize=0:duration=first", lossy: false },
];

export function createVoiceService({ config, store, embedder }) {
  const enrolling = new Set();
  const key = parseKey(config.voiceProfileKey);

  const aad = (ownerId, meta) => `${ownerId}|${meta.modelVersion}|${meta.embeddingVersion}`;

  async function status(ownerId) {
    if (enrolling.has(ownerId)) return { status: "enrolling" };
    const meta = store.voiceProfileMeta(ownerId);
    if (!meta) return { status: "not_enrolled" };
    let stale = meta.embeddingVersion !== calibration.embeddingVersion;
    if (!stale && (await embedder.available())) stale = meta.modelVersion !== (await embedder.modelVersion());
    return {
      status: stale ? "needs_reenrollment" : "enrolled",
      enrolledAt: meta.enrolledAt, updatedAt: meta.updatedAt, sampleCount: meta.sampleCount, modelVersion: meta.modelVersion,
      consentRecordedAt: meta.consentRecordedAt,
    };
  }

  /** Decrypted reference embeddings for identification (server memory only), or null. */
  async function loadReferences(ownerId) {
    const current = await status(ownerId);
    if (current.status !== "enrolled" || !key) return null;
    const meta = store.voiceProfileMeta(ownerId);
    const payload = decryptJson(store.voiceProfileCiphertext(ownerId), key, aad(ownerId, meta));
    return payload?.references ?? null;
  }

  async function normalizeSample(input, output, config) {
    try {
      await run(config.ffmpegBin, ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-i", input, "-vn",
        "-t", String(E.maxSampleSeconds + 5), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", output], { timeoutMs: 120_000 });
      return true;
    } catch (error) {
      if (error.notFound) throw serviceUnavailable("Audio processing is not available on the server.");
      return false;
    }
  }

  async function makeVariants(source, dir, index) {
    const out = [];
    for (const variant of VARIANTS) {
      const wav = path.join(dir, `s${index}-${variant.name}.wav`);
      await run(config.ffmpegBin, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", source, "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=1:r=16000",
        "-filter_complex", variant.filter, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wav], { timeoutMs: 120_000 });
      if (variant.lossy) {
        const opus = path.join(dir, `s${index}-${variant.name}.opus`);
        const back = path.join(dir, `s${index}-${variant.name}-b.wav`);
        await run(config.ffmpegBin, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", "16k", "-y", opus], { timeoutMs: 120_000 });
        await run(config.ffmpegBin, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", opus, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", back], { timeoutMs: 120_000 });
        out.push(back);
      } else {
        out.push(wav);
      }
    }
    return out;
  }

  /**
   * Enroll (or REPLACE) the caller's voice profile from exactly three samples. Every sample is validated first and nothing is saved
   * unless all of them pass. Raw audio is deleted by the caller. Never returns embeddings.
   */
  async function enroll(ownerId, { files, consent, consentVersion }) {
    if (consent !== "true" || consentVersion !== CONSENT_VERSION) throw consentRequired();
    if (!config.voiceEnabled || !(await embedder.available())) throw serviceUnavailable("Voice profiles are not available on this server.");
    if (!key) throw serviceUnavailable("Voice profiles are not configured on this server (no encryption key).");
    if (!Array.isArray(files) || files.length !== E.sampleCount) throw invalidRequest(`Send exactly ${E.sampleCount} voice samples in the 'samples' field.`);
    if (enrolling.has(ownerId)) throw new AppError("INVALID_REQUEST", 409, "A voice enrollment is already in progress.");

    enrolling.add(ownerId);
    const dir = await mkdtemp(path.join(config.tmpDir, "enroll-"));
    try {
      const problems = [];
      const cleanWavs = [];
      for (const [i, file] of files.entries()) {
        const wav = path.join(dir, `s${i}.wav`);
        if (await normalizeSample(file.path, wav, config)) cleanWavs.push(wav);
        else problems.push({ sample: i + 1, code: "INVALID_AUDIO", message: "This file is not readable audio." });
      }
      if (problems.length) throw enrollmentRejected(problems);

      const measured = await embedder.quality(cleanWavs);
      measured.forEach((m, i) => {
        const sample = i + 1;
        const seconds = (ms) => Math.round(ms / 100) / 10;
        if (m.peak < E.minPeak || m.voicedMs < 1000) problems.push({ sample, code: "SAMPLE_SILENT", message: "No speech was detected. Check the microphone and speak clearly." });
        else if (m.durationMs > E.maxSampleSeconds * 1000) problems.push({ sample, code: "SAMPLE_TOO_LONG", message: `The sample is longer than ${E.maxSampleSeconds} seconds.` });
        else if (m.clipRatio > E.maxClipRatio) problems.push({ sample, code: "SAMPLE_CLIPPED", message: "The recording is distorted (too loud). Move back from the microphone and record again." });
        else if (m.voicedMs < E.minVoicedSeconds * 1000) problems.push({ sample, code: "SAMPLE_TOO_SHORT", message: `Only ${seconds(m.voicedMs)} seconds of speech were detected; at least ${E.minVoicedSeconds} are needed.` });
        else if (m.windowMinSimilarity !== null && m.windowMinSimilarity < E.windowMinSimilarity) problems.push({ sample, code: "MULTIPLE_SPEAKERS_SUSPECTED", message: "More than one voice may be present. Record alone in a quiet room." });
        else if (!m.embedding) problems.push({ sample, code: "SAMPLE_SILENT", message: "No usable speech was found." });
      });
      if (problems.length) throw enrollmentRejected(problems);

      // The three samples must sound like the same person.
      const vecs = measured.map((m) => m.embedding);
      const pairs = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => dot(vecs[a], vecs[b]));
      if (pairs.reduce((s, v) => s + v, 0) / pairs.length < E.sampleConsistency) {
        throw enrollmentRejected([{ sample: null, code: "SAMPLES_DIFFER", message: "The three samples do not sound like the same person. Record all three yourself." }]);
      }

      const variantWavs = [];
      for (const [i, wav] of cleanWavs.entries()) variantWavs.push(...(await makeVariants(wav, dir, i)));
      const variants = await embedder.quality(variantWavs);
      if (variants.some((v) => !v.embedding)) throw enrollmentRejected([{ sample: null, code: "SAMPLE_SILENT", message: "The samples were too quiet to use." }]);

      const references = [...vecs, ...variants.map((v) => v.embedding)];
      const modelVersion = await embedder.modelVersion();
      const meta = { modelVersion, embeddingVersion: calibration.embeddingVersion };
      store.saveVoiceProfile(ownerId, {
        modelName: MODEL_NAME, modelVersion, embeddingVersion: calibration.embeddingVersion, sampleCount: files.length, consentVersion,
        ciphertext: encryptJson({ version: 1, references }, key, aad(ownerId, meta)),
      });
    } catch (error) {
      enrolling.delete(ownerId);
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // The in-progress marker is cleared first so the answer reports the finished state.
    enrolling.delete(ownerId);
    return status(ownerId);
  }

  return { status, enroll, loadReferences, remove: (ownerId) => store.deleteVoiceProfile(ownerId), consent: { version: CONSENT_VERSION, text: CONSENT_TEXT } };
}
