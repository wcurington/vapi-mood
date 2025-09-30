/**
 * Health America Backend — server_v2.5.3.js
 * Adds Postgres integration for call logs
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
const db = require('./db'); // <— Postgres

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

const PORT = process.env.PORT ? Number(process.env.PORT) : 8880;
const app = express();

// ---- Middleware ----
app.disable('x-powered-by');
app.use(helmet());
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
app.use(pinoHttp({ customProps: (req, res) => ({ reqid: req.id }) }));

// CORS
app.use(cors({ origin: '*', credentials: true }));

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 60 * 1000, limit: 120 }));

// ---- Health ----
app.get(['/','/health'], (req, res) => {
  res.json({ status: 'UP', service: 'Server Alex', version: '2.5.3' });
});

// ---- Swagger ----
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// ---- AI Bridge ----
const alex = {
  async query(payload) {
    const { text } = payload || {};
    if (!text) return { error: 'text is required' };
    return { ok: true, reply: "Stubbed Alex response", guardrails: ["value-first", "no guarantees"] };
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
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
      fs.appendFileSync(path.join(process.cwd(), 'logs', 'call_events.log'), line, { encoding: 'utf8' });
      return { ok: true, persisted: 'file' };
    }
  }
};

// ---- Routes ----
app.post('/api/ai/query', async (req, res, next) => {
  try {
    res.json(await alex.query(req.body));
  } catch (e) { next(e); }
});

app.post('/api/ai/call-events', async (req, res, next) => {
  try {
    res.json(await alex.logCallEvent(req.body));
  } catch (e) { next(e); }
});

// ---- Error Handling ----
app.use((req, res, next) => {
  const err = new Error('Not Found'); err.status = 404; next(err);
});
app.use((err, req, res, next) => {
  logger.error({ message: err.message, stack: err.stack, reqid: req.id });
  res.status(err.status || 500).json({ error: true, message: err.message, reqid: req.id });
});

// ---- Boot ----
fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });
app.listen(PORT, "0.0.0.0", () => console.log(`App running on port ${PORT}`));
