import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

export const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const jfkWav = path.join(fixtureDir, "jfk.wav");

/** Real config (real FFmpeg, real whisper.cpp, real model) with a private temp dir per test. */
export async function makeConfig(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stt-test-"));
  const tmpDir = path.join(root, "work");
  // Tests default to the local engine (fast, no network). Deepgram tests opt in explicitly.
  const config = {
    ...loadConfig({}), tmpDir, uploadDir: path.join(root, "uploads"), dbPath: path.join(root, "db", "test.sqlite"),
    sttEngine: "local", deepgramApiKey: "", ...overrides,
  };
  return { config, root, tmpDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Start the app on an ephemeral port. `overrides` is passed to createApp (jwks, store). */
export async function startServer(config, overrides) {
  const app = createApp(config, overrides);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { app, baseUrl, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

export function postAudio(baseUrl, bytes, { filename = "recording.wav", field = "audio", type = "audio/wav" } = {}) {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), filename);
  return fetch(`${baseUrl}/api/transcribe`, { method: "POST", body: form });
}

/** Files left in the temp directory (should always be empty after a request finishes). */
export async function leftoverFiles(tmpDir) {
  try {
    return await readdir(tmpDir);
  } catch {
    return [];
  }
}

export const readFixture = (file = jfkWav) => readFile(file);

/**
 * Write a stand-in for whisper-cli. It behaves like the real CLI's interface (-of PREFIX
 * produces PREFIX.json) but is a shell script, so tests using it exercise our subprocess
 * handling only and are NOT evidence of real speech recognition.
 */
export async function makeFakeWhisper(dir, mode) {
  const bodies = {
    ok: `printf '{"transcription":[{"text":" Hello","offsets":{"from":250,"to":1500}},{"text":" world.","offsets":{"from":1500,"to":3000}}]}' > "$OUT.json"`,
    blank: `printf '{"transcription":[{"text":" [BLANK_AUDIO]"}]}' > "$OUT.json"`,
    badjson: `printf 'not json' > "$OUT.json"`,
    nooutput: `exit 0`,
    fail: `echo "boom at /secret/internal/path" >&2; exit 1`,
    // Records its pid next to the script, then becomes `sleep` so killing it leaves no orphan.
    hang: `echo $$ > "$(dirname "$0")/hang.pid"; exec sleep 30`,
    slow: `sleep 1.5; printf '{"transcription":[{"text":" slow"}]}' > "$OUT.json"`,
  };
  const file = path.join(dir, `fake-whisper-${mode}`);
  await writeFile(
    file,
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -of) OUT="$2"; shift;; esac; shift; done\n${bodies[mode]}\n`,
  );
  await chmod(file, 0o755);
  return file;
}

/** Generate a silent WAV of the given length with the real FFmpeg. */
export function makeSilentWav(file, seconds) {
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", String(seconds), file],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}

/** Re-encode the fixture as WebM/Opus, like a browser MediaRecorder would produce. */
export function makeWebm(inputWav, outputWebm) {
  const result = spawnSync("ffmpeg", ["-y", "-v", "error", "-i", inputWav, "-c:a", "libopus", outputWebm], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}

export const fixtureSynthetic = (name) => path.join(fixtureDir, "synthetic", name);

export const TEST_SUPABASE_URL = "https://test-project.supabase.co";

/**
 * A local signing-key set standing in for Supabase's published keys, plus a token signer.
 * Verification code paths (signature, expiry, issuer, audience, algorithm) are the real ones.
 */
export async function makeAuth() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });

  const sign = async (subject = "doctor-a", claims = {}, options = {}) => {
    const {
      key = privateKey, alg = "ES256", expiresIn = "1h", issuer = `${TEST_SUPABASE_URL}/auth/v1`, audience = "authenticated",
    } = options;
    return new SignJWT({ role: "authenticated", email: `${subject}@example.test`, ...claims })
      .setProtectedHeader({ alg, kid: "test-key" })
      .setSubject(subject)
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(expiresIn)
      .sign(key);
  };
  return { jwks, sign, privateKey };
}

/** A stand-in for diarize.py. Like the fake whisper, tests using it verify our handling only. */
export async function makeFakeDiarizer(dir, mode) {
  const bodies = {
    // Matches the fake whisper "ok" output: 250-1500 "Hello", 1500-3000 "world."
    ok: `printf '{"engine":"fake","numSpeakers":2,"segments":[{"speaker":0,"start":0.25,"end":1.5},{"speaker":1,"start":1.5,"end":3.0}]}'`,
    fail: `printf '{"error":"DIARIZATION_FAILED"}'; exit 2`,
    missingModel: `printf '{"error":"MODEL_MISSING"}'; exit 2`,
    garbage: `printf 'not json'`,
    hang: `exec sleep 30`,
  };
  const file = path.join(dir, `fake-diarizer-${mode}`);
  await writeFile(file, `#!/bin/sh\n${bodies[mode]}\n`);
  await chmod(file, 0o755);
  return file;
}

/** A tone of the given length in the given container (for length/size boundary tests). */
export function makeTone(file, seconds, codec = ["-c:a", "pcm_s16le"]) {
  const result = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", String(seconds), ...codec, file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}
