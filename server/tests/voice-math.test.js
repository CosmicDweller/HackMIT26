// Pure voice math: clustering (checked against SciPy), the doctor decision policy, and encryption at rest.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { decryptJson, encryptJson, parseKey } from "../services/voice/protect.js";
import { clusterAverageLinkage, decideDoctor, dot, meanUnit, normalize, scoreAgainstProfile } from "../services/voice/vecmath.js";

const parity = JSON.parse(readFileSync(new URL("./fixtures/voice/cluster-parity.json", import.meta.url), "utf8"));
const unitVec = (...x) => normalize(x);

describe("clustering", () => {
  test("produces exactly the partitions SciPy's average linkage gave on real embeddings (24 sessions)", () => {
    for (const [i, session] of parity.sessions.entries()) {
      const labels = clusterAverageLinkage(session.vectors.map((vec) => ({ vec: normalize(vec), weight: 1 })), parity.threshold);
      assert.deepEqual(labels, session.labels, `session ${i}`);
    }
  });
  test("separates orthogonal voices and joins identical ones", () => {
    const a = unitVec(1, 0, 0), b = unitVec(0, 1, 0);
    assert.deepEqual(clusterAverageLinkage([a, a, b, b, a].map((vec) => ({ vec, weight: 1 })), 0.5), [0, 0, 1, 1, 0]);
  });
  test("numbers clusters by first appearance and handles empty and single inputs", () => {
    assert.deepEqual(clusterAverageLinkage([], 0.5), []);
    assert.deepEqual(clusterAverageLinkage([{ vec: unitVec(1, 0), weight: 1 }], 0.5), [0]);
    assert.deepEqual(clusterAverageLinkage([unitVec(0, 1), unitVec(1, 0)].map((vec) => ({ vec, weight: 1 })), 0.5), [0, 1]);
  });
  test("a long region outweighs a short noisy one", () => {
    const stable = unitVec(1, 0), drift = unitVec(0.6, 0.8);
    const labels = clusterAverageLinkage([{ vec: stable, weight: 100 }, { vec: stable, weight: 100 }, { vec: drift, weight: 1 }], 0.3);
    assert.equal(labels[0], labels[1]);
  });
});

describe("vector helpers", () => {
  test("cosine, mean prototype and profile score", () => {
    assert.equal(dot(unitVec(1, 0), unitVec(0, 1)), 0);
    const proto = meanUnit([unitVec(1, 0), unitVec(0, 1)]);
    assert.ok(Math.abs(dot(proto, proto) - 1) < 1e-9);
    assert.ok(Math.abs(scoreAgainstProfile(unitVec(1, 0), [unitVec(0, 1), unitVec(1, 0)]) - 1) < 1e-9, "max over references");
  });
});

describe("doctor decision policy", () => {
  const policy = { tMatch: 0.89, tReject: 0.8, margin: 0.05, minRegions: 3, minSpeechSeconds: 6 };
  const c = (score, regions = 5, speechSeconds = 20) => ({ score, regions, speechSeconds });
  test("one clear match is matched, the other is a reliable non-match", () => {
    assert.deepEqual(decideDoctor([c(0.93), c(0.4)], policy).map((d) => d.status), ["matched", "unknown"]);
  });
  test("doctor absent: nobody is matched", () => {
    assert.deepEqual(decideDoctor([c(0.5), c(0.42)], policy).map((d) => d.status), ["unknown", "unknown"]);
  });
  test("two clusters that both reach the match line are BOTH left uncertain (near-identical voices)", () => {
    const result = decideDoctor([c(0.92), c(0.9)], policy);
    assert.deepEqual(result.map((d) => d.status), ["uncertain", "uncertain"]);
    assert.ok(result.every((d) => d.reason === "MULTIPLE_CLOSE_MATCHES"));
  });
  test("a match without enough evidence is never a match", () => {
    assert.equal(decideDoctor([c(0.95, 2, 20)], policy)[0].status, "uncertain");
    assert.equal(decideDoctor([c(0.95, 5, 3)], policy)[0].reason, "INSUFFICIENT_SPEECH");
    assert.equal(decideDoctor([c(null)], policy)[0].reason, "NO_USABLE_SPEECH");
  });
  test("between the two lines is uncertain, not a guess", () => {
    assert.deepEqual(decideDoctor([c(0.85), c(0.3)], policy).map((d) => d.status), ["uncertain", "unknown"]);
  });
  test("three speakers: only the doctor is matched, the others stay unknown (never merged or assumed to be patients)", () => {
    assert.deepEqual(decideDoctor([c(0.4), c(0.94), c(0.5)], policy).map((d) => d.status), ["unknown", "matched", "unknown"]);
  });
  test("a required margin over the best rival is enforced", () => {
    assert.equal(decideDoctor([c(0.9), c(0.88)], { ...policy, tMatch: 0.89 })[0].status, "uncertain");
  });
});

describe("encryption at rest", () => {
  const key = randomBytes(32);
  const secret = { references: [[0.1, 0.2, 0.3]] };
  test("round trips and hides the content", () => {
    const blob = encryptJson(secret, key, "owner-a|model-1");
    assert.ok(!blob.toString("latin1").includes("0.1"), "no plaintext in the blob");
    assert.deepEqual(decryptJson(blob, key, "owner-a|model-1"), secret);
  });
  test("refuses another owner, another model, another key, or tampered data", () => {
    const blob = encryptJson(secret, key, "owner-a|model-1");
    assert.equal(decryptJson(blob, key, "owner-b|model-1"), null, "profile copied to another account");
    assert.equal(decryptJson(blob, key, "owner-a|model-2"), null);
    assert.equal(decryptJson(blob, randomBytes(32), "owner-a|model-1"), null);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 1;
    assert.equal(decryptJson(tampered, key, "owner-a|model-1"), null);
  });
  test("keys must be exactly 32 bytes", () => {
    assert.ok(parseKey(randomBytes(32).toString("base64")));
    assert.equal(parseKey(randomBytes(16).toString("base64")), null);
    assert.equal(parseKey(""), null);
    assert.equal(parseKey(undefined), null);
  });
  test("each encryption uses a fresh nonce", () => {
    assert.notDeepEqual(encryptJson(secret, key, "a"), encryptJson(secret, key, "a"));
  });
});
