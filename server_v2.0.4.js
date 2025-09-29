'use strict';
/**
 * server_v2.0.4.js (Server Alex Ultimate Powerhouse)
 *
 * - HTTPS endpoint behind Caddy
 * - Auto-integrates with latest integrations via versionLoader
 * - Loads sales flows (JSON) and Alex persona prompt (Markdown)
 * - ElevenLabs media served via /media
 * - Guardrails: helmet, compression, rate-limit, trust proxy (safe)
 * - SignalWire inbound handler returns LaML (answers calls)
 * - Deep logging for diagnostics
 */

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { loadLatestVersion } = require('./versionLoader');

dotenv.config();

const VERSION = '2.0.4';
const app = express();
app.set('trust proxy', 1); // safe: trust first proxy (Caddy)

// --- Security & logging ---
app.use(helmet());
app.use(compression());
app.use(morgan('combined'));
app.use(rateLimit({ windowMs: 60 * 1000, max: 500 }));

// --- Body parsing ---
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false, verify: (req, _res, buf) => { req.rawBody = buf; } }));

// --- Root route ---
app.get('/', (req, res) => {
  res.json({ status: 'UP', service: 'Server Alex', version: VERSION });
});

// --- Healthcheck ---
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'Server Alex',
    version: VERSION,
    time: new Date().toISOString(),
  });
});

// --- Static media ---
const MEDIA_DIR = path.join(process.cwd(), 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
app.use('/media', express.static(MEDIA_DIR, { setHeaders: (res) => res.setHeader('Content-Type', 'audio/mpeg') }));

// --- Load integrations ---
const integrations = loadLatestVersion('integrations');

// --- Load sales flows ---
let salesFlows;
try {
  salesFlows = loadLatestVersion('flows');
  console.log(`[server_v${VERSION}] Loaded sales flows with ${Object.keys(salesFlows).length} sections`);
} catch (e) {
  console.warn(`[server_v${VERSION}] No flows file found, continuing without flows`);
  salesFlows = {};
}

// --- Load Alex prompt ---
let alexPrompt = '';
try {
  alexPrompt = fs.readFileSync(path.resolve(process.cwd(), 'alex_prompt.md'), 'utf-8');
  console.log(`[server_v${VERSION}] Loaded alex_prompt.md (${alexPrompt.length} chars)`);
} catch (e) {
  console.warn(`[server_v${VERSION}] No alex_prompt.md found`);
}

// --- Inbound webhook for SignalWire ---
app.post('/events/signalwire', async (req, res) => {
  try {
    await integrations.handleInboundVoice(req, res, req.rawBody, salesFlows, alexPrompt);
  } catch (e) {
    console.error('Inbound handler error:', e);
    res.set('Content-Type', 'text/xml; charset=utf-8')
       .status(200)
       .send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, something went wrong. Please call again.</Say></Response>`);
  }
});

// --- Outbound test helper ---
app.get('/laml/test', (req, res) => {
  res.set('Content-Type', 'text/xml; charset=utf-8')
     .status(200)
     .send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello, this is Alex calling with a test message.</Say>
</Response>`);
});

// --- Start server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server Alex v${VERSION} listening on ${PORT}`);
  console.log(`   Media served from ${process.env.PUBLIC_BASE_URL || 'MISSING_BASEURL'}/media`);
});
