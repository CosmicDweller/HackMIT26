// LIVE Deepgram tests: the real service, real FFmpeg preparation, the real job system and database.
// Skipped unless DEEPGRAM_API_KEY and DEEPGRAM_LIVE_TEST=1 are both set, because they upload SYNTHETIC audio to
// Deepgram (billed per audio minute). Run: DEEPGRAM_LIVE_TEST=1 node --env-file=.env --test tests/real-deepgram.test.js
// The 5-minute test needs tests/.generated/medical-5min.wav (python3 scripts/make-long-recording.py medical 5 tests/.generated/medical-5min.wav).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import { der, truthText, truthTurns, wer, wordAttribution } from "./eval.js";
import { locate } from "./live-eval.js";
import { leftoverFiles, makeAuth, makeConfig, readFixture, startServer, TEST_SUPABASE_URL } from "./helpers.js";
import { loadConfig } from "../config.js";

const LIVE = Boolean(process.env.DEEPGRAM_API_KEY) && process.env.DEEPGRAM_LIVE_TEST === "1";
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function liveApp() {
  const env = await makeConfig({
    supabaseUrl: TEST_SUPABASE_URL, sttEngine: "deepgram", deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    // defaults from the real configuration: nova-3-medical, diarize_model=latest
    deepgramModel: loadConfig(process.env).deepgramModel, deepgramDiarizeModel: loadConfig(process.env).deepgramDiarizeModel,
  });
  cleanups.push(env.cleanup);
  const keys = await makeAuth();
  const server = await startServer(env.config, { jwks: keys.jwks });
  cleanups.push(server.close);
  const token = await keys.sign("doctor-live");
  const auth = { Authorization: `Bearer ${token}` };

  /** Upload a recording as a job, watch its statuses, and return the final transcript. */
  async function transcribe(name) {
    const { wav, truthPath } = locate(name);
    const truth = JSON.parse(readFileSync(truthPath, "utf8"));
    const form = new FormData();
    form.append("audio", new Blob([await readFixture(wav)]), `${name}.wav`);
    const created = await fetch(`${server.baseUrl}/api/transcription-jobs`, { method: "POST", headers: auth, body: form });
    assert.equal(created.status, 202);
    const job = await created.json();
    const seen = [];
    const started = Date.now();
    for (;;) {
      const view = await (await fetch(`${server.baseUrl}/api/transcription-jobs/${job.jobId}`, { headers: auth })).json();
      if (seen.at(-1) !== view.status) seen.push(view.status);
      assert.equal(view.progressPercent, null);
      if (view.status === "completed" || view.status === "failed") {
        assert.equal(view.status, "completed", `job failed: ${JSON.stringify(view.error)}`);
        // Reopen the saved transcript through the API, as the website would.
        const transcript = await (await fetch(`${server.baseUrl}/api/transcriptions/${view.transcriptionId}`, { headers: auth })).json();
        return { transcript, truth, seen, seconds: (Date.now() - started) / 1000, jobId: job.jobId };
      }
      if (Date.now() - started > 8 * 60_000) throw new Error("job did not finish");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Score the STORED segments (what the website shows) against the ground truth. */
  function score({ transcript, truth }) {
    const turns = truthTurns(truth);
    const hypothesis = transcript.segments.filter((s) => s.speakerId !== null).map((s) => ({ speaker: s.speakerId, startMs: s.startMs, endMs: s.endMs }));
    return {
      wer: wer(truthText(truth), transcript.text).wer,
      der: der(turns, hypothesis).der,
      trueSpeakers: new Set(turns.map((t) => t.speaker)).size,
      speakers: transcript.speakers.length,
      // a segment is judged by the speaker that spoke at most of its duration
      segmentAttribution: wordAttribution(turns, transcript.segments.filter((s) => s.speakerId).map((s) => ({ speaker: s.speakerId, startMs: s.startMs, endMs: s.endMs }))).accuracy,
    };
  }
  return { ...env, ...server, auth, transcribe, score, store: server.app.locals.store };
}

describe("live Deepgram Nova-3 Medical with the batch diarizer, on synthetic recordings", () => {
  test("30-second two-speaker medical conversation: correct model, diarizer ran, speakers and timing right", async (t) => {
    if (!LIVE) return t.skip("set DEEPGRAM_API_KEY and DEEPGRAM_LIVE_TEST=1 (uploads synthetic audio to Deepgram)");
    const app = await liveApp();
    const result = await app.transcribe("medical");
    const { transcript } = result;
    const metrics = app.score(result);
    t.diagnostic(`statuses: ${result.seen.join(" -> ")}; ${result.seconds.toFixed(1)} s; ${JSON.stringify(metrics)}`);

    assert.deepEqual(result.seen.at(-1), "completed");
    assert.equal(transcript.engine, "deepgram");
    assert.equal(transcript.diarizationStatus, "completed");
    assert.equal(transcript.speakers.length, 2);
    assert.deepEqual(transcript.speakers.map((s) => s.id), ["speaker_0", "speaker_1"]);
    assert.ok(transcript.speakers.every((s) => s.role === "unassigned"), "never assumes who is the doctor");

    // What Deepgram itself reported, kept internally.
    const meta = app.store.providerMeta("doctor-live", transcript.id);
    assert.deepEqual(meta.models.map((m) => m.split(" ")[0]), ["medical-nova-3"], "Nova-3 Medical was really used");
    assert.equal(meta.diarizeModel.arch, "v2", "the batch v2 diarizer really ran");
    assert.ok(meta.requestId && meta.requestId !== "scrubbed");
    assert.equal(meta.requestedModel, "nova-3-medical");

    assert.ok(metrics.der < 0.1, `DER ${metrics.der}`);
    assert.ok(metrics.wer < 0.15, `WER ${metrics.wer}`);
    // Medical vocabulary: kept as heard. The recognizer really misheard "atorvastatin"; that must be visible and flagged, not silently fixed.
    assert.match(transcript.text, /metformin/i);
    assert.match(transcript.text, /lisinopril/i);
    const drug = transcript.segments.find((s) => /statin/i.test(s.text));
    assert.ok(drug, "the statin sentence exists");
    if (!/atorvastatin/i.test(drug.text)) assert.equal(drug.needsReview, true, "a misrecognized drug name must be flagged for review");

    // The doctor maps a role to a provider-derived speaker id; it persists and the internal id is unchanged.
    const patched = await (await fetch(`${app.baseUrl}/api/transcriptions/${transcript.id}/speakers`, {
      method: "PATCH", headers: { ...app.auth, "Content-Type": "application/json" }, body: JSON.stringify({ speakerId: "speaker_0", role: "doctor" }),
    })).json();
    assert.equal(patched.speakers[0].id, "speaker_0");
    assert.equal(patched.speakers[0].role, "doctor");
    assert.deepEqual(patched.segments.map((s) => s.speakerId), transcript.segments.map((s) => s.speakerId));
    const reopened = await (await fetch(`${app.baseUrl}/api/transcriptions/${transcript.id}`, { headers: app.auth })).json();
    assert.equal(reopened.speakers[0].role, "doctor");
    assert.deepEqual(await leftoverFiles(app.config.tmpDir), []);
    assert.deepEqual(await leftoverFiles(app.config.uploadDir), [], "the recording is deleted after success");
  });

  test("A-B-A: the returning speaker keeps the same label", async (t) => {
    if (!LIVE) return t.skip("set DEEPGRAM_API_KEY and DEEPGRAM_LIVE_TEST=1");
    const app = await liveApp();
    const { transcript } = await app.transcribe("aba");
    assert.deepEqual(transcript.segments.map((s) => s.speakerId), ["speaker_0", "speaker_1", "speaker_0"]);
    assert.deepEqual(transcript.segments.map((s) => s.text), ["Are you eating regularly?", "I eat two meals per day.", "Have you noticed any weight changes?"]);
  });

  test("three-person conversation: three speakers, with the known misattribution documented", async (t) => {
    if (!LIVE) return t.skip("set DEEPGRAM_API_KEY and DEEPGRAM_LIVE_TEST=1");
    const app = await liveApp();
    const result = await app.transcribe("three-speaker");
    const metrics = app.score(result);
    t.diagnostic(JSON.stringify(metrics));
    assert.equal(result.transcript.speakers.length, 3, "no hard-coded two-speaker assumption");
    assert.equal(result.transcript.diarizationStatus, "completed");
    // Measured 9.9% DER: the third voice's last sentence is attributed to the doctor. A regression guard, not a promise.
    assert.ok(metrics.der < 0.25, `DER ${metrics.der}`);
    assert.ok(metrics.wer < 0.1, `WER ${metrics.wer}`);
  });

  test("five-minute conversation: stable speakers across the whole recording, timestamps span the full length", async (t) => {
    if (!LIVE) return t.skip("set DEEPGRAM_API_KEY and DEEPGRAM_LIVE_TEST=1");
    if (!existsSync(locate("medical-5min").wav)) return t.skip("generate it: python3 scripts/make-long-recording.py medical 5 tests/.generated/medical-5min.wav");
    const app = await liveApp();
    const result = await app.transcribe("medical-5min");
    const metrics = app.score(result);
    t.diagnostic(`${result.seconds.toFixed(1)} s; segments ${result.transcript.segments.length}; ${JSON.stringify(metrics)}`);
    assert.equal(result.transcript.speakers.length, 2, "the same two people for the whole 5 minutes, ids never reset");
    assert.ok(metrics.der < 0.1 && metrics.wer < 0.1, JSON.stringify(metrics));
    const { segments } = result.transcript;
    assert.ok(segments.at(-1).endMs > 280_000, "timestamps run to the end of the recording, never reset");
    for (let i = 1; i < segments.length; i++) assert.ok(segments[i].startMs >= segments[i - 1].startMs);
    // Nothing duplicated across the recording: the count of a marker phrase equals the number of repetitions.
    assert.equal((result.transcript.text.match(/shortness of breath/gi) ?? []).length, 9);
  });

  test("silence is reported as no speech, not as a transcript", async (t) => {
    if (!LIVE) return t.skip("set DEEPGRAM_API_KEY and DEEPGRAM_LIVE_TEST=1");
    const app = await liveApp();
    const file = `${app.root}/silence.wav`;
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "4", file]);
    const form = new FormData();
    form.append("audio", new Blob([await readFixture(file)]), "silence.wav");
    const created = await (await fetch(`${app.baseUrl}/api/transcription-jobs`, { method: "POST", headers: app.auth, body: form })).json();
    let view;
    for (let i = 0; i < 300; i++) {
      view = await (await fetch(`${app.baseUrl}/api/transcription-jobs/${created.jobId}`, { headers: app.auth })).json();
      if (["completed", "failed"].includes(view.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(view.status, "failed");
    assert.equal(view.error.code, "NO_SPEECH");
  });
});
