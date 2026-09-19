# Real Deepgram responses (synthetic audio only)

Responses from POST /v1/listen with model=nova-3-medical, diarize_model=latest, utterances=true,
smart_format=true, language=en, captured on 2026-09-19 from the SYNTHETIC recordings of the same name in
../synthetic/. Request ids, hashes and timestamps are scrubbed. Used to develop and test the normalizer
against real provider output (three-speaker.json contains a real misattribution; medical.json contains a
real misrecognized drug name). No real patient data.
