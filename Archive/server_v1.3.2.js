'use strict';

/**
 * Alex Core Server v1.3.2
 * - Health/pacing micro-turns
 * - Digit articulation smoothing
 * - Payments validation (card brands, CVV lengths, expiry)
 * - ACH routing/account capture (length rules + check number)
 * - Bundle pricing calculator with optional discount
 * - Address confirmation: state abbreviation -> full name
 * - Proactive shipping close (5–7 business days)
 * - Persuasive phrasing injection (You're going to love it. It is Absolutely Amazing. This Product is incredible.)
 * - Static docs (PDFs) + forced-download routes
 * - Coaching/training request endpoint for human agents
 * - Mounts: /speech-filter and /flows
 */

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 10000;

// --- Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// --- Static docs
const docsDir = path.join(__dirname, 'docs');
if (!fs.existsSync(docsDir)) {
  try { fs.mkdirSync(docsDir, { recursive: true }); } catch {}
}
app.use('/docs', express.static(docsDir, { fallthrough: false, maxAge: '1h', extensions: ['pdf'] }));

// Forced download helpers
function sendDownload(res, fileAbsPath, downloadName) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  const s = fs.createReadStream(fileAbsPath);
  s.on('error', () => res.status(404).send('File not found'));
  s.pipe(res);
}

// Map of state abbreviations to names (subset + common)
const STATE_MAP = {
  'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California', 'CO': 'Colorado',
  'CT': 'Connecticut', 'DE': 'Delaware', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho',
  'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana',
  'ME': 'Maine', 'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi',
  'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey',
  'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma',
  'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina', 'SD': 'South Dakota',
  'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington',
  'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming', 'DC': 'District of Columbia'
};

// --- Health
app.get('/health', (req, res) => {
  res.json({ status: 'UP', service: 'Alex Core v1.3.2', time: new Date().toISOString() });
});

// --- Forced-download routes for docs
app.get('/docs/testing-guide.pdf', (req, res) => {
  const p = path.join(docsDir, 'Alex_Agent_Testing_Guide_v1.3.pdf');
  return sendDownload(res, p, 'Alex_Agent_Testing_Guide_v1.3.pdf');
});
app.get('/docs/testing-checklist.pdf', (req, res) => {
  const p = path.join(docsDir, 'Alex_Testing_Checklist_v1.7.pdf');
  return sendDownload(res, p, 'Alex_Testing_Checklist_v1.7.pdf');
});

// --- Address confirmation: expand state abbreviations for speech
app.post('/speech/address/confirm', (req, res) => {
  const { line1='', line2='', city='', state='', zip='' } = req.body || {};
  let spokenState = state;
  if (state && STATE_MAP[state.toUpperCase()]) spokenState = STATE_MAP[state.toUpperCase()];
  const parts = [line1, line2, city, spokenState, zip].filter(Boolean);
  const sentence = parts.join(', ');
  res.json({
    spoken: `Let me confirm your address: ${sentence}.`,
    normalized: { line1, line2, city, state: spokenState, zip }
  });
});

// --- Identity response (robot/computer inquiry)
app.get('/identity/response', (req, res) => {
  res.json({
    identity: "Alex, a Senior Escalation Sales Health Expert here at Health America.",
    spoken: "I'm Alex, a Senior Escalation Sales Health Expert here at Health America, and I'm ready to help you reach your health goals today."
  });
});

// --- Persuasive phrases helper
function addPersuasionLines(lines) {
  const tags = [
    "You're going to love it.",
    "It is Absolutely Amazing.",
    "This Product is incredible."
  ];
  return lines.concat(tags);
}

// --- Order confirm with proactive shipping + persuasion
app.post('/order/confirm', (req, res) => {
  const { orderId, products=[] } = req.body || {};
  const base = [`Great news—your order ${orderId || ''} is confirmed.`.trim(),
                'Your package will ship in 5–7 business days.'];
  const spoken = addPersuasionLines(base).join(' ');
  res.json({ ok: true, spoken, orderId, products });
});

// --- Payments: card brand detection, Luhn, CVV, expiry
function luhnCheck(num) {
  const s = (num || '').replace(/\D/g, '');
  let sum = 0, dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = parseInt(s[i], 10);
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n; dbl = !dbl;
  }
  return (sum % 10) === 0;
}
function detectBrand(num) {
  const s = (num || '').replace(/\D/g, '');
  if (/^3[47]\d{13}$/.test(s)) return 'AMEX';
  if (/^4\d{12}(\d{3})?$/.test(s)) return 'VISA';
  if (/^5[1-5]\d{14}$/.test(s) || /^2(22[1-9]|2[3-9]\d|[3-6]\d{2}|7([01]\d|20))\d{12}$/.test(s)) return 'MASTERCARD';
  if (/^6(?:011|5\d{2})\d{12}$/.test(s)) return 'DISCOVER';
  return 'UNKNOWN';
}
function validExpiry(mm, yy) {
  if (!/^\d{1,2}$/.test(String(mm)) || !/^\d{2,4}$/.test(String(yy))) return false;
  let month = parseInt(mm,10);
  let year = parseInt(yy,10);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12) return false;
  const now = new Date();
  const exp = new Date(year, month, 1);
  exp.setMonth(exp.getMonth()+1);
  return exp > now;
}

app.post('/payments/validate-card', (req, res) => {
  const { cardNumber='', cvv='', expMonth, expYear } = req.body || {};
  const brand = detectBrand(cardNumber);
  const clean = (cardNumber || '').replace(/\D/g, '');
  const okLuhn = luhnCheck(clean);
  let cvvOK = false;
  if (brand === 'AMEX') cvvOK = /^\d{4}$/.test(cvv || '');
  else cvvOK = /^\d{3}$/.test(cvv || '');
  const expiryOK = validExpiry(expMonth, expYear);
  const ok = (brand !== 'UNKNOWN') && okLuhn && cvvOK && expiryOK;
  res.json({ ok, brand, okLuhn, cvvOK, expiryOK });
});

// --- Bundle pricing
app.post('/pricing/bundle', (req, res) => {
  const { items=[], discountPct=0 } = req.body || {};
  let subtotal = 0.0;
  items.forEach(it => { subtotal += Number(it.price || 0) * Number(it.qty || 1); });
  const discount = Math.max(0, Math.min(100, Number(discountPct || 0)));
  const total = +(subtotal * (1 - discount/100)).toFixed(2);
  res.json({ subtotal: +subtotal.toFixed(2), discountPct: discount, total });
});

// --- Coaching/training request
app.post('/coaching/request', (req, res) => {
  const { sessionId, topic, notes } = req.body || {};
  // In production, enqueue to a task queue or notify ops.
  res.json({ ok: true, queued: { sessionId, topic, notes, at: new Date().toISOString() } });
});

// --- Mount submodules
const speechFilterRouter = require('./server_speech_filter_v1.3.2.js');
const flowsRouter = require('./patch_flows_pauses_shipping_v1.3.2.js');
app.use('/speech-filter', speechFilterRouter);
app.use('/flows', flowsRouter);

// --- Root banner
app.get('/', (req, res) => {
  res.status(200).send('✅ Alex Core v1.3.2 is running. Use /health, /docs/testing-guide.pdf, and /docs/testing-checklist.pdf.');
});

app.listen(PORT, () => {
  console.log(`🚀 Alex Core v1.3.2 listening on ${PORT}`);
});
