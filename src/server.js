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
const OPENAI_PRICING = {
  // USD per 1K tokens; adjust if you use different models
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4o-mini-tts': { input: 0.0002, output: 0.0002 },
};

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

const normalizeTargetLanguageLabel = (language) => {
  const lower = (language || '').toLowerCase();
  if (lower.includes('cantonese')) return 'Cantonese (Traditional Chinese, Cantonese phrasing)';
  if (lower.includes('mandarin')) return 'Mandarin Chinese (Simplified Chinese, Mainland usage)';
  return language;
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

const refineTranscript = async (rawTranscript, sourceLanguage) => {
  if (!rawTranscript || rawTranscript.trim().length < 2) return rawTranscript || '';

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
          content:
            'You clean ASR transcripts. Fix obvious recognition mistakes, punctuation, and casing while preserving meaning. Do NOT add or remove sentences. Keep language same as input.',
        },
        {
          role: 'user',
          content: `Language: ${sourceLanguage || 'unknown / mixed'}\nTranscript:\n${rawTranscript}`,
        },
      ],
      temperature: 0.2,
    }),
  });

  return completion.choices?.[0]?.message?.content?.trim() || rawTranscript;
};

const translateText = async (text, targetLanguage, context = '') => {
  const sysParts = [
    `You are a translation engine. Translate user text to ${targetLanguage}.`,
    'Use the provided context for coherence (names, pronouns, tense).',
    'Return ONLY the translation of the new text, not the context.',
    'If the text is already in the target language, return it unchanged.',
    'Never reply with explanations, apologies, or placeholders. Never return empty output.',
  ];

  const lowerLang = (targetLanguage || '').toLowerCase();
  if (lowerLang.includes('cantonese')) {
    sysParts.push(
      'Write in spoken Cantonese using Traditional Chinese characters (e.g., 喺/嘅/佢/佢哋/唔/冇/咗/啦/喇/啱).',
      'Avoid Mainland Mandarin lexical choices; prefer colloquial Cantonese phrasing and particles.',
      'Do not mix Simplified Chinese; keep vocabulary natural for Cantonese listeners.'
    );
  }

  const messages = [
    {
      role: 'system',
      content: sysParts.join(' '),
    },
    context
      ? {
          role: 'user',
          content: `Context (previous transcript):\n${context}\n\nNew text to translate:\n${text}\n\nTranslate only the new text, keep consistent with context.`,
        }
      : { role: 'user', content: text },
  ];

const tryTranslate = async () => {
  const completion = await fetchJson(`${OPENAI_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    body: JSON.stringify({
      model: OPENAI_TRANSLATE_MODEL,
      messages,
      temperature: 0.2,
    }),
  });
    if (completion?.usage) {
      sessionUsage.total_tokens += completion.usage.total_tokens || 0;
      sessionUsage.prompt_tokens += completion.usage.prompt_tokens || 0;
      sessionUsage.completion_tokens += completion.usage.completion_tokens || 0;
    }
    return completion.choices?.[0]?.message?.content?.trim() || '';
};

  let result = await tryTranslate();
  if (!result) {
    // Second attempt with stricter instruction if first came back empty.
    messages[0].content += ' Output must not be empty. Provide best-effort translation.';
    result = await tryTranslate();
  }
  return result;
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
  if (audioBuffer?.usage && sessionUsage) {
    sessionUsage.total_tokens += audioBuffer.usage.total_tokens || 0;
    sessionUsage.prompt_tokens += audioBuffer.usage.prompt_tokens || 0;
    sessionUsage.completion_tokens += audioBuffer.usage.completion_tokens || 0;
  }
  return Buffer.from(audioBuffer).toString('base64');
};

// --- Lightweight pub/sub for channel broadcasts (SSE) ---
const subscribers = new Map(); // channel -> Set<res>
const roomPasscodes = new Map(); // room -> passcode

const addSubscriber = (channel, res) => {
  if (!subscribers.has(channel)) subscribers.set(channel, new Set());
  subscribers.get(channel).add(res);
};

const removeSubscriber = (channel, res) => {
  const set = subscribers.get(channel);
  if (!set) return;
  set.delete(res);
  if (!set.size) subscribers.delete(channel);
};

const broadcast = (channel, payload) => {
  const set = subscribers.get(channel);
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of Array.from(set)) {
    res.write(data);
  }
};

const handleSubscribeRequest = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const channel = url.searchParams.get('channel');
  const room = (url.searchParams.get('room') || '').trim() || 'default';
  const passcode = (url.searchParams.get('passcode') || '').trim();
  if (!channel) {
    respondJson(res, 400, { error: 'Missing channel query param' });
    return;
  }

  const requiredPass = roomPasscodes.get(room);
  if (requiredPass && requiredPass !== passcode) {
    respondJson(res, 403, { error: 'Invalid passcode' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  addSubscriber(channel, res);
  // Initial ping keeps some proxies happy.
  res.write(`data: ${JSON.stringify({ type: 'ready', channel })}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeSubscriber(channel, res);
  });
};

// Build channel name for a given room + language (language lowercased for stability)
const channelName = (room, language) => `${room || 'default'}:${(language || '').toLowerCase() || 'unknown'}`;

const parseTargetLanguages = (url) => {
  // Allow multiple query params (?targetLang=English&targetLang=Spanish) or comma separated (?targetLangs=en,es).
  const langsFromRepeats = url.searchParams.getAll('targetLang').flatMap((v) => v.split(','));
  const langsFromList = (url.searchParams.get('targetLangs') || '').split(',');
  const all = [...langsFromRepeats, ...langsFromList]
    .map((v) => v.trim())
    .filter(Boolean);
  return all.length ? Array.from(new Set(all)) : ['English'];
};

const handleTranslateRequest = async (req, res) => {
  if (!ensureApiKey(res)) return;

  try {
    sessionUsage.total_tokens += 0; // ensure object exists
    const url = new URL(req.url, `http://${req.headers.host}`);
    const targetLanguages = parseTargetLanguages(url);
    const sourceLanguage = url.searchParams.get('sourceLang') || '';
    const outputMode = url.searchParams.get('outputMode') || 'text';
    const room = url.searchParams.get('room') || 'default';
    const passcode = (url.searchParams.get('passcode') || '').trim();
    const context = url.searchParams.get('context') || '';

    if (!passcode) {
      respondJson(res, 400, { error: 'Missing passcode' });
      return;
    }
    // Remember passcode for room (first write wins; later must match).
    const existing = roomPasscodes.get(room);
    if (existing && existing !== passcode) {
      respondJson(res, 403, { error: 'Room passcode mismatch' });
      return;
    }
    roomPasscodes.set(room, passcode);

    const audioMimeType = normalizeMimeType(req.headers['x-audio-mime-type'] || req.headers['content-type']);

    const audioBuffer = await readRequestBody(req);
    if (!audioBuffer.length) {
      respondJson(res, 400, { error: 'No audio content received.' });
      return;
    }

    const transcriptRaw = await transcribeAudio(audioBuffer, sourceLanguage, audioMimeType);
    const transcript = await refineTranscript(transcriptRaw, sourceLanguage);
    const wantsAudio = outputMode === 'audio' || outputMode === 'both';

    const results = await Promise.all(
      targetLanguages.map(async (language) => {
        const normalizedLang = normalizeTargetLanguageLabel(language);
        const translation = await translateText(transcript, normalizedLang, context);
        let audioBase64 = null;
        if (wantsAudio) {
          audioBase64 = await synthesizeSpeech(translation);
        }
        const result = { language, translation, audioBase64 };
        // Broadcast per-language channel so listeners can join their stream.
        broadcast(channelName(room, language), {
          type: 'translation',
          room,
          language,
          transcript,
          translation,
          audioBase64,
        });
        return result;
      })
    );

    respondJson(res, 200, {
      transcript,
      results,
      usage: {
        ...sessionUsage,
        cost: estimateCost(),
        model: OPENAI_TRANSLATE_MODEL,
      },
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

  if (req.method === 'GET' && req.url.startsWith('/api/subscribe')) {
    handleSubscribeRequest(req, res);
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
let sessionUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

const resetSessionUsage = () => {
  sessionUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
};

const estimateCost = () => {
  const translatePricing = OPENAI_PRICING[OPENAI_TRANSLATE_MODEL] || { input: 0, output: 0 };
  // approximation: prompt_tokens use input pricing, completion_tokens use output pricing
  const cost =
    (sessionUsage.prompt_tokens / 1000) * translatePricing.input +
    (sessionUsage.completion_tokens / 1000) * translatePricing.output;
  return Number(cost.toFixed(6));
};
