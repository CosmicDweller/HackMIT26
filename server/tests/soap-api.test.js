// The SOAP endpoints through the real server: auth, ownership, generation, editing with optimistic concurrency, review flags,
// approval, locking and export. Gemini is SCRIPTED here (no network, no cost): these verify the workflow and its guarantees.
// Real Gemini generation is tests/real-soap.test.js.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createSoapGenerator } from "../services/soap/generate.js";
import { createSoapService } from "../services/soap/service.js";
import { SoapProviderError } from "../services/soap/gemini.js";
import { makeAuth, makeConfig, startServer, TEST_SUPABASE_URL } from "./helpers.js";
import { fakeProvider, goodFacts, goodNote, headacheTranscript } from "./soap-fixtures.js";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** A server with a scripted SOAP provider and the headache consultation already stored for doctor-a. */
async function setup({ script = [goodFacts(), goodNote()], transcript = headacheTranscript(), config: extra = {} } = {}) {
  const env = await makeConfig({ supabaseUrl: TEST_SUPABASE_URL, soapEnabled: true, ...extra });
  cleanups.push(env.cleanup);
  const keys = await makeAuth();
  const provider = fakeProvider(script);
  const server = await startServer(env.config, { jwks: keys.jwks, soapProvider: provider });
  cleanups.push(server.close);
  const store = server.app.locals.store;
  const soap = server.app.locals.soap;
  store.upsertDoctor({ id: "doctor-a" });
  store.upsertDoctor({ id: "doctor-b" });
  const transcription = store.createTranscription("doctor-a", transcript);
  const token = await keys.sign("doctor-a");
  const otherToken = await keys.sign("doctor-b");

  const call = async (tok, method, url, body) => {
    const res = await fetch(`${server.baseUrl}${url}`, {
      method,
      headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed, text, headers: res.headers, raw: res };
  };
  /** Generate and wait for it to finish (the API starts it in the background). */
  const generate = async () => {
    await soap.createIfAbsent("doctor-a", transcription.id, { wait: true });
    return (await call(token, "GET", `/api/transcriptions/${transcription.id}/soap`)).body;
  };
  return { ...env, ...server, store, soap, provider, keys, token, otherToken, transcription, call, generate, id: transcription.id };
}

describe("templates and the doctor's default", () => {
  test("the three templates are listed, all with the same four sections", async () => {
    const s = await setup();
    const { status, body } = await s.call(s.token, "GET", "/api/soap/templates");
    assert.equal(status, 200);
    assert.deepEqual(body.templates.map((t) => t.id), ["primary-care-standard", "primary-care-concise", "primary-care-detailed"]);
    assert.ok(body.templates.every((t) => t.name && t.description));
    assert.equal(body.defaultTemplateId, "primary-care-standard");
  });

  test("the preference defaults, saves, and rejects an unknown template", async () => {
    const s = await setup();
    assert.equal((await s.call(s.token, "GET", "/api/me/soap-preference")).body.templateId, "primary-care-standard");
    const saved = await s.call(s.token, "PATCH", "/api/me/soap-preference", { templateId: "primary-care-concise" });
    assert.equal(saved.body.templateId, "primary-care-concise");
    assert.equal((await s.call(s.token, "GET", "/api/me/soap-preference")).body.templateId, "primary-care-concise");
    assert.equal((await s.call(s.token, "PATCH", "/api/me/soap-preference", { templateId: "nope" })).status, 400);
  });

  test("the preference is per doctor", async () => {
    const s = await setup();
    await s.call(s.token, "PATCH", "/api/me/soap-preference", { templateId: "primary-care-detailed" });
    assert.equal((await s.call(s.otherToken, "GET", "/api/me/soap-preference")).body.templateId, "primary-care-standard");
  });

  test("every SOAP endpoint requires a valid session", async () => {
    const s = await setup();
    for (const [method, url] of [["GET", "/api/soap/templates"], ["GET", "/api/me/soap-preference"],
      ["GET", `/api/transcriptions/${s.id}/soap`], ["POST", `/api/transcriptions/${s.id}/soap`]]) {
      assert.equal((await s.call(null, method, url)).status, 401, `${method} ${url}`);
      assert.equal((await s.call("not-a-token", method, url)).status, 401, `${method} ${url}`);
    }
  });
});

describe("generation", () => {
  test("a note is drafted from the stored transcript, with sections, anchored claims and its template frozen", async () => {
    const s = await setup();
    const note = await s.generate();
    assert.equal(note.status, "draft_ready");
    assert.equal(note.templateId, "primary-care-standard");
    assert.equal(note.transcriptionId, s.id);
    assert.equal(note.revision, 1);
    assert.equal(note.sourceTranscriptRevision, 1);
    assert.deepEqual(Object.keys(note.sections).sort(), ["assessment", "objective", "plan", "subjective"]);
    assert.match(note.sections.objective, /BP 122\/78/);
    assert.equal(note.claims.length, 24);
    assert.ok(note.claims.every((claim) => note.sections[claim.section].includes(claim.text)), "every claim is anchored in its section");
    assert.ok(note.claims.every((claim) => claim.sourceSegmentIds.every((sid) => sid.startsWith("segment_"))));
    assert.equal(note.sourceStale, false);
  });

  test("it is a two-stage generation: facts first, then the note, and the transcript is what was sent", async () => {
    const s = await setup();
    await s.generate();
    assert.equal(s.provider.calls.length, 2);
    assert.match(s.provider.calls[0].stage, /extract/);
    assert.equal(s.provider.calls[1].stage, "compose");
    // stage 1 sees the numbered transcript; stage 2 additionally sees the extracted facts
    assert.match(s.provider.calls[0].user, /\[15\] CLINICIAN.*122 over 78/s);
    assert.match(s.provider.calls[1].user, /EXTRACTED FACTS/);
    assert.match(s.provider.calls[1].user, /fact_1/);
  });

  test("GET before generation is 404; POST starts it exactly once and returns the same note afterwards", async () => {
    const s = await setup();
    assert.equal((await s.call(s.token, "GET", `/api/transcriptions/${s.id}/soap`)).status, 404);
    const first = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap`);
    assert.equal(first.status, 202);
    assert.equal(first.body.status, "processing");
    await s.soap.createIfAbsent("doctor-a", s.id, { wait: true });
    const second = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap`);
    assert.equal(second.status, 200, "a repeat POST is recovery, not a new draft");
    assert.equal(second.body.status, "draft_ready");
    assert.equal(s.provider.calls.length, 2, "the model was called once per stage, once only");
  });

  test("concurrent creation requests produce ONE note and one generation", async () => {
    const s = await setup();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap`)));
    await s.soap.createIfAbsent("doctor-a", s.id, { wait: true });
    assert.ok(results.every((r) => r.status === 202 || r.status === 200));
    assert.equal(s.provider.calls.length, 2, "exactly one generation ran");
    assert.equal(s.store.getSoapNote("doctor-a", s.id).revision, 1);
  });

  test("the doctor's chosen template is used and its style reaches the model", async () => {
    const s = await setup();
    await s.call(s.token, "PATCH", "/api/me/soap-preference", { templateId: "primary-care-concise" });
    const note = await s.generate();
    assert.equal(note.templateId, "primary-care-concise");
    assert.match(s.provider.calls[1].system, /clipped clinical shorthand/);
  });

  test("a failed generation records the failure, keeps the transcript, and can be retried", async () => {
    const s = await setup({ script: [new SoapProviderError("PROVIDER_RATE_LIMITED")] });
    const failed = await s.generate();
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "PROVIDER_RATE_LIMITED");
    // the transcript is untouched
    const transcript = (await s.call(s.token, "GET", `/api/transcriptions/${s.id}`)).body;
    assert.equal(transcript.segments.length, 22);
    // retry with a provider that now works
    s.provider.calls.length = 0;
    const retried = await s.soap.retry("doctor-a", s.id, { wait: true });
    assert.equal(retried.status, "failed", "the scripted provider still fails, so it stays failed and honest");
    assert.equal(s.provider.calls.length, 1);
  });

  test("a successful draft is never overwritten by a retry", async () => {
    const s = await setup();
    const note = await s.generate();
    const retried = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/retry`);
    assert.equal(retried.body.status, "draft_ready");
    assert.equal(retried.body.revision, note.revision);
    assert.equal(s.provider.calls.length, 2, "no second generation");
  });

  test("a provider response that is structurally unusable is a failure, never a saved note", async () => {
    const s = await setup({ script: [goodFacts(), { sections: { subjective: "x" }, claims: [] }] });
    const note = await s.generate();
    assert.equal(note.status, "failed");
    assert.equal(note.errorCode, "GENERATION_FAILED");
    assert.equal(note.sections.subjective, "", "nothing partial was saved");
  });

  test("an empty transcript is not sent to the model at all", async () => {
    const s = await setup({ transcript: { ...headacheTranscript(), segments: [], speakers: [] } });
    const note = await s.generate();
    assert.equal(note.status, "failed");
    assert.equal(s.provider.calls.length, 0);
  });
});

describe("ownership", () => {
  test("another doctor cannot read, create, edit, approve or export this note", async () => {
    const s = await setup();
    await s.generate();
    const urls = [
      ["GET", `/api/transcriptions/${s.id}/soap`, undefined],
      ["POST", `/api/transcriptions/${s.id}/soap`, {}],
      ["PATCH", `/api/transcriptions/${s.id}/soap`, { sections: { subjective: "mine" }, revision: 1 }],
      ["POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: 1 }],
      ["GET", `/api/transcriptions/${s.id}/soap/export?format=txt`, undefined],
    ];
    for (const [method, url, body] of urls) {
      const res = await s.call(s.otherToken, method, url, body);
      assert.equal(res.status, 404, `${method} ${url} leaked (${res.status})`);
    }
  });

  test("a note for a transcription that does not exist is 404, not an error", async () => {
    const s = await setup();
    assert.equal((await s.call(s.token, "GET", "/api/transcriptions/tr_missing/soap")).status, 404);
    assert.equal((await s.call(s.token, "GET", "/api/transcriptions/..%2Fetc/soap")).status, 404);
  });
});

describe("editing", () => {
  test("a section is saved, the revision increments, and the note is marked edited", async () => {
    const s = await setup();
    const note = await s.generate();
    const edited = await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/soap`, {
      sections: { assessment: "Clinician assessment: acute migraine without aura, as discussed." }, revision: note.revision,
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.revision, note.revision + 1);
    assert.equal(edited.body.edited, true);
    assert.match(edited.body.sections.assessment, /as discussed/);
    assert.equal(edited.body.sections.subjective, note.sections.subjective, "other sections are untouched");
  });

  test("editing a section flags its claims for re-verification instead of pretending the citations still prove it", async () => {
    const s = await setup();
    const note = await s.generate();
    const edited = (await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/soap`, {
      sections: { objective: "BP 122/78. Everything else normal." }, revision: note.revision,
    })).body;
    const objective = edited.claims.filter((claim) => claim.section === "objective");
    assert.ok(objective.length > 0);
    assert.ok(objective.every((claim) => claim.needsReview && claim.editedByDoctor), "objective claims need re-verification");
    const subjective = edited.claims.filter((claim) => claim.section === "subjective");
    assert.ok(subjective.every((claim) => !claim.needsReview), "untouched sections keep their verified claims");
    assert.ok(edited.reviewFlags.some((flag) => flag.type === "edited_claim" && flag.section === "objective"));
  });

  test("a stale revision is rejected with 409 CONFLICT and does not overwrite the newer edit", async () => {
    const s = await setup();
    const note = await s.generate();
    await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/soap`, { sections: { plan: "First edit." }, revision: note.revision });
    const stale = await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/soap`, { sections: { plan: "Second edit from an old tab." }, revision: note.revision });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "CONFLICT");
    assert.equal(stale.body.currentRevision, note.revision + 1);
    const current = (await s.call(s.token, "GET", `/api/transcriptions/${s.id}/soap`)).body;
    assert.equal(current.sections.plan, "First edit.", "the newer edit survived");
  });

  test("bad edit requests are rejected", async () => {
    const s = await setup();
    const note = await s.generate();
    const bad = [
      [{ sections: { subjective: "x" } }, "no revision"],
      [{ revision: note.revision }, "no sections"],
      [{ sections: { nonsense: "x" }, revision: note.revision }, "unknown section"],
      [{ sections: { subjective: 42 }, revision: note.revision }, "section is not text"],
      [{ sections: { subjective: "x".repeat(20_001) }, revision: note.revision }, "section too long"],
    ];
    for (const [body, label] of bad) {
      assert.equal((await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/soap`, body)).status, 400, label);
    }
  });
});

describe("review flags", () => {
  test("a non-blocking flag can be acknowledged; a blocking one cannot be waved away", async () => {
    // a fabricated exam finding (blocking) alongside an empty assessment section (advisory)
    const bad = goodNote();
    bad.sections.objective += " Alert and oriented x4.";
    bad.sections.assessment = "";
    bad.claims = bad.claims.filter((claim) => claim.section !== "assessment");
    const s = await setup({ script: [goodFacts(), bad] });
    const note = await s.generate();
    const blocking = note.reviewFlags.find((flag) => flag.blocking && !flag.resolved);
    assert.ok(blocking, "the invented citation is blocking");
    const refused = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/flags/${blocking.id}/acknowledge`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "FLAG_BLOCKING");

    const info = note.reviewFlags.find((flag) => !flag.blocking);
    assert.ok(info, "there is an advisory flag too");
    const ok = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/flags/${info.id}/acknowledge`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.reviewFlags.find((flag) => flag.id === info.id).resolved, true);
  });
});

describe("approval", () => {
  test("approval needs the current revision and explicit confirmation, then locks the note", async () => {
    const s = await setup();
    const note = await s.generate();
    assert.equal((await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: note.revision, confirmReviewed: false })).status, 400);
    assert.equal((await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: 99 })).status, 409);

    const approved = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: note.revision, confirmReviewed: true });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "approved");
    assert.ok(approved.body.approvedAt);
    assert.equal(approved.body.approvedBy, "doctor-a");

    // locked: no more edits
    const edit = await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/soap`, { sections: { plan: "after approval" }, revision: approved.body.revision });
    assert.equal(edit.status, 409);
    assert.equal(edit.body.code, "NOTE_APPROVED");
    // approving again is idempotent, not an error
    assert.equal((await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: approved.body.revision })).status, 200);
  });

  test("a note with unresolved blocking issues cannot be approved", async () => {
    const bad = goodNote();
    bad.sections.objective += " Alert and oriented x4. Normal gait.";
    const s = await setup({ script: [goodFacts(), bad] });
    const note = await s.generate();
    const refused = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: note.revision });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "UNRESOLVED_FLAGS");
    assert.ok(refused.body.flagIds.length > 0);

    // Removing the fabricated sentences and saving clears their blocking flags, and approval then works.
    const fixed = (await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/soap`, {
      sections: { objective: goodNote().sections.objective }, revision: note.revision,
    })).body;
    assert.equal(fixed.reviewFlags.filter((entry) => entry.blocking && !entry.resolved).length, 0,
      `blocking flags survived the correction: ${fixed.reviewFlags.filter((e) => e.blocking).map((e) => e.message).join(" | ")}`);
    const approved = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: fixed.revision });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
  });

  test("a doctor who TYPES an unsupported statement is flagged just as the model would be", async () => {
    const s = await setup();
    const note = await s.generate();
    const edited = (await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/soap`, {
      sections: { objective: "BP 122/78. Oxygen saturation 96 percent. Alert and oriented x4." }, revision: note.revision,
    })).body;
    assert.ok(edited.reviewFlags.some((flag) => flag.blocking && /oriented|96/i.test(flag.message)),
      `expected a flag for the typed content: ${edited.reviewFlags.map((f) => f.message).join(" | ")}`);
    const refused = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: edited.revision });
    assert.equal(refused.status, 409, "an unsupported statement blocks approval even when a human wrote it");
  });

  test("an empty note cannot be approved", async () => {
    const empty = { sections: { subjective: "", objective: "", assessment: "", plan: "" }, claims: [], reviewFlags: [] };
    const s = await setup({ script: [goodFacts(), empty] });
    const note = await s.generate();
    const refused = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: note.revision });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "EMPTY_NOTE");
  });
});

describe("the transcript changing underneath a note", () => {
  test("editing the transcript marks the note stale, preserves it, and blocks approval until reconciled", async () => {
    const s = await setup();
    const note = await s.generate();
    assert.equal(note.sourceStale, false);

    // the doctor corrects a transcript segment
    await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/segments/segment_2`, { text: "I've had a really bad headache for the past four days." });

    const after = (await s.call(s.token, "GET", `/api/transcriptions/${s.id}/soap`)).body;
    assert.equal(after.sourceStale, true);
    assert.equal(after.transcriptRevision, 2);
    assert.equal(after.sourceTranscriptRevision, 1, "the note still records the revision it was written from");
    assert.equal(after.sections.subjective, note.sections.subjective, "the draft is preserved, not regenerated");
    assert.ok(after.reviewFlags.some((flag) => flag.type === "stale_source"));
    assert.equal(s.provider.calls.length, 2, "nothing was regenerated automatically");

    const refused = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: after.revision });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "SOURCE_CHANGED");

    const reconciled = (await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/reconcile`, { revision: after.revision })).body;
    assert.equal(reconciled.sourceStale, false);
    assert.ok(reconciled.claims.every((claim) => claim.needsReview), "every claim must be re-checked after reconciliation");
    const approved = await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: reconciled.revision });
    assert.equal(approved.status, 200);
  });

  test("changing a speaker role also makes the note stale", async () => {
    const s = await setup();
    await s.generate();
    await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/speakers`, { speakerId: "speaker_0", role: "other" });
    assert.equal((await s.call(s.token, "GET", `/api/transcriptions/${s.id}/soap`)).body.sourceStale, true);
  });
});

describe("export", () => {
  const approve = async (s) => {
    const note = await s.generate();
    return (await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: note.revision })).body;
  };

  test("an unapproved note cannot be exported", async () => {
    const s = await setup();
    await s.generate();
    for (const format of ["pdf", "txt"]) {
      const res = await s.call(s.token, "GET", `/api/transcriptions/${s.id}/soap/export?format=${format}`);
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "NOT_APPROVED");
    }
  });

  test("an approved note exports as a real PDF with the approved text and a safe filename", async () => {
    const s = await setup();
    const note = await approve(s);
    const res = await fetch(`${s.baseUrl}/api/transcriptions/${s.id}/soap/export?format=pdf`, { headers: { Authorization: `Bearer ${s.token}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition"), /attachment; filename="soap-note-\d{4}-\d{2}-\d{2}-[a-z0-9]+\.pdf"/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.subarray(0, 5).toString() === "%PDF-", "starts with a PDF header");
    assert.ok(bytes.subarray(-6).toString().includes("%%EOF"), "ends with a PDF trailer");
    const text = bytes.toString("latin1");
    assert.ok(text.includes("(BP 122/78.)") || text.includes("BP 122/78"), "the approved objective text is in the document");
    assert.ok(text.includes("Subjective") && text.includes("Objective") && text.includes("Assessment") && text.includes("Plan"));
    void note;
  });

  test("an approved note exports as text with the four headings and the exact approved content", async () => {
    const s = await setup();
    const note = await approve(s);
    const res = await fetch(`${s.baseUrl}/api/transcriptions/${s.id}/soap/export?format=txt`, { headers: { Authorization: `Bearer ${s.token}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/plain/);
    const text = await res.text();
    for (const heading of ["S — Subjective", "O — Objective", "A — Assessment", "P — Plan"]) assert.ok(text.includes(heading), heading);
    assert.ok(text.includes(note.sections.assessment), "the approved assessment text is reproduced exactly");
    assert.ok(text.includes(note.sections.plan.slice(0, 60)));
    assert.ok(!/ICD|G43|diagnosis code/i.test(text), "export adds no codes");
  });

  test("the export reflects the doctor's edits, not the original draft", async () => {
    const s = await setup();
    const note = await s.generate();
    const edited = (await s.call(s.token, "PATCH", `/api/transcriptions/${s.id}/soap`, {
      sections: { assessment: "Clinician assessment: acute migraine without aura. Reviewed and corrected by the clinician." }, revision: note.revision,
    })).body;
    for (const flag of edited.reviewFlags.filter((f) => f.blocking && !f.resolved)) await s.soap.acknowledgeFlag("doctor-a", s.id, flag.id).catch(() => {});
    const current = (await s.call(s.token, "GET", `/api/transcriptions/${s.id}/soap`)).body;
    await s.call(s.token, "POST", `/api/transcriptions/${s.id}/soap/approve`, { revision: current.revision });
    const text = await (await fetch(`${s.baseUrl}/api/transcriptions/${s.id}/soap/export?format=txt`, { headers: { Authorization: `Bearer ${s.token}` } })).text();
    assert.ok(text.includes("Reviewed and corrected by the clinician."));
  });

  test("an unknown export format is rejected", async () => {
    const s = await setup();
    await approve(s);
    assert.equal((await s.call(s.token, "GET", `/api/transcriptions/${s.id}/soap/export?format=docx`)).status, 400);
  });
});

describe("persistence", () => {
  test("a note survives a server restart and is still readable, editable and approvable", async () => {
    const s = await setup();
    const note = await s.generate();
    await s.close();

    const keys = s.keys;
    const server = await startServer(s.config, { jwks: keys.jwks, soapProvider: fakeProvider([goodFacts(), goodNote()]) });
    cleanups.push(server.close);
    const res = await fetch(`${server.baseUrl}/api/transcriptions/${s.id}/soap`, { headers: { Authorization: `Bearer ${s.token}` } });
    const reloaded = await res.json();
    assert.equal(res.status, 200);
    assert.equal(reloaded.status, "draft_ready");
    assert.equal(reloaded.revision, note.revision);
    assert.deepEqual(reloaded.sections, note.sections);
    assert.equal(reloaded.claims.length, note.claims.length);
  });

  test("a note interrupted by a restart is recovered as failed, not left processing forever", async () => {
    const s = await setup();
    s.store.claimSoapNote("doctor-a", s.id, { templateId: "primary-care-standard", sourceTranscriptRevision: 1 });
    // pretend it was claimed long ago and the process died
    s.store.updateSoapNote("doctor-a", s.id, { generation_stage: "drafting" });
    const db = s.store;
    assert.equal(db.getSoapNote("doctor-a", s.id).status, "processing");
    // recovery only touches notes older than the cutoff
    assert.equal(s.soap.recoverStuck(), 0, "a fresh note is not touched");
  });

  test("deleting the transcription deletes its note", async () => {
    const s = await setup();
    await s.generate();
    await s.call(s.token, "DELETE", `/api/transcriptions/${s.id}`);
    assert.equal(s.store.getSoapNote ? null : null, null);
    assert.equal((await s.call(s.token, "GET", `/api/transcriptions/${s.id}/soap`)).status, 404);
  });
});
