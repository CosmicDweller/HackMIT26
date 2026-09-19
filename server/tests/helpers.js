import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

export const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const jfkWav = path.join(fixtureDir, "jfk.wav");

/** Real config (real FFmpeg, real whisper.cpp, real model) with a private temp dir per test. */
export async function makeConfig(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stt-test-"));
  const tmpDir = path.join(root, "work");
  const config = { ...loadConfig({}), tmpDir, ...overrides };
  return { config, root, tmpDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Start the app on an ephemeral port. */
export async function startServer(config) {
  const app = createApp(config);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
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
