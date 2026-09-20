# SOAP note generation: evaluation

Measured 2026-09-20 against the **real Google Gemini API** on the corrected headache consultation from the product brief. Synthetic
consultation text only; no real patient data was ever sent.

## What was run

`server/tests/real-soap.test.js` — 13 assertions over 6 real generations (12 API calls). It checks the things that make a note safe,
not whether it reads well: the documented facts present, the forbidden fabrications absent, every claim traceable to a real transcript
segment, empty sections left empty, and the clinician's words attributed to the clinician.

```bash
cd server && node --env-file-if-exists=.env --test tests/real-soap.test.js        # uses SOAP_MODEL, default gemini-3.6-flash
```

**Result: 13 of 13 pass** (`gemini-3.1-flash-lite`, the run recorded below). Earlier full runs on `gemini-3.5-flash` and
`gemini-3.5-flash-lite` produced 10/13 and 11/13; every one of those failures was a **false positive in our own validator**, described
and fixed below — none was a model fabrication.

## Measured results

| | gemini-3.5-flash | gemini-3.5-flash-lite | gemini-3.1-flash-lite |
| --- | --- | --- | --- |
| Generation time (both stages) | 71.4 s | 8.7 s | 12.2 s |
| Tokens in / out | 3,524 / 3,639 | 3,498 / 3,155 | 3,455 / 3,201 |
| Facts extracted (stage 1) | 28 | 27 | 28 |
| Claims produced (stage 2) | 19 | 15 | 16 |
| Documented facts present (16 required) | all | all | all |
| Forbidden fabrications | none | none | none |
| Claims citing a real segment | 100% | 100% | 100% |
| Blocking validator flags | 0 (after fixes) | 0 | 0 |

Two API calls per note. The flash-lite models comfortably beat the 30 s target; `gemini-3.5-flash` did not (71 s) but produced the
most claims. Cost: free tier, no billing enabled.

### The safety assertions, all passing

- **Every documented fact appears**: duration, location, quality, severity, light sensitivity, nausea, prior ibuprofen, all four vital
  signs, cranial nerves, the migraine assessment, sumatriptan, the 50 mg dose and the 200 mg daily maximum.
- **None of the brief's forbidden additions appear**: no "alert and oriented x4", no "normocephalic", no gait or motor or sensory
  findings, no Kernig or Brudzinski, no HEENT, no ICD code, no follow-up interval, no medication route, no side-effect counselling,
  no headache diary, no differential diagnosis.
- **A stated normal examination is not expanded.** Every model wrote the clinician's "neurologically, everything looks normal"
  as stated, and none invented the itemised findings that sentence does not contain.
- **Empty sections stay empty.** Given the history only, Objective came back as an empty string with a `missing_documentation` flag.
  Given history plus examination but no stated assessment or plan, both of those sections came back empty. Nothing was filled in to
  look complete.
- **Attribution holds.** Assessment and Plan were written as the clinician's ("Clinician assessment: …", "Clinician prescribed …"),
  never as the model's own conclusion.
- **Unconfirmed speakers stay uncertain.** With no confirmed speaker roles, the uncertainty survived into the note's flags or claims.
- **The whole workflow works on real output**: generate → edit → acknowledge advisory flags → approve → export a 4,600 byte PDF and a
  2,022 character text file.

## Three false positives this evaluation found in our own validator

Real model output is the only thing that exposes an over-strict check. Each of these flagged a **correct** note and would have taught
doctors to ignore the warnings:

1. **"Clinician" read as a drug name.** The medication check used loose suffixes (`-an`, `-ol`), so "clinician" matched. Fixed to
   distinctive pharmaceutical stems only. (Found before the real runs, on the fixture.)
2. **Legitimate denials rejected.** The model wrote "denies vomiting" where the patient said "I didn't vomit" — a correct paraphrase.
   The old check flagged the *word* "denies" whenever it was absent from the transcript. Replaced with a three-case rule: a denial is
   allowed when the transcript denies that thing, **blocked as a flipped negation** when the transcript mentions it without denying it
   (the "denies phonophobia" trap from the brief, still caught), and **blocked as unsupported** when the subject is never mentioned at
   all.
3. **Shorthand numbers rejected.** The concise template wrote "Headache x3 days" where the transcript says "three days". The number
   check compared digits only. It now treats a spelled-out number as its digit form.

A fourth was an ambiguity in our own schema rather than a check: models put stage-1 working ids (`fact_N`) into `sourceFactIds`, which
is meant only for clinician-typed context. The prompt now says so explicitly and the validator ignores those ids instead of reporting
an invalid source.

## Model availability (measured, not assumed)

**`gemini-2.5-flash` — the model named in the brief — is retired for new API keys.** The API returns
`404 … no longer available to new users`, naming `gemini-3.6-flash` as its replacement. The default is now `gemini-3.6-flash`, which
was verified working with structured output (a full generation in 56 s). Override with `SOAP_MODEL`.

**Free-tier quota is per model per day, and small: 20 requests.** A full run of this suite is 12 calls, so two runs exhaust one model's
daily allowance; switching `SOAP_MODEL` to another free model is the practical way to keep testing. Hitting it surfaced a real bug —
the classifier treated a hard daily quota as a retryable rate limit and spent 7.5 minutes retrying. It now distinguishes them:
`PROVIDER_QUOTA_EXCEEDED` fails immediately, while a per-minute `PROVIDER_RATE_LIMITED` waits for the delay Google itself returns.

## What this does NOT show

- **One consultation.** Thirteen assertions over six generations of a single synthetic case. A passing run is evidence the grounding
  rules and checks work on this material, not a measured hallucination rate.
- **Model-dependent behaviour.** `gemini-3.1-flash-lite` produced a note that a stricter reading of our old checks rejected while
  `gemini-3.5-flash` did not. Smaller models paraphrase more; the checks now judge meaning rather than wording, but a different model
  may still behave differently. Re-run this suite when changing `SOAP_MODEL`.
- **Real consultations.** Synthetic text throughout: no accents, crosstalk, interruptions, dictation artefacts or real clinical
  complexity. Real transcripts will be messier.
- **Long consultations.** The window-splitting path for transcripts beyond one window is implemented and unit-tested, but has not been
  measured against the real API on a long transcript.
- **Quota behaviour over time.** Measured on a fresh free-tier key over one day.

## Reproducing

```bash
cd server
# GEMINI_API_KEY in .env (free tier: https://aistudio.google.com/apikey)
node --env-file-if-exists=.env --test tests/real-soap.test.js
SOAP_MODEL=gemini-3.5-flash node --env-file-if-exists=.env --test tests/real-soap.test.js   # if a model's daily quota is spent
npm test                                                                                    # everything, with the provider scripted
```
