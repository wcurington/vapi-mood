/**
 * Health America Backend — server_v2.5.2.js
 * Port policy: honor PORT env, default to 8880 (per Caddy config rule)
 * Mounts: API routes, knowledgebase loader, AI bridge, media, Swagger
 * Security: Helmet, CORS, rate limiting, compression
 * Observability: Pino JSON logs, Winston file logs, Request IDs
 * Version: 2.5.2
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
const swaggerDoc = require('./swagger.json');
const pinoHttp = require('pino-http');
const winston = require('winston');

// ---- Winston Logger ----
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

// ---- Env / Port ----
const PORT = process.env.PORT ? Number(process.env.PORT) : 8880;

// ---- App ----
const app = express();

// ---- Middleware ----
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'", "https:", "data:"],
      "object-src": ["'none'"],
      "script-src": ["'self'"],
      "frame-ancestors": ["'self'"],
      "base-uri": ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: "same-origin" }
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Request ID
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});

// Structured logs (Pino)
app.use(pinoHttp({
  customProps: (req, res) => ({ reqid: req.id })
}));

// Controlled CORS
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "").split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, cb) {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true
}));

// Rate limiter
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', publicLimiter);

// ---- Static / Media ----
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(process.cwd(), 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
app.use('/media', express.static(MEDIA_DIR, { fallthrough: true, maxAge: '1h' }));

// ---- Health ----
app.get(['/','/health'], (req, res) => {
  res.json({ status: 'UP', service: 'Server Alex', version: '2.5.2' });
});

// ---- Swagger Docs ----
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// ---- Knowledgebase Loader ----
function parseCSV(content) {
  const lines = content.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(',');
  return lines.map(line => {
    const cols = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i+1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        cols.push(cur); cur = '';
      } else cur += ch;
    }
    cols.push(cur);
    const obj = {};
    header.forEach((h, idx) => obj[h.trim()] = (cols[idx]||'').trim());
    return obj;
  });
}

const KB_PATH = process.env.KNOWLEDGE_CSV || path.join(process.cwd(), "PRODUCT_KNOWLEDGEBASE(1).csv");
let KNOWLEDGE = [];
let SKU_MAP = new Map();

function preloadKnowledge() {
  try {
    if (!fs.existsSync(KB_PATH)) {
      console.warn(`[kb] CSV not found at ${KB_PATH}. Skipping preload.`);
      KNOWLEDGE = [];
      SKU_MAP = new Map();
      return;
    }
    const csv = fs.readFileSync(KB_PATH, 'utf8');
    KNOWLEDGE = parseCSV(csv);
    SKU_MAP = new Map();
    for (const row of KNOWLEDGE) {
      const name = (row['Name'] || row['ProductName'] || '').toLowerCase().trim();
      const sku = (row['SKU'] || row['Sku'] || row['Code'] || '').trim();
      if (name && sku) SKU_MAP.set(name, sku);
    }
    console.log(`[kb] Loaded ${KNOWLEDGE.length} items. SKU_MAP entries: ${SKU_MAP.size}`);
  } catch (err) {
    console.error('[kb] preload error', err);
  }
}
preloadKnowledge();

app.post('/api/knowledge/reload', (req, res) => {
  preloadKnowledge();
  res.json({ ok: true, size: KNOWLEDGE.length, skus: SKU_MAP.size });
});

// ---- AI Bridge ----
const alex = {
  async query(payload) {
    const { text, context = {}, customer = {} } = payload || {};
    if (!text || typeof text !== 'string') return { error: 'text is required' };

    const GUARDRAILS = [
      'Never say or imply a money-back guarantee.',
      'Build value for 6–10 minutes before pricing.',
      'Ask 4–10 health questions, cover all reported issues.',
      'Use strict step-down: 6-Month -> 3-Month -> Monthly.',
      'Never verbalize cues like (pause).',
      'Always close with shipping 5–7 days + hotline.',
      'No shipping fees or taxes ever.'
    ];

    return {
      ok: true,
      reply: "Stubbed Alex response (model call not wired in this example).",
      guardrails: GUARDRAILS,
      contextEcho: { context, customer }
    };
  },

  async logCallEvent(event) {
    const required = ['sw_call_id', 'caller', 'callee', 'outcome'];
    for (const k of required) {
      if (!event || typeof event[k] !== 'string' || !event[k].length) {
        return { error: `Missing field: ${k}` };
      }
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    fs.appendFileSync(path.join(process.cwd(), 'logs', 'call_events.log'), line, { encoding: 'utf8' });
    return { ok: true };
  }
};

app.post('/api/ai/query', async (req, res, next) => {
  try {
    const result = await alex.query(req.body);
    res.json(result);
  } catch (e) { next(e); }
});

app.post('/api/ai/call-events', async (req, res, next) => {
  try {
    const resp = await alex.logCallEvent(req.body);
    res.json(resp);
  } catch (e) { next(e); }
});

// ---- Error Handling ----
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

app.use((err, req, res, next) => {
  logger.error({ message: err.message, stack: err.stack, reqid: req.id });
  const status = err.status || 500;
  res.status(status).json({
    error: true,
    status,
    message: err.message,
    reqid: req.id
  });
});

// ---- Boot ----
fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });
app.listen(PORT, "0.0.0.0", () => {
  console.log(`App running on port ${PORT}`);
});
