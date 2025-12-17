import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { Buffer } from 'buffer';

import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const projectRoot = resolve(__dirname, '..');
const publicDir = join(projectRoot, 'public');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE_URL = (process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
const OPENAI_TRANSLATE_MODEL = process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4o-mini';
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const respondJson = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
};

const readRequestBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const ensureApiKey = (res) => {
  if (!OPENAI_API_KEY) {
    respondJson(res, 500, { error: 'Missing OPENAI_API_KEY' });
    return false;
  }
  return true;
};

const fetchJson = async (url, options = {}) => {
  const res = await fetch(url, options);
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`OpenAI request failed (${res.status}): ${message}`);
  }
  return res.json();
};

const fetchArrayBuffer = async (url, options = {}) => {
  const res = await fetch(url, options);
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`OpenAI request failed (${res.status}): ${message}`);
  }
  return res.arrayBuffer();
};

const normalizeMimeType = (value) => {
  if (!value) return '';
  return String(value).split(';')[0].trim().toLowerCase();
};

const extensionForAudioMimeType = (mimeType) => {
  switch (mimeType) {
    case 'audio/webm':
      return 'webm';
    case 'audio/ogg':
    case 'audio/oga':
      return 'ogg';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/m4a':
      return 'mp4';
    case 'audio/flac':
      return 'flac';
    default:
      return 'webm';
  }
};

const transcribeAudio = async (audioBuffer, sourceLanguage, audioMimeType) => {
  const formData = new FormData();
  const normalizedMimeType = normalizeMimeType(audioMimeType) || 'audio/webm';
  const extension = extensionForAudioMimeType(normalizedMimeType);
  const file = new File([audioBuffer], `audio.${extension}`, { type: normalizedMimeType });
  formData.set('file', file);
  formData.set('model', OPENAI_TRANSCRIBE_MODEL);
  if (sourceLanguage) {
    formData.set('language', sourceLanguage);
  }

  const result = await fetchJson(`${OPENAI_API_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });
  return result.text;
};

const translateText = async (text, targetLanguage) => {
  const completion = await fetchJson(`${OPENAI_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_TRANSLATE_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are a translation engine. Translate user text to ${targetLanguage}. Respond with translation only without extra commentary.`,
        },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
    }),
  });

  return completion.choices?.[0]?.message?.content?.trim() || '';
};

const synthesizeSpeech = async (text, voice = OPENAI_TTS_VOICE) => {
  const audioBuffer = await fetchArrayBuffer(`${OPENAI_API_BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      input: text,
      voice,
    }),
  });
  return Buffer.from(audioBuffer).toString('base64');
};

const handleTranslateRequest = async (req, res) => {
  if (!ensureApiKey(res)) return;

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const targetLanguage = url.searchParams.get('targetLang') || 'English';
    const sourceLanguage = url.searchParams.get('sourceLang') || '';
    const outputMode = url.searchParams.get('outputMode') || 'text';

    const audioMimeType = normalizeMimeType(req.headers['x-audio-mime-type'] || req.headers['content-type']);

    const audioBuffer = await readRequestBody(req);
    if (!audioBuffer.length) {
      respondJson(res, 400, { error: 'No audio content received.' });
      return;
    }

    const transcript = await transcribeAudio(audioBuffer, sourceLanguage, audioMimeType);
    const translation = await translateText(transcript, targetLanguage);

    let audioBase64 = null;
    if (outputMode === 'audio' || outputMode === 'both') {
      audioBase64 = await synthesizeSpeech(translation);
    }

    respondJson(res, 200, {
      transcript,
      translation,
      audioBase64,
    });
  } catch (error) {
    console.error(error);
    respondJson(res, 500, { error: error.message || 'Unexpected server error' });
  }
};

const serveStatic = (req, res, filePath) => {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const stats = statSync(filePath);
  if (stats.isDirectory()) {
    const indexPath = join(filePath, 'index.html');
    if (!existsSync(indexPath)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    serveStatic(req, res, indexPath);
    return;
  }

  const contentType = MIME_TYPES[extname(filePath)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  const stream = Readable.from(readFileSync(filePath));
  stream.pipe(res);
};

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Audio-Mime-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    respondJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/api/translate-audio')) {
    handleTranslateRequest(req, res);
    return;
  }

  const requestedPath = req.url.split('?')[0];
  const filePath = join(publicDir, requestedPath === '/' ? 'index.html' : requestedPath);
  serveStatic(req, res, filePath);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
