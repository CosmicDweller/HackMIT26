# Voice enrollment and identification: evaluation

**Everything here was measured on SYNTHETIC (text-to-speech) voices. No real person's voice was used.** Text-to-speech is far more
consistent than people, so these numbers are optimistic and say nothing certain about real doctors. The thresholds must be
re-measured with real, consenting speakers before real use. Nothing below is a claim about real-world accuracy.

## What was built, and the failure it addresses

Deepgram Nova-3 Medical remains the transcription engine. On 180 synthetic two-person recordings it returned ONE speaker for 12% of them
(a merge; the words were right, only the speaker separation was missing). The pipeline now has three separate jobs:
transcription (Deepgram), diarization (Deepgram's labels, plus an independent check when Deepgram finds at most one speaker),
and doctor verification (local SpeechBrain ECAPA-TDNN against an enrolled profile). See `docs/API_CONTRACT.md` (Contract v4).

## Model choice

`speechbrain/spkrec-ecapa-voxceleb` (ECAPA-TDNN, Apache-2.0, ungated, 192-d embeddings, runs locally on CPU). On the held-out identities it had an
equal error rate of 5.5%, against 31% for the WeSpeaker model already used for diarization, so WeSpeaker was not reused for verification.
Enrolling from three clean samples alone matched only 34.5% of held-out doctor sessions; enrolling from clean plus simulated
degraded copies of the same samples (a narrow-band lossy microphone, and added noise) raised that to 86.4%, so enrollment stores nine references per doctor.

## Calibration (nothing arbitrary)

27 synthetic identities, split into 11 for calibration and 16 held-out; the two groups share no identity. Every threshold in
`server/voice/calibration.json` records the rule that produced it. Same-name UK/US voices are the same underlying voice and are treated as inseparable, so they are excluded from
"different person" training pairs and reported separately.

| Setting | Value | How it was chosen |
| --- | --- | --- |
| `tMatch` | 0.89 | lowest match line (0.50 to 0.94 searched) with zero false doctor matches in 4,000 calibration sessions, then maximum doctor recall |
| `tReject` | 0.839 | 1st percentile of genuine doctor scores in the calibration sessions (below it a genuine doctor is rare) |
| evidence for a definitive status | 3 regions and 6 s | with 1 region, 55% of genuine doctor clusters scored below the reject line; with 3, 3.9% |
| clustering distance | 0.55 | upper part of a plateau (0.375 to 0.575); see the trade-off below |
| enrollment: minimum speech | 6 s | 75% of the shortest genuine sample |
| enrollment: several-voices check | 0.553 | single-voice window minimum p1 minus 0.10 |
| enrollment: samples must agree | 0.555 | highest different-person set similarity in calibration (0.455) plus 0.10 |

A cosine similarity is not a probability, so scores are never sent to the client.

## Held-out results (frozen thresholds, simulated sessions on held-out identities)

| Measure | Result |
| --- | --- |
| Doctor clusters correctly `matched` | 86.4% (2,654 doctor clusters) |
| Doctor `uncertain` (too little evidence or no clear margin) | 12.9% |
| Doctor `unknown` (false rejection) | 0.7% |
| Non-doctor clusters falsely `matched` (FAR) | 0.30% (20 of 6,669), **all 20 from near-identical sibling voices** |
| Non-doctor clusters falsely `matched`, excluding sibling voices | 0 |
| Speaker count correct: 1 / 2 / 3 speakers | 99.8% / 96.2% / 91.6% (calibration file, plateau setting) |

## End-to-end on 162 synthetic two-person recordings (real Deepgram responses saved earlier, real ECAPA, real segmentation, real enrollment)

Doctor profiles came only from held-out voices; 9 of 10 enrolled (one hoarse voice was rejected by the real quality checks, see limits).
Run with `npm run eval:voice`. Before = Deepgram alone; after = with independent analysis and identification.

| | Before | After |
| --- | --- | --- |
| Speaker count correct, all 162 | 93.2% | 95.1% |
| Word-to-speaker accuracy, all | 96.5% | 97.2% |
| DER, all | 7.2% | 6.6% |
| Deepgram merged voices (11 recordings): count correct | 0% | 27.3% (3 of 11) |
| Those 11: word-to-speaker accuracy | 59.7% | 69.5% |
| Those 11: DER | 46.5% | 36.4% |
| Recordings where Deepgram found 2 speakers (151) | 100% count, 99.2% words, DER 4.4% | unchanged |

**Doctor identification (doctor present, correct profile, 162 recordings of about 21 s):** doctor `matched` 58.0%, `uncertain` 38.9%, `unknown` 3.1%.
The high `uncertain` share is deliberate: a 21 s recording gives too little evidence for a definitive status, and `uncertain` is the safe answer.
Patient (never the enrolled doctor): `unknown` 2.5%, `uncertain` 95.1%, `matched` 2.5%.
**The 4 patient `matched` cases are not voice look-alikes.** In each, Deepgram had merged the two voices and independent analysis did not separate them, so the patient's words sit inside
the doctor's speaker and the merged speaker matched. That is the unresolved diarization failure below, not a false voice match.

**Doctor-absent control** (a different doctor's profile applied to the same 162 recordings): a speaker was matched as the doctor in **0 of 162**.

Analysis time: mean 3.1 s per 21 s recording (segmentation dominates).

### The clustering threshold trade-off (measured on the 11 merged recordings)

| Threshold | Count correct after | DER after | Cost |
| --- | --- | --- | --- |
| 0.475 (plateau centre) | 54.5% | 25.6% | over-split one real, variable, hoarse recording into 4 speakers |
| 0.50 | 27.3% | 37.1% | |
| **0.55 (used)** | 27.3% | 36.4% | no over-split found on 36 fixtures and pair recordings |

The independent check runs only when Deepgram found at most one speaker. Over-splitting invents speakers a doctor must undo; under-splitting only leaves Deepgram's answer as it was.
Because the costs are asymmetric, 0.55 was chosen even though it recovers fewer merged recordings. A different balance is a product decision and a one-line change in `calibration.json`,
but should be revisited with real recordings.

## Scenario recordings (real pipeline; Deepgram deliberately given a merged one-speaker transcript; `node scripts/probe-voice-scenarios.mjs`, asserted in `tests/real-voice.test.js`)

| Scenario | Truth | Found | Doctor | Other |
| --- | --- | --- | --- | --- |
| Doctor and patient alternating (D-P x4) | 2 | 2 (independent) | matched | unknown |
| Doctor absent, two other voices | 2 | 2 | (none) | unknown, unknown |
| Doctor, patient and nurse | 3 | 3 | matched | unknown, uncertain |
| Doctor alone | 1 | 1 | matched | |
| Patient alone | 1 | 1 | | unknown |
| Deepgram-miss (two voices merged), enrolled Kathy | 2 | 2 (independent, DER under 15%) | matched | unknown |
| Doctor returns after a 2.5 minute gap | 2 | 2 | matched, same id after the gap | unknown |
| Different microphone (band-limited, lossy, noisy) | 2 | 2 | matched | unknown |
| Short doctor reply inside a long patient monologue | 2 | 2 | **uncertain** (one short region) | unknown |
| Near-identical voices (same underlying voice) | 2 | **1** | both `matched` | *known limitation* |

Real enrollment was also tested against silence, a 3 s sample, a clipped sample, a sample with two voices, and three samples from three different people: each is rejected with a specific code, and nothing is saved.
Other conditions are covered by scripted-embedding unit tests (overlap, unknown Deepgram speaker, doctor speaker number 1, doctor absent, one-speaker Deepgram results,
Deepgram finding more speakers than the analysis, a segmentation failure, and a recording over the length limit).

## Long recordings

Measured with `node scripts/probe-voice-long.mjs --minutes 120` (150 repetitions of a two-person conversation, 230 MB WAV, 7,200 s; analysis only, no Deepgram call):

| Case | Time | Peak memory of the voice model | Result |
| --- | --- | --- | --- |
| Deepgram separated the speakers | 5 s | 621 MB (Node process stayed near 110 MB) | doctor matched, patient unknown, all 13,200 words kept, no timestamp going backwards, last word at 7,197 s |
| Deepgram merged them | 3 s | 550 MB | independent check **skipped with a warning**, see below |

**Found by this measurement and fixed:** the independent check runs the segmentation model over the whole recording; a first two-hour run silently hit the default 60 s timeout and
did nothing. Measured cost: about 2 minutes for 20 minutes of audio, and over 10 minutes for two hours (worse than linear). Now, recordings over `VOICE_INDEPENDENT_MAX_SECONDS`
(default 1,800) skip the independent check and add the warning `INDEPENDENT_SPEAKER_CHECK_SKIPPED`; shorter ones get a timeout in proportion to their length;
a failure adds `VOICE_ANALYSIS_FAILED`. Doctor identification embeds at most 120 evenly spread regions per speaker, so it stays fast at any length.
For a two-hour recording where Deepgram merged voices, therefore, the merge is neither detected nor repaired; the warning tells the doctor to assign speakers by hand.
(In the merged two-hour probe the merged speaker was `unknown`: it was a mix of both voices, so its status describes the mix, not either person.)

## Known limitations (all measured)

- **Merged voices that are not recovered** (8 of 11 Deepgram merges at the used threshold). The merged speaker's words all carry one speaker id; if the doctor is one of the voices the merged speaker can be `matched`, `uncertain` or `unknown` depending on the mix, so the status describes the merged speech, not either person.
- **Near-identical voices** stay one speaker (no model separates them); both are labelled with the same status.
- **A short interjection** is separated only when it has a pause around it and 2.5 s of speech, and is then `uncertain`.
- **Short recordings** (about 20 s) mostly give `uncertain` rather than `matched`.
- **Hoarse or variable voices** may be rejected at enrollment (one held-out synthetic voice was) or score low.
- **Real speakers, real microphones and clinical noise were not measured.** Neither were accents, illness, multiple rooms or crosstalk.
- **Three-speaker counting** is the weakest case (91.6% at the calibration plateau; lower at the more conservative threshold actually used, about 74% in an earlier measurement).
- **Recordings over 30 minutes** skip the independent check (above).
- **Existing transcripts cannot be reprocessed**: the recording is deleted when a job completes, so a "reprocess speakers" endpoint is not implemented. A design that would allow it (opt-in, encrypted, time-limited audio retention) is a privacy decision for the product owner.
- **Live Deepgram + voice model** tests exist (`tests/real-voice.test.js`, opt-in with `DEEPGRAM_LIVE_TEST=1`) but were **not run**: they upload synthetic audio to a paid service and are held for approval.

## Reproducing

```bash
cd server
npm run setup:voice                       # once
npm test                                  # real-voice tests run when the model is installed
node scripts/probe-voice-scenarios.mjs    # scenario table above
node scripts/probe-voice-long.mjs --minutes 120 [--deepgram-correct]
npm run eval:voice                        # 162-recording before/after (needs the git-ignored lab data)
```

The lab scripts that generated the calibration (`server/voice/lab/`) and the synthetic conversations (`server/scripts/synth-conversation.py`, `make-voice-fixtures.py`) are committed; generated audio and embeddings are git-ignored, except the small fixtures in `server/tests/fixtures/voice/`.
