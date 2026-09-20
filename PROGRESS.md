# Progress

## Current milestone — review checks no longer gate the doctor
**Product decision (user's call): the validator informs, it never refuses.**
Saving and approving now always succeed; every check still runs and every
finding is still shown and stored, but none of them withholds a signature.

Removed from `approve()`: `UNRESOLVED_FLAGS` (blocking flags),
`SOURCE_CHANGED` (transcript edited since drafting), `EMPTY_NOTE`,
`REVIEW_REQUIRED` (`confirmReviewed`), and the revision `CONFLICT`.
Removed from `update()`: the required `revision` and its `CONFLICT`.
`acknowledgeFlag` no longer refuses blocking flags (`FLAG_BLOCKING` is gone).

Optimistic concurrency was dropped deliberately: there is one doctor per
note, so a lagging client copy is not a competing writer, and refusing a save
over it just lost their typing. Last write wins.

Still enforced: ownership, the note existing, `draft_ready` before approval,
section types/lengths, and an approved note staying read-only.

UI: Approve is never disabled; serious findings are still shown in red and
can now be acknowledged; the confirm prompt names what is outstanding
("1 statement the transcript doesn't support and 2 open review notes") but
always lets the doctor through. Approving also clears staleness, since
signing accepts the note against the transcript as it stands.

**Verified in the browser** on a note that previously could not be signed:
edit -> "Saved." -> Approve -> approved, exports enabled. Server 509 pass /
0 fail; client tsc, lint, build clean. Eight backend tests asserted the old
gating and were rewritten to the new behaviour.

## Previous milestone
**The whole demo path works end to end against real services.** Verified in
the browser: transcript -> speaker identification -> real Gemini SOAP note ->
reconcile -> approve -> export. This had never completed before; approval was
unreachable.

Five fixes got it there (four in `server/`, approved by the user this session):

1. **`thinkingConfig: { thinkingBudget: 0 }`** (`gemini.js`, new
   `SOAP_THINKING_BUDGET`). Gemini 3.x reasons before answering and those
   tokens are billed *and* spent from `maxOutputTokens`. Measured on one real
   consultation: **24.1 s / 6597 tokens -> 4.4 s / 2767 tokens (5.4x faster)**.
2. **A truncated answer is no longer retried** (`gemini.js`). Thinking could
   exhaust the budget and cut the JSON mid-string; `finishReason` was only
   inspected when the text was *empty*, so partial JSON was classed
   `retryable` and retried 5x with 3+6+12+24 s of waiting. That — not the
   model — was the "stuck on extracting clinical statements".
3. **`reconcile` drops flags the transcript has since answered**
   (`service.js`). This was the demo blocker: a model `uncertain_speaker`
   flag is *blocking*, and nothing cleared it — not acknowledging (blocking
   flags can't be), not reconciling, not `retry` (a no-op on a drafted note).
   Any note that picked one up could never be approved by any route.
4. **`missing_documentation` can never block** (`validate.js`). Severity came
   from the model's own pick, so it could escalate "nothing was documented
   here" into something a doctor cannot clear. An empty Objective is the
   accurate note for a visit that examined nothing.
5. **The note refetches when the transcript changes** (`SoapEditor.tsx`).
   Assigning a speaker makes the note stale server-side, but the client never
   re-read it: no stale banner, no reconcile button, until a manual reload.

Also: the `blocking` count in the `soap draft:` log counted only the
validator's own flags, logging `0 blocking` for notes that could not be
approved.

Merged from the backend this session: notes are never left stuck in
`processing` (`recoverStuck` at startup + on read), and `useSoapNote` stops
polling after 5 consecutive failures instead of spinning for ever.

**Checks:** server 508 pass / 0 fail / 6 skipped; client `tsc` clean, 0 lint
errors, production build OK; no console errors.

**Not verified:** mobile layout — the automation harness would not resize the
window (`innerWidth` stayed 2560), so narrow-width rendering is unconfirmed.
`Copy Note` fails under automation only, with `NotAllowedError: Document is
not focused` — the clipboard API needs a focused window; PDF/TXT export is
verified (real file on disk, correct content).

## Previous milestone — SOAP notes wired to the real backend (PR #9)
Merged their SOAP
implementation and reconciled the client against `docs/SOAP_API_CONTRACT.md`
rather than the issue summary. `VITE_USE_MOCK_SOAP=false` — every mock flag
is now off.

Contract differences found and fixed (all additive, as they said):
- `errorCode: string | null` replaces the invented `error: {code,message}`.
- New note fields wired: `transcriptRevision`, `sourceStale`, `edited`,
  `provider`, `model`, `approvedBy`; `claims[].editedByDoctor`.
- `reviewFlags[]` was a completely different shape — now
  `{ id, type, severity, section, claimId, message, blocking, resolved,
  acknowledgedAt, source }`.
- **approve requires `confirmReviewed: true`** — without it the real backend
  returns `400 REVIEW_REQUIRED`, so approval would have failed outright.
- Three endpoints added: `reconcile`, `retry`, `flags/:id/acknowledge`.
- Staleness now reads the backend's own `sourceStale` instead of the client
  comparing revisions itself.

UI consequences: blocking flags render as must-fix (no acknowledge button,
and they disable Approve) while advisory flags are acknowledgeable;
`sourceStale` offers "I've re-checked this against the transcript" rather
than silently regenerating; a failed note shows a plain-language reason and
a retry.

**Verified against the live backend:** templates and preference round-trip,
GET 404 -> POST recovery, and the `failed` path end to end. **Real Gemini
generation is NOT yet verified from the client** — the free tier is 20
requests/model/day and the backend agent's 13 real-Gemini tests used today's
quota, so generation currently returns `PROVIDER_QUOTA_EXCEEDED`. The client
handles that correctly (plain-language message, retry offered, transcript
untouched), but a successful real note through the UI has to wait for the
quota to reset.

## Previous milestone — recording limit lowered from 2 hours to 30 minutes
Product decision,
client-side change (`useAudioRecorder.ts`'s `MAX_RECORDING_SECONDS`:
7200 -> 1800); the actual enforcement point is the backend's job endpoint
limit, which needs the matching change there — flagged on issue #3. The
client change alone just stops recording earlier and shows the shorter
budget in the UI; a doctor could still exceed the backend's own limit until
that side is updated too.

## Previous milestone — voice enrollment reconciled against the real backend (Contract v4)
`git merge origin/main` brought in `d9c7bda`/`38c81a0` (backend: real local
voice enrollment + speaker identification, merged as PR #8). Compared
against what this branch had mocked/proposed and fixed every mismatch:

- `VoiceProfile` shape corrected: real GET always returns `consent: {version,
  text}` and `requiredSamples`; enrolled-only fields (`enrolledAt`,
  `updatedAt`, `sampleCount`, `modelVersion`, `consentRecordedAt`) are
  optional. No `enrolling` status is ever observable client-side (enroll is
  one synchronous POST, not a background job) — removed the mock's fake
  polling assumption.
- `enroll()` now sends `consent: "true"` + `consentVersion` (echoed from the
  GET response) — the real backend rejects enrollment without these
  (`400 CONSENT_REQUIRED`). `remove()` now sends the required
  `X-Confirm: delete-voice-profile` header.
- `Speaker.identificationStatus` widened from 2 values to the real 4:
  `matched | unknown | uncertain | unavailable`. Added `Speaker.suggestedRole`
  (`"doctor"` only, never `"patient"`/`"other"`) and
  `Transcription.speakerSource`. `voiceIdentificationStatus` corrected to
  `not_enrolled | completed | unavailable` (dropped the invented `failed`).
- New `TranscribeApiError.problems` field to surface `422
  ENROLLMENT_REJECTED`'s per-sample `{sample, code, message}` array; the
  enrollment wizard now shows each rejected sample's own message and clears
  only those samples for re-recording, keeping the good ones.
- `SpeakerMappingPanel` rebuilt per the backend's frontend-integration
  checklist: a one-tap "This looks like you → Confirm" button for
  `suggestedRole === "doctor"` (PATCHes the role directly), a visible
  "please check" warning only for `uncertain`, and — per explicit
  instruction — **no message at all for `unknown`** (a confident non-match
  isn't ambiguous). Sample-duration guidance corrected to the real
  thresholds (10-30s suggested, 60s hard cap, was a guessed 10-20s).
- **Verified live against the real backend, not just read from the
  contract doc**: ran the real server, got a real Supabase token for the
  test account via curl, and confirmed `GET /api/me/voice-profile`'s exact
  JSON matches the `VoiceProfile` type; confirmed `DELETE` without the
  confirm header returns `400 CONFIRMATION_REQUIRED`, with it but no
  profile returns `404`; confirmed `POST .../enroll` without consent
  returns `400 CONSENT_REQUIRED` — all exactly as coded. Then loaded the
  actual enrollment wizard against the real backend in a real signed-in
  browser session and confirmed the consent checkbox renders the backend's
  exact live consent text and sample count, zero console errors. (Did not
  attempt a full successful enrollment — that needs the local ECAPA-TDNN
  Python/model setup, `uv` + ~500 MB, not installed in this session; the
  GET/DELETE/enroll-validation paths don't need it, so those were verified
  for real regardless.) Mock mode re-verified afterward with the corrected
  shapes: enroll round-trip, "This looks like you" confirm button,
  "uncertain" badge on the minor speaker, "Unknown Speaker 2" labeling.

## Previous milestone — SOAP note generation, review, and export
Built client-side against a mock, coordination proposal posted on issue #3.
No backend support exists for this yet, same situation voice enrollment was
in before this reconciliation: the client is ahead and waiting on the
backend agent (and on a hosted AI provider decision, entirely backend-side).

## SOAP notes — client built, mock-only, awaiting backend
Proposed contract posted to issue #3: the six endpoints from the brief
confirmed as-is, plus one addition (`GET/PATCH /api/me/soap-preference`
for the account's default template — not in the original endpoint list but
required by "persist this before the consultation starts"), plus two
additive fields (`Transcription.revision`, a `CONFLICT` error code). Runs
against `services/soap/mockSoapApi.ts` (`VITE_USE_MOCK_SOAP`, defaults to
mock) and is real-backend-safe — nothing above changes behavior against the
actual server today.

- **Extends the existing transcript detail page** (not a new page): SOAP
  note is now the main content; the existing speaker-mapping/segment editor
  moved into a collapsible "Original transcript" panel (still fully
  functional — mark-reviewed/export/delete for the raw transcript are
  untouched) that auto-expands and scrolls-and-highlights the cited segment
  when a SOAP statement is clicked.
- **Generation**: fetched once per page load (GET, then POST only as
  idempotent recovery if the GET 404s), polls only while
  `status: "processing"`, shows the real stage (`queued` /`extracting`/
  `drafting`/`validating`) — no fabricated percentage, no regeneration.
  Guarded against React 18 StrictMode's dev-only double-invoke of effects
  with a persistent ref, separate from a per-render "is mounted" ref (the
  first version of this had a real bug here — the double-invoke's cleanup
  discarded the one real fetch's result — caught by testing in-browser
  before this ever reached the backend agent).
- **Editor**: four sections, each a view of clickable claims (with a
  pencil-toggle into a plain textarea to edit the raw text — no rich-text
  editor). Editing a section flags every existing claim in it for
  re-verification rather than pretending a stale citation still applies.
  Empty sections render blank, never filled in with a guess.
- **Save/Approve/Export**: Save Draft sends the full `sections` + revision;
  a 409 shows a conflict banner with "discard my edits" or "keep editing
  and retry with the fresh revision" (never silently overwrites). Approve
  auto-saves first, shows a confirmation with the outstanding review-flag
  count, and is blocked while the source transcript's revision has moved
  past what the note was generated from (a stale-source warning, not a
  silent auto-regenerate). Export (PDF/TXT/clipboard) is disabled until
  approved and pulls from the same `soap.export()` call the real backend
  will serve — the mock's PDF is a small hand-written single/multi-page
  writer (`lib/simplePdf.ts`, no new dependency; the real backend generates
  the actual PDF, this only exists to demo the flow).
- **Grounding fixture**: rebuilt the shared mock transcript
  (`lib/transcriptionFixtures.ts`) around the corrected migraine
  consultation from the brief, so every SOAP claim's `sourceSegmentIds`
  cites a real, matching segment — clicking "BP 122/78" scrolls to the
  nurse's actual vitals line. Kept the 3-speaker minor-speaker-warning demo
  (brief nurse interjection). One claim (a blanket "neuro exam normal"
  statement with no itemized findings) is deliberately flagged
  `needsReview` to exercise that path honestly.
- **Verified for real** in-browser: full flow end to end — upload → job
  completes → SOAP auto-generates through its real stages → edit a section
  → citations flag for review → save → approve (confirmed via an overridden
  `window.confirm`, the same native-dialog limitation as the delete
  button elsewhere in this app) → PDF/TXT/clipboard export all confirmed
  correct via direct calls (PDF is a well-formed, openable file; TXT
  contains the edited text with the right headings). Existing "Mark as
  reviewed"/export/delete for the transcript itself confirmed still working
  unchanged alongside the new feature.
- **Not implemented**: nothing outside the brief's scope; template choice
  is a control on the New Transcription page rather than duplicated in
  Account settings (not explicitly required, kept minimal).

## Previous milestone — recording pause/resume + live waveform
Added to both the consultation recorder and voice-profile sample recorder.
Pure client-side UX improvement, no backend or contract changes involved.

## Recording pause/resume + live waveform
- `useAudioRecorder` gained a `"paused"` status plus `pause()`/`resume()`
  (native `MediaRecorder.pause()/.resume()` — paused audio is excluded from
  the final blob automatically). The elapsed-time clock now correctly
  freezes while paused (`accumulatedMsRef` + `segmentStartRef` track time
  across pause/resume boundaries) and the 2-hour auto-stop only fires while
  actually recording.
- New `components/LiveWaveform.tsx`: a canvas bar graph driven by a Web
  Audio `AnalyserNode` reading the same `MediaStream` `getUserMedia` already
  returned (`useAudioRecorder` now exposes `stream`) — no extra mic access,
  theme-aware (`currentColor`), responsive via `ResizeObserver`. Reacts to
  live mic input whether recording or paused (the mic stream stays open
  either way); shows a flat idle line when there's no stream.
- Wired into both `RecordPanel` (consultation recording — pause/stop as two
  separate buttons once active) and `VoiceSampleRecorder` (voice-profile
  enrollment samples), which were the two places `useAudioRecorder` is used.
- **Verified:** TypeScript/lint/build clean. The idle-state UI renders
  correctly with no console errors. The exact Web Audio call sequence
  `LiveWaveform` uses (`createMediaStreamSource` → `AnalyserNode` →
  `getByteFrequencyData`) was confirmed live in this browser against a
  synthetic 440 Hz tone (peak amplitude 255, 10 non-zero bins) — proves the
  pipeline reacts correctly to real audio. **Not verified end-to-end**:
  actually starting a live recording through the UI — the browser's native
  microphone-permission prompt has no clickable surface for automation
  (same limitation as the voice-enrollment work), so the pause/resume timer
  math and waveform were verified by code review + the isolated checks
  above, not a full live-mic run. Please try pause/resume yourself in a
  real browser session (mic permission grants normally on first click).

## Previous milestone — doctor voice enrollment + voice-assisted speaker ID
Built client-side against a mock, coordination proposal posted on issue #3.
No backend support exists yet for this — unlike the Deepgram migration,
this time the client is ahead and waiting on the backend agent.

## Voice enrollment — client built, mock-only, awaiting backend
Proposed contract posted to issue #3 (`GET/POST/DELETE /api/me/voice-profile*`,
additive `Speaker.identificationStatus` and `Transcription.voiceIdentificationStatus`
fields — see the comment for the full shape). Everything below runs against
`services/voiceProfile/mockVoiceProfileApi.ts` (`VITE_USE_MOCK_VOICE_PROFILE`,
defaults to mock since the real endpoints don't exist) and is real-backend-safe:
every new field is optional, so nothing breaks against the actual server today.

- **Enrollment wizard** (`/dashboard/voice-profile`): explanation, an
  explicit unchecked-by-default consent checkbox (nothing records before
  consent), recording instructions, 3 sample recordings reusing the existing
  `useAudioRecorder` hook (auto-stops at 20s, no duplicate mic-management
  code), per-sample playback/re-record/delete, then submit. Success screen
  offers "Go to Dashboard" / "Manage Voice Profile".
- **Account settings**: a Voice Profile card with not-enrolled / enrolled
  (enrollment date + model version, Replace/Delete) / needs-reenrollment
  states. Delete requires a confirm dialog and warns that it disables
  automatic doctor matching.
- **Dashboard onboarding banner**: "Set Up Your Voice Profile" /
  "Skip for Now", shown only while not enrolled, dismissal persisted in
  localStorage per user. Skipping never blocks recording or transcription.
- **New Transcription page**: a small availability notice ("Doctor voice
  matching is available" vs. "unavailable until a voice profile is
  created" with a link to set one up) — informational only, never blocks
  the existing record/upload flow.
- **Transcript display**: `SpeakerMappingPanel` shows a distinct "Suggested:
  Doctor — voice match detected (unconfirmed)" hint for a matched, still-
  unassigned speaker, and "Needs confirmation" otherwise — the suggestion is
  never auto-applied to `role`; the doctor still confirms via the existing
  role buttons. `speakerDisplayLabel` (`lib/exportTranscript.ts`) renders
  "Unknown Speaker N" for an unassigned speaker once identification has
  run and found no match, unchanged ("Speaker N") when the field is absent
  (today's real backend). The mock transcript fixture only sets these
  fields when the signed-in doctor has actually enrolled, so the demo never
  implies a match that didn't happen.
- **Not implemented**: `nurse`/`family member` roles suggested by the brief
  — not sending role values the backend hasn't agreed to (existing contract
  rule). Live microphone recording could not be verified through browser
  automation (native mic-permission prompts are outside what the Chrome
  extension can click through, unlike in-page `confirm()` dialogs) — the
  recording UI was verified visually, and the enroll/get/delete round trip
  and every downstream display state were verified for real by driving the
  same mock service functions the UI calls, in the page's own JS context.

## Previous milestone — Deepgram/job-system migration (Contract v3)
Built and verified against the real, merged backend. Backend delivered the
whole thing in one pass (job endpoints, 2h/1GiB recordings, `warnings`,
`needsReview`, `diarizationStatus`) — ahead of the coordination proposal
below, so the client caught up to match rather than the other way around.

## Deepgram migration — done
Client now uses `POST /api/transcription-jobs` (not the old synchronous
route) for new-transcription, with real polling
(`queued|preparing|uploading|transcribing|completed|failed`) and
stage-specific copy ("Uploading recording…", "Preparing audio…",
"Transcribing with Deepgram…", "Finalizing transcript…"). Built:
- `services/transcriptions/jobsApi.ts` (+ `mockJobsApi.ts` behind
  `VITE_USE_MOCK_TRANSCRIPTIONS`, simulating the same staged timing) and
  `hooks/useTranscriptionJob.ts` (create, poll, retry, resume).
- `POST .../:jobId/retry` wired to the failure screen's Retry button;
  `GET /api/transcription-jobs` surfaced as a "Processing" section on the
  dashboard so a doctor can reopen an unfinished job after navigating away
  (`/dashboard/new?jobId=...` resumes polling) — "do not pretend an
  unfinished job is complete" is satisfied by literally showing the real
  status, not a guess.
- `ErrorBanner` widened to accept any error code (not just the fixed REST
  `ErrorCode` union) with friendly labels for all documented job error
  codes (`RECORDING_TOO_LONG`, `PROVIDER_TIMEOUT`, etc.) — unrecognized
  future codes still degrade gracefully.
- `Transcription.warnings[]` (e.g. `MINOR_SPEAKER_DETECTED`) and per-segment
  `needsReview` now render — an amber banner and a segment-level "Review"
  badge respectively, advisory only, never presented as verified.
- Upload size limit raised from 10 MB to 1 GiB for the new-transcription
  flow specifically (`UploadPanel`'s limit is now a prop; the legacy
  quick-transcribe page keeps its original 10 MB against the unchanged
  `/api/transcribe`).
- Recording duration bumped 60s → 7200s (2h), `HH:MM:SS` clock, warning in
  the last 5 minutes, "keep this tab open" notice, mic/track-interruption
  handling that preserves whatever was captured.
- 3+ speaker support confirmed with no hardcoded 2-speaker assumption —
  the shared mock fixture now has a third speaker (a nurse stepping in),
  permanently, with a `needsReview`/`MINOR_SPEAKER_DETECTED` demo mirroring
  what the backend actually observed on a real 2-hour recording.

**Real bug found and fixed via this integration testing:** the shared
`apiRequest` helper's success/failure heuristic checked `"error" in
payload`, but a *successful* job response legitimately has an `error` key
(`null` when nothing failed) — so every successful job creation was being
misread as a failure ("SERVER ERROR / null"). Fixed to trust the HTTP
status code only (`services/transcriptions/apiClient.ts`), which is what
the contract actually specifies.

**Verified for real** (not mocks): `STT_ENGINE=local` (no Deepgram key
available in this session — flagged below), real job creation → real
polling → real completion → real `tr_<uuid>` transcript with correct
diarization, through the new job endpoint end to end, zero console errors,
clean server logs throughout.

**Not yet verified:** the actual Deepgram engine (needs `DEEPGRAM_API_KEY`,
which wasn't available this session — only Supabase credentials were
shared). Everything was tested against the `local` whisper.cpp fallback via
the *same* job endpoints Deepgram uses, so the client-side job/polling
mechanics are proven; only the Deepgram-specific response shape (`engine:
"deepgram"`, real `warnings`/`needsReview` from real Deepgram data) is
unverified. Chunked upload was explicitly *not* built — the backend
recommended against it (single multipart POST is reliable on localhost)
and the frontend agreed on issue #3.

## Completed features
- Original single-speaker quick-transcribe flow (`/`) preserved unchanged —
  record/upload → transcribe → edit/copy/download, still against
  `POST /api/transcribe` (real or mock via `VITE_USE_MOCK_API`).
- Blue brand palette applied via design tokens (`client/src/index.css`) —
  Egyptian Blue / Sapphire Sky / Glaucous / Baby Blue Ice / Pale Sky.
- Doctor workspace (dashboard, new transcription, speaker-separated
  transcript viewer, history, export), fully aligned with contract v2:
  list envelope, 204-on-delete, `UNAUTHENTICATED`/`INVALID_REQUEST`/
  `SERVER_ERROR` codes with auto sign-out on session expiry, explicit
  "Mark as reviewed" (no client-derived review status), `diarization.status`
  handling, `expectedSpeakers=2` on upload, and now `engine` ("Processed
  locally" / "Processed by Deepgram (cloud)" shown on the transcript).
- Real Supabase Auth (`services/auth/supabaseAuthProvider.ts`) verified
  end-to-end earlier (signup → real confirmation email → confirm → sign
  in/out).

## Verified for real today (not mocks), against the merged backend
Ran `cd server && npm install && npm run setup:model && npm run
setup:diarization` locally (Node 23.6 — `node:sqlite` and the diarization
Python venv both work fine despite the README's Node 24 recommendation),
`npm run doctor` (all green: FFmpeg, whisper-cli, both models, diarization,
Supabase config, a real transcription, and real diarization on synthetic
audio), then `npm start`.

With the client pointed at it for real:
- Signed in with a real (previously-confirmed) Supabase account.
- Uploaded the backend's own `two-speaker.wav` fixture. Got back a real
  `tr_<uuid>` transcription: accurate whisper.cpp text, and diarization
  correctly alternated every turn between the two speakers.
- Assigned Speaker 1 → Doctor, Speaker 2 → Patient — persisted correctly,
  applied to every segment, `reviewStatus` correctly stayed `needs_review`
  (not auto-flipped — confirms that fix holds against real data).
- "Mark as reviewed" → flipped to `reviewed`. Edited a segment's text →
  **automatically flipped back to `needs_review` and the "Mark as
  reviewed" button reappeared, with zero client-side logic for this** —
  the UI just reflects whatever the backend returns, exactly as designed.
- Export (while reviewed, no confirm-dialog risk in the automated browser).
- Transcript history showed the real transcript with correct duration and
  status.
- Verified `DELETE` directly (via the page's own authenticated `fetch`,
  bypassing the confirm() dialog that automation can't click through):
  real `204` with an empty body, exactly matching the fix from last
  session. Reflected correctly in the UI after reload.
- Server logs stayed clean throughout — no audio, tokens, or transcript
  text logged, matching their stated privacy commitment.
- Zero console errors at any step of the whole session.

## Remaining prioritized tasks
1. Voice enrollment: set up the real ECAPA-TDNN model locally
   (`npm run setup:voice`, needs `uv` + ~500 MB, not installed this
   session) and `VOICE_PROFILE_KEY`, then verify a full successful
   enrollment + a real doctor-voice-match against the live backend — only
   the GET/DELETE/consent-validation paths were verified for real so far.
2. Backend agreement on the SOAP-notes contract (proposal posted on issue
   #3) — still mock-only until the endpoints exist; also needs a hosted-AI
   provider decision, entirely backend-side.
4. Get a `DEEPGRAM_API_KEY` to verify the actual Deepgram engine end to end
   (tested via the local fallback through the same job endpoints so far).
5. Automated test suite (Playwright/Vitest) for the scenarios in the brief
   — deferred until now because the job-workflow contract was still
   changing; it's stable now, so this is a reasonable next step.
6. Mobile-width layout not manually verified (browser automation here
   can't reliably resize the viewport).
7. Deploy to Vercel (client) + decide on backend hosting (laptop + tunnel
   per backend's plan, since Vercel can't run whisper.cpp).
8. Optional: surface `GET /api/me` somewhere (not required by any current
   screen).

## Architectural decisions
- `client/` owned by the frontend agent (branch `kv`); backend owned by the
  agent on branch `lz`. Coordinating via issue #3.
- Original quick-transcribe flow kept as-is at `/`, not merged into the new
  authenticated flow, per "preserve existing functionality."
- Auth and the transcriptions API each sit behind their own
  provider-agnostic service + mock flag (`VITE_USE_MOCK_AUTH`,
  `VITE_USE_MOCK_TRANSCRIPTIONS`) — both now flipped to `false` locally
  since the real backend is verified working. Voice profile now points at
  the real, merged backend (`VITE_USE_MOCK_VOICE_PROFILE`, verified working
  against `main` this session) — the mock stays available and shape-matched
  for demoing without the local ECAPA-TDNN model set up. SOAP notes still
  follow the same pattern (`VITE_USE_MOCK_SOAP`) but stay mock-only since
  the backend doesn't have that endpoint yet.

## Known bugs and blockers
- SOAP notes have no backend support yet — mock-only, see above. Voice
  enrollment's real backend is merged and verified for GET/DELETE/consent
  validation, but a full enrollment hasn't been exercised for real in this
  session (needs the local voice-model setup — see remaining tasks).
  Everything else: no known bugs. Auth/transcriptions mock flags can stay
  `false` for local dev/demo as long as `server/` is running with models
  set up. `server/.env` needs `DEEPGRAM_API_KEY` for the real Deepgram
  engine — without it, set `STT_ENGINE=local` to use the whisper.cpp
  fallback (what this session's testing used).

## Test and deployment status
- No automated tests on the client. Full manual pass against the real,
  merged v3 backend (job creation, polling, completion, warnings,
  needsReview, resume-unfinished-job) plus earlier real-auth and v2 passes.
  Voice enrollment verified for real against the merged v4 backend where
  possible without the local model (GET, DELETE + confirm header, consent
  validation — all exact-match against the live server, confirmed via both
  curl and a real signed-in browser session) plus the reconciled mock for
  the rest. SOAP notes verified against their mock only (full generate →
  edit → save → approve → export round trip, including a real StrictMode
  double-invoke bug caught and fixed in this session) — see each feature's
  notes above for what live browser automation couldn't cover (mainly
  native browser dialogs: mic permission prompts and `window.confirm`, the
  latter worked around by overriding it in-page for testing, same
  technique used for the transcript delete button previously). Lint
  (`oxlint`) and build (`tsc -b && vite build`) both pass. No deployment yet.

## Next specific action
Integrate the merged SOAP backend (PR #9): reconcile the client against
`docs/SOAP_API_CONTRACT.md`, wire the additive fields (`sourceStale`,
`transcriptRevision`, `blocking` review flags, `reconcile`), then switch
`VITE_USE_MOCK_SOAP=false` and verify real Gemini generation end to end.

## Backend status (lz)
- v1 (`/api/transcribe`, `/api/health`) and v2 (accounts, `/api/transcriptions*`) are merged on `main` and unchanged in shape.
- v3 (merged into `main`): **Deepgram Nova-3 Medical + the latest batch diarizer is the primary engine**, with a persistent job system
  (`/api/transcription-jobs*`), file-backed recordings up to **30 minutes each** (limit lowered from 2 hours on 2026-09-20; the frontend's recorder still says 2 h: see Contract v5), `needsReview` flags, `diarizationStatus`, and a secured (off by

  default) callback listener for long recordings. whisper.cpp remains an optional fallback (`STT_ENGINE=local`).
- Verified live with synthetic audio: exact request, model `medical-nova-3`, diarizer v2, A-B-A / 3-speaker / 5-minute recordings
  through the full stack, including 30-minute and (before the limit was lowered) 2-hour recordings (2 h: 29 s end to end, WER 0.73%, DER 0.63%, server memory +110 MB). Known flaws: the 3-speaker case
  misattributes a sentence, and the 2-hour recording produced a spurious 3rd speaker (0.08% of speech; now flagged with a warning, not reassigned).
  Synchronous limit default is now 30 min (equal to the recording maximum). **Not verified:** callbacks against the real service (not needed at these speeds), real microphones/patients.
- v4 (merged into `main` via PR #8): **doctor voice enrollment and identification** (`/api/me/voice-profile`), local SpeechBrain ECAPA-TDNN, independent speaker check when Deepgram finds <=1 speaker, `identificationStatus` / `suggestedRole` on speakers (suggestion only; `role` stays the doctor's). Encrypted profiles, explicit consent. Measured on SYNTHETIC voices only: 0/162 false doctor matches with the doctor absent; recovers 3 of 11 Deepgram merges at the conservative setting; thresholds must be re-measured with real consenting speakers. See docs/VOICE_EVALUATION.md and Contract v4. Setup: `npm run setup:voice`, set `VOICE_PROFILE_KEY`.
- v5 (merged into `main` via PR #9): **pyannote Community-1 diarization** (local, gated model, `npm run setup:pyannote`). Deepgram still transcribes; pyannote decides who spoke when and its turns are aligned to Deepgram's words. Default policy `more-speakers` (adopt pyannote only when it hears MORE speakers): measured on 162 synthetic recordings it recovers 5 of 11 Deepgram merges with 0 regressions and 0 false splits, where "always" would have broken 32 of 151. Measured limit: one short exchange (7 s) is heard as one speaker.
- v6 (merged into `main` via PR #9): **SOAP notes via Gemini 2.5 Flash.** Two-stage generation (facts with sources, then composition) from the FINAL STORED transcript, deterministic grounding checks against that transcript, review flags, doctor editing with optimistic concurrency, explicit approval that locks the note, PDF/TXT export. One note per consultation, never regenerated. `docs/SOAP_API_CONTRACT.md` (frontend's proposed contract adopted as-is). Real-Gemini tests written and **run: 13/13 passing** (commit d81c85a).

- Setup: `cd server && npm install && npm run setup:model && npm run setup:diarization && npm run doctor` (set `DEEPGRAM_API_KEY` in `server/.env`).
- Synthetic data only. Not approved for real patient information (Deepgram BAA, consent, retention, encryption, audit logging all pending).
