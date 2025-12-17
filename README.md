# Realtime Audio Translation

A lightweight demo that captures microphone audio in the browser, sends short chunks to a Node.js server, and uses OpenAI APIs for transcription (Whisper), translation (gpt-4o-mini), and optional text-to-speech playback.

## Prerequisites
- Node.js 18+
- An OpenAI API key available as `OPENAI_API_KEY`

## Running locally
1. Install dependencies (none required beyond Node.js built-ins).
2. Start the server:
   ```bash
   OPENAI_API_KEY=your_key_here npm start
   ```
3. Visit `http://localhost:3000` and allow microphone access.

## How it works
- The browser records audio via `MediaRecorder` in 3-second chunks.
- Each chunk is sent to `/api/translate-audio` with query params for `targetLang`, `outputMode`, and optional `sourceLang`.
- The server calls:
  - **Whisper** (`whisper-1`) for transcription
  - **gpt-4o-mini** for translation
  - **gpt-4o-mini-tts** for optional speech synthesis
- Responses return transcript text, translated text, and base64 audio (for audio/both modes).

## Notes
- This demo avoids external npm dependencies due to offline-friendly constraints and relies on built-in `fetch` and `FormData`.
- For true low-latency streaming, you could swap the chunked HTTP calls for WebSockets, but the current approach keeps the API footprint minimal while still providing near-realtime updates.
