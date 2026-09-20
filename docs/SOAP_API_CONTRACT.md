# SOAP note API contract

Backend (branch `lz`). **Implemented.** The endpoint and field names are the ones the frontend proposed on issue #3, adopted as-is; the
additions the frontend asked for (`Transcription.revision` and a `CONFLICT` code) are implemented.

Status of verification is stated per section. Anything not verified says so.

## What this is

A SOAP note is drafted by Google Gemini from the **final stored transcript** (after diarization, doctor corrections and confirmed speaker
roles), checked against that transcript by deterministic code, reviewed and edited by the doctor, explicitly approved, and only then
exportable. The model drafts; it never decides anything clinical, and it is never the last word.

```
stored transcript -> extract facts (+source lines) -> compose 4 sections (+claims) -> deterministic validation -> draft
   -> doctor edits (re-validated) -> explicit approval -> locked -> PDF / TXT export
```

**Privacy.** Only transcript text and clinician-typed context are sent to Gemini: never audio, voice embeddings, tokens or a doctor's
identity. Prompt and response content is never logged (only codes, token counts and timings). The API key lives in the server
environment, never in the browser or a `VITE_` variable. Synthetic data only; this is not a HIPAA-compliant configuration.

## Endpoints

All require `Authorization: Bearer <supabase token>`. Ownership always comes from the verified token, never the request body. Another
doctor's consultation is `404` on every route (never `403`, which would confirm it exists).

| | |
| --- | --- |
| `GET /api/soap/templates` | `{ templates: [{ id, name, description }], defaultTemplateId }` |
| `GET /api/me/soap-preference` | `{ templateId }` (the server default when never set) |
| `PATCH /api/me/soap-preference` | `{ templateId }` → `{ templateId }`; `400` for an unknown template |
| `GET /api/transcriptions/:id/soap` | the note, or `404` when none exists yet |
| `POST /api/transcriptions/:id/soap` | idempotent create/recovery. `202` + a `processing` note when it starts generation, `200` + the existing note otherwise. Optional body `{ templateId }` is used only when creating. **Never regenerates.** |
| `PATCH /api/transcriptions/:id/soap` | `{ sections: {…}, revision }` → the note. `409 CONFLICT` on a stale revision |
| `POST /api/transcriptions/:id/soap/approve` | `{ revision, confirmReviewed: true }` → the approved note |
| `POST /api/transcriptions/:id/soap/reconcile` | `{ revision }` → clears a stale-source state after the doctor re-checks an edited transcript |
| `POST /api/transcriptions/:id/soap/retry` | retries a `failed` note only; a good or edited draft is returned untouched |
| `POST /api/transcriptions/:id/soap/flags/:flagId/acknowledge` | acknowledges a non-blocking flag; `409 FLAG_BLOCKING` for a blocking one |
| `GET /api/transcriptions/:id/soap/export?format=pdf\|txt` | the file. **Approved notes only** (`409 NOT_APPROVED`) |

Generation also starts **by itself** once a transcript is stored (`SOAP_AUTO_GENERATE`, default on), so the client normally finds a
note already `processing` or `draft_ready`. `POST` exists for recovery when it did not.

## The note resource

```json
{
  "id": "soap_tr_3d1f0c5e-…",
  "transcriptionId": "tr_3d1f0c5e-…",
  "templateId": "primary-care-standard",
  "status": "draft_ready",
  "generationStage": null,
  "errorCode": null,
  "revision": 1,
  "sourceTranscriptRevision": 1,
  "transcriptRevision": 1,
  "sourceStale": false,
  "edited": false,
  "sections": { "subjective": "…", "objective": "…", "assessment": "…", "plan": "…" },
  "claims": [
    { "id": "claim_1", "section": "subjective", "text": "Chief complaint: severe headache for three days.",
      "sourceSegmentIds": ["segment_2"], "sourceFactIds": [], "needsReview": false }
  ],
  "reviewFlags": [
    { "id": "flag_1", "type": "missing_documentation", "severity": "info", "section": "assessment", "claimId": null,
      "message": "Nothing was documented for the assessment section in this consultation.",
      "blocking": false, "resolved": false, "acknowledgedAt": null, "source": "validator" }
  ],
  "provider": "gemini", "model": "gemini-3.6-flash",
  "createdAt": "…", "updatedAt": "…", "approvedAt": null, "approvedBy": null
}
```

| Field | Notes |
| --- | --- |
| `status` | `processing` → `draft_ready` → `approved`, or `failed`. Poll only while `processing`. |
| `generationStage` | `queued`, `extracting`, `drafting`, `validating`, or `null`. A label, not a percentage: no fake progress. |
| `errorCode` | Set when `status` is `failed`: `PROVIDER_NOT_CONFIGURED`, `PROVIDER_AUTH_FAILED`, `PROVIDER_RATE_LIMITED`, `PROVIDER_QUOTA_EXCEEDED`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_MODEL_UNAVAILABLE`, `PROVIDER_BAD_OUTPUT`, `GENERATION_FAILED`, `INTERRUPTED`, `EMPTY_TRANSCRIPT`. |
| `revision` | The note's own revision. Send it with every PATCH and approve. |
| `sourceTranscriptRevision` / `transcriptRevision` | The transcript revision the note was written from, and the transcript's revision now. |
| `sourceStale` | `true` when those differ: the transcript was edited after drafting. The draft is preserved; approval is refused until `reconcile`. |
| `edited` | `true` once a doctor has saved a change. |
| `sections` | Exactly these four keys, always present. **An empty string means nothing was documented** — never filled in to look complete. |
| `claims[].text` | The statement **exactly as it appears** in `sections[section]`, so the client can find and highlight it. |
| `claims[].sourceSegmentIds` | Real `segment_N` ids of this transcription, for scroll-to-evidence. Empty means unsupported: check `reviewFlags`. |
| `claims[].needsReview` | Support is partial, the speaker was uncertain, or a doctor has edited that section. |
| `claims[].editedByDoctor` | Present and `true` when the doctor rewrote that section: the citation no longer vouches for the text. |
| `reviewFlags[].blocking` | `true` blocks approval and **cannot be acknowledged**: the statement must be corrected or removed. `false` is advisory and can be acknowledged. |
| `reviewFlags[].source` | `validator` (deterministic check) or `model` (the model's own doubt). |

Flag types: `missing_documentation`, `missing_source`, `invalid_source`, `unsupported_claim`, `conflicting_facts`, `unclear_medication`,
`unclear_dose`, `uncertain_speaker`, `uncertain_transcript`, `needs_verification`, `edited_claim`, `stale_source`, `other`.

## Error codes (added to the existing `{ error, code }` shape)

| Status | `code` | When |
| --- | --- | --- |
| 409 | `CONFLICT` | stale `revision` on PATCH or approve. Body carries `currentRevision`. |
| 409 | `NOTE_APPROVED` | editing an approved (locked) note |
| 409 | `UNRESOLVED_FLAGS` | approval with unresolved blocking flags. Body carries `flagIds`. |
| 409 | `SOURCE_CHANGED` | approval while `sourceStale`. Body carries `noteSourceRevision`, `transcriptRevision`. |
| 409 | `NOT_READY` / `EMPTY_NOTE` / `NOT_APPROVED` / `FLAG_BLOCKING` | approving a draft that is not ready / an empty note / exporting before approval / acknowledging a blocking flag |
| 400 | `INVALID_REQUEST` | missing revision, unknown section, section not text or too long (20 000 characters), unknown template or export format |
| 400 | `REVIEW_REQUIRED` | approve without `confirmReviewed: true` |
| 404 | `NOT_FOUND` | no note, or not this doctor's consultation |
| 503 | `SOAP_DISABLED` | `SOAP_ENABLED=false` on the server |

## Transcription resource: the additive field

`Transcription.revision: number` — starts at 1, increments on **every** edit to the transcript (segment text, segment speaker, speaker
role). Compare it with the note's `sourceTranscriptRevision`; the note also reports `sourceStale` directly.

## Rules the backend enforces (so the client does not have to)

1. **One note per consultation.** The slot is claimed in a transaction, so duplicate completion events, retries and concurrent POSTs cannot create competing drafts. *Verified with five concurrent requests.*
2. **Never regenerated.** No endpoint overwrites a draft; `retry` only touches a `failed` note. There is no user-facing regeneration.
3. **Approved notes are read-only** and are the only ones that export.
4. **Blocking flags cannot be acknowledged away.** A fabricated statement must be corrected or deleted.
5. **A doctor's edit is re-validated** against the transcript — in both directions: deleting a fabricated sentence clears its flag, and typing an unsupported number or drug name raises one.
6. **Editing a section invalidates its citations** rather than pretending they still prove the new text.
7. **A generation failure never damages the transcript.**

## Clinical grounding

The model may only document what the transcript contains. It must not invent symptoms or denials, examination findings (including
normal ones), vitals, labs, diagnoses, differentials, ICD codes, medications, doses, routes, follow-up intervals, counselling or return
precautions; must not turn a reported symptom into a denial, or a stated "neurological examination normal" into itemised findings; and
must attribute the clinician's assessment and plan to the clinician. Empty sections stay empty.

Deterministic checks then verify, against the transcript: citations resolve to real segments; each claim's text is present in its
section; every number and medication name in a claim occurs in its cited source; a set of known fabrication patterns is absent;
denials are not flipped; and every sentence is covered by a claim. **These are a floor, not hallucination detection** — what cannot be
checked mechanically becomes a review flag. Physician review remains mandatory.

## Verification status

**Verified with scripted providers (no network):** the whole workflow above — 34 API tests and 45 validator tests, including ownership
across accounts, concurrency, optimistic concurrency, approval gating, locking, staleness, export formats and restart persistence.

**Verified with the real Gemini API (2026-09-20): 13 of 13 pass.** `server/tests/real-soap.test.js` runs the corrected headache
consultation through the live model: all 16 documented facts appear, none of the forbidden fabrications do, 100% of claims cite a real
segment, empty sections stay empty, and the full generate → edit → approve → export path produces a real PDF. Note: **`gemini-2.5-flash`
is retired for new API keys**; the default is now `gemini-3.6-flash` (Google's named replacement, verified). Free-tier quota is 20
requests per model per day. See `docs/SOAP_EVALUATION.md`.

**Not verified:** real patient data (prohibited), notes longer than one consultation's transcript in a single window at real scale,
and long-run free-tier quota behaviour.

## Frontend notes

- The client's existing flow (GET, then POST only on 404, poll while `processing`, never regenerate) matches this contract exactly.
- `claims[].text` is an exact substring of its section, so `indexOf` is enough to anchor a highlight; `sourceSegmentIds` map to the segment ids already used by the transcript viewer.
- Show `blocking` flags as things to fix (no acknowledge button) and non-blocking ones as acknowledgeable.
- `sourceStale` should offer "the transcript changed — re-check and reconcile" rather than silently regenerating.
- Export buttons stay disabled until `status === "approved"`.
