// Evaluates the speaker pipeline on the SYNTHETIC "pairs" recordings (see tests/.generated/pairs, made by the lab scripts) using the
// real Deepgram responses saved next to them, the real ECAPA model, and real enrollment. Compares Deepgram alone with Deepgram plus
// independent voice analysis and doctor identification. Doctor profiles come from HELD-OUT voices only.
// Usage: node scripts/eval-voice.mjs [--limit N]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { openStore } from "../db/store.js";
import { createEmbedder } from "../services/voice/embedder.js";
import { createVoiceService } from "../services/voice/enrollment.js";
import { analyzeSpeakers } from "../services/voice/analysis.js";
import { normalizeDeepgramResponse } from "../services/deepgram.js";
import { der, wordAttribution } from "../tests/eval.js";

const dir = "tests/.generated/pairs";
const labData = "voice/lab/data";
const limit = Number(process.argv[process.argv.indexOf("--limit") + 1]) || Infinity;
const config = { ...loadConfig({}), voiceProfileKey: randomBytes(32).toString("base64"), tmpDir: mkdtempSync(path.join(os.tmpdir(), "evalvoice-")) };
const store = openStore(":memory:");
const embedder = createEmbedder(config);
const voice = createVoiceService({ config, store, embedder });
if (!(await embedder.available())) { console.error("voice model not installed (npm run setup:voice)"); process.exit(2); }

const doctors = [...new Set(readdirSync(dir).filter((f) => f.endsWith(".truth.json")).map((f) => f.split("__")[0]))];
const references = new Map();
const rejected = [];
for (const d of doctors) {
  store.upsertDoctor({ id: d });
  try {
    await voice.enroll(d, { files: [0, 1, 2].map((i) => ({ path: `${labData}/${d}/enroll_${i}.wav` })), consent: "true", consentVersion: voice.consent.version });
    references.set(d, await voice.loadReferences(d));
  } catch (error) {
    if (error.code !== "ENROLLMENT_REJECTED") throw error;
    rejected.push(`${d}: ${error.extra.problems.map((p) => `sample ${p.sample} ${p.code}`).join(", ")}`);
  }
}
console.log(`enrolled ${references.size}/${doctors.length} held-out doctors with the real service (the rest were rejected by the real quality checks and are excluded)`);
if (rejected.length) console.log("  rejected:", rejected.join(" | "));

const onlyMerged = process.argv.includes("--only-merged"); // just the recordings Deepgram merged (fast way to test the independent path)
const names = readdirSync(dir).filter((f) => f.endsWith(".truth.json")).map((f) => f.replace(".truth.json", "")).filter((n) => references.has(n.split("__")[0]))
  .filter((n) => !onlyMerged || normalizeDeepgramResponse(JSON.parse(readFileSync(`${dir}/${n}.dg.json`, "utf8"))).speakerIndices.length <= 1)
  .slice(0, limit);
const sibling = (a, b) => a.split("_")[0] === b.split("_")[0];
const rows = [];
for (const name of names) {
  const [d, p] = name.split("__");
  const truth = JSON.parse(readFileSync(`${dir}/${name}.truth.json`, "utf8")).turns;
  const raw = JSON.parse(readFileSync(`${dir}/${name}.dg.json`, "utf8"));
  const normalized = normalizeDeepgramResponse(raw);
  const turns = truth.map((t) => ({ speaker: t.speaker, startMs: t.startMs, endMs: t.endMs }));
  const wavPath = `${dir}/${name}.wav`;

  // control: a doctor who is NOT in the recording (never a sibling of either voice)
  const third = [...references.keys()].find((x) => x !== d && x !== p && !sibling(x, d) && !sibling(x, p));
  const t0 = Date.now();
  const withDoc = await analyzeSpeakers({ normalized, wavPath, references: references.get(d), config, embedder });
  const ms = Date.now() - t0;
  const absent = await analyzeSpeakers({ normalized, wavPath, references: references.get(third), config, embedder });

  const score = (n2) => {
    const words = n2.groups.flat();
    const attr = wordAttribution(turns, words.filter((w) => w.speaker !== null).map((w) => ({ speaker: w.speaker, startMs: w.start * 1000, endMs: w.end * 1000 })));
    const hyp = n2.segments.filter((s) => s.providerSpeaker !== null).map((s) => ({ speaker: s.providerSpeaker, startMs: s.startMs, endMs: s.endMs }));
    return { speakers: n2.speakerIndices.length, attr: attr.accuracy, der: der(turns, hyp).der };
  };
  // which final speaker is the doctor / the patient (majority overlap with the truth turns)?
  const who = (n2, id) => {
    const votes = new Map();
    for (const w of n2.groups.flat()) {
      const mid = ((w.start + w.end) / 2) * 1000;
      const t = truth.find((x) => mid >= x.startMs - 300 && mid <= x.endMs + 300);
      if (t && t.speaker === id && w.speaker !== null) votes.set(w.speaker, (votes.get(w.speaker) ?? 0) + 1);
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const dSp = who(withDoc.normalized, "D"), pSp = who(withDoc.normalized, "P");
  const st = (r, sp) => (sp === null ? "none" : r.identification.get(sp)?.status ?? "n/a");
  rows.push({ name, d, p, sib: sibling(d, p), dgSpeakers: normalized.speakerIndices.length, before: score(normalized), after: score(withDoc.normalized), source: withDoc.source,
    docStatus: st(withDoc, dSp), patStatus: st(withDoc, pSp), merged: dSp !== null && dSp === pSp, absentAnyMatched: [...absent.identification.values()].some((v) => v.status === "matched"), ms });
}
const pct = (n, t) => (t ? `${((n / t) * 100).toFixed(1)}%` : "n/a");
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const miss = rows.filter((r) => r.dgSpeakers === 1);
console.log(`\nrecordings: ${rows.length} (truth: always 2 speakers) | Deepgram merged voices in ${miss.length}`);
const line = (label, rs) => rs.length && console.log(`${label.padEnd(34)} n=${String(rs.length).padStart(3)} | speakers found: before ${avg(rs.map((r) => r.before.speakers)).toFixed(2)} -> after ${avg(rs.map((r) => r.after.speakers)).toFixed(2)} | count correct: before ${pct(rs.filter((r) => r.before.speakers === 2).length, rs.length)} -> after ${pct(rs.filter((r) => r.after.speakers === 2).length, rs.length)} | word->speaker ${(avg(rs.map((r) => r.before.attr)) * 100).toFixed(1)}% -> ${(avg(rs.map((r) => r.after.attr)) * 100).toFixed(1)}% | DER ${(avg(rs.map((r) => r.before.der)) * 100).toFixed(1)}% -> ${(avg(rs.map((r) => r.after.der)) * 100).toFixed(1)}%`);
line("ALL recordings", rows);
line("Deepgram MISSED (found 1 speaker)", miss);
line("Deepgram found 2", rows.filter((r) => r.dgSpeakers === 2));
line("  sibling-voice pairs (same voice)", rows.filter((r) => r.sib));
console.log(`speaker source used: independent ${rows.filter((r) => r.source === "independent").length} | deepgram ${rows.filter((r) => r.source === "deepgram").length}`);
const count = (rs, k, v) => rs.filter((r) => r[k] === v).length;
console.log("\nDOCTOR identification (doctor present, correct profile):");
for (const s of ["matched", "uncertain", "unknown", "none"]) console.log(`   doctor labelled ${s.padEnd(9)} ${pct(count(rows, "docStatus", s), rows.length)}`);
console.log("PATIENT (never the enrolled doctor):");
for (const s of ["matched", "uncertain", "unknown", "none"]) console.log(`   patient labelled ${s.padEnd(9)} ${pct(count(rows, "patStatus", s), rows.length)}   ${s === "matched" ? "<- FALSE DOCTOR MATCH" : ""}`);
console.log(`doctor and patient merged into one speaker (after): ${rows.filter((r) => r.merged).length}`);
console.log(`DOCTOR ABSENT control (a different doctor's profile): any speaker matched as doctor in ${rows.filter((r) => r.absentAnyMatched).length}/${rows.length} = ${pct(rows.filter((r) => r.absentAnyMatched).length, rows.length)}`);
console.log(`analysis time per recording (~21 s of audio): mean ${(avg(rows.map((r) => r.ms)) / 1000).toFixed(1)} s`);
const bad = rows.filter((r) => r.patStatus === "matched" || r.docStatus === "unknown" || r.merged).slice(0, 12);
console.log("\nexamples of failures:", bad.map((r) => `${r.name}[doctor:${r.docStatus},patient:${r.patStatus}${r.merged ? ",MERGED" : ""}${r.sib ? ",sibling" : ""}]`).join("  "));
