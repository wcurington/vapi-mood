/**
 * server_v1.2.0.js — Alex XXL Core Server
 * Version: 1.2.0
 * Purpose: Serves the Vapi webhook, mounts health endpoints, static docs,
 * integrates speech filter and flow manager, and embeds business-rule fixes:
 *   - Health Q&A pacing with natural pauses
 *   - State name expansion (no abbreviations like "LA")
 *   - Prevent verbalization of internal tokens (e.g., "Silent 4 S Pause")
 *   - Number-string clarity for phone/zip/routing/account sequences
 *   - Payment validation (Visa/MC/Discover/AMEX lengths, CVV rules, expiry)
 *   - Bank routing (9) & account number (7–12) validation
 *   - Proactive shipping disclosure (5–7 business days) after order
 *   - Hang-up guard: no premature terminate unless explicit
 *   - Multi-product pricing: sum SKU prices + optional bundle discounts
 *   - Version banner & /version endpoint
 */

'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cors = require('cors');
const morgan = require('morgan');
const crypto = require('crypto');

const { 
  sanitizeTTS,
  redactInternalTokens,
  normalizeNumberSequence,
  expandStateName,
  isLikelyInternalToken
} = require('./server_speech_filter_v1.2.0.js');

const {
  initFlowEngine,
  healthQuestionPacingPolicy,
  computeOfferFromSKUs,
  validatePaymentEnvelope,
  enforceShippingDisclosure,
  hangupGuard,
  state
} = require('./patch_flows_pauses_shipping_v1.2.0.js');

const VERSION = '1.2.0';
const START_TS = new Date().toISOString();
const app = express();

// ───────────────────────────────────────────────────────────────────────────────
// Middleware
// ───────────────────────────────────────────────────────────────────────────────
app.set('trust proxy', true);
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true }));

// Structured access logs
morgan.token('reqId', (req) => req.id || '-');
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
  next();
});
app.use(morgan(':method :url :status :res[content-length] - :response-time ms reqId=:reqId'));

// Basic rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 120 req/min per IP
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// ───────────────────────────────────────────────────────────────────────────────
// Static docs (serve exactly as requested; individual downloads preferred)
// ───────────────────────────────────────────────────────────────────────────────
const docsDir = path.join(process.cwd(), 'docs');
if (!fs.existsSync(docsDir)) {
  fs.mkdirSync(docsDir, { recursive: true });
}
app.use('/docs', express.static(docsDir, {
  fallthrough: false,
  dotfiles: 'ignore',
  etag: true,
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    // Force download behavior for PDFs/DOCX per preference
    const basename = path.basename(filePath);
    if (/\.(pdf|docx?)$/i.test(basename)) {
      res.setHeader('Content-Disposition', `attachment; filename="${basename}"`);
    }
  }
}));

// Dedicated aliases requested earlier
app.get('/docs/testing-guide.docx', (req, res) => {
  const p = path.join(docsDir, 'Alex_Agent_Testing_Guide_v1.1.docx');
  fs.access(p, fs.constants.R_OK, err => {
    if (err) return res.status(404).send('Guide not found.');
    res.download(p, 'Alex_Agent_Testing_Guide_v1.1.docx');
  });
});
app.get('/docs/testing-guide.pdf', (req, res) => {
  const p = path.join(docsDir, 'Alex_Agent_Testing_Guide_v1.1.pdf');
  fs.access(p, fs.constants.R_OK, err => {
    if (err) return res.status(404).send('Guide not found.');
    res.download(p, 'Alex_Agent_Testing_Guide_v1.1.pdf');
  });
});
app.get('/docs/testing-checklist.pdf', (req, res) => {
  const p = path.join(docsDir, 'Alex_Testing_Checklist_v1.5.pdf');
  fs.access(p, fs.constants.R_OK, err => {
    if (err) return res.status(404).send('Checklist not found.');
    res.download(p, 'Alex_Testing_Checklist_v1.5.pdf');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Version & health
// ───────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.type('text/plain').send('✅ Alex XXL Core is live. See /health, /version, /docs');
});

app.get('/version', (req, res) => {
  res.json({
    component: 'alex-core',
    version: VERSION,
    started: START_TS
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    time: new Date().toISOString(),
    version: VERSION,
    flowEngine: state.flowEngineReady === true,
    policies: {
      healthPacing: true,
      shippingDisclosure: true,
      paymentValidation: true,
      hangupGuard: true
    }
  });
});

app.get('/speech-filter/health', (req, res) => {
  res.json({ status: 'UP', module: 'speech-filter', version: VERSION });
});
app.get('/flows/health', (req, res) => {
  res.json({ status: 'UP', module: 'flows-manager', version: VERSION, engineReady: state.flowEngineReady === true });
});

// ───────────────────────────────────────────────────────────────────────────────
// Webhook endpoints (examples): replace with actual Vapi integration easily
// ───────────────────────────────────────────────────────────────────────────────

// Simulate ingestion of a user utterance and produce a response with filters
app.post('/vapi-webhook/ingest', (req, res) => {
  const { text, context = {} } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing text' });
  }

  // Prevent internal tokens from leaking
  if (isLikelyInternalToken(text)) {
    return res.json({ text: '', meta: { filtered: true, reason: 'internal-token' } });
  }

  // Expand state abbreviations and normalize number sequences for clarity
  let safe = redactInternalTokens(text);
  safe = expandStateName(safe);
  safe = normalizeNumberSequence(safe);
  safe = sanitizeTTS(safe);

  return res.json({ text: safe, context });
});

// Example: compute an offer from provided SKUs and duration
app.post('/vapi-webhook/offer', (req, res) => {
  const { skus = [], months = 6 } = req.body || {};
  try {
    const offer = computeOfferFromSKUs(skus, months);
    return res.json({ ok: true, offer });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// Example: validate payment payload
app.post('/vapi-webhook/payment/validate', (req, res) => {
  try {
    const envelope = validatePaymentEnvelope(req.body || {});
    return res.json({ ok: true, envelope });
  } catch (err) {
    return res.status(422).json({ ok: false, error: err.message });
  }
});

// Example: close an order and ensure shipping disclosure is appended
app.post('/vapi-webhook/order/close', (req, res) => {
  const { confirmationText = '' } = req.body || {};
  const out = enforceShippingDisclosure(confirmationText);
  return res.json({ ok: true, confirmationText: out });
});

// Example: keep-alive / no premature end
app.post('/vapi-webhook/signal', (req, res) => {
  const { event = '' } = req.body || {};
  const action = hangupGuard(event);
  return res.json({ ok: true, action });
});

// ───────────────────────────────────────────────────────────────────────────────
// Startup
// ───────────────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);

initFlowEngine().then(() => {
  state.flowEngineReady = true;
}).catch(() => {
  state.flowEngineReady = false;
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`🚀 Alex XXL Core v${VERSION} listening on :${PORT}`);
});
