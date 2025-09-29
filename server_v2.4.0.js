//
// server_v2.4.0.js
// Health America Backend — flow-heavy, production-hardened
//
// Major upgrades vs 2.3.x:
//  - Default port 8882 to avoid CRM/aaPanel collisions
//  - Hardened error handling + structured logging + graceful shutdown
//  - Hot reload endpoint (/reload) for flows + KB without container restart
//  - Flow mounting from single file (flows_alex_sales.json) and/or /flows directory
//  - Searchable in-RAM indices for 40k+ flow stages (token index)
//  - Smarter KB auto-detect (file or directory; multiple CSVs supported)
//  - Guarantee verbatim endpoint; discount gating preserved (senior/veteran/2x haggle)
//  - Clean CORS + helmet CSP + compression + morgan logging
//
// Env (optional):
//  PORT                 default 8882
//  MEDIA_DIR            default ./media
//  KNOWLEDGEBASE_PATH   file OR directory (auto-detect fallback)
//  FLOWS_PATH           single JSON flow file (default ./flows_alex_sales.json)
//  FLOWS_DIR            directory of JSON flow files (default ./flows)
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

// Local policy/modules
const { healthAmericaGuarantee } = require('./guarantees');
const DiscountRules = require('./discountRules');

// Optional: versioned integrations with fallback
let integrations = null;
try {
  integrations = require('./versionLoader').loadLatestVersion('integrations');
} catch (e) {
  console.warn('[server] versionLoader unavailable for integrations:', e.message);
  try { integrations = require('./integrations_v1.8.0.js'); }
  catch {
    try { integrations = require('./integrations_v1.7.0.js'); }
    catch { console.warn('[server] integrations module not found; continuing without adapters'); }
  }
}

// ---------------- Config ----------------
const VERSION   = '2.4.0';
const PORT      = Number(process.env.PORT || 8882);
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');

const KB_PATH   = process.env.KNOWLEDGEBASE_PATH || autoDetectKBPath();
const FLOWS_PATH= process.env.FLOWS_PATH || path.join(__dirname, 'flows_alex_sales.json');
const FLOWS_DIR = process.env.FLOWS_DIR  || path.join(__dirname, 'flows');

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------- App ----------------
const app = express();
app.set('trust proxy', true);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "img-src": ["'self'", "data:"],
      "media-src": ["'self'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Structured logging
morgan.token('time', () => new Date().toISOString());
morgan.token('remote', (req) => req.ip);
app.use(morgan('[:time] :remote :method :url :status :res[content-length] - :response-time ms'));

// Static media
app.use('/media', express.static(MEDIA_DIR, { fallthrough: true, index: false }));

// ---------------- Utilities ----------------
const STATE_MAP = {
  'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California','CO':'Colorado','CT':'Connecticut',
  'DE':'Delaware','FL':'Florida','GA':'Georgia','HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa',
  'KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland','MA':'Massachusetts','MI':'Michigan',
  'MN':'Minnesota','MS':'Mississippi','MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire',
  'NJ':'New Jersey','NM':'New Mexico','NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio','OK':'Oklahoma',
  'OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina','SD':'South Dakota','TN':'Tennessee',
  'TX':'Texas','UT':'Utah','VT':'Vermont','VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming',
  'DC':'District of Columbia'
};
const expandState = (s) => {
  if (!s) return '';
  const u = String(s).trim().toUpperCase();
  if (STATE_MAP[u]) return STATE_MAP[u];
  const m = Object.values(STATE_MAP).find(n => n.toLowerCase() === String(s).trim().toLowerCase());
  return m || s;
};
const readDigitsClearly = (s) => (String(s||'').replace(/\D/g,'').split('').join(' '));
const formatUSD = (cents) => (Number(cents||0)/100).toLocaleString('en-US',{style:'currency',currency:'USD'});

// ---------------- Knowledgebase ----------------
let KB = [];
let KBIndex = new Map(); // token -> Set(rowIndex)

function autoDetectKBPath() {
  const root = fs.readdirSync(__dirname);
  const prefer = root.find(f => /^PRODUCT_KNOWLEDGEBASE.*\.csv$/i.test(f));
  if (prefer) return path.join(__dirname, prefer);
  if (root.includes('PRODUCT_KNOWLEDGEBASE(1)')) return path.join(__dirname, 'PRODUCT_KNOWLEDGEBASE(1)');
  const anyCsv = root.find(f => /\.csv$/i.test(f));
  return anyCsv ? path.join(__dirname, anyCsv) : path.join(__dirname, 'PRODUCT_KNOWLEDGEBASE(1).csv');
}
function tokenize(text) { return String(text||'').toLowerCase().match(/[a-z0-9]+/g) || []; }

function loadKnowledgebase() {
  KB = []; KBIndex = new Map();
  try {
    if (!fs.existsSync(KB_PATH)) { console.warn(`[KB] path not found: ${KB_PATH}`); return; }
    const stats = fs.statSync(KB_PATH);
    const files = stats.isDirectory()
      ? fs.readdirSync(KB_PATH).filter(f => /\.csv$/i.test(f)).map(f => path.join(KB_PATH,f))
      : [KB_PATH];

    let total = 0;
    for (const file of files) {
      const raw = fs.readFileSync(file,'utf8');
      const rows = parse(raw,{columns:true, skip_empty_lines:true});
      const base = KB.length;
      rows.forEach((r,i)=> KB.push({__idx: base+i, __file: path.basename(file), ...r}));
      total += rows.length;
    }

    for (const row of KB) {
      const blob = Object.values(row).join(' ').toLowerCase();
      const terms = tokenize(blob);
      const seen = new Set();
      for (const t of terms) {
        if (seen.has(t)) continue;
        seen.add(t);
        if (!KBIndex.has(t)) KBIndex.set(t, new Set());
        KBIndex.get(t).add(row.__idx);
      }
    }
    console.log(`[KB] Loaded ${total} rows from ${files.length} file(s).`);
  } catch (e) {
    console.error('[KB] load error:', e.message);
  }
}
function kbSearch(q, limit=8) {
  const terms = tokenize(q);
  const score = new Map();
  for (const t of terms) {
    const set = KBIndex.get(t); if (!set) continue;
    for (const idx of set) score.set(idx, (score.get(idx)||0)+1);
  }
  return [...score.entries()].sort((a,b)=>b[1]-a[1]).slice(0, Math.min(Number(limit||8),100))
    .map(([idx,s])=>({score:s, row:KB[idx]}));
}

// ---------------- Flows (big) ----------------
let FlowMeta = { sources:[], count:0, version:null };
let FlowIndex = new Map();     // id -> stage
let FlowTokens = new Map();    // token -> Set(id)
let FlowIds = [];

function addStage(stage) {
  if (!stage || !stage.id) return;
  const id = String(stage.id);
  if (FlowIndex.has(id)) return; // keep first, ignore duplicates
  FlowIndex.set(id, stage);
  FlowIds.push(id);

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
function loadFlowFile(fp) {
  try {
    const raw = fs.readFileSync(fp,'utf8');
    const data = JSON.parse(raw);
    const stages = Array.isArray(data) ? data : Array.isArray(data.stages) ? data.stages : [];
    stages.forEach(addStage);
    const v = data.version || null;
    if (v && !FlowMeta.version) FlowMeta.version = v;
    FlowMeta.sources.push({ type:'file', path: fp, count: stages.length, version:v });
  } catch (e) {
    console.error('[flow] load error for', fp, e.message);
  }
}
function loadFlows() {
  FlowMeta = { sources:[], count:0, version:null };
  FlowIndex = new Map(); FlowTokens = new Map(); FlowIds = [];
  if (fs.existsSync(FLOWS_PATH)) loadFlowFile(FLOWS_PATH);
  if (fs.existsSync(FLOWS_DIR) && fs.statSync(FLOWS_DIR).isDirectory()) {
    for (const f of fs.readdirSync(FLOWS_DIR).filter(f=>/\.json$/i.test(f))) loadFlowFile(path.join(FLOWS_DIR,f));
  }
  FlowMeta.count = FlowIndex.size;
  console.log(`[flow] Mounted ${FlowMeta.count} stages from ${FlowMeta.sources.length} source(s).`);

  // wire adapters into integrations
  if (integrations && typeof integrations.setFlowAdapters === 'function') {
    integrations.setFlowAdapters({
      getById: (id) => FlowIndex.get(String(id)) || null,
      search: (q, limit=10) => flowSearch(q, limit),
      random: () => FlowIds.length ? FlowIndex.get(FlowIds[Math.floor(Math.random()*FlowIds.length)]) : null
    });
  }
}
function flowSearch(q, limit=10) {
  const terms = tokenize(q);
  const score = new Map(); // id -> score
  for (const t of terms) {
    const set = FlowTokens.get(t); if (!set) continue;
    for (const id of set) score.set(id, (score.get(id)||0)+1);
  }
  return [...score.entries()].sort((a,b)=>b[1]-a[1]).slice(0, Math.min(Number(limit||10),100))
    .map(([id,s])=>({score:s, stage:FlowIndex.get(id)}));
}

// initial loads
loadKnowledgebase();
loadFlows();

// ---------------- Call sessions + discount gating ----------------
const calls = new Map();
const AGENTS = ['alex_sales','alex_service'];

function getOrCreateCall(callId) {
  if (!callId) throw new Error('callId required');
  if (!calls.has(callId)) {
    const stageByAgent = {}; for (const a of AGENTS) stageByAgent[a] = FlowIds[0]||null;
    calls.set(callId,{
      createdAt: Date.now(),
      rules: new DiscountRules(), // senior, veteran, price objections
      flags: { senior:false, veteran:false },
      objections: 0,
      meta: {},
      stageByAgent
    });
  }
  return calls.get(callId);
}

// ---------------- Routes ----------------

// health
app.get(['/','/health'], (req,res)=> {
  res.json({
    status:'UP', service:'Health America Backend',
    version: VERSION, time: new Date().toISOString(), hostname: os.hostname(),
    flowLoaded: FlowMeta.count>0, flowCount: FlowMeta.count,
    kbLoaded: KB.length>0, kbRows: KB.length
  });
});

// guarantee (verbatim only)
app.get('/guarantee', (req,res)=> { res.type('text/plain').send(healthAmericaGuarantee); });

// utils
app.get('/expand-state', (req,res)=> { const {s} = req.query; res.json({ input:s||'', full: expandState(s) }); });
app.get('/read-digits', (req,res)=> { const {s} = req.query; res.json({ input:s||'', spoken: readDigitsClearly(s) }); });

// KB
app.get('/kb/search', (req,res)=> {
  const { q, limit } = req.query;
  const results = kbSearch(q, limit?Number(limit):8);
  res.json({ query: q||'', count: results.length, results });
});

// Flow QA
app.get('/flow/info', (req,res)=> { res.json({ version: FlowMeta.version, mounted: FlowMeta.count, sources: FlowMeta.sources }); });
app.get('/flow/:id', (req,res)=> {
  const st = FlowIndex.get(String(req.params.id));
  if (!st) return res.status(404).json({ error:'stage not found' });
  res.json(st);
});
app.get('/flow/random', (req,res)=> {
  if (!FlowIds.length) return res.status(404).json({ error:'no stages loaded' });
  res.json(FlowIndex.get(FlowIds[Math.floor(Math.random()*FlowIds.length)]));
});
app.get('/flow/search', (req,res)=> {
  const { q, limit } = req.query;
  const results = flowSearch(q, limit?Number(limit):10);
  res.json({ query: q||'', count: results.length, results });
});

// Hot reload (flows + KB)
app.post('/reload', (req,res)=> {
  loadKnowledgebase();
  loadFlows();
  res.json({ ok:true, kbRows: KB.length, flowCount: FlowMeta.count });
});

// Call lifecycle + discount gating
app.post('/call/start', (req,res)=> {
  const { callId, caller, callee } = req.body||{};
  if (!callId) return res.status(400).json({ error:'callId required' });
  const c = getOrCreateCall(callId);
  c.meta.caller = caller||null; c.meta.callee = callee||'alex_sales';
  res.json({ ok:true, call:{ callId, createdAt:c.createdAt } });
});
app.post('/call/flag', (req,res)=> {
  const { callId, senior, veteran } = req.body||{};
  if (!callId) return res.status(400).json({ error:'callId required' });
  const c = getOrCreateCall(callId);
  if (typeof senior==='boolean') { c.flags.senior=senior; if (senior) c.rules.registerSenior(); }
  if (typeof veteran==='boolean'){ c.flags.veteran=veteran; if (veteran) c.rules.registerVeteran(); }
  res.json({ ok:true, flags:c.flags });
});
app.post('/call/price-objection', (req,res)=> {
  const { callId } = req.body||{};
  if (!callId) return res.status(400).json({ error:'callId required' });
  const c = getOrCreateCall(callId);
  c.objections += 1; c.rules.registerPriceObjection();
  res.json({ ok:true, objections:c.objections });
});
app.get('/call/can-offer', (req,res)=> {
  const { callId } = req.query||{};
  if (!callId) return res.status(400).json({ error:'callId required' });
  const c = getOrCreateCall(callId);
  const allowed = c.rules.canOfferDiscount();
  res.json({ callId, allowed, reason: allowed?'qualified':'not_yet' });
});
app.get('/call/maybe-offer', (req,res)=> {
  const { callId } = req.query||{};
  if (!callId) return res.status(400).json({ error:'callId required' });
  const c = getOrCreateCall(callId);
  const allowed = c.rules.canOfferDiscount();
  const message = allowed
    ? 'Since you qualify, I can include up to 15% off or a bonus gift today.'
    : 'I understand the concern. Let me highlight the value you’re getting and why this program is right for you.';
  res.json({ callId, allowed, message });
});

// Media upload
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, MEDIA_DIR),
  filename: (_, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({ storage });
app.post('/media/upload', upload.single('file'), (req,res)=> {
  if (!req.file) return res.status(400).json({ error:'file required' });
  res.json({ ok:true, path:`/media/${req.file.filename}` });
});

// Quote helper
app.post('/quote/stepdown', (req,res)=> {
  const { callId, tier } = req.body||{};
  if (!callId) return res.status(400).json({ error:'callId required' });
  const TIERS = {
    '6m': { label: '6-Month Rejuvenation Program', total: 29900 },
    '3m': { label: '3-Month Supply',            total: 19900 },
    'mo': { label: 'Monthly Membership',        total:  7900 }
  };
  const chosen = TIERS[tier] || TIERS['6m'];
  res.json({ callId, tier: chosen.label, price: formatUSD(chosen.total) });
});

// 404 + error
app.use((_,res)=> res.status(404).json({ error:'Not Found' }));
app.use((err,req,res,_)=> {
  console.error('[ERROR]', err);
  res.status(500).json({ error:'Internal Server Error' });
});

// Start
const server = app.listen(PORT, ()=> {
  console.log(`Health America backend v${VERSION} on :${PORT}`);
  console.log(`Media dir: ${MEDIA_DIR}`);
  console.log(`KB Path: ${KB_PATH}`);
  console.log(`Flow path: ${FLOWS_PATH}`);
  console.log(`Flow dir: ${FLOWS_DIR}`);
});

// Graceful shutdown
function shutdown(sig) {
  console.log(`[${new Date().toISOString()}] ${sig} received, shutting down...`);
  server.close(()=> {
    console.log('HTTP server closed. Bye.');
    process.exit(0);
  });
  setTimeout(()=> process.exit(1), 8000).unref();
}
process.on('SIGTERM', ()=>shutdown('SIGTERM'));
process.on('SIGINT',  ()=>shutdown('SIGINT'));
