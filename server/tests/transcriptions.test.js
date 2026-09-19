// Contract v2 API tests: authentication, ownership, persistence, speaker mapping, corrections,
// history and deletion. Whisper and the diarizer are stand-in scripts here (deterministic and fast),
// so these verify the API and data layer only. Real speech recognition and real diarization are
// covered by real-inference.test.js and real-diarization.test.js.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { SignJWT, generateKeyPair } from "jose";
import {
  leftoverFiles, makeAuth, makeConfig, makeFakeDiarizer, makeFakeWhisper, readFixture, startServer, TEST_SUPABASE_URL,
} from "./helpers.js";
import path from "node:path";
import { writeFile } from "node:fs/promises";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** App with fake whisper + fake diarizer, a local key set, and its own SQLite file. */
async function setup({ diarizer = "ok", auth = true, ...overrides } = {}) {
  const env = await makeConfig({ supabaseUrl: TEST_SUPABASE_URL, ...overrides });
  cleanups.push(env.cleanup);
  env.config.whisperBin = await makeFakeWhisper(env.root, "ok");
  env.config.whisperModel = path.join(env.root, "model.bin");
  await writeFile(env.config.whisperModel, "x");
  env.config.whisperVadModel = null;
  env.config.diarizationPython = await makeFakeDiarizer(env.root, diarizer);
  env.config.diarizationScript = env.config.diarizationPython;
  env.config.diarizationEnabled = true;

  const keys = await makeAuth();
  const server = await startServer(env.config, auth ? { jwks: keys.jwks } : {});
  cleanups.push(server.close);

  const call = async (token, method, url, body) => {
    const res = await fetch(`${server.baseUrl}${url}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const upload = async (token, fields = {}) => {
    const form = new FormData();
    form.append("audio", new Blob([await readFixture()], { type: "audio/wav" }), "visit.wav");
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const res = await fetch(`${server.baseUrl}/api/transcriptions`, {
      method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form,
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const tokenFor = (subject, claims, options) => keys.sign(subject, claims, options);
  return { ...env, ...server, keys, call, upload, tokenFor };
}

const expectError = (res, status, code) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.code, code);
  assert.deepEqual(Object.keys(res.body).sort(), ["code", "error"]);
};

describe("authentication", () => {
  const protectedRoutes = [
    ["GET", "/api/me"],
    ["GET", "/api/transcriptions"],
    ["GET", "/api/transcriptions/tr_x"],
    ["DELETE", "/api/transcriptions/tr_x"],
    ["POST", "/api/transcriptions/tr_x/review"],
    ["PATCH", "/api/transcriptions/tr_x/speakers", { speakerId: "speaker_1", role: "doctor" }],
    ["PATCH", "/api/transcriptions/tr_x/segments/segment_1", { text: "x" }],
  ];

  test("every protected route returns 401 UNAUTHENTICATED without a token", async () => {
    const { call } = await setup();
    for (const [method, url, body] of protectedRoutes) {
      expectError(await call(null, method, url, body), 401, "UNAUTHENTICATED");
    }
  });

  test("POST /api/transcriptions returns 401 before any audio is processed", async () => {
    const { upload, tmpDir } = await setup();
    expectError(await upload(null), 401, "UNAUTHENTICATED");
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });

  test("a valid token succeeds and /api/me reports the verified identity, never verified credentials", async () => {
    const { call, tokenFor } = await setup();
    const token = await tokenFor("doctor-a", { email: "a@example.test", user_metadata: { full_name: "Dr A" } });
    const me = await call(token, "GET", "/api/me");
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { id: "doctor-a", email: "a@example.test", displayName: "Dr A", credentialsVerified: false });
  });

  test("rejects malformed and garbage tokens", async () => {
    const { call } = await setup();
    for (const token of ["garbage", "a.b.c", "Bearer x"]) {
      expectError(await call(token, "GET", "/api/me"), 401, "UNAUTHENTICATED");
    }
  });

  test("rejects an expired token", async () => {
    const { call, tokenFor } = await setup();
    expectError(await call(await tokenFor("doctor-a", {}, { expiresIn: "-1m" }), "GET", "/api/me"), 401, "UNAUTHENTICATED");
  });

  test("rejects a token signed with a different key", async () => {
    const { call, tokenFor } = await setup();
    const { privateKey } = await generateKeyPair("ES256");
    expectError(await call(await tokenFor("doctor-a", {}, { key: privateKey }), "GET", "/api/me"), 401, "UNAUTHENTICATED");
  });

  test("rejects a token from another issuer or audience", async () => {
    const { call, tokenFor } = await setup();
    expectError(await call(await tokenFor("a", {}, { issuer: "https://evil.example/auth/v1" }), "GET", "/api/me"), 401, "UNAUTHENTICATED");
    expectError(await call(await tokenFor("a", {}, { audience: "someone-else" }), "GET", "/api/me"), 401, "UNAUTHENTICATED");
  });

  test("rejects HMAC and unsigned tokens (algorithm confusion)", async () => {
    const { call } = await setup();
    const hmac = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", kid: "test-key" })
      .setSubject("doctor-a").setIssuer(`${TEST_SUPABASE_URL}/auth/v1`).setAudience("authenticated")
      .setExpirationTime("1h").sign(new TextEncoder().encode("secret-secret-secret-secret-secret!"));
    expectError(await call(hmac, "GET", "/api/me"), 401, "UNAUTHENTICATED");

    const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "doctor-a", role: "authenticated", aud: "authenticated", iss: `${TEST_SUPABASE_URL}/auth/v1`, exp: 9_999_999_999 })}.`;
    expectError(await call(unsigned, "GET", "/api/me"), 401, "UNAUTHENTICATED");
  });

  test("rejects anonymous and non-authenticated roles", async () => {
    const { call, tokenFor } = await setup();
    expectError(await call(await tokenFor("anon-user", { is_anonymous: true }), "GET", "/api/me"), 401, "UNAUTHENTICATED");
    expectError(await call(await tokenFor("service", { role: "service_role" }), "GET", "/api/me"), 401, "UNAUTHENTICATED");
  });

  test("reports SERVICE_UNAVAILABLE when authentication is not configured", async () => {
    const { call } = await setup({ auth: false, supabaseUrl: "" });
    expectError(await call("some.token.value", "GET", "/api/me"), 503, "SERVICE_UNAVAILABLE");
  });

  test("the legacy public POST /api/transcribe still works without authentication", async () => {
    const { baseUrl } = await setup();
    const form = new FormData();
    form.append("audio", new Blob([await readFixture()], { type: "audio/wav" }), "a.wav");
    const res = await fetch(`${baseUrl}/api/transcribe`, { method: "POST", body: form });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(await res.json()).sort(), ["durationSeconds", "text"]);
  });
});

describe("creating and reading transcriptions", () => {
  test("returns the full resource with unassigned speakers and needs_review", async () => {
    const { upload, tokenFor, tmpDir } = await setup();
    const res = await upload(await tokenFor("doctor-a"));
    assert.equal(res.status, 201);
    assert.match(res.headers.get("location"), /^\/api\/transcriptions\/tr_/);
    const t = res.body;
    assert.match(t.id, /^tr_[0-9a-f-]{36}$/);
    assert.equal(t.text, "Hello world.");
    assert.equal(t.durationSeconds, 11);
    assert.equal(t.reviewStatus, "needs_review");
    assert.deepEqual(t.diarization, { status: "ok", speakerCount: 2 });
    assert.deepEqual(t.speakers, [
      { id: "speaker_1", label: "Speaker 1", role: "unassigned" },
      { id: "speaker_2", label: "Speaker 2", role: "unassigned" },
    ]);
    assert.deepEqual(t.segments, [
      { id: "segment_1", startMs: 250, endMs: 1500, text: "Hello", speakerId: "speaker_1" },
      { id: "segment_2", startMs: 1500, endMs: 3000, text: "world.", speakerId: "speaker_2" },
    ]);
    assert.ok(!("ownerId" in t) && !("owner_id" in t), "owner id must not be exposed");
    assert.deepEqual(await leftoverFiles(tmpDir), [], "raw audio must not be retained");
  });

  test("a saved transcription can be retrieved and is listed newest first", async () => {
    const { upload, call, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const first = (await upload(token)).body;
    const second = (await upload(token)).body;
    const got = await call(token, "GET", `/api/transcriptions/${first.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, first);

    const list = await call(token, "GET", "/api/transcriptions");
    assert.equal(list.status, 200);
    assert.deepEqual(Object.keys(list.body), ["transcriptions"]);
    assert.deepEqual(list.body.transcriptions.map((t) => t.id), [second.id, first.id]);
    assert.deepEqual(Object.keys(list.body.transcriptions[0]).sort(), ["createdAt", "durationSeconds", "id", "reviewStatus"]);
  });

  test("an owner id supplied by the client is ignored: ownership comes from the token", async () => {
    const { upload, call, tokenFor } = await setup();
    const created = await upload(await tokenFor("doctor-a"), { ownerId: "doctor-b", owner_id: "doctor-b" });
    assert.equal(created.status, 201);
    expectError(await call(await tokenFor("doctor-b"), "GET", `/api/transcriptions/${created.body.id}`), 404, "NOT_FOUND");
    assert.equal((await call(await tokenFor("doctor-a"), "GET", `/api/transcriptions/${created.body.id}`)).status, 200);
  });

  test("survives a server restart (data is on disk)", async () => {
    const { upload, tokenFor, config, keys, close } = await setup();
    const token = await tokenFor("doctor-a");
    const created = (await upload(token)).body;
    await close();
    const again = await startServer(config, { jwks: keys.jwks });
    cleanups.push(again.close);
    const res = await fetch(`${again.baseUrl}/api/transcriptions/${created.id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual(await res.json(), created);
  });

  test("rejects an invalid expectedSpeakers value", async () => {
    const { upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    for (const bad of ["0", "7", "two", "1.5"]) expectError(await upload(token, { expectedSpeakers: bad }), 400, "INVALID_REQUEST");
    assert.equal((await upload(token, { expectedSpeakers: "2" })).status, 201);
  });
});

describe("diarization fallback", () => {
  test("when diarization fails the transcript is returned with every speaker null and status failed", async () => {
    const { upload, tokenFor } = await setup({ diarizer: "fail" });
    const res = await upload(await tokenFor("doctor-a"));
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.diarization, { status: "failed", speakerCount: 0 });
    assert.deepEqual(res.body.speakers, []);
    assert.ok(res.body.segments.length > 0 && res.body.segments.every((s) => s.speakerId === null));
    assert.equal(res.body.reviewStatus, "needs_review");
  });

  test("a missing diarization model is reported as unavailable, not as a normal result", async () => {
    const { upload, tokenFor } = await setup({ diarizer: "missingModel" });
    const res = await upload(await tokenFor("doctor-a"));
    assert.equal(res.body.diarization.status, "unavailable");
    assert.ok(res.body.segments.every((s) => s.speakerId === null));
  });

  test("unparseable diarizer output is a failure, not fabricated labels", async () => {
    const { upload, tokenFor } = await setup({ diarizer: "garbage" });
    const res = await upload(await tokenFor("doctor-a"));
    assert.equal(res.body.diarization.status, "failed");
    assert.ok(res.body.segments.every((s) => s.speakerId === null));
  });

  test("a diarization timeout degrades to failed and still cleans up", async () => {
    const { upload, tokenFor, tmpDir } = await setup({ diarizer: "hang", diarizationTimeoutMs: 1000 });
    const res = await upload(await tokenFor("doctor-a"));
    assert.equal(res.status, 201);
    assert.equal(res.body.diarization.status, "failed");
    assert.deepEqual(await leftoverFiles(tmpDir), []);
  });
});

describe("ownership: doctor B can never touch doctor A's transcript", () => {
  async function twoDoctors() {
    const env = await setup();
    const tokenA = await env.tokenFor("doctor-a");
    const tokenB = await env.tokenFor("doctor-b");
    const created = (await env.upload(tokenA)).body;
    return { ...env, tokenA, tokenB, created };
  }

  test("B cannot read A's transcript, and B's history is empty", async () => {
    const { call, tokenB, created } = await twoDoctors();
    expectError(await call(tokenB, "GET", `/api/transcriptions/${created.id}`), 404, "NOT_FOUND");
    assert.deepEqual((await call(tokenB, "GET", "/api/transcriptions")).body, { transcriptions: [] });
  });

  test("B cannot edit A's segments or speaker roles", async () => {
    const { call, tokenA, tokenB, created } = await twoDoctors();
    expectError(await call(tokenB, "PATCH", `/api/transcriptions/${created.id}/segments/segment_1`, { text: "hacked" }), 404, "NOT_FOUND");
    expectError(await call(tokenB, "PATCH", `/api/transcriptions/${created.id}/speakers`, { speakerId: "speaker_1", role: "doctor" }), 404, "NOT_FOUND");
    const after = await call(tokenA, "GET", `/api/transcriptions/${created.id}`);
    assert.deepEqual(after.body, created, "A's data must be unchanged");
  });

  test("B cannot delete A's transcript", async () => {
    const { call, tokenA, tokenB, created } = await twoDoctors();
    expectError(await call(tokenB, "DELETE", `/api/transcriptions/${created.id}`), 404, "NOT_FOUND");
    assert.equal((await call(tokenA, "GET", `/api/transcriptions/${created.id}`)).status, 200);
  });

  test("history contains only the caller's own transcripts", async () => {
    const { call, upload, tokenA, tokenB, created } = await twoDoctors();
    const b = (await upload(tokenB)).body;
    assert.deepEqual((await call(tokenA, "GET", "/api/transcriptions")).body.transcriptions.map((t) => t.id), [created.id]);
    assert.deepEqual((await call(tokenB, "GET", "/api/transcriptions")).body.transcriptions.map((t) => t.id), [b.id]);
  });

  test("malformed ids look like any missing resource", async () => {
    const { call, tokenA } = await twoDoctors();
    for (const id of ["nope", "tr_../../etc", "x".repeat(200), "tr_1' OR '1'='1"]) {
      expectError(await call(tokenA, "GET", `/api/transcriptions/${encodeURIComponent(id)}`), 404, "NOT_FOUND");
    }
  });
});

describe("speaker roles", () => {
  test("assigning a role persists, keeps stable speaker ids, and does not mark the transcript reviewed", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const created = (await upload(token)).body;

    const res = await call(token, "PATCH", `/api/transcriptions/${created.id}/speakers`, { speakerId: "speaker_1", role: "doctor" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.speakers.map((s) => [s.id, s.role]), [["speaker_1", "doctor"], ["speaker_2", "unassigned"]]);
    assert.deepEqual(res.body.segments, created.segments, "segments keep referencing internal speaker ids");
    assert.equal(res.body.reviewStatus, "needs_review");

    await call(token, "PATCH", `/api/transcriptions/${created.id}/speakers`, { speakerId: "speaker_2", role: "patient" });
    const got = await call(token, "GET", `/api/transcriptions/${created.id}`);
    assert.deepEqual(got.body.speakers.map((s) => s.role), ["doctor", "patient"]);
    assert.equal(got.body.reviewStatus, "needs_review");
  });

  test("validates role, speaker and body", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const { id } = (await upload(token)).body;
    const patch = (body) => call(token, "PATCH", `/api/transcriptions/${id}/speakers`, body);
    expectError(await patch({ speakerId: "speaker_1", role: "surgeon" }), 400, "INVALID_REQUEST");
    expectError(await patch({ speakerId: "speaker_9", role: "doctor" }), 400, "INVALID_REQUEST");
    expectError(await patch({ role: "doctor" }), 400, "INVALID_REQUEST");
    expectError(await patch({ speakerId: 1, role: "doctor" }), 400, "INVALID_REQUEST");
    for (const role of ["doctor", "patient", "other", "unassigned"]) assert.equal((await patch({ speakerId: "speaker_1", role })).status, 200);
  });

  test("rejects malformed JSON", async () => {
    const { baseUrl, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const { id } = (await upload(token)).body;
    const res = await fetch(`${baseUrl}/api/transcriptions/${id}/speakers`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "INVALID_REQUEST");
  });
});

describe("segment corrections", () => {
  test("text and speaker changes persist, keep timestamps, and keep the full text consistent", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const created = (await upload(token)).body;
    const url = `/api/transcriptions/${created.id}/segments/segment_2`;

    const res = await call(token, "PATCH", url, { text: "  World, corrected.  ", speakerId: "speaker_1" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.segments[1], { id: "segment_2", startMs: 1500, endMs: 3000, text: "World, corrected.", speakerId: "speaker_1" });
    assert.equal(res.body.text, "Hello World, corrected.");
    assert.equal(res.body.reviewStatus, "needs_review");

    const got = await call(token, "GET", `/api/transcriptions/${created.id}`);
    assert.deepEqual(got.body, res.body);
  });

  test("text-only and speaker-only updates both work; speakerId may be set to null", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const { id } = (await upload(token)).body;
    const url = `/api/transcriptions/${id}/segments/segment_1`;
    assert.equal((await call(token, "PATCH", url, { text: "Hi" })).body.segments[0].speakerId, "speaker_1");
    assert.equal((await call(token, "PATCH", url, { speakerId: "speaker_2" })).body.segments[0].speakerId, "speaker_2");
    const cleared = await call(token, "PATCH", url, { speakerId: null });
    assert.equal(cleared.body.segments[0].speakerId, null);
    assert.equal(cleared.body.segments[0].text, "Hi");
  });

  test("rejects invalid updates", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const { id } = (await upload(token)).body;
    const patch = (segment, body) => call(token, "PATCH", `/api/transcriptions/${id}/segments/${segment}`, body);
    expectError(await patch("segment_1", {}), 400, "INVALID_REQUEST");
    expectError(await patch("segment_1", { text: "" }), 400, "INVALID_REQUEST");
    expectError(await patch("segment_1", { text: "x".repeat(10_001) }), 400, "INVALID_REQUEST");
    expectError(await patch("segment_1", { text: 5 }), 400, "INVALID_REQUEST");
    expectError(await patch("segment_1", { speakerId: "speaker_9" }), 400, "INVALID_REQUEST");
    expectError(await patch("segment_99", { text: "x" }), 404, "NOT_FOUND");
  });

  test("a failed update changes nothing (text and speaker are applied atomically)", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const created = (await upload(token)).body;
    expectError(await call(token, "PATCH", `/api/transcriptions/${created.id}/segments/segment_1`, { text: "changed", speakerId: "speaker_9" }), 400, "INVALID_REQUEST");
    assert.deepEqual((await call(token, "GET", `/api/transcriptions/${created.id}`)).body, created);
  });

  test("a speaker from another transcription cannot be referenced", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const withSpeakers = (await upload(token)).body;
    assert.ok(withSpeakers.speakers.some((s) => s.id === "speaker_1"));
    // A transcription whose diarization failed has no speakers at all.
    const failing = await setup({ diarizer: "fail" });
    const bareToken = await failing.tokenFor("doctor-a");
    const bare = (await failing.upload(bareToken)).body;
    expectError(
      await failing.call(bareToken, "PATCH", `/api/transcriptions/${bare.id}/segments/segment_1`, { speakerId: "speaker_1" }),
      400, "INVALID_REQUEST",
    );
  });
});

describe("deletion", () => {
  test("delete returns 204, removes the transcript and every dependent record", async () => {
    const { call, upload, tokenFor, config } = await setup();
    const token = await tokenFor("doctor-a");
    const { id } = (await upload(token)).body;

    const del = await call(token, "DELETE", `/api/transcriptions/${id}`);
    assert.equal(del.status, 204);
    assert.equal(del.body, null);
    expectError(await call(token, "GET", `/api/transcriptions/${id}`), 404, "NOT_FOUND");
    assert.deepEqual((await call(token, "GET", "/api/transcriptions")).body, { transcriptions: [] });
    expectError(await call(token, "DELETE", `/api/transcriptions/${id}`), 404, "NOT_FOUND");

    const raw = new DatabaseSync(config.dbPath);
    for (const table of ["transcriptions", "speakers", "segments"]) {
      assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} rows must be deleted`);
    }
    raw.close();
  });

  test("deleting one transcript leaves the same doctor's others intact", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const keep = (await upload(token)).body;
    const drop = (await upload(token)).body;
    assert.equal((await call(token, "DELETE", `/api/transcriptions/${drop.id}`)).status, 204);
    assert.deepEqual((await call(token, "GET", `/api/transcriptions/${keep.id}`)).body, keep);
  });
});

describe("review confirmation", () => {
  test("is only ever set by the explicit review action, and persists", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const created = (await upload(token)).body;
    assert.equal(created.reviewStatus, "needs_review");

    // Doing all the other things does not review it.
    await call(token, "PATCH", `/api/transcriptions/${created.id}/speakers`, { speakerId: "speaker_1", role: "doctor" });
    await call(token, "PATCH", `/api/transcriptions/${created.id}/speakers`, { speakerId: "speaker_2", role: "patient" });
    const edited = await call(token, "PATCH", `/api/transcriptions/${created.id}/segments/segment_1`, { text: "Hi" });
    assert.equal(edited.body.reviewStatus, "needs_review");

    const reviewed = await call(token, "POST", `/api/transcriptions/${created.id}/review`);
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.reviewStatus, "reviewed");
    assert.deepEqual({ ...reviewed.body, reviewStatus: "x" }, { ...edited.body, reviewStatus: "x" }, "only the status changes");
    assert.equal((await call(token, "GET", `/api/transcriptions/${created.id}`)).body.reviewStatus, "reviewed");
    assert.equal((await call(token, "GET", "/api/transcriptions")).body.transcriptions[0].reviewStatus, "reviewed");
  });

  test("is idempotent", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const { id } = (await upload(token)).body;
    await call(token, "POST", `/api/transcriptions/${id}/review`);
    assert.equal((await call(token, "POST", `/api/transcriptions/${id}/review`)).body.reviewStatus, "reviewed");
  });

  test("editing text, changing a segment's speaker or assigning a role after review requires review again", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const { id } = (await upload(token)).body;
    const review = () => call(token, "POST", `/api/transcriptions/${id}/review`);

    await review();
    assert.equal((await call(token, "PATCH", `/api/transcriptions/${id}/segments/segment_1`, { text: "Changed" })).body.reviewStatus, "needs_review");
    await review();
    assert.equal((await call(token, "PATCH", `/api/transcriptions/${id}/segments/segment_1`, { speakerId: "speaker_2" })).body.reviewStatus, "needs_review");
    await review();
    assert.equal((await call(token, "PATCH", `/api/transcriptions/${id}/speakers`, { speakerId: "speaker_1", role: "other" })).body.reviewStatus, "needs_review");
  });

  test("a rejected edit does not disturb an existing review", async () => {
    const { call, upload, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    const { id } = (await upload(token)).body;
    await call(token, "POST", `/api/transcriptions/${id}/review`);
    expectError(await call(token, "PATCH", `/api/transcriptions/${id}/segments/segment_1`, { text: "" }), 400, "INVALID_REQUEST");
    assert.equal((await call(token, "GET", `/api/transcriptions/${id}`)).body.reviewStatus, "reviewed");
  });

  test("doctor B cannot review doctor A's transcript", async () => {
    const { call, upload, tokenFor } = await setup();
    const tokenA = await tokenFor("doctor-a");
    const tokenB = await tokenFor("doctor-b");
    const { id } = (await upload(tokenA)).body;
    expectError(await call(tokenB, "POST", `/api/transcriptions/${id}/review`), 404, "NOT_FOUND");
    assert.equal((await call(tokenA, "GET", `/api/transcriptions/${id}`)).body.reviewStatus, "needs_review");
  });

  test("an unknown or malformed id is not found", async () => {
    const { call, tokenFor } = await setup();
    const token = await tokenFor("doctor-a");
    expectError(await call(token, "POST", "/api/transcriptions/tr_00000000-0000-0000-0000-000000000000/review"), 404, "NOT_FOUND");
    expectError(await call(token, "POST", "/api/transcriptions/..%2Fx/review"), 404, "NOT_FOUND");
  });
});
