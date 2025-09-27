
/**
 * server_speech_filter.js — XXL Edition (speech/output sanitization + health pacing)
 * ----------------------------------------------------------------------------
 * PURPOSE
 *   Centralized speech post-processing and guardrails:
 *   - Strip any internal stage directions so they never get spoken
 *   - Expand state abbreviations in addresses to full state names ("LA" -> "Louisiana")
 *   - Expand currency to clear words ("$199.99" -> "199 dollars and 99 cents")
 *   - Normalize casual affirmations to yes/no/other
 *   - Apply adaptive pacing meta for health questions to avoid rapid-fire delivery
 *   - Expose a small Express router for /speech-filter/* diagnostics & utilities
 *
 * DESIGN NOTES
 *   - Zero external dependencies (safe for Render)
 *   - Pure functions + a factory for an Express router (lazy require)
 *   - This module does not mutate input; always returns new strings/objects
 *
 * INTEGRATION HINTS
 *   In server.js ensure you:
 *     const speechFilter = require('./server_speech_filter');
 *     app.use('/speech-filter', speechFilter.router());
 *   and call sanitizeOutput(...) before emitting TTS, plus expandStatesInline(...) for address readbacks.
 *
 * GUARANTEES
 *   - Never lets literals like "Silent 4 S Pause", "(pause)", "(processing...)", etc. leak to the user
 *   - Expands 50-state USPS abbreviations + DC & territories
 *   - Keeps output conservative and human-friendly
 */
const STATE_MAP = Object.freeze({
  "AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas","CA":"California","CO":"Colorado","CT":"Connecticut",
  "DE":"Delaware","FL":"Florida","GA":"Georgia","HI":"Hawaii","ID":"Idaho","IL":"Illinois","IN":"Indiana",
  "IA":"Iowa","KS":"Kansas","KY":"Kentucky","LA":"Louisiana","ME":"Maine","MD":"Maryland","MA":"Massachusetts",
  "MI":"Michigan","MN":"Minnesota","MS":"Mississippi","MO":"Missouri","MT":"Montana","NE":"Nebraska","NV":"Nevada",
  "NH":"New Hampshire","NJ":"New Jersey","NM":"New Mexico","NY":"New York","NC":"North Carolina","ND":"North Dakota",
  "OH":"Ohio","OK":"Oklahoma","OR":"Oregon","PA":"Pennsylvania","RI":"Rhode Island","SC":"South Carolina",
  "SD":"South Dakota","TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont","VA":"Virginia","WA":"Washington",
  "WV":"West Virginia","WI":"Wisconsin","WY":"Wyoming",
  "DC":"District of Columbia","PR":"Puerto Rico","VI":"U.S. Virgin Islands","GU":"Guam","AS":"American Samoa","MP":"Northern Mariana Islands"
});
const INTERNAL_CUE_REGEX = new RegExp([
  String.raw`\(\s*pause\s*\)`,
  String.raw`\(\s*processing.*?\)`,
  String.raw`\[\s*stage\s*directions\s*\]`,
  String.raw`(?<!\S)silent\s*\d+\s*s?\s*pause(?!\S)`,
  String.raw`(?<!\S)long\s*pause(?!\S)`,
  String.raw`(?<!\S)agent\s*waits?(?:\s*about)?\s*\d+\s*ms(?!\S)`,
  String.raw`(?<!\S)\*?asides?\*?(?!\S)`
].join('|'), 'ig');
const MONEY_REGEX = /\$ ?(\d{1,3}(?:,\d{3})*)(?:\.(\d{1,2}))?/g;
const YES_WORDS = /\b(yes|yep|yeah|yup|sure|ok|okay|affirmative|please do|go ahead|sounds good)\b/i;
const NO_WORDS  = /\b(no|nope|nah|negative|not now|maybe later|don(?:'|’)t|do not|stop)\b/i;
const DEFAULT_HEALTH_MIN_PAUSE_MS = 2600;
function sanitizeOutput(text = "") {
  let s = String(text);
  s = s.replace(INTERNAL_CUE_REGEX, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}
function numberToEnglishCurrency(totalCents) {
  const n = Math.max(0, Number.isFinite(totalCents) ? totalCents : 0);
  const dollars = Math.floor(n/100);
  const cents = n % 100;
  const centsPart = cents === 0 ? '' : ` and ${cents} ${cents === 1 ? 'cent' : 'cents'}`;
  return `${dollars} dollars${centsPart}`;
}
function slowDownMoney(text = "") {
  return String(text).replace(MONEY_REGEX, (_, dStr, cStr) => {
    const dollars = parseInt(dStr.replace(/,/g, ''), 10) || 0;
    const cents = cStr ? parseInt(cStr.padEnd(2,'0'), 10) : 0;
    const total = dollars * 100 + cents;
    return numberToEnglishCurrency(total);
  });
}
function expandStateName(abbrev = "") {
  const key = String(abbrev).replace(/[^A-Za-z]/g, '').toUpperCase();
  return STATE_MAP[key] || abbrev;
}
function expandStatesInline(text = "") {
  let s = String(text);
  s = s.replace(/,\s*([A-Za-z]{2})(?=\s*\d{5}(?:-\d{4})?$)/g, (_, abbr) => `, ${expandStateName(abbr)}`);
  s = s.replace(/\b([A-Za-z]{2})\b/g, (m, abbr) => {
    const full = expandStateName(abbr);
    return STATE_MAP[abbr.toUpperCase()] ? full : m;
  });
  return s;
}
function normalizeAffirmation(text = "") {
  const t = String(text).trim();
  if (YES_WORDS.test(t)) return 'yes';
  if (NO_WORDS.test(t)) return 'no';
  return 'other';
}
function applyHealthPacing(text = "", opts = {}) {
  const minPauseMs = Math.max(1200, Number(opts.minPauseMs || DEFAULT_HEALTH_MIN_PAUSE_MS));
  return { text: sanitizeOutput(text), meta: { minPauseMs } };
}
function safeUtterance(text = "", { addressMode = false } = {}) {
  let s = sanitizeOutput(text);
  s = slowDownMoney(s);
  if (addressMode) s = expandStatesInline(s);
  return s;
}
function router() {
  const express = require('express');
  const r = express.Router();
  r.get('/health', (req, res) => {
    res.json({ status: 'UP', module: 'server_speech_filter', ts: new Date().toISOString() });
  });
  r.post('/sanitize', (req, res) => {
    try { const { text } = req.body || {}; return res.json({ out: sanitizeOutput(text || '') }); }
    catch { return res.status(400).json({ error: 'bad_input' }); }
  });
  r.post('/expand-states', (req, res) => {
    try { const { text } = req.body || {}; return res.json({ out: expandStatesInline(text || '') }); }
    catch { return res.status(400).json({ error: 'bad_input' }); }
  });
  r.post('/affirm', (req, res) => {
    try { const { text } = req.body || {}; return res.json({ class: normalizeAffirmation(text || '') }); }
    catch { return res.status(400).json({ error: 'bad_input' }); }
  });
  r.post('/pace/health', (req, res) => {
    try { const { text, minPauseMs } = req.body || {}; return res.json(applyHealthPacing(text || '', { minPauseMs })); }
    catch { return res.status(400).json({ error: 'bad_input' }); }
  });
  return r;
}
module.exports = {
  sanitizeOutput,
  numberToEnglishCurrency,
  slowDownMoney,
  expandStateName,
  expandStatesInline,
  normalizeAffirmation,
  applyHealthPacing,
  safeUtterance,
  router
};
/* Long-form runbooks omitted here for brevity in code block generation. */
