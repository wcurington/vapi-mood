/**
 * Health America Backend — server_v2.5.4.js
 * Merge: inlined Logic Service (GPT-4.1), optional Whisper ASR route,
 * Redis-backed per-call memory with in-memory fallback,
 * keeps Postgres logging + existing routes from v2.5.3.
 *
 * Changelog:
 * - NEW: /logic/on-start, /logic/on-message, /logic/on-hangup (Vapi external brain)
 * - NEW: OpenAI GPT-4.1 chat integration with strict system prompt
 * - NEW: Redis short-term memory (fallback to in-memory Map if REDIS_URL missing)
 * - NEW: Optional Whisper ASR endpoint (/api/ai/asr) gated by USE_WHISPER=1|true
 * - KEEP: /health, Swagger, /api/ai/query (now real LLM), /api/ai/call-events (DB logging)
 *
 * Env (example):
 *   PORT=8880
 *   OPENAI_API_KEY=sk-...
 *   REDIS_URL=redis://localhost:6379/0  (optional; otherwise in-memory fallback)
 *   DATABASE_URL=postgres://user:pass@host:5432/ha
 *   MODEL_MAIN=gpt-4.1
 *   MODEL_SUMMARY=gpt-4.1-mini
 *   USE_WHISPER=false
 *   CARRIER_ADAPTER=signalwire
 *   VAPI_WEBHOOK_SECRET=...   (optional - placeholder; full HMAC verification TBD)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');
let swaggerDoc = null;
try {
  swaggerDoc = require('./swagger.json');
} catch (_) {
  swaggerDoc = { openapi: '3.0.0', info: { title: 'Health America API', version: 'v2.5.4' } };
}
const pinoHttp = require('pino-http');
const winston = require('winston');
const db = require('./db'); // Postgres pool
const { promisify } = require('util');

// OpenAI
let OpenAI;
try {
  OpenAI = require('openai');
} catch (e) {
  console.warn('[init] Missing "openai" dependency. Run: npm i openai');
}
const openai = OpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Redis (optional)
let Redis;
try {
  Redis = require('ioredis');
} catch (e) {
  console.warn('[init] Missing "ioredis" dependency. Run: npm i ioredis');
}
const REDIS_URL = process.env.REDIS_URL || null;
const redis = (Redis && REDIS_URL) ? new Redis(REDIS_URL) : null;

// In-memory fallback store (used only if Redis not configured)
const memStore = new Map();

const PORT = process.env.PORT ? Number(process.env.PORT) : 8880;
const app = express();

/* ---------------------------- Logger (Winston) ---------------------------- */
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'server-alex' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}

/* --------------------------------- App ---------------------------------- */
app.disable('x-powered-by');
app.use(helmet());
app.use(compression());

// Capture raw body for optional verification (minimal)
app.use((req, res, next) => {
  let data = [];
  req.on('data', chunk => data.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(data);
    next();
  });
});

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

// Request ID
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

// Structured logs (Pino)
app.use(pinoHttp({ customProps: (req, res) => ({ reqid: req.id }) }));

// CORS
app.use(cors({ origin: '*', credentials: true }));

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 60 * 1000, limit: 120 }));
app.use('/logic/', rateLimit({ windowMs: 60 * 1000, limit: 240 }));

/* ------------------------------- Health ---------------------------------- */
app.get(['/', '/health'], (req, res) => {
  res.json({ status: 'UP', service: 'Server Alex', version: '2.5.4' });
});

/* ------------------------------- Swagger --------------------------------- */
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

/* ----------------------- Short-term Memory Helpers ----------------------- */
const HISTORY_TTL_SECONDS = 60 * 60; // 1 hour
const MAX_TURNS_BEFORE_SUMMARIZE = 30;

async function rpushHistory(callId, payload) {
  const key = `call:${callId}:history`;
  if (redis) {
    await redis.rpush(key, JSON.stringify(payload));
    await redis.expire(key, HISTORY_TTL_SECONDS);
  } else {
    const arr = memStore.get(key) || [];
    arr.push(payload);
    memStore.set(key, arr);
  }
}

async function lrangeHistory(callId) {
  const key = `call:${callId}:history`;
  if (redis) {
    const arr = await redis.lrange(key, 0, -1);
    return arr.map(s => JSON.parse(s));
  } else {
    return (memStore.get(key) || []).slice();
  }
}

async function delHistory(callId) {
  const key = `call:${callId}:history`;
  if (redis) {
    await redis.del(key);
  } else {
    memStore.delete(key);
  }
}

async function lengthHistory(callId) {
  const key = `call:${callId}:history`;
  if (redis) {
    return await redis.llen(key);
  } else {
    return (memStore.get(key) || []).length;
  }
}

/* ------------------------- OpenAI Chat Utilities ------------------------- */
const MODEL_MAIN = process.env.MODEL_MAIN || 'gpt-4.1';
const MODEL_SUMMARY = process.env.MODEL_SUMMARY || 'gpt-4.1-mini';

const SYSTEM_PROMPT = [
  "You are Alex from Health America, an AI sales agent for natural supplements.",
  "Non-negotiables:",
  "- Build value for 6–10 minutes before any pricing.",
  "- Ask at least 4–10 qualifying questions (energy level 1–10, sleep, diet, exercise, primary concerns).",
  "- Address ALL health issues mentioned before offering pricing.",
  "- Use strict step-down offers (annual/membership → 6-month → 3-month → single).",
  "- Do not guarantee medical outcomes; avoid medical advice or diagnosis.",
  "- After presenting price, emphasize: no shipping fees or taxes for this offer.",
  "- Use natural [PAUSE] markers to indicate short pauses (do not say the word 'pause').",
  "Tone: warm, persuasive, confident, and precise. Keep sentences TTS-friendly."
].join(' ');

async function summarizeConversation(history) {
  if (!openai) return 'Summary unavailable';
  const messages = [
    { role: 'system', content: 'Summarize this conversation briefly for memory context. Include key health issues and purchase intent in ≤120 words.' },
    ...history.map(m => ({ role: m.role, content: m.content }))
  ];
  try {
    const out = await openai.chat.completions.create({
      model: MODEL_SUMMARY,
      messages,
      temperature: 0.2,
      max_tokens: 180
    });
    return out.choices[0]?.message?.content?.trim() || 'Summary unavailable';
  } catch (e) {
    console.error('[summary] OpenAI error:', e.message);
    return 'Summary unavailable';
  }
}

async function ensureBudget(callId) {
  const len = await lengthHistory(callId);
  if (len > MAX_TURNS_BEFORE_SUMMARIZE) {
    const history = await lrangeHistory(callId);
    const summary = await summarizeConversation(history);
    await delHistory(callId);
    await rpushHistory(callId, { role: 'system', content: 'Summary so far: ' + summary });
  }
}

async function runAlexLLM(messages) {
  if (!openai || !process.env.OPENAI_API_KEY) {
    return "I'm online, but my reasoning engine isn't configured. Please set OPENAI_API_KEY.";
  }
  const out = await openai.chat.completions.create({
    model: MODEL_MAIN,
    messages,
    temperature: 0.7,
    max_tokens: 350
  });
  return out.choices[0]?.message?.content?.trim() || 'Understood.';
}

/* ---------------------------- AI Bridge (API) ---------------------------- */
const alex = {
  async query(payload) {
    const { text, context = {}, customer = {}, callId = 'ad-hoc' } = payload || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return { error: 'text is required' };
    }
    // Build messages: enforce system prompt + any context
    const history = await lrangeHistory(callId);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: text }
    ];
    const reply = await runAlexLLM(messages);
    await rpushHistory(callId, { role: 'user', content: text });
    await rpushHistory(callId, { role: 'assistant', content: reply });
    await ensureBudget(callId);
    return { ok: true, reply, guardrails: ['value-first', 'no guarantees', 'step-down offers'] };
  },

  async logCallEvent(event) {
    const required = ['sw_call_id', 'caller', 'callee', 'outcome'];
    for (const k of required) {
      if (!event || typeof event[k] !== 'string' || !event[k].length) {
        return { error: `Missing field: ${k}` };
      }
    }
    try {
      await db.query(
        `INSERT INTO call_logs (sw_call_id, caller, callee, outcome, transcript, meta, started_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
         ON CONFLICT (sw_call_id) DO NOTHING`,
        [
          event.sw_call_id,
          event.caller,
          event.callee,
          event.outcome,
          JSON.stringify(event.transcript || {}),
          JSON.stringify(event.meta || {})
        ]
      );
      return { ok: true, persisted: 'db' };
    } catch (err) {
      logger.error({ message: 'DB insert failed, falling back to file', error: err });
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\\n';
      fs.appendFileSync(path.join(process.cwd(), 'logs', 'call_events.log'), line, { encoding: 'utf8' });
      return { ok: true, persisted: 'file' };
    }
  }
};

/* --------------------------------- Routes -------------------------------- */
// Existing
app.post('/api/ai/query', async (req, res, next) => {
  try { res.json(await alex.query(req.body)); } catch (e) { next(e); }
});

app.post('/api/ai/call-events', async (req, res, next) => {
  try { res.json(await alex.logCallEvent(req.body)); } catch (e) { next(e); }
});

/* ------------------------------ Whisper (opt) ----------------------------- */
const USE_WHISPER = /^1|true$/i.test(String(process.env.USE_WHISPER || 'false'));
app.post('/api/ai/asr', async (req, res, next) => {
  try {
    if (!USE_WHISPER) {
      return res.status(501).json({ error: 'Whisper ASR disabled. Set USE_WHISPER=true to enable.' });
    }
    if (!openai) {
      return res.status(500).json({ error: 'OpenAI not configured' });
    }
    const { audioBase64, mimetype = 'audio/wav', callId } = req.body || {};
    if (!audioBase64) return res.status(400).json({ error: 'audioBase64 is required' });

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    // NOTE: openai.audio.transcriptions.create expects a File/Blob in browser or fs stream in Node.
    // For simplicity, write temp buffer then stream it.
    const tmp = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const tmpFile = path.join(tmp, `asr_${Date.now()}.wav`);
    fs.writeFileSync(tmpFile, audioBuffer);

    // The v4 SDK (node) supports: client.audio.transcriptions.create({ file: fs.createReadStream(...), model: "whisper-1" })
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1'
    });

    const text = result?.text || '';
    if (callId) {
      // append to transcript in DB as convenience
      try {
        await db.query(
          `UPDATE call_logs SET transcript = COALESCE(transcript, '{}'::jsonb) || jsonb_build_object('asr', jsonb_build_array(coalesce(transcript->'asr', '[]'::jsonb) || to_jsonb($2))) WHERE sw_call_id = $1`,
          [callId, { ts: new Date().toISOString(), text }]
        );
      } catch (e) { logger.warn({ msg: 'ASR transcript DB append failed', err: e.message }); }
    }

    // cleanup
    fs.unlink(tmpFile, () => void 0);
    res.json({ text });
  } catch (err) { next(err); }
});

/* --------------------------- Vapi Logic Webhooks -------------------------- */
function verifyVapi(req) {
  // Placeholder — if VAPI_WEBHOOK_SECRET is set, you can implement HMAC verification here.
  // For now, simply return true to proceed.
  return true;
}

// on-start: seed memory, optional CRM/vtiger context
app.post('/logic/on-start', async (req, res) => {
  if (!verifyVapi(req)) return res.status(401).json({ error: 'invalid signature' });
  const { callId, metadata } = req.body || {};
  await rpushHistory(callId, { role: 'system', content: 'Conversation started.' });
  try {
    await db.query(
      `INSERT INTO call_logs (sw_call_id, caller, callee, outcome, transcript, meta, started_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, now())
       ON CONFLICT (sw_call_id) DO NOTHING`,
      [ callId || crypto.randomUUID(), metadata?.caller || '', metadata?.callee || 'alex', 'started', JSON.stringify({}), JSON.stringify(metadata || {}) ]
    );
  } catch (e) {
    logger.warn({ msg: 'on-start DB insert failed', err: e.message });
  }
  res.json({ reply: "Hello, this is Alex with Health America. How are you today? [PAUSE]" });
});

// on-message: core reasoning turn
app.post('/logic/on-message', async (req, res) => {
  if (!verifyVapi(req)) return res.status(401).json({ error: 'invalid signature' });
  const { callId, text, partial } = req.body || {};

  if (partial) return res.json({ reply: null }); // ignore partials for now

  await rpushHistory(callId, { role: 'user', content: text || '' });
  await ensureBudget(callId);

  const history = await lrangeHistory(callId);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history
  ];

  let reply = 'Understood.';
  try {
    reply = await runAlexLLM(messages);
  } catch (e) {
    logger.error({ msg: 'OpenAI error in on-message', err: e.message });
    reply = "I'm having a little trouble right now, but let's continue. [PAUSE]";
  }

  await rpushHistory(callId, { role: 'assistant', content: reply });
  res.json({ reply });
});

// on-hangup: finalize
app.post('/logic/on-hangup', async (req, res) => {
  if (!verifyVapi(req)) return res.status(401).json({ error: 'invalid signature' });
  const { callId, reason } = req.body || {};
  try {
    await db.query('UPDATE call_logs SET ended_at = NOW(), outcome = $1 WHERE sw_call_id = $2', [
      reason || 'ended', callId || ''
    ]);
  } catch (e) {
    logger.warn({ msg: 'on-hangup DB update failed', err: e.message });
  }
  res.json({ ok: true });
});

/* ---------------------------- Not Found + Error --------------------------- */
app.use((req, res, next) => {
  const err = new Error('Not Found'); err.status = 404; next(err);
});
app.use((err, req, res, next) => {
  logger.error({ message: err.message, stack: err.stack, reqid: req.id });
  res.status(err.status || 500).json({ error: true, message: err.message, reqid: req.id });
});

/* --------------------------------- Boot ---------------------------------- */
fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });
app.listen(PORT, "0.0.0.0", () => console.log(`App running on port ${PORT}`));
