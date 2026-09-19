# Text-to-Speech API Contract

Endpoint:
POST /api/tts

Request:
Content-Type: application/json

{
  "text": "Hello world",
  "voice": "default"
}

Successful response:
HTTP 200
Content-Type: audio/mpeg

Body:
MP3 audio bytes

Validation error:
HTTP 400
Content-Type: application/json

{
  "error": "Invalid text"
}

Generation failure:
HTTP 502
Content-Type: application/json

{
  "error": "Speech generation failed"
}

Frontend responsibilities:
- Collect text from user.
- Send POST request to /api/tts.
- Receive binary audio.
- Display audio player.
- Allow playback and downloading.
- Handle errors.

Backend responsibilities:
- Validate request.
- Call the TTS provider or model.
- Return MP3 audio.
- Secure API credentials.
- Handle timeouts and model errors.