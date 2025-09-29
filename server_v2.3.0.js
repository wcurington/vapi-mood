//
// server_v2.3.0.js
// Health America Backend – Flow-Heavy Edition
//
// Key upgrades vs 2.2.0:
//  - Robust flow mounting for very large flow sets (40k+ stages)
//  - Supports both a single JSON file (flows_alex_sales.json) and a /flows directory of JSON files
//  - Fast in-RAM indices: id -> stage and keyword -> set(ids)
//  - New endpoints for flow QA: /flow/info, /flow/:id, /flow/random, /flow/search, /flows/reload
//  - Smarter knowledgebase loader: accepts a CSV file OR a directory; auto-detects PRODUCT_KNOWLEDGEBASE* files
//  - Preserves all existing endpoints and hard rules (guarantee verbatim, discount gating)
//  - Production middleware: helmet, compression, CORS, logging
//
// Env:
//  PORT (default 8880)
//  MEDIA_DIR (default ./media)
//  KNOWLEDGEBASE_PATH (file OR directory; default autodetect)
//  FLOWS_PATH (single JSON file; default ./flows_alex_sales.json)
//  FLOWS_DIR (directory of JSON flow files; default ./flows)
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

// Optional: versioned integrations (preferred) with fallback
let integrations = null;
try {
  integrations = require('./versionLoader').loadLatestVersion('integrations');
} catch (e) {
  console.warn('[server] versionLoader not used for integrations:', e.message);
  try {
    integrations = require('./integrations_v1.7.0.js');
  } catch (err2) {
    try {
      integrations = require('./integrations_v1.6.0.js');
    } catch (err3) {
      console.warn('[server] integrations module not found; continuing with null adapters.');
      integrations = null;
    }
  }
}

// ---------------------- Config ----------------------
const VERSION = '2.3.0';
const PORT = Number(process.env.PORT || 8880);
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');

// KB can be a path to a CSV OR a directory containing CSV(s)
const KB_PATH = process.env.KNOWLEDGEBASE_PATH || autoDetectKBPath();

// Flows: file AND/OR directory
const FLOWS_PATH = process.env.FLOWS_PATH || path.join(__dirname, 'flows_alex_sales.json');
const FLOWS_DIR  = process.env.FLOWS_DIR  || path.join(__dirname, 'flows');

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

// USD formatting
function formatDollarsCents(amount) {
  const num = Number(amount || 0);
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// ---------------------- Knowledgebase ----------------------

let KB = [];
let KBIndex = new Map(); // term -> Set(rowIndex)

function autoDetectKBPath() {
  // Prefer explicit PRODUCT_KNOWLEDGEBASE files; fallback to any .csv in root
  const rootFiles = fs.readdirSync(__dirname);
  // First, exact match that many setups use
  const preferred = rootFiles.find(f => /^PRODUCT_KNOWLEDGEBASE.*\.csv$/i.test(f));
  if (preferred) return path.join(__dirname, preferred);
  // If there's a directory named PRODUCT_KNOWLEDGEBASE(1), accept it as folder
  if (rootFiles.includes('PRODUCT_KNOWLEDGEBASE(1)')) {
    return path.join(__dirname, 'PRODUCT_KNOWLEDGEBASE(1)');
  }
  // Otherwise, pick first CSV in root
  const anyCsv = rootFiles.find(f => /\.csv$/i.test(f));
  return anyCsv ? path.join(__dirname, anyCsv) : path.join(__dirname, 'PRODUCT_KNOWLEDGEBASE(1).csv');
}

function loadKnowledgebase() {
  KB = [];
  KBIndex = new Map();

  try {
    if (!fs.existsSync(KB_PATH)) {
      console.warn(`[KB] Path not found at ${KB_PATH}.`);
      return;
    }

    let csvFiles = [];
    const stats = fs.statSync(KB_PATH);
    if (stats.isDirectory()) {
      csvFiles = fs.readdirSync(KB_PATH).filter(f => /\.csv$/i.test(f)).map(f => path.join(KB_PATH, f));
    } else {
      csvFiles = [KB_PATH];
    }

    let totalRows = 0;
    for (const file of csvFiles) {
      const raw = fs.readFileSync(file, 'utf8');
      const records = parse(raw, { columns: true, skip_empty_lines: true });
      const baseIdx = KB.length;
      records.forEach((row, i) => KB.push({ __idx: baseIdx + i, __file: path.basename(file), ...row }));
      totalRows += records.length;
    }

    // Build a lightweight keyword index (across all columns)
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
    console.log(`[KB] Loaded ${totalRows} rows from ${csvFiles.length} file(s).`);
  } catch (e) {
    console.error('[KB] Failed to load KB:', e.message);
  }
}

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

// ---------------------- Massive Flow Mounting ----------------------

let FlowMeta = {
  sources: [],       // [{type:'file'|'dir', path, count, version? }]
  count: 0
};
let FlowIndex = new Map();   // id -> stage
let FlowTokens = new Map();  // token -> Set(id)
let FlowIds = [];            // array of ids for random
let FlowVersion = null;

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function addStageToIndex(stage) {
  if (!stage || !stage.id) return;
  const id = String(stage.id);
  // Avoid overwriting identical ids from later files
  if (!FlowIndex.has(id)) {
    FlowIndex.set(id, stage);
    FlowIds.push(id);
    // Index text content for search
    const blob = [stage.prompt, stage.text, stage.title, stage.note].filter(Boolean).join(' ');
    const terms = tokenize(blob);
    const seen = new Set();
    for (const t of terms) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (!FlowTokens.has(t)) FlowTokens.set(t, new Set());
      FlowTokens.get(t).add(id);
    }
  }
}

function loadFlowFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const stages = Array.isArray(data) ? data : Array.isArray(data.stages) ? data.stages : [];
    stages.forEach(addStageToIndex);
    const v = data.version || null;
    if (v && !FlowVersion) FlowVersion = v;
    FlowMeta.sources.push({ type: 'file', path: filePath, count: stages.length, version: v });
  } catch (e) {
    console.error('[flow] Failed to load', filePath, e.message);
  }
}

function loadFlows() {
  FlowMeta = { sources: [], count: 0 };
  FlowIndex = new Map();
  FlowTokens = new Map();
  FlowIds = [];
  FlowVersion = null;

  // Single file (optional)
  if (fs.existsSync(FLOWS_PATH)) {
    loadFlowFile(FLOWS_PATH);
  } else {
    console.warn(`[flow] Flow file not found at ${FLOWS_PATH}.`);
  }

  // Directory of JSON flow files (optional)
  if (fs.existsSync(FLOWS_DIR) && fs.statSync(FLOWS_DIR).isDirectory()) {
    const files = fs.readdirSync(FLOWS_DIR).filter(f => /\.json$/i.test(f));
    for (const f of files) loadFlowFile(path.join(FLOWS_DIR, f));
  }

  FlowMeta.count = FlowIndex.size;
  console.log(`[flow] Mounted ${FlowMeta.count} stages from ${FlowMeta.sources.length} source(s).`);

  // Wire adapters into integrations (if available)
  if (integrations && typeof integrations.setFlowAdapters === 'function') {
    integrations.setFlowAdapters({
      getById: (id) => FlowIndex.get(String(id)) || null,
      search: (q, limit = 10) => flowSearch(q, limit),
      random: () => {
        if (!FlowIds.length) return null;
        const id = FlowIds[Math.floor(Math.random() * FlowIds.length)];
        return FlowIndex.get(id);
      }
    });
  }
}

function flowSearch(query, limit = 10) {
  if (!query) return [];
  const terms = tokenize(query);
  const score = new Map(); // id -> score
  for (const t of terms) {
    const set = FlowTokens.get(t);
    if (!set) continue;
    for (const id of set) score.set(id, (score.get(id) || 0) + 1);
  }
  return [...score.entries()].sort((a,b)=>b[1]-a[1]).slice(0, limit).map(([id, s]) => ({ score: s, stage: FlowIndex.get(id) }));
}

// Initial loads
loadKnowledgebase();
loadFlows();

// ---------------------- Call Session State ----------------------
const calls = new Map();
const AGENTS = ['alex_sales', 'alex_service']; // both mount same flow index; logic can diverge later

function getOrCreateCall(callId) {
  if (!callId) throw new Error('callId required');
  if (!calls.has(callId)) {
    const stageByAgent = {};
    for (const agent of AGENTS) stageByAgent[agent] = FlowIds[0] || null;
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
    flowLoaded: FlowMeta.count > 0,
    flowCount: FlowMeta.count,
    kbLoaded: KB.length > 0,
    kbRows: KB.length
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
  const results = kbSearch(q, Math.min(Number(limit || 8), 100));
  res.json({ query: q || '', count: results.length, results });
});

// Reload knowledgebase
app.post('/kb/reload', (req, res) => {
  loadKnowledgebase();
  res.json({ ok: true, loaded: KB.length });
});

// ----- Flow QA & Access -----
app.get('/flow/info', (req, res) => {
  res.json({
    version: FlowVersion,
    mounted: FlowMeta.count,
    sources: FlowMeta.sources
  });
});

app.get('/flow/:id', (req, res) => {
  const s = FlowIndex.get(String(req.params.id));
  if (!s) return res.status(404).json({ error: 'stage not found' });
  res.json(s);
});

app.get('/flow/random', (req, res) => {
  if (!FlowIds.length) return res.status(404).json({ error: 'no stages loaded' });
  const id = FlowIds[Math.floor(Math.random() * FlowIds.length)];
  res.json(FlowIndex.get(id));
});

app.get('/flow/search', (req, res) => {
  const { q, limit } = req.query;
  const results = flowSearch(q, Math.min(Number(limit || 10), 100));
  res.json({ query: q || '', count: results.length, results });
});

app.post('/flows/reload', (req, res) => {
  loadFlows();
  res.json({ ok: true, mounted: FlowMeta.count });
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
  console.log(`KB Path: ${KB_PATH}`);
  console.log(`Flow path: ${FLOWS_PATH}`);
  console.log(`Flow dir: ${FLOWS_DIR}`);
});
