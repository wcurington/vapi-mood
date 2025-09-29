//
// server_v2.2.0.js
// Health America Backend – Meaty Edition
// Ports: defaults to 8880 per Caddy upstream rule.
//
// Features
//  - Express server with secure & perf middleware
//  - In-memory sessions per call (discount rules, flags, objections, meta)
//  - Verbatim Guarantee endpoint (no paraphrasing)
//  - Conditional discount enforcement (senior OR veteran OR >=2 price objections)
//  - State name expander & long-number reader utilities
//  - Knowledgebase preload (CSV) into RAM with keyword index + reload endpoint
//  - Flow PRELOAD at boot + “mount both Alex’s” via multi-agent flow endpoints
//  - Flow runner per callId with start / prompt / next endpoints
//  - Health checks, metrics, static media hosting & upload
//  - Stubs for integrations (vtiger/shipping/payment) are externalized via integrations module
//
// Env:
//  PORT (default 8880)
//  MEDIA_DIR (default ./media)
//  KNOWLEDGEBASE_CSV (default ./PRODUCT_KNOWLEDGEBASE(1).csv)
//  FLOWS_PATH (default ./flows_alex_sales.json)
//
// Requires local modules in the same directory:
//  - guarantees.js                  (verbatim guarantee string)
//  - discountRules.js               (eligibility gating for discounts/gifts)
//  - versionLoader.js + version.json (optional if you want to require versioned modules)
//
// npm i express helmet compression morgan cors csv-parse multer
//
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cors = require('cors');
const multer = require('multer');
const { parse } = require('csv-parse/sync');

// Local policy modules
const { healthAmericaGuarantee } = require('./guarantees');
const DiscountRules = require('./discountRules');

// Optional: versioned integrations (if you’re using versionLoader)
let integrations = null;
try {
  integrations = require('./versionLoader').loadLatestVersion('integrations');
} catch (e) {
  console.warn('[server] versionLoader not used for integrations:', e.message);
  try {
    integrations = require('./integrations_v1.6.0.js');
  } catch (err2) {
    console.warn('[server] fallback integrations module not found; continuing without it.');
  }
}

// ---------------------- Config ----------------------
const VERSION = '2.2.0';
const PORT = Number(process.env.PORT || 8880);
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');
const KB_CSV = process.env.KNOWLEDGEBASE_CSV || path.join(__dirname, 'PRODUCT_KNOWLEDGEBASE(1).csv');
const FLOWS_PATH = process.env.FLOWS_PATH || path.join(__dirname, 'flows_alex_sales.json');

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------------- App ----------------------
const app = express();

// Security & perf
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "img-src": ["'self'", "data:"],
      "media-src": ["'self'"],
    }
  }
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

// Static media
app.use('/media', express.static(MEDIA_DIR, { fallthrough: true, index: false }));

// ---------------------- Utilities ----------------------

// Full state names (US)
const STATE_MAP = {
  'AL': 'Alabama','AK': 'Alaska','AZ': 'Arizona','AR': 'Arkansas','CA': 'California','CO': 'Colorado','CT': 'Connecticut',
  'DE': 'Delaware','FL': 'Florida','GA': 'Georgia','HI': 'Hawaii','ID': 'Idaho','IL': 'Illinois','IN': 'Indiana','IA': 'Iowa',
  'KS': 'Kansas','KY': 'Kentucky','LA': 'Louisiana','ME': 'Maine','MD': 'Maryland','MA': 'Massachusetts','MI': 'Michigan',
  'MN': 'Minnesota','MS': 'Mississippi','MO': 'Missouri','MT': 'Montana','NE': 'Nebraska','NV': 'Nevada','NH': 'New Hampshire',
  'NJ': 'New Jersey','NM': 'New Mexico','NY': 'New York','NC': 'North Carolina','ND': 'North Dakota','OH': 'Ohio','OK': 'Oklahoma',
  'OR': 'Oregon','PA': 'Pennsylvania','RI': 'Rhode Island','SC': 'South Carolina','SD': 'South Dakota','TN': 'Tennessee',
  'TX': 'Texas','UT': 'Utah','VT': 'Vermont','VA': 'Virginia','WA': 'Washington','WV': 'West Virginia','WI': 'Wisconsin','WY': 'Wyoming',
  'DC': 'District of Columbia'
};

function expandState(input) {
  if (!input) return '';
  const s = String(input).trim();
  const upper = s.toUpperCase();
  if (STATE_MAP[upper]) return STATE_MAP[upper];
  const match = Object.values(STATE_MAP).find(n => n.toLowerCase() === s.toLowerCase());
  return match || s;
}

// Convert long digit strings into spaced-out reading (for TTS)
function readDigitsClearly(s) {
  if (s == null) return '';
  const digits = String(s).replace(/\D/g, '');
  return digits.split('').join(' ');
}

// Basic numeric formatting for dollars and cents
function formatDollarsCents(amount) {
  const num = Number(amount || 0);
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// ---------------------- Knowledgebase ----------------------

let KB = [];
let KBIndex = new Map(); // term -> Set(rowIndex)

function loadKnowledgebase() {
  KB = [];
  KBIndex = new Map();
  if (!fs.existsSync(KB_CSV)) {
    console.warn(`[KB] CSV not found at ${KB_CSV}. Server will run without KB.`);
    return;
  }
  try {
    const raw = fs.readFileSync(KB_CSV, 'utf8');
    const records = parse(raw, { columns: true, skip_empty_lines: true });
    KB = records.map((row, idx) => ({ __idx: idx, ...row }));
    for (const row of KB) {
      const blob = Object.values(row).join(' ').toLowerCase();
      const terms = blob.match(/[a-z0-9]+/g) || [];
      const seen = new Set();
      for (const t of terms) {
        if (seen.has(t)) continue;
        seen.add(t);
        if (!KBIndex.has(t)) KBIndex.set(t, new Set());
        KBIndex.get(t).add(row.__idx);
      }
    }
    console.log(`[KB] Loaded ${KB.length} rows from CSV.`);
  } catch (e) {
    console.error('[KB] Failed to parse CSV:', e.message);
  }
}

loadKnowledgebase();

function kbSearch(query, limit = 8) {
  if (!query) return [];
  const terms = String(query).toLowerCase().match(/[a-z0-9]+/g) || [];
  const score = new Map();
  for (const t of terms) {
    const set = KBIndex.get(t);
    if (!set) continue;
    for (const idx of set) score.set(idx, (score.get(idx) || 0) + 1);
  }
  const ranked = [...score.entries()].sort((a,b) => b[1]-a[1]).slice(0, limit).map(([idx, s]) => ({ score: s, row: KB[idx] }));
  return ranked;
}

// ---------------------- Flow Engine (Preload & Per-Call Runner) ----------------------

let Flow = null;
try {
  if (!fs.existsSync(FLOWS_PATH)) {
    console.warn(`[flow] Flow file not found at ${FLOWS_PATH}.`);
  } else {
    Flow = JSON.parse(fs.readFileSync(FLOWS_PATH, 'utf8'));
    console.log(`[flow] Preloaded flow v${Flow.version} with ${Array.isArray(Flow.stages)?Flow.stages.length:0} stages.`);
  }
} catch (e) {
  console.error('[flow] Failed to preload flow:', e.message);
  Flow = null;
}

function getStageById(id) {
  if (!Flow || !Array.isArray(Flow.stages)) return null;
  return Flow.stages.find(s => s.id === id) || null;
}

// ---------------------- Call Session State ----------------------

/**
 * Simple in-memory call store keyed by callId.
 * Each session holds a DiscountRules instance, flags, objections, meta,
 * and current flow stage for each agent.
 */
const calls = new Map();
const AGENTS = ['alex_sales', 'alex_service']; // "mount both Alex’s"

function getOrCreateCall(callId) {
  if (!callId) throw new Error('callId required');
  if (!calls.has(callId)) {
    const stageByAgent = {};
    for (const agent of AGENTS) stageByAgent[agent] = Flow && Flow.stages ? Flow.stages[0]?.id || null : null;
    calls.set(callId, {
      createdAt: Date.now(),
      rules: new DiscountRules(),
      flags: { senior: false, veteran: false },
      objections: 0,
      meta: {},
      stageByAgent
    });
  }
  return calls.get(callId);
}

// ---------------------- Routes ----------------------

// Health
app.get(['/','/health'], (req, res) => {
  res.status(200).json({
    status: 'UP',
    service: 'Health America Backend',
    version: VERSION,
    time: new Date().toISOString(),
    hostname: os.hostname(),
    flowLoaded: !!Flow
  });
});

// Guarantee (verbatim only)
app.get('/guarantee', (req, res) => {
  res.type('text/plain').send(healthAmericaGuarantee);
});

// State name expander
app.get('/expand-state', (req, res) => {
  const { s } = req.query;
  return res.json({ input: s || '', full: expandState(s) });
});

// Digit reader
app.get('/read-digits', (req, res) => {
  const { s } = req.query;
  return res.json({ input: s || '', spoken: readDigitsClearly(s) });
});

// Knowledgebase search
app.get('/kb/search', (req, res) => {
  const { q, limit } = req.query;
  const results = kbSearch(q, Math.min(Number(limit || 8), 50));
  res.json({ query: q || '', count: results.length, results });
});

// Reload knowledgebase (local admin)
app.post('/kb/reload', (req, res) => {
  loadKnowledgebase();
  res.json({ ok: true, loaded: KB.length });
});

// ----- Call lifecycle & discount logic -----

// Start/log a call
app.post('/call/start', (req, res) => {
  const { callId, caller, callee } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  const c = getOrCreateCall(callId);
  c.meta.caller = caller || null;
  c.meta.callee = callee || 'alex_sales';
  return res.json({ ok: true, call: { callId, createdAt: c.createdAt } });
});

// Set flags
app.post('/call/flag', (req, res) => {
  const { callId, senior, veteran } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  const c = getOrCreateCall(callId);
  if (typeof senior === 'boolean') {
    c.flags.senior = senior;
    if (senior) c.rules.registerSenior();
  }
  if (typeof veteran === 'boolean') {
    c.flags.veteran = veteran;
    if (veteran) c.rules.registerVeteran();
  }
  return res.json({ ok: true, flags: c.flags });
});

// Price objection
app.post('/call/price-objection', (req, res) => {
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  const c = getOrCreateCall(callId);
  c.objections += 1;
  c.rules.registerPriceObjection();
  return res.json({ ok: true, objections: c.objections });
});

// Can we offer discount/gift?
app.get('/call/can-offer', (req, res) => {
  const { callId } = req.query || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  const c = getOrCreateCall(callId);
  const allowed = c.rules.canOfferDiscount();
  return res.json({ callId, allowed, reason: allowed ? 'qualified' : 'not_yet' });
});

// Decide discount/gift message without violating rules
app.get('/call/maybe-offer', (req, res) => {
  const { callId } = req.query || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  const c = getOrCreateCall(callId);
  const allowed = c.rules.canOfferDiscount();
  const message = allowed
    ? 'Since you qualify, I can include up to 15% off or a bonus gift today.'
    : 'I understand the concern. Let me highlight the value you are getting and why this program is right for you.';
  return res.json({ callId, allowed, message });
});

// End/reset call session
app.post('/call/reset', (req, res) => {
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  calls.delete(callId);
  return res.json({ ok: true });
});

// ----- Media upload -----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({ storage });

app.post('/media/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  return res.json({ ok: true, path: `/media/${req.file.filename}` });
});

// ----- Quote/step-down helper -----
app.post('/quote/stepdown', (req, res) => {
  const { callId, tier } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  const TIERS = {
    '6m': { label: '6-Month Rejuvenation Program', total: 29900 },
    '3m': { label: '3-Month Supply', total: 19900 },
    'mo': { label: 'Monthly Membership', total: 7900 }
  };
  const chosen = TIERS[tier] || TIERS['6m'];
  const price = formatDollarsCents(chosen.total / 100);
  return res.json({ callId, tier: chosen.label, price });
});

// ---------------------- Multi-Agent Flow Endpoints ----------------------
// Agent IDs supported: alex_sales, alex_service (both mount the same flow file by default)

app.post('/agent/:agentId/flow/start', (req, res) => {
  const { agentId } = req.params;
  const { callId } = req.body || {};
  if (!AGENTS.includes(agentId)) return res.status(400).json({ error: 'unknown agent' });
  if (!callId) return res.status(400).json({ error: 'callId required' });
  if (!Flow || !Flow.stages || !Flow.stages.length) return res.status(500).json({ error: 'flow not loaded' });

  const c = getOrCreateCall(callId);
  c.stageByAgent[agentId] = Flow.stages[0].id;
  return res.json({ ok: true, agentId, callId, stage: c.stageByAgent[agentId], prompt: Flow.stages[0].prompt });
});

app.get('/agent/:agentId/flow/prompt', (req, res) => {
  const { agentId } = req.params;
  const { callId } = req.query || {};
  if (!AGENTS.includes(agentId)) return res.status(400).json({ error: 'unknown agent' });
  if (!callId) return res.status(400).json({ error: 'callId required' });
  const c = getOrCreateCall(callId);
  const curId = c.stageByAgent[agentId];
  const stage = getStageById(curId);
  if (!stage) return res.status(404).json({ error: 'stage not found', id: curId });
  return res.json({ ok: true, agentId, callId, stage: curId, prompt: stage.prompt });
});

app.post('/agent/:agentId/flow/next', (req, res) => {
  const { agentId } = req.params;
  const { callId } = req.body || {};
  if (!AGENTS.includes(agentId)) return res.status(400).json({ error: 'unknown agent' });
  if (!callId) return res.status(400).json({ error: 'callId required' });
  if (!Flow || !Flow.stages) return res.status(500).json({ error: 'flow not loaded' });

  const c = getOrCreateCall(callId);
  const curId = c.stageByAgent[agentId];
  const curStage = getStageById(curId);
  if (!curStage) return res.status(404).json({ error: 'current stage not found', id: curId });

  if (curStage.next === 'end') {
    c.stageByAgent[agentId] = null;
    return res.json({ ok: true, agentId, callId, done: true });
  }

  const nextStage = getStageById(curStage.next);
  if (!nextStage) return res.status(404).json({ error: 'next stage not found', id: curStage.next });
  c.stageByAgent[agentId] = nextStage.id;
  return res.json({ ok: true, agentId, callId, stage: nextStage.id, prompt: nextStage.prompt });
});

// ---------------------- Error Handling ----------------------

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ---------------------- Start ----------------------

app.listen(PORT, () => {
  console.log(`Health America backend v${VERSION} on :${PORT}`);
  console.log(`Media dir: ${MEDIA_DIR}`);
  console.log(`KB CSV: ${KB_CSV}`);
  console.log(`Flow path: ${FLOWS_PATH}`);
});
