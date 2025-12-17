# Realtime Audio Translation

A lightweight demo that captures microphone audio in the browser, sends short chunks to a Node.js server, and uses OpenAI APIs for transcription (Whisper), translation (gpt-4o-mini), and optional text-to-speech playback.

## Prerequisites
- Node.js 18+
- An OpenAI API key in `.env` as `OPENAI_API_KEY`

## Running locally
1. Install dependencies:
  ```bash
  npm install
  ```
2. Create `.env` (you can copy `.env.example`) and set `OPENAI_API_KEY`.
3. Start the server:
  ```bash
  npm start
  ```
4. Visit `http://localhost:3000` and allow microphone access.

## Configuration
- `OPENAI_API_KEY` (required): OpenAI API key.
- `PORT` (optional, default `3000`): Server port.
- `OPENAI_API_BASE_URL` (optional, default `https://api.openai.com/v1`)
- `OPENAI_TRANSCRIBE_MODEL` (optional, default `whisper-1`)
- `OPENAI_TRANSLATE_MODEL` (optional, default `gpt-4o-mini`)
- `OPENAI_TTS_MODEL` (optional, default `gpt-4o-mini-tts`)
- `OPENAI_TTS_VOICE` (optional, default `alloy`)

## How it works
- The browser records audio via `MediaRecorder` in 3-second chunks.
- Each chunk is sent to `/api/translate-audio` with query params for `targetLang`, `outputMode`, and optional `sourceLang`.
- The server calls:
  - **Whisper** (`whisper-1`) for transcription
  - **gpt-4o-mini** for translation
  - **gpt-4o-mini-tts** for optional speech synthesis
- Responses return transcript text, translated text, and base64 audio (for audio/both modes).

## Notes
- This demo relies on built-in `fetch`/`FormData` plus `dotenv` for loading `.env`.
- For true low-latency streaming, you could swap the chunked HTTP calls for WebSockets, but the current approach keeps the API footprint minimal while still providing near-realtime updates.
