// Benchmark on the SYNTHETIC two-person recordings in tests/.generated/pairs (made by the lab scripts; real Deepgram responses saved next
// to each recording as *.dg.json; manual ground truth in *.truth.json). The SAME recordings and labels are used for every configuration:
//   A  Deepgram alone
//   B  Deepgram + the older independent detector (sherpa segmentation + ECAPA clustering)
//   C  Deepgram words + pyannote Community-1 speaker turns, under each policy:
//        C1 always (pyannote's labels replace Deepgram's), C2 more-speakers (used only when pyannote heard more speakers), C3 when-merged (only when Deepgram found <=1)
//   D  the chosen policy (--policy, default "more-speakers") + the existing doctor voice matching
// Usage: node scripts/eval-pyannote.mjs [--only-merged] [--limit N] [--refresh] [--policy always|more-speakers|when-merged] [--skip-independent]
// pyannote runs once per recording and is cached (git-ignored) in tests/.generated/pairs-pyannote/.
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { openStore } from "../db/store.js";
import { normalizeDeepgramResponse } from "../services/deepgram.js";
import { createPyannote } from "../services/pyannote.js";
import { analyzeSpeakers } from "../services/voice/analysis.js";
import { createEmbedder } from "../services/voice/embedder.js";
import { createVoiceService } from "../services/voice/enrollment.js";
import { der, wordAttribution } from "../tests/eval.js";

const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const flag = (name) => process.argv.includes(`--${name}`);
const dir = "tests/.generated/pairs";
const cacheDir = "tests/.generated/pairs-pyannote";
const labData = "voice/lab/data";
const limit = Number(arg("limit", Infinity));
const policy = arg("policy", "more-speakers");
const work = mkdtempSync(path.join(os.tmpdir(), "evalpyannote-"));
const config = { ...loadConfig({}), pyannoteEnabled: true, pyannotePolicy: policy, voiceProfileKey: randomBytes(32).toString("base64"), tmpDir: work };
const pyannoteService = createPyannote(config);
if (!(await pyannoteService.available())) { console.error("pyannote is not ready (npm run setup:pyannote)"); process.exit(2); }
mkdirSync(cacheDir, { recursive: true });

const store = openStore(":memory:");
const embedder = createEmbedder(config);
const voice = createVoiceService({ config, store, embedder });
const haveVoice = await embedder.available();

// Doctor profiles (real enrollment, from held-out voices only)
const doctors = [...new Set(readdirSync(dir).filter((f) => f.endsWith(".truth.json")).map((f) => f.split("__")[0]))];
const references = new Map();
if (haveVoice) {
  for (const d of doctors) {
    store.upsertDoctor({ id: d });
    try {
      await voice.enroll(d, { files: [0, 1, 2].map((i) => ({ path: `${labData}/${d}/enroll_${i}.wav` })), consent: "true", consentVersion: voice.consent.version });
      references.set(d, await voice.loadReferences(d));
    } catch (error) {
      if (error.code !== "ENROLLMENT_REJECTED") throw error;
    }
  }
}
console.log(`doctor profiles: ${references.size}/${doctors.length} enrolled with the real service${haveVoice ? "" : " (voice model not installed: doctor matching skipped)"}`);

const merged = (name) => normalizeDeepgramResponse(JSON.parse(readFileSync(`${dir}/${name}.dg.json`, "utf8"))).speakerIndices.length <= 1;
const names = readdirSync(dir).filter((f) => f.endsWith(".truth.json")).map((f) => f.replace(".truth.json", ""))
  .filter((n) => !haveVoice || references.has(n.split("__")[0])).filter((n) => !flag("only-merged") || merged(n)).slice(0, limit);
const sibling = (a, b) => a.split("_")[0] === b.split("_")[0];

/** pyannote result for one recording, from cache or by running the real worker. */
async function pyannoteFor(name) {
  const cached = `${cacheDir}/${name}.json`;
  if (!flag("refresh") && existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  const wav = path.join(work, `${name}.wav`);
  copyFileSync(`${dir}/${name}.wav`, wav);
  const result = await pyannoteService.diarize(wav, { durationSeconds: 25 });
  writeFileSync(cached, JSON.stringify(result));
  return result;
}
const cachedPyannote = (result) => ({ available: async () => true, diarize: async () => result });

const rows = [];
for (const name of names) {
  const [d, p] = name.split("__");
  const truth = JSON.parse(readFileSync(`${dir}/${name}.truth.json`, "utf8")).turns;
  const turns = truth.map((t) => ({ speaker: t.speaker, startMs: t.startMs, endMs: t.endMs }));
  const normalized = normalizeDeepgramResponse(JSON.parse(readFileSync(`${dir}/${name}.dg.json`, "utf8")));
  const wavPath = path.join(work, `${name}.wav`);
  copyFileSync(`${dir}/${name}.wav`, wavPath);
  const diar = await pyannoteFor(name);
  const py = cachedPyannote(diar);

  const measure = (n2) => {
    const words = n2.groups.flat();
    const attr = wordAttribution(turns, words.filter((w) => w.speaker !== null).map((w) => ({ speaker: w.speaker, startMs: w.start * 1000, endMs: w.end * 1000 })));
    const hyp = n2.segments.filter((s) => s.providerSpeaker !== null).map((s) => ({ speaker: s.providerSpeaker, startMs: s.startMs, endMs: s.endMs }));
    // which found speaker owns each TRUE speaker (majority of that speaker's words)?
    const owner = {};
    for (const id of ["D", "P"]) {
      const votes = new Map();
      for (const w of words) {
        const mid = ((w.start + w.end) / 2) * 1000;
        const t = truth.find((x) => mid >= x.startMs - 300 && mid <= x.endMs + 300);
        if (t?.speaker === id && w.speaker !== null) votes.set(w.speaker, (votes.get(w.speaker) ?? 0) + 1);
      }
      owner[id] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    // does each true speaker keep ONE identity across all their turns (returning speaker)? share of their words on their owner
    const keep = (id) => {
      let mine = 0, own = 0;
      for (const w of words) {
        const mid = ((w.start + w.end) / 2) * 1000;
        const t = truth.find((x) => mid >= x.startMs - 300 && mid <= x.endMs + 300);
        if (t?.speaker === id) { mine++; if (w.speaker === owner[id]) own++; }
      }
      return mine ? own / mine : 1;
    };
    return { speakers: n2.speakerIndices.length, attr: attr.accuracy, der: der(turns, hyp).der, owner, keepD: keep("D"), keepP: keep("P"), unassigned: words.filter((w) => w.speaker === null).length / words.length };
  };
  const t0 = Date.now();
  const A = { r: { normalized }, m: measure(normalized) };
  const B = haveVoice && !flag("skip-independent") ? await analyzeSpeakers({ normalized, wavPath, references: null, config, embedder }) : { normalized, source: "deepgram" };
  const variant = (pol) => analyzeSpeakers({ normalized, wavPath, references: null, config: { ...config, pyannotePolicy: pol }, embedder: undefined, pyannote: py });
  const [C1, C2, C3] = [await variant("always"), await variant("more-speakers"), await variant("when-merged")];
  const C = { always: C1, "more-speakers": C2, "when-merged": C3 }[policy];
  const D = haveVoice ? await analyzeSpeakers({ normalized, wavPath, references: references.get(d), config, embedder, pyannote: py }) : null;
  let absent = null;
  if (D) {
    const third = [...references.keys()].find((x) => x !== d && x !== p && !sibling(x, d) && !sibling(x, p));
    absent = await analyzeSpeakers({ normalized, wavPath, references: references.get(third), config, embedder, pyannote: py });
  }
  const st = (r, sp) => (sp === null || !r ? "none" : r.identification.get(sp)?.status ?? "n/a");
  const mB = measure(B.normalized), mC = measure(C.normalized), mD = D ? measure(D.normalized) : null;
  const mC1 = measure(C1.normalized), mC2 = measure(C2.normalized), mC3 = measure(C3.normalized);
  rows.push({
    name, sib: sibling(d, p), dg: normalized.speakerIndices.length, A: A.m, B: mB, C: mC, C1: mC1, C2: mC2, C3: mC3, srcB: B.source, srcC: C.source, warnC: C.warnings.map((w) => w.code),
    pyMs: diar.processingTimeMs, pySpeakers: diar.speakers.length, wall: Date.now() - t0,
    docStatus: D ? st(D, mD.owner.D) : null, patStatus: D ? st(D, mD.owner.P) : null,
    mergedD: D ? mD.owner.D !== null && mD.owner.D === mD.owner.P : null,
    absentAnyMatched: absent ? [...absent.identification.values()].some((v) => v.status === "matched") : null,
    wordsKept: C.normalized.groups.flat().length === normalized.groups.flat().length,
  });
}

// ---- report -----------------------------------------------------------------------------------------------------------------------
const pct = (n, t) => (t ? `${((n / t) * 100).toFixed(1)}%` : "n/a");
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
console.log(`\nrecordings: ${rows.length} (truth: always 2 speakers: D and P) | Deepgram found <=1 speaker in ${rows.filter((r) => r.dg <= 1).length} | doctor-matching policy (D)=${policy}`);
const cfgs = { "A Deepgram alone": (r) => r.A, ...(flag("skip-independent") ? {} : { "B + independent detector": (r) => r.B }), "C1 pyannote: always": (r) => r.C1, "C2 pyannote: more-speakers": (r) => r.C2, "C3 pyannote: when-merged": (r) => r.C3 };
function table(label, rs) {
  if (!rs.length) return;
  console.log(`\n${label}  (n=${rs.length})`);
  for (const [name, get] of Object.entries(cfgs)) {
    const ms = rs.map(get);
    const correct = ms.filter((m) => m.speakers === 2).length;
    const merges = ms.filter((m) => m.speakers < 2).length;
    const falseSplits = ms.filter((m) => m.speakers > 2).length;
    console.log(`  ${name.padEnd(28)} count correct ${pct(correct, rs.length).padStart(6)} | merges left ${String(merges).padStart(3)} | false splits (>2) ${String(falseSplits).padStart(3)} | speakers avg ${avg(ms.map((m) => m.speakers)).toFixed(2)} | word->speaker ${fmt(avg(ms.map((m) => m.attr)))} | DER ${fmt(avg(ms.map((m) => m.der)))} | D keeps id ${fmt(avg(ms.map((m) => m.keepD)))} P ${fmt(avg(ms.map((m) => m.keepP)))} | unassigned words ${fmt(avg(ms.map((m) => m.unassigned)))}`);
  }
}
table("ALL recordings", rows);
table("Deepgram MERGED the voices (found <=1 speaker)", rows.filter((r) => r.dg <= 1));
table("Deepgram found 2", rows.filter((r) => r.dg === 2));
table("Deepgram found >2", rows.filter((r) => r.dg > 2));
table("Same-voice sibling pairs (acoustically identical: no model can separate them)", rows.filter((r) => r.sib));
table("Non-sibling pairs", rows.filter((r) => !r.sib));
const rec = rows.filter((r) => r.dg <= 1);
console.log(`\nMERGE RECOVERY: Deepgram merged ${rec.length}; recovered (found 2) by B: ${rec.filter((r) => r.B.speakers === 2).length}, by C1 always: ${rec.filter((r) => r.C1.speakers === 2).length}, C2 more-speakers: ${rec.filter((r) => r.C2.speakers === 2).length}, C3 when-merged: ${rec.filter((r) => r.C3.speakers === 2).length}`);
const worse = (k) => rows.filter((r) => r.dg === 2 && r[k].speakers !== 2).length;
console.log(`RECORDINGS WHERE DEEPGRAM WAS RIGHT (found 2) AND THE POLICY BROKE IT (no longer 2): C1 always ${worse("C1")}, C2 more-speakers ${worse("C2")}, C3 when-merged ${worse("C3")}  of ${rows.filter((r) => r.dg === 2).length}`);
console.log(`words preserved (count) in C: ${rows.filter((r) => r.wordsKept).length}/${rows.length}`);
console.log(`pyannote speakers found vs 2: ${[1, 2, 3, 4].map((k) => `${k}:${rows.filter((r) => Math.min(r.pySpeakers, 4) === k).length}`).join("  ")} (4 = four or more)`);
console.log(`pyannote processing time per recording (~21 s audio): mean ${(avg(rows.map((r) => r.pyMs)) / 1000).toFixed(1)} s`);
if (rows[0]?.docStatus !== null) {
  const count = (k, v) => rows.filter((r) => r[k] === v).length;
  console.log("\nD: DOCTOR IDENTIFICATION on pyannote's speakers (doctor present, correct profile):");
  for (const s of ["matched", "uncertain", "unknown", "none"]) console.log(`   doctor labelled ${s.padEnd(9)} ${pct(count("docStatus", s), rows.length)}`);
  console.log("   the other voice (never the doctor):");
  for (const s of ["matched", "uncertain", "unknown", "none"]) console.log(`   other labelled ${s.padEnd(9)} ${pct(count("patStatus", s), rows.length)}   ${s === "matched" ? "<- FALSE DOCTOR MATCH" : ""}`);
  console.log(`   doctor and other merged into one speaker: ${rows.filter((r) => r.mergedD).length}`);
  console.log(`   DOCTOR ABSENT control (a different doctor's profile): matched in ${rows.filter((r) => r.absentAnyMatched).length}/${rows.length}`);
}
const bad = rows.filter((r) => r.C.speakers !== 2).slice(0, 14);
console.log(`\nrecordings where the chosen policy (${policy}) did not find exactly 2:`, bad.map((r) => `${r.name}[dg${r.dg},B${r.B.speakers},C${r.C.speakers}${r.sib ? ",sibling" : ""}]`).join("  "));
