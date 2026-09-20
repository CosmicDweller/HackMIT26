// Preflight check: `npm run doctor`. Verifies FFmpeg, whisper.cpp and the models, then runs a
// real transcription of a bundled clip. Also serves as the demo warm-up (the first whisper run
// after install compiles GPU shaders, which can take ~15 s; later runs are fast).
import { mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { executableExists, fileExists, run } from "../lib/exec.js";
import { convertToWav } from "../services/audio.js";
import { diarizationSetup, diarizeWav } from "../services/diarization.js";
import { transcribeWav } from "../services/whisper.js";

const config = loadConfig();
const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sample = path.join(serverDir, "tests", "fixtures", "jfk.wav");

let failures = 0;
const ok = (message) => console.log(`  ok    ${message}`);
const warn = (message, fix) => console.log(`  warn  ${message}${fix ? `\n          fix: ${fix}` : ""}`);
const fail = (message, fix) => {
  failures += 1;
  console.log(`  FAIL  ${message}${fix ? `\n          fix: ${fix}` : ""}`);
};

async function version(bin, args) {
  try {
    const { stdout, stderr } = await run(bin, args, { timeoutMs: 15_000 });
    return (stdout || stderr).split("\n")[0].trim();
  } catch {
    return null;
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port);
  });
}

console.log("Speech-to-text preflight\n");
console.log(`Node ${process.version} on ${os.platform()}/${os.arch()}`);

console.log("\nDependencies");
if (await executableExists(config.ffmpegBin)) {
  ok((await version(config.ffmpegBin, ["-version"])) ?? `${config.ffmpegBin} found`);
} else {
  fail("FFmpeg not found", "brew install ffmpeg   (or set FFMPEG_BIN)");
}
if (await executableExists(config.whisperBin)) {
  ok(`${config.whisperBin} found`);
} else {
  fail("whisper-cli not found", "brew install whisper-cpp   (or build whisper.cpp and set WHISPER_BIN)");
}

console.log("\nModels");
if (await fileExists(config.whisperModel)) {
  const { size } = await stat(config.whisperModel);
  ok(`${path.basename(config.whisperModel)} (${Math.round(size / 1024 / 1024)} MB)`);
} else {
  fail(`Model missing: ${path.relative(serverDir, config.whisperModel)}`, "npm run setup:model");
}
if (!config.whisperVadModel) {
  warn("VAD disabled: silent recordings may produce phantom text such as \"you\"");
} else if (await fileExists(config.whisperVadModel)) {
  ok(`${path.basename(config.whisperVadModel)} (silence detection)`);
} else {
  warn("VAD model missing: silent recordings may produce phantom text such as \"you\"", "npm run setup:model");
}

console.log("\nSpeaker diarization");
const diarization = await diarizationSetup(config);
const diarizationReady = diarization.enabled && diarization.python && diarization.script && diarization.models;
if (!diarization.enabled) {
  warn("disabled (DIARIZATION_ENABLED=false): transcripts will have no speaker labels");
} else if (diarizationReady) {
  ok("Python environment and models found");
} else {
  warn("not installed: transcripts will have no speaker labels", "npm run setup:diarization");
}

console.log("\nSpeech engine");
if (config.sttEngine === "deepgram") {
  if (config.deepgramApiKey) {
    warn(
      `Deepgram (${config.deepgramModel}, diarize_model=${config.deepgramDiarizeModel}) is the primary engine: audio from signed-in recordings leaves this machine (mip_opt_out=true)`,
      "set STT_ENGINE=local to use the whisper.cpp fallback instead (short recordings only)",
    );
  } else {
    fail("STT_ENGINE is deepgram (the default) but DEEPGRAM_API_KEY is empty: recordings will fail", "set DEEPGRAM_API_KEY in server/.env, or STT_ENGINE=local");
  }
  console.log(`  info  recordings up to ${config.maxRecordingSeconds} s and ${Math.round(config.maxRecordingBytes / 1048576)} MB are accepted; synchronous Deepgram requests up to ${config.deepgramSyncMaxSeconds} s`);
  if (config.deepgramCallbackBaseUrl) warn(`callbacks enabled for longer recordings (listener 127.0.0.1:${config.callbackPort}, public URL ${new URL(config.deepgramCallbackBaseUrl).host})`, "only expose that one port, and only with synthetic data");
  else console.log("  info  callbacks are off: recordings longer than the synchronous limit are rejected before any audio is sent");
} else {
  ok("local whisper.cpp fallback (audio never leaves this machine; short recordings only)");
}
if (await executableExists(config.ffprobeBin)) ok(`${config.ffprobeBin} found (recording validation)`);
else fail("ffprobe not found (it ships with FFmpeg)", "brew install ffmpeg   (or set FFPROBE_BIN)");
console.log(`  info  recordings are stored in ${path.relative(serverDir, config.uploadDir)} until processed (failed jobs: ${config.audioRetentionHours} h)`);

console.log("\nDoctor voice recognition");
{
  const { createEmbedder } = await import("../services/voice/embedder.js");
  const { parseKey } = await import("../services/voice/protect.js");
  const embedder = createEmbedder(config);
  if (!config.voiceEnabled) warn("disabled (VOICE_ENABLED=false)");
  else if (await embedder.available()) ok(`ECAPA-TDNN model installed (${await embedder.modelVersion()})`);
  else warn("not installed: doctors cannot enroll a voice, and merged voices cannot be separated", "npm run setup:voice");
  if (parseKey(config.voiceProfileKey)) ok("VOICE_PROFILE_KEY is set (32 bytes)");
  else warn("VOICE_PROFILE_KEY is not set: voice enrollment is refused", "add VOICE_PROFILE_KEY=$(openssl rand -base64 32) to server/.env");
}

console.log("\nAccounts");
if (config.supabaseUrl) {
  ok(`Supabase Auth configured (${new URL(config.supabaseUrl).host})`);
} else {
  warn("SUPABASE_URL is not set: /api/transcriptions and /api/me will reject every request", "set SUPABASE_URL in server/.env");
}
console.log(`  info  transcripts are stored in ${path.relative(serverDir, config.dbPath)} (never commit it)`);

console.log("\nEnvironment");
if (await portIsFree(config.port)) {
  ok(`port ${config.port} is free`);
} else {
  warn(`port ${config.port} is in use (is the server already running?)`, "stop the other process or set PORT");
}
console.log(`  info  CORS allows ${config.corsOrigin}`);

console.log("\nReal transcription test");
if (failures === 0) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "stt-doctor-"));
  try {
    const started = Date.now();
    const wav = path.join(workDir, "audio.wav");
    const { durationSeconds } = await convertToWav(sample, wav, config, config.processTimeoutMs);
    const { text } = await transcribeWav(wav, workDir, config, config.processTimeoutMs);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (/ask not what your country can do for you/i.test(text)) {
      ok(`transcribed ${durationSeconds} s of audio in ${seconds} s: "${text}"`);
      if (diarizationReady) {
        const two = path.join(serverDir, "tests", "fixtures", "synthetic", "two-speaker.wav");
        const started = Date.now();
        const result = await diarizeWav(two, config, { timeoutMs: config.diarizationTimeoutMs });
        const took = ((Date.now() - started) / 1000).toFixed(1);
        if (result.status === "ok" && result.speakerCount === 2) {
          ok(`diarization found 2 speakers in a synthetic conversation in ${took} s`);
        } else {
          fail(`diarization returned status ${result.status} with ${result.speakerCount} speakers (expected 2)`, "npm run setup:diarization");
        }
      }
    } else {
      fail(`unexpected transcript: "${text}"`, "check the model file is not corrupt (delete it and run npm run setup:model)");
    }
  } catch (error) {
    fail(`transcription failed: ${error.message}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
} else {
  console.log("  skip  fix the failures above first");
}

console.log(failures === 0 ? "\nAll good. Start the server with `npm start`." : `\n${failures} problem(s) found.`);
process.exit(failures === 0 ? 0 : 1);
