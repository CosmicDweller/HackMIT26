// THE WHOLE PRODUCT, on one real recording: audio in, approved SOAP PDF out.
//
//   real 146 s two-voice WAV  ->  upload  ->  FFmpeg verify + normalise  ->  Deepgram (stub, replaying the real words with the real
//   timings of this audio)  ->  REAL pyannote Community-1 speaker turns  ->  word alignment  ->  doctor voice matching  ->  stored
//   transcript  ->  automatic SOAP generation (scripted Gemini)  ->  doctor edits  ->  approval  ->  PDF and TXT export.
//
// Only two things are simulated, and for a reason: Deepgram (a paid call, and the test must control the exact words so the note's
// grounding can be asserted) and Gemini (tests/real-soap.test.js covers the real one). Everything between them is real: real audio,
// real FFmpeg, real speaker diarization, real alignment, real database, real HTTP, real auth, real PDF.
//
// The pyannote parts are skipped (not passed) when the model is not installed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { createPyannote } from "../services/pyannote.js";
import { loadConfig } from "../config.js";
import { json, startDeepgramStub } from "./deepgram-stub.js";
import { makeAuth, makeConfig, startServer, TEST_SUPABASE_URL } from "./helpers.js";
import { fakeProvider, goodFacts } from "./soap-fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIO = path.join(HERE, "fixtures/soap/headache-consultation.flac");
const TRUTH = path.join(HERE, "fixtures/soap/headache-consultation.truth.json");
const KEY = "dg-test-key-NOT-A-REAL-KEY-12345";

const pyannoteReady = await createPyannote(loadConfig({})).available();
const skip = pyannoteReady ? false : "pyannote is not installed (npm run setup:pyannote)";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** Deepgram's answer for THIS audio: the real words of each turn, spread across that turn's real timing. */
async function deepgramResponse({ mergeSpeakers = true } = {}) {
  const truth = JSON.parse(await readFile(TRUTH, "utf8"));
  const words = [];
  truth.turns.forEach((turn, index) => {
    const tokens = turn.text.split(/\s+/).filter(Boolean);
    const span = (turn.endMs - turn.startMs) / 1000 / tokens.length;
    tokens.forEach((token, position) => {
      const start = turn.startMs / 1000 + position * span;
      words.push({
        word: token.replace(/[^\w']/g, "").toLowerCase() || token,
        punctuated_word: token,
        start,
        end: start + span * 0.9,
        confidence: 0.98,
        // mergeSpeakers reproduces the failure this project exists to fix: Deepgram hearing one person.
        speaker: mergeSpeakers ? 0 : (turn.speaker === "D" ? 0 : 1),
        speaker_confidence: 0.9,
      });
    });
  });
  return {
    metadata: { request_id: "e2e", duration: truth.durationMs / 1000, model_info: { m: { name: "medical-nova-3", version: "1" } }, diarize_info: { arch: "v2", model_uuid: "u" } },
    results: { channels: [{ alternatives: [{ transcript: truth.turns.map((t) => t.text).join(" "), words }] }], utterances: [] },
  };
}

/**
 * A note the scripted Gemini returns, built from the numbered transcript IN THE PROMPT, exactly as a real model would: it finds the
 * lines it needs and cites those numbers. This keeps the test honest about the real contract (the model only ever sees line numbers)
 * and works whatever segments the real pipeline produced.
 */
function noteFromPrompt(user) {
  const lines = [...user.matchAll(/^\[(\d+)\] ([^:]+): (.*)$/gm)].map((match) => ({ number: Number(match[1]), who: match[2], text: match[3] }));
  const lineOf = (pattern) => lines.find((line) => pattern.test(line.text))?.number;
  const sections = {
    subjective: "Chief complaint: severe headache for three days.",
    objective: "BP 122/78. HR 72. Temperature 98.6 F. Respiratory rate 16.",
    assessment: "Clinician assessment: classic features of an acute migraine without aura.",
    plan: "Clinician prescribed sumatriptan 50 mg at the onset of a migraine attack.",
  };
  const cite = (pattern) => { const number = lineOf(pattern); return number ? [number] : []; };
  return {
    sections,
    claims: [
      { section: "subjective", text: sections.subjective, sourceLines: cite(/three days/), sourceFactIds: [], needsReview: false },
      { section: "objective", text: sections.objective, sourceLines: cite(/blood pressure/), sourceFactIds: [], needsReview: false },
      { section: "assessment", text: sections.assessment, sourceLines: cite(/classic features/), sourceFactIds: [], needsReview: false },
      { section: "plan", text: sections.plan, sourceLines: cite(/prescribing sumatriptan/), sourceFactIds: [], needsReview: false },
    ],
    reviewFlags: [],
  };
}

async function setup({ mergeSpeakers = true } = {}) {
  const stub = await startDeepgramStub(json(200, await deepgramResponse({ mergeSpeakers })));
  cleanups.push(stub.close);
  const env = await makeConfig({
    supabaseUrl: TEST_SUPABASE_URL, sttEngine: "deepgram", deepgramApiKey: KEY, deepgramBaseUrl: stub.url,
    pyannoteEnabled: true, voiceEnabled: false, soapEnabled: true, soapAutoGenerate: true, diarizationEnabled: false,
  });
  cleanups.push(env.cleanup);
  const keys = await makeAuth();
  // The scripted Gemini writes its note from the transcript the real pipeline produced.
  const provider = fakeProvider((stage, index) => (stage.startsWith("extract") ? goodFacts() : noteFromPrompt(provider.calls[index].user)));
  const server = await startServer(env.config, { jwks: keys.jwks, soapProvider: provider });
  cleanups.push(server.close);
  const token = await keys.sign("doctor-a");
  const call = async (method, url, body, tok = token) => {
    const res = await fetch(`${server.baseUrl}${url}`, {
      method, headers: { Authorization: `Bearer ${tok}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return {
    ...env, ...server, stub, keys, token, call, provider,
    store: server.app.locals.store, soap: server.app.locals.soap,
    setTranscript: () => {}, // the scripted model reads the transcript from its own prompt
  };
}

describe("audio to approved SOAP note", { skip, concurrency: 1 }, () => {
  test("a real recording Deepgram merges becomes a two-speaker transcript and an approved, exported note", async () => {
    const s = await setup({ mergeSpeakers: true });

    // ---- 1. upload the real recording -------------------------------------------------------
    const form = new FormData();
    form.append("audio", new Blob([await readFile(AUDIO)], { type: "audio/flac" }), "consultation.flac");
    const started = Date.now();
    const upload = await fetch(`${s.baseUrl}/api/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` }, body: form });
    const transcription = await upload.json();
    const transcribeSeconds = (Date.now() - started) / 1000;
    assert.equal(upload.status, 201, JSON.stringify(transcription));

    // ---- 2. Deepgram transcribed, pyannote separated the speakers ---------------------------
    assert.equal(transcription.engine, "deepgram");
    assert.equal(transcription.speakerSource, "pyannote", "the merged Deepgram labels were replaced by real speaker detection");
    assert.equal(transcription.diarizationProvider, "pyannote-community-1");
    assert.equal(transcription.speakers.length, 2, `expected two speakers, got ${transcription.speakers.length}`);
    assert.ok(transcription.warnings.some((warning) => warning.code === "SPEAKERS_FROM_PYANNOTE"));

    // every word Deepgram returned is still present, in order, with its own timestamps
    const expected = JSON.parse(await readFile(TRUTH, "utf8")).turns.map((turn) => turn.text).join(" ");
    assert.equal(transcription.text.split(/\s+/).length, expected.split(/\s+/).length, "no word was lost or duplicated");
    assert.match(transcription.text, /sumatriptan/);
    assert.match(transcription.text, /122 over 78/);
    const starts = transcription.segments.map((segment) => segment.startMs);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "segments are in time order");
    assert.ok(transcription.segments.at(-1).endMs > 140_000, "timestamps span the whole 146 s recording");

    // the two voices really are separated: the doctor's opening and the patient's reply differ
    const opening = transcription.segments.find((segment) => /brings you in today/.test(segment.text));
    const reply = transcription.segments.find((segment) => /really bad headache/.test(segment.text));
    assert.ok(opening && reply);
    assert.notEqual(opening.speakerId, reply.speakerId, "the doctor and the patient have different speaker ids");
    const laterDoctor = transcription.segments.find((segment) => /prescribing sumatriptan/.test(segment.text));
    assert.equal(laterDoctor.speakerId, opening.speakerId, "the doctor keeps one id across the whole recording");

    // ---- 3. the doctor confirms the speaker roles -------------------------------------------
    await s.call("PATCH", `/api/transcriptions/${transcription.id}/speakers`, { speakerId: opening.speakerId, role: "doctor" });
    const confirmed = (await s.call("PATCH", `/api/transcriptions/${transcription.id}/speakers`, { speakerId: reply.speakerId, role: "patient" })).body;
    assert.equal(confirmed.speakers.find((sp) => sp.id === opening.speakerId).role, "doctor");
    assert.equal(confirmed.revision, 3, "each edit bumped the transcript revision");
    s.setTranscript(confirmed);

    // ---- 4. SOAP generation from the STORED transcript --------------------------------------
    const soapStarted = Date.now();
    await s.soap.createIfAbsent("doctor-a", transcription.id, { wait: true });
    const soapSeconds = (Date.now() - soapStarted) / 1000;
    const note = (await s.call("GET", `/api/transcriptions/${transcription.id}/soap`)).body;
    assert.equal(note.status, "draft_ready", `generation failed: ${note.errorCode}`);
    assert.equal(note.transcriptionId, transcription.id);
    assert.deepEqual(Object.keys(note.sections).sort(), ["assessment", "objective", "plan", "subjective"]);
    assert.match(note.sections.objective, /BP 122\/78/);
    assert.ok(note.claims.length >= 4);
    // every citation points at a segment of THIS transcript, and the transcript really says it
    for (const claim of note.claims) {
      assert.ok(claim.sourceSegmentIds.length > 0, `unsourced claim: ${claim.text}`);
      for (const id of claim.sourceSegmentIds) {
        assert.ok(transcription.segments.some((segment) => segment.id === id), `claim cites a segment that is not in this transcript: ${id}`);
      }
    }
    const vitalsClaim = note.claims.find((claim) => claim.section === "objective");
    const citedSegment = confirmed.segments.find((segment) => segment.id === vitalsClaim.sourceSegmentIds[0]);
    assert.match(citedSegment.text, /blood pressure is 122 over 78/, "the cited segment really contains the vitals");

    // ---- 5. the doctor edits, then approves -------------------------------------------------
    const edited = (await s.call("PATCH", `/api/transcriptions/${transcription.id}/soap`, {
      sections: { assessment: `${note.sections.assessment} Discussed with the patient.` }, revision: note.revision,
    })).body;
    assert.match(edited.sections.assessment, /Discussed with the patient\./);

    const current = (await s.call("GET", `/api/transcriptions/${transcription.id}/soap`)).body;
    for (const flag of current.reviewFlags.filter((entry) => !entry.blocking && !entry.resolved)) {
      await s.call("POST", `/api/transcriptions/${transcription.id}/soap/flags/${flag.id}/acknowledge`);
    }
    let ready = (await s.call("GET", `/api/transcriptions/${transcription.id}/soap`)).body;

    // Confirming the speaker roles edited the transcript after the note was drafted, so the note is correctly marked stale and
    // approval is refused until the doctor reconciles it. This is the designed path, not a workaround.
    assert.equal(ready.sourceStale, true, "confirming speaker roles changed the source the note was written from");
    const premature = await s.call("POST", `/api/transcriptions/${transcription.id}/soap/approve`, { revision: ready.revision, confirmReviewed: true });
    assert.equal(premature.status, 409);
    assert.equal(premature.body.code, "SOURCE_CHANGED");
    ready = (await s.call("POST", `/api/transcriptions/${transcription.id}/soap/reconcile`, { revision: ready.revision })).body;
    assert.equal(ready.sourceStale, false);
    assert.deepEqual(ready.reviewFlags.filter((flag) => flag.blocking && !flag.resolved).map((flag) => flag.message), []);

    const approved = (await s.call("POST", `/api/transcriptions/${transcription.id}/soap/approve`, { revision: ready.revision, confirmReviewed: true })).body;
    assert.equal(approved.status, "approved", JSON.stringify(approved));
    assert.ok(approved.approvedAt);

    // ---- 6. export ---------------------------------------------------------------------------
    const pdfRes = await fetch(`${s.baseUrl}/api/transcriptions/${transcription.id}/soap/export?format=pdf`, { headers: { Authorization: `Bearer ${s.token}` } });
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get("content-type"), "application/pdf");
    const pdf = Buffer.from(await pdfRes.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.includes(Buffer.from("Discussed with the patient.")), "the PDF carries the doctor's edit");
    assert.ok(pdf.includes(Buffer.from("Subjective")) && pdf.includes(Buffer.from("Plan")));

    const txtRes = await fetch(`${s.baseUrl}/api/transcriptions/${transcription.id}/soap/export?format=txt`, { headers: { Authorization: `Bearer ${s.token}` } });
    const txt = await txtRes.text();
    assert.ok(txt.includes("S — Subjective") && txt.includes("P — Plan"));
    assert.ok(txt.includes("Discussed with the patient."));

    console.log(`  end to end on 146 s of real audio: transcription+diarization ${transcribeSeconds.toFixed(1)} s, SOAP ${soapSeconds.toFixed(1)} s, `
      + `${transcription.speakers.length} speakers, ${transcription.segments.length} segments, ${note.claims.length} claims, ${pdf.length} byte PDF`);
  });

  test("the transcript, its speakers and the approved note all survive a restart", async () => {
    const s = await setup();
    const form = new FormData();
    form.append("audio", new Blob([await readFile(AUDIO)], { type: "audio/flac" }), "consultation.flac");
    const transcription = await (await fetch(`${s.baseUrl}/api/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` }, body: form })).json();
    s.setTranscript(transcription);
    await s.soap.createIfAbsent("doctor-a", transcription.id, { wait: true });
    const note = (await s.call("GET", `/api/transcriptions/${transcription.id}/soap`)).body;
    await s.close();

    const restarted = fakeProvider((stage, index) => (stage.startsWith("extract") ? goodFacts() : noteFromPrompt(restarted.calls[index].user)));
    const server = await startServer(s.config, { jwks: s.keys.jwks, soapProvider: restarted });
    cleanups.push(server.close);
    const reread = await (await fetch(`${server.baseUrl}/api/transcriptions/${transcription.id}/soap`, { headers: { Authorization: `Bearer ${s.token}` } })).json();
    assert.deepEqual(reread.sections, note.sections);
    assert.equal(reread.claims.length, note.claims.length);
    const transcript = await (await fetch(`${server.baseUrl}/api/transcriptions/${transcription.id}`, { headers: { Authorization: `Bearer ${s.token}` } })).json();
    assert.equal(transcript.speakers.length, 2);
    assert.equal(transcript.speakerSource, "pyannote");
  });

  test("when Deepgram gets the speakers right, pyannote does not overrule it, and the note still generates", async () => {
    const s = await setup({ mergeSpeakers: false });
    const form = new FormData();
    form.append("audio", new Blob([await readFile(AUDIO)], { type: "audio/flac" }), "consultation.flac");
    const transcription = await (await fetch(`${s.baseUrl}/api/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` }, body: form })).json();
    assert.equal(transcription.speakers.length, 2);
    assert.equal(transcription.speakerSource, "deepgram", "Deepgram was already right, so its labels stand");
    assert.ok(!transcription.warnings.some((warning) => warning.code === "SPEAKERS_FROM_PYANNOTE"));
    s.setTranscript(transcription);
    await s.soap.createIfAbsent("doctor-a", transcription.id, { wait: true });
    assert.equal((await s.call("GET", `/api/transcriptions/${transcription.id}/soap`)).body.status, "draft_ready");
  });

  test("SOAP generation is started once by the pipeline, not by the client loading a page", async () => {
    const s = await setup();
    const form = new FormData();
    form.append("audio", new Blob([await readFile(AUDIO)], { type: "audio/flac" }), "consultation.flac");
    const transcription = await (await fetch(`${s.baseUrl}/api/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` }, body: form })).json();
    s.setTranscript(transcription);
    // the note exists (processing or finished) without the client ever asking for it
    const immediately = (await s.call("GET", `/api/transcriptions/${transcription.id}/soap`)).body;
    assert.ok(["processing", "draft_ready", "failed"].includes(immediately.status), JSON.stringify(immediately));
    await s.soap.createIfAbsent("doctor-a", transcription.id, { wait: true });
    const extractCalls = s.provider.calls.filter((call) => call.stage.startsWith("extract")).length;
    assert.equal(extractCalls, 1, "exactly one generation ran for one consultation");
  });
});

describe("the pipeline without pyannote installed", () => {
  test("Deepgram's own speakers are used and the note still generates (nothing depends on the model being present)", async () => {
    const stub = await startDeepgramStub(json(200, await deepgramResponse({ mergeSpeakers: false })));
    cleanups.push(stub.close);
    const env = await makeConfig({
      supabaseUrl: TEST_SUPABASE_URL, sttEngine: "deepgram", deepgramApiKey: KEY, deepgramBaseUrl: stub.url,
      pyannoteEnabled: false, voiceEnabled: false, soapEnabled: true, diarizationEnabled: false,
    });
    cleanups.push(env.cleanup);
    const keys = await makeAuth();
    const provider = fakeProvider((stage, index) => (stage.startsWith("extract") ? goodFacts() : noteFromPrompt(provider.calls[index].user)));
    const server = await startServer(env.config, { jwks: keys.jwks, soapProvider: provider });
    cleanups.push(server.close);
    const token = await keys.sign("doctor-a");
    const form = new FormData();
    form.append("audio", new Blob([await readFile(AUDIO)], { type: "audio/flac" }), "consultation.flac");
    const transcription = await (await fetch(`${server.baseUrl}/api/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form })).json();
    assert.equal(transcription.speakerSource, "deepgram");
    assert.equal(transcription.speakers.length, 2);
    await server.app.locals.soap.createIfAbsent("doctor-a", transcription.id, { wait: true });
    const note = await (await fetch(`${server.baseUrl}/api/transcriptions/${transcription.id}/soap`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(note.status, "draft_ready");
  });
});
