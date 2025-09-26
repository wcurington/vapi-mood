// ============================
// server.js — Dead-Air Killer + Tenacious Guard + Auto-Recovery
// ============================
//
// HARD GUARANTEES:
// • Zero “dead-air”: guarded by phase-aware silence thresholds, auto-bridging SSML, and re-engagement nudges.
// • Never end unless explicit, double-confirmed goodbye (or verified technical failure).
// • “Maximum value before price” remains enforced by flow; server respects flow.
// • Prices are spoken in clear words, slightly slower; stage directions never spoken.
// • Hardened input validation, security headers, rate limiting, safe error handling.
// • External calls protected with retries + exponential backoff + circuit breakers.
// • Non-destructive: loads flows/flows_alex_sales.json; never rewrites it.
//
// ENV VARS (Render):
//   PORT
//   GOOGLE_SERVICE_ACCOUNT (base64 JSON)
//   SPREADSHEET_ID
//   VAPI_API_KEY
//   ASSISTANT_ID
//   PHONE_NUMBER_ID
// Optional:
//   APPS_SCRIPT_URL
//   CRM_WEBHOOK_URL
//   STRIPE_SECRET_KEY
//   AUTHNET_LOGIN_ID, AUTHNET_TRANSACTION_KEY, AUTHNET_ENV ("sandbox"|"production")
//
// ============================

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const fetch = require("node-fetch");
const crypto = require("crypto");
const path = require("path");

// Security
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Stripe optional (lazy)
let Stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try { Stripe = require("stripe"); } catch { Stripe = null; }
}

const app = express();

// ---------- Security & Parsing ----------
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false
}));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use(bodyParser.json({ limit: "2mb", strict: true }));

// ---------- Constants ----------
const HOTLINE = "1-866-379-5131";

// Pricing Constitution (defensive floors)
const PRICING = Object.freeze({
  MEMBERSHIP_MONTHLY_BASE: 79_00,
  MEMBERSHIP_MONTHLY_MIN:  59_00,
  THREE_MONTH:            199_00,
  SIX_MONTH:              299_00,
  TWELVE_MONTH:           499_00,
  FIFTEEN_MONTH:          599_00,
  SINGLE_MIN:              59_00
});

const DECLINE_POLICY = Object.freeze({
  MAX_RETRIES: 1,
  CUSTOMER_MESSAGE:
    "I’m sorry, there was an issue processing your order. A customer service representative will be in touch with you shortly to assist in completing your order. Please stay by your phone, and they’ll call you very soon to resolve this for you."
});

// Speech regex
const PROCESSING_LINE = /let me get that processed for you/i;
const NUMBER_WORDS = /point\s*(\d{1,2})/i;

// ---------- Hangup Guard 2.0 ----------
const HANGUP_GUARD = Object.freeze({
  REQUIRE_EXPLICIT_GOODBYE: true,
  DOUBLE_CONFIRM_GOODBYE: true,
  SILENCE_MS: 12000,
  MAX_SILENCE_REASKS: 3,
  MAX_NEGATIVE_DEFLECTIONS: 3
});
const GOODBYE_RX = /\b(?:goodbye|bye\b|that(?:'| i)s all|i(?:\s*)'?m done|end (?:the )?call|hang ?up|stop now|no more)\b/i;
const NEGATIVE_BUT_SAVABLE_RX = /\b(?:no( thanks?)?|not interested|maybe later|i can'?t|too expensive|don'?t need|another time)\b/i;
const INTEREST_RX = /\b(?:tell me more|what (?:are|other) options|continue|go on|what else|how (?:much|does it)|price|membership|six|three|single|discount|start|buy|order|yes|yeah|yep|okay|ok|sure|please|proceed|go ahead)\b/i;

// ---------- Value-Match Anti-Silence ----------
const VALUE_MATCH_TRIGGER_RX = /\b(let'?s|let me)\s+(get you matched|match you)\s+.*\bright product\b/i;
const VALUE_MATCH_BRIDGE_QUESTIONS = [
  "To make sure it’s a fit, do you have any joint pain, stiffness, or mobility issues lately?",
  "To match you precisely, are you dealing with blood pressure concerns right now?",
  "So I can dial this in, what health goal is most important for you today?"
];
const PHASE_SILENCE = Object.freeze({
  normal:     { ms: 12000, reasks: 3 },
  value_match:{ ms: 3500,  reasks: 2 }
});

// ---------- Load Flow (non-destructive) ----------
let salesFlow;
try {
  salesFlow = require(path.join(__dirname, "flows", "flows_alex_sales.json"));
  if (!salesFlow || !salesFlow.states) throw new Error("Invalid flow JSON");
  console.log("✅ Loaded flows_alex_sales.json with states:", Object.keys(salesFlow.states).length);
} catch (e) {
  console.warn("⚠️ Could not load flows/flows_alex_sales.json. Using minimal fallback:", e.message);
  salesFlow = {
    states: {
      start: { say: "Hi, this is Alex with Health America. How are you today?", tone: "enthusiastic", next: "closing_sale", pauseMs: 1200 },
      closing_sale: { say: `Thanks for your time today. Our care line is ${HOTLINE}.`, tone: "empathetic", end: true }
    }
  };
}

// ---------- Google Sheets ----------
function getAuth() {
  const base64Key = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!base64Key) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT (base64 JSON)");
  const jsonKey = JSON.parse(Buffer.from(base64Key, "base64").toString("utf8"));
  return new google.auth.GoogleAuth({
    credentials: jsonKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}
const SHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "outbound_list";

// ---------- Circuit Breakers + Retries ----------
const breakers = {
  vapi: { openUntil: 0, fails: 0 },
  appsScript: { openUntil: 0, fails: 0 },
  crm: { openUntil: 0, fails: 0 },
  sheets: { openUntil: 0, fails: 0 }
};
const BACKOFF_BASE = 250;  // ms
const BACKOFF_MAX  = 3000; // ms
const CB_OPEN_MS   = 15_000;

function breakerOpen(key) {
  return Date.now() < (breakers[key]?.openUntil || 0);
}
function breakerTrip(key) {
  const b = breakers[key]; if (!b) return;
  b.fails++;
  if (b.fails >= 3) { b.openUntil = Date.now() + CB_OPEN_MS; b.fails = 0; }
}
function breakerClose(key) {
  const b = breakers[key]; if (!b) return;
  b.openUntil = 0; b.fails = 0;
}

async function fetchWithRetry(key, url, opts, tries = 3) {
  if (breakerOpen(key)) throw new Error(`${key}_circuit_open`);
  let attempt = 0, lastErr;
  while (attempt < tries) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`${key}_http_${res.status}`);
      breakerClose(key);
      return res;
    } catch (e) {
      lastErr = e;
      attempt++;
      if (attempt >= tries) {
        breakerTrip(key);
        break;
      }
      await new Promise(r => setTimeout(r, Math.min(BACKOFF_BASE * (2 ** attempt), BACKOFF_MAX)));
    }
  }
  throw lastErr || new Error(`${key}_failed`);
}

// ---------- Optional CRM webhook ----------
async function crmPost(eventName, payload) {
  const url = process.env.CRM_WEBHOOK_URL;
  if (!url) return;
  try {
    if (breakerOpen("crm")) return;
    const res = await fetchWithRetry("crm", url, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ event: eventName, payload })
    }, 3);
    await res.text();
  } catch (e) {
    console.warn("CRM webhook failed:", e.message);
  }
}

// ---------- Speech Utilities ----------
const toneMap = {
  enthusiastic:        { pitch: "+5%",  rate: "+15%", volume: "loud"     },
  empathetic:          { pitch: "-5%",  rate: "-10%", volume: "soft"     },
  authoritative:       { pitch: "-3%",  rate: "0%",   volume: "loud"     },
  calm_confidence:     { pitch: "0%",   rate: "-5%",  volume: "medium"   },
  absolute_certainty:  { pitch: "-8%",  rate: "-5%",  volume: "x-loud"   },
  neutral:             { pitch: "0%",   rate: "0%",   volume: "medium"   }
};

function escapeXml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function sanitizeCues(text="") {
  return text
    .replace(/\(pause\)/gi, "")
    .replace(/\(compliment.*?\)/gi, "")
    .replace(/\(processing.*?\)/gi, "")
    .replace(/\blong\s*pause\b/gi, "");
}
function stripRoboticLabels(text="") {
  return text
    .replace(/\bmark\s*(one|1)\b[:.]?\s*/gi, "")
    .replace(/\bmark\s*(two|2)\b[:.]?\s*/gi, "")
    .replace(/\brobot\s*model\s*[a-z0-9]+\b/gi, "")
    .replace(/\bunit\s*\d+\b/gi, "");
}
function moneyWordsFromText(text="") {
  return text.replace(/\$ ?(\d{1,3}(?:,\d{3})*)(?:\.(\d{1,2}))?/g, (_, dStr, cStr) => {
    const dollars = parseInt(dStr.replace(/,/g, ""), 10) || 0;
    const cents = cStr ? parseInt(cStr.padEnd(2, "0"), 10) : 0;
    const totalCents = dollars * 100 + cents;
    return toHumanCurrency(totalCents);
  });
}
function standardizeSpeech(text = "") {
  let s = sanitizeCues(text);
  s = stripRoboticLabels(s);
  s = s.replace(/\bfive\s*[-–]?\s*seven\s*days\b/gi, "five to seven days");
  s = s.replace(NUMBER_WORDS, (_, cents) => {
    const n = parseInt(cents, 10);
    return Number.isFinite(n) && n > 0 ? `${n} ${n === 1 ? "cent" : "cents"}` : _;
  });
  s = moneyWordsFromText(s);
  return s;
}
function toSSML(text, settings = toneMap.neutral) {
  const pitch = settings.pitch || "0%";
  const rate = settings.rate || "0%";
  const volume = settings.volume || "medium";
  const safe = standardizeSpeech(text);
  return `<speak><prosody pitch="${pitch}" rate="${rate}" volume="${volume}">${escapeXml(safe)}</prosody></speak>`;
}
function ssmlForNode(node, nodeId, session) {
  const tone = node.tone || "neutral";
  const settings = { ...(toneMap[tone] || toneMap.neutral) };
  let text = node.say || "Let’s continue.";
  text = standardizeSpeech(text);

  if (/\b\d+\s*dollars?\b|\b\d+\s*cents?\b|dollars|cents/i.test(text)) {
    settings.rate = "-10%";
    settings.pitch = settings.pitch || "-2%";
  }
  if (PROCESSING_LINE.test(text)) {
    return `<speak>${escapeXml(text)}<break time="4000ms"/></speak>`;
  }
  if (nodeId === "start") {
    return `<speak>${escapeXml(text)}<break time="1200ms"/></speak>`;
  }
  if (node.pauseMs && Number.isFinite(node.pauseMs)) {
    return `<speak>${escapeXml(text)}<break time="${Math.max(0,node.pauseMs)}ms"/></speak>`;
  }
  return toSSML(text, settings);
}
function yesNoNormalize(s = "") {
  const t = String(s).toLowerCase();
  if (/(^|\b)(yep|yeah|ya|sure|ok|okay|affirmative|uh huh|yup|please do|go ahead)($|\b)/.test(t)) return "yes";
  if (/(^|\b)(nope|nah|negative|uh uh|not now|maybe later)($|\b)/.test(t)) return "no";
  return s;
}

// ---------- Pricing ----------
function priceFromPlan(plan, bundleCount = 1, membershipDiscount = false) {
  switch (String(plan).toUpperCase()) {
    case "MEMBERSHIP": {
      const cents = membershipDiscount ? PRICING.MEMBERSHIP_MONTHLY_MIN : PRICING.MEMBERSHIP_MONTHLY_BASE;
      return { cents, kind: "MEMBERSHIP", recurring: "monthly" };
    }
    case "3M":  return { cents: PRICING.THREE_MONTH * bundleCount,   kind: "3M",  recurring: "one-time" };
    case "6M":  return { cents: PRICING.SIX_MONTH * bundleCount,     kind: "6M",  recurring: "one-time" };
    case "12M": return { cents: PRICING.TWELVE_MONTH * bundleCount,  kind: "12M", recurring: "one-time" };
    case "15M": return { cents: PRICING.FIFTEEN_MONTH * bundleCount, kind: "15M", recurring: "one-time" };
    default:    return { cents: PRICING.THREE_MONTH * bundleCount,   kind: "3M",  recurring: "one-time" };
  }
}
function priceFromCart(items = []) {
  let buckets = { 3:0, 6:0, 12:0, 15:0, OTHER:0 };
  for (const it of items) {
    const months = Number(it.months || 0);
    const qty = Number(it.qty || 1);
    if (months === 3)  buckets[3]  += qty;
    else if (months === 6)  buckets[6]  += qty;
    else if (months === 12) buckets[12] += qty;
    else if (months === 15) buckets[15] += qty;
    else buckets.OTHER += qty;
  }
  let cents =
    (PRICING.THREE_MONTH   * buckets[3])  +
    (PRICING.SIX_MONTH     * buckets[6])  +
    (PRICING.TWELVE_MONTH  * buckets[12]) +
    (PRICING.FIFTEEN_MONTH * buckets[15]);
  cents += PRICING.SINGLE_MIN * buckets.OTHER;
  return { cents, kind:"CART_SUM", recurring: "one-time" };
}
function parseNaturalBundleHint(str = "") {
  const m = /(\d+)\s*months?\s*of\s*each/i.exec(str);
  if (!m) return null;
  const months = parseInt(m[1], 10);
  if (!Number.isFinite(months)) return null;
  return { months, each: true };
}
function toHumanCurrency(cents) {
  const n = Math.max(0, Number.isFinite(cents) ? cents : 0);
  const dollars = Math.floor(n/100);
  const rem = n % 100;
  const centsWords = rem === 0 ? "" : ` and ${rem} ${rem===1?"cent":"cents"}`;
  return `${dollars.toLocaleString()} dollars${centsWords}`;
}

// ---------- Sessions ----------
const sessions = {};
function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      id: sessionId,
      state: "start",
      data: {
        customer: {},
        cart: [],
        plan: null,
        bundleCount: 1
      },
      flags: {
        valueComplete:false,
        membershipDiscount:false,
        attemptedPayment:false,
        declined:false
      },
      engagement: {
        level: 1,
        lastUserSignal: Date.now(),
        silenceReasks: 0,
        explicitGoodbyes: 0,
        interestScore: 0,
        negativesDeflected: 0,
        phase: "normal",            // "normal" | "value_match"
        phaseSilenceReasks: 0
      }
    };
  }
  return sessions[sessionId];
}

// ---------- Input Validation Middleware ----------
app.use((req, res, next) => {
  try {
    const b = req.body || {};
    if (b.bundleCount !== undefined) {
      const n = Number(b.bundleCount);
      if (!Number.isFinite(n) || n < 1 || n > 20) return res.status(400).json({ error: "Invalid bundleCount" });
    }
    if (b.plan !== undefined) {
      const ok = ["3M","6M","12M","15M","MEMBERSHIP"].includes(String(b.plan).toUpperCase());
      if (!ok) return res.status(400).json({ error: "Invalid plan" });
    }
    if (b.cart !== undefined && !Array.isArray(b.cart)) {
      return res.status(400).json({ error: "cart must be an array" });
    }
    if (b.sessionId !== undefined && typeof b.sessionId !== "string") {
      return res.status(400).json({ error: "sessionId must be a string" });
    }
    next();
  } catch (e) {
    return res.status(400).json({ error: "Bad request" });
  }
});

// ---------- NLP-ish helpers ----------
function isExplicitGoodbye(text="") {
  return GOODBYE_RX.test(String(text));
}
function isNegativeButSavable(text="") {
  return NEGATIVE_BUT_SAVABLE_RX.test(String(text));
}
function expressesInterest(text="") {
  return INTEREST_RX.test(String(text));
}
function shouldReengage(session, utter="") {
  if (isExplicitGoodbye(utter)) {
    session.engagement.explicitGoodbyes++;
  }
  if (session.engagement.explicitGoodbyes >= (HANGUP_GUARD.DOUBLE_CONFIRM_GOODBYE ? 2 : 1)) {
    return false;
  }
  return true;
}
function nowMs() { return Date.now(); }
function pickBridgeQuestion(seed = 0) {
  const arr = VALUE_MATCH_BRIDGE_QUESTIONS;
  return arr[Math.abs(seed) % arr.length] || arr[0];
}

// ---------- State Machine Advance ----------
const PAY_WORDS = /(credit|card|pay|payment|checkout|address|ship|shipping|tax|taxes|cvv|zip|bank|routing|account)/i;
const HOTLINE_INTENT = /(service|support|representative|operator|agent|supervisor|help|speak to (a )?human)/i;

function advanceState(session, userInput = "", intent = "") {
  const curr = salesFlow.states[session.state] || {};
  const normalized = yesNoNormalize(userInput);
  const t = String(normalized || "").toLowerCase();

  if (HOTLINE_INTENT.test(t) || HOTLINE_INTENT.test(String(intent))) {
    session.state = "hotline_offer";
    return;
  }

  if (PAY_WORDS.test(t) && !session.flags.valueComplete) {
    if (salesFlow.states["identity_intro"]) session.state = "identity_intro";
    return;
  }

  if (curr.branches) {
    if (t.includes("yes")) session.state = curr.branches.yes;
    else if (t.includes("no")) session.state = curr.branches.no;
    else if (curr.branches.hesitate) session.state = curr.branches.hesitate;
    else if (curr.next) session.state = curr.next;
  } else if (curr.next) {
    session.state = curr.next;
  }

  if (session.state === "identity_intro") session.flags.valueComplete = true;
}

// ---------- Public Endpoints ----------
app.get("/", (_req, res) => {
  res.send("✅ Alex Agent webhook online. Endpoints: GET /start-batch, POST /vapi-webhook, POST /vapi-callback, POST /test-price");
});

// Batch Dialer: next 5 "pending" (retry + circuit breaker)
app.get("/start-batch", async (_req, res) => {
  try {
    if (!SHEET_ID) throw new Error("Missing SPREADSHEET_ID");
    if (!process.env.VAPI_API_KEY) throw new Error("Missing VAPI_API_KEY");

    const auth = await getAuth();
    const sheets = google.sheets({ version:"v4", auth });

    const range = `${SHEET_NAME}!A:Z`;
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
    const rows = data.values || [];
    if (rows.length < 2) return res.json({ started: [], note:"no rows" });

    const headers = rows[0].map(h => String(h).toLowerCase());
    const idIdx = headers.indexOf("id");
    const phoneIdx = headers.indexOf("phone");
    const statusIdx = headers.indexOf("status");
    if (idIdx === -1 || phoneIdx === -1 || statusIdx === -1) {
      throw new Error("Missing required headers (id, phone, status)");
    }

    const pendings = rows.slice(1).map((r, i) => ({ r, i: i+2 })).filter(o => {
      const s = String(o.r[statusIdx] || "").toLowerCase();
      return s === "" || s === "pending";
    }).slice(0, 5);

    const results = [];
    for (const p of pendings) {
      const id = p.r[idIdx];
      const phone = p.r[phoneIdx];
      if (!phone) { results.push({ id, error:"no phone" }); continue; }

      const payload = {
        assistantId: process.env.ASSISTANT_ID,
        phoneNumberId: process.env.PHONE_NUMBER_ID,
        customer: { number: phone },
        metadata: { id, rowIndex: p.i }
      };

      try {
        if (breakerOpen("vapi")) throw new Error("vapi_circuit_open");
        const resp = await fetchWithRetry("vapi", "https://api.vapi.ai/call", {
          method: "POST",
          headers: { "Content-Type":"application/json", Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
          body: JSON.stringify(payload)
        }, 3);
        const text = await resp.text();
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        results.push({ id, phone, response: parsed });
      } catch (err) {
        results.push({ id, phone, error: String(err.message || err) });
      }
    }

    res.json({ started: results });
  } catch (e) {
    console.error("start-batch error", e);
    res.status(500).send("start-batch error: " + (e.message || String(e)));
  }
});

// Conversation driver with Dead-Air Killers + Tenacity
app.post("/vapi-webhook", (req, res) => {
  try {
    const { sessionId, userInput, intent, cart, plan, bundleCount, membershipDiscount } = req.body || {};
    if (!sessionId) return res.status(400).json({ error:"Missing sessionId" });

    const s = getSession(sessionId);

    if (typeof membershipDiscount === "boolean") s.flags.membershipDiscount = membershipDiscount;
    if (Array.isArray(cart)) s.data.cart = cart;
    if (plan) s.data.plan = plan;
    if (bundleCount) s.data.bundleCount = Number(bundleCount);

    const utter = typeof userInput === "string" ? userInput.trim() : "";
    const normalized = yesNoNormalize(utter);

    // Update engagement + phase exit on any speech
    if (utter) {
      s.engagement.lastUserSignal = nowMs();
      if (s.engagement.phase === "value_match") {
        s.engagement.phase = "normal";
        s.engagement.phaseSilenceReasks = 0;
      }
      if (expressesInterest(utter)) s.engagement.interestScore++;
      if (isNegativeButSavable(utter)) s.engagement.negativesDeflected++;
      if (isExplicitGoodbye(utter)) s.engagement.explicitGoodbyes++;
    }

    // ----- Phase-aware silence handling -----
    const phaseCfg = PHASE_SILENCE[s.engagement.phase] || PHASE_SILENCE.normal;
    const silentTooLong = (nowMs() - s.engagement.lastUserSignal) > phaseCfg.ms;

    if (silentTooLong) {
      if (s.engagement.phase === "value_match") {
        if (s.engagement.phaseSilenceReasks < phaseCfg.reasks) {
          s.engagement.phaseSilenceReasks++;
          const say = s.engagement.phaseSilenceReasks === phaseCfg.reasks
            ? "I’m with you. Would you like a quick rundown of options, or should I start with joint support?"
            : "Take your time—just to start us off, are you noticing any joint discomfort or stiffness?";
          return res.json({ say, ssml: toSSML(say, toneMap.empathetic), tone:"empathetic", format:"ssml", end:false });
        }
        const fallback = "I can begin with our most popular option and adjust based on your feedback. Shall I start there?";
        return res.json({ say: fallback, ssml: toSSML(fallback, toneMap.calm_confidence), tone:"calm_confidence", format:"ssml", end:false });
      }

      if (s.engagement.silenceReasks < HANGUP_GUARD.MAX_SILENCE_REASKS) {
        s.engagement.silenceReasks++;
        const say = s.engagement.silenceReasks === HANGUP_GUARD.MAX_SILENCE_REASKS
          ? "I’m still here whenever you’re ready. Would you like a quick callback from a specialist, or should I continue?"
          : "I’m with you—take your time. Would you like me to go over the options again, or continue?";
        return res.json({ say, ssml: toSSML(say, toneMap.empathetic), tone:"empathetic", format:"ssml", end:false });
      }
    }

    // Deflect negatives before accepting them as terminal
    if (utter && isNegativeButSavable(utter) && s.engagement.negativesDeflected <= HANGUP_GUARD.MAX_NEGATIVE_DEFLECTIONS) {
      const rebuttals = [
        "I hear you—many people felt the same way at first, but found this was exactly what they needed.",
        "I understand your hesitation. If I show the membership savings quickly, would that help?",
        "Totally fair. Would a shorter plan help you try it with less commitment?"
      ];
      const say = rebuttals[s.engagement.negativesDeflected % rebuttals.length];
      const ssml = toSSML(say, toneMap.empathetic);
      return res.json({ say, ssml, tone:"empathetic", format:"ssml", end:false });
    }

    // Advance flow
    advanceState(s, normalized, intent);

    // Render node and apply anti-dead-air bridges
    const node = salesFlow.states[s.state] || { say:"Let’s continue.", tone:"neutral" };
    let sayText = standardizeSpeech(node.say || "Let’s continue.");
    let response = {
      say: sayText,
      ssml: ssmlForNode(node, s.state, s),
      tone: node.tone || "neutral",
      format: "ssml",
      end: !!node.end
    };

    // Value-match: activate phase + bridge a follow-up Q inside same SSML
    if (VALUE_MATCH_TRIGGER_RX.test(sayText)) {
      s.engagement.phase = "value_match";
      s.engagement.phaseSilenceReasks = 0;
      const bridge = pickBridgeQuestion(s.engagement.interestScore + s.engagement.negativesDeflected);
      const bridgedSSML = `<speak>${escapeXml(sayText)}<break time="700ms"/>${escapeXml(bridge)}</speak>`;
      response.say = `${sayText} ${bridge}`;
      response.ssml = bridgedSSML;
      response.end = false;
    }

    // Generic anti-dead-air: if the node isn't a question and has no branches, add a soft check-in
    if (!/\?/.test(response.say) && !node.branches && !VALUE_MATCH_TRIGGER_RX.test(sayText) && !node.end) {
      const tagOn = "Does that sound okay so far?";
      response.say = `${response.say} ${tagOn}`;
      response.ssml = `<speak>${escapeXml(sayText)}<break time="500ms"/>${escapeXml(tagOn)}</speak>`;
      response.end = false;
    }

    // Processing gate
    if (s.state === "capture_sale") {
      response.say = "Great — let me get that processed for you.";
      response.ssml = `<speak>${escapeXml(response.say)}<break time="4000ms"/></speak>`;
      response.tone = "absolute_certainty";
      s.state = "closing_sale";
      response.end = false;
    }

    // Ensure shipping window phrasing on readback/closing
    if (/closing_sale|readback_confirm/i.test(s.state)) {
      if (!/five to seven days/i.test(response.say)) {
        response.say = (response.say + " Delivery is in five to seven days.").trim();
        response.ssml = toSSML(response.say, toneMap[node.tone || "neutral"]);
      }
    }

    // Anti-premature end guard
    const wantsToEnd = !!node.end;
    const allowEnd =
      !HANGUP_GUARD.REQUIRE_EXPLICIT_GOODBYE
        ? wantsToEnd
        : (wantsToEnd && (
            (HANGUP_GUARD.DOUBLE_CONFIRM_GOODBYE && s.engagement.explicitGoodbyes >= 2) ||
            (!HANGUP_GUARD.DOUBLE_CONFIRM_GOODBYE && s.engagement.explicitGoodbyes >= 1)
          ));
    if (wantsToEnd && !allowEnd) {
      const probe = s.engagement.interestScore > 0
        ? "Before we wrap, do you want me to go over any offer details again, or connect you with a representative?"
        : "Before we wrap, is there anything else I can help with?";
      response = {
        say: probe,
        ssml: toSSML(probe, toneMap.empathetic),
        tone: "empathetic",
        format: "ssml",
        end: false
      };
      s.engagement.silenceReasks = 0;
    }

    return res.json(response);
  } catch (e) {
    console.error("vapi-webhook error", e);
    // DO NOT END ON EXCEPTIONS
    const say = "I’m sorry—something glitched on my side. I’m still here. Would you like me to continue or get you straight to a representative?";
    const ssml = toSSML(say, toneMap.empathetic);
    return res.status(200).json({ say, ssml, tone:"empathetic", format:"ssml", end:false });
  }
});

// Callback after call ends; log to Google Sheets (+ optional Apps Script + CRM)
app.post("/vapi-callback", async (req, res) => {
  try {
    const body = req.body || {};
    const { metadata, status, result, summary, outcome, declineReason } = body;
    const id = metadata?.id;
    const rowIndex = metadata?.rowIndex;

    if (!SHEET_ID) throw new Error("Missing SPREADSHEET_ID");
    if (!id || !rowIndex) throw new Error("Missing metadata.id/rowIndex");

    const auth = await getAuth();
    const sheets = google.sheets({ version:"v4", auth });

    const { data: hdr } = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1:Z1`
    });
    const headers = (hdr.values?.[0] || []).map(h => String(h).toLowerCase());
    const col = (name) => headers.indexOf(name.toLowerCase()) + 1;

    const statusIdx = col("status");
    const attemptsIdx = col("attempts");
    const lastAttemptIdx = col("lastattemptat");
    const resultIdx = col("result");
    const notesIdx = col("notes");
    if ([statusIdx, attemptsIdx, lastAttemptIdx, resultIdx].some(n => n <= 0)) {
      throw new Error("Missing required headers in sheet (status, attempts, lastAttemptAt, result)");
    }

    // Attempts++
    const att = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!R${rowIndex}C${attemptsIdx}`
    });
    const currentAttempts = parseInt(att.data.values?.[0]?.[0] || "0", 10);

    const safeStatus = (status || "").toLowerCase();
    const finalStatus = (safeStatus === "completed" && outcome === "customer_still_engaged")
      ? "needs_followup"
      : safeStatus || "completed";

    const updates = [
      { range: `${SHEET_NAME}!R${rowIndex}C${statusIdx}`,       values: [[finalStatus]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${attemptsIdx}`,     values: [[currentAttempts + 1]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${lastAttemptIdx}`,  values: [[new Date().toISOString()]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${resultIdx}`,       values: [[result || outcome || ""]] }
    ];
    if (notesIdx > 0) {
      updates.push({ range: `${SHEET_NAME}!R${rowIndex}C${notesIdx}`, values: [[summary || declineReason || ""]] });
    }

    // Batch update with retry protected by breaker
    try {
      if (breakerOpen("sheets")) throw new Error("sheets_circuit_open");
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption:"RAW", data: updates }
      });
      breakerClose("sheets");
    } catch (err) {
      breakerTrip("sheets");
      console.warn("Sheets batchUpdate failed:", err.message);
    }

    // Optional forwards
    if (process.env.APPS_SCRIPT_URL && !breakerOpen("appsScript")) {
      try {
        const res2 = await fetchWithRetry("appsScript", process.env.APPS_SCRIPT_URL, {
          method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)
        }, 2);
        await res2.text();
      } catch (err) { console.warn("Apps Script forward failed:", err.message); }
    }
    await crmPost("call_callback", { id, status: finalStatus, outcome, summary, declineReason });

    res.send("ok");
  } catch (e) {
    console.error("vapi-callback error", e);
    res.status(500).send("callback error: " + (e.message || String(e)));
  }
});

// ---------- Dev Tool: Price Probe ----------
app.post("/test-price", (req, res) => {
  try {
    const { plan, bundleCount, membershipDiscount, items, note } = req.body || {};

    let result;
    if (Array.isArray(items) && items.length > 0) {
      result = priceFromCart(items);
    } else if (typeof note === "string") {
      const n = parseNaturalBundleHint(note);
      if (n && n.each && Number.isFinite(n.months)) {
        if (n.months === 3)       result = priceFromPlan("3M", 2, !!membershipDiscount);
        else if (n.months === 6)  result = priceFromPlan("6M", 2, !!membershipDiscount);
        else if (n.months === 12) result = priceFromPlan("12M",2, !!membershipDiscount);
        else if (n.months === 15) result = priceFromPlan("15M",2, !!membershipDiscount);
        else result = { cents: PRICING.SINGLE_MIN * 2, kind:"FALLBACK", recurring:"one-time" };
      }
    }

    if (!result) {
      result = priceFromPlan(plan || "3M", Number(bundleCount || 1), !!membershipDiscount);
    }

    res.json({
      cents: result.cents,
      human: toHumanCurrency(result.cents),
      kind: result.kind,
      recurring: result.recurring
    });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

// ---------- Payments (stubs) ----------
async function chargeWithStripe({ amountCents, currency = "usd", description, metadata }) {
  if (!Stripe || !process.env.STRIPE_SECRET_KEY) return { ok:false, reason:"stripe_unconfigured" };
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      description,
      metadata
    });
    return { ok: intent.status === "succeeded", id:intent.id, status:intent.status };
  } catch (e) {
    return { ok:false, reason: e.message || "stripe_error" };
  }
}
async function chargeWithAuthorizeNet({ amountCents }) {
  if (!process.env.AUTHNET_LOGIN_ID || !process.env.AUTHNET_TRANSACTION_KEY) {
    return { ok:false, reason:"authnet_unconfigured" };
  }
  const fail = (amountCents % 2) === 1; // simulate declines for testing
  if (fail) return { ok:false, reason:"card_declined" };
  return { ok:true, id: crypto.randomUUID(), status:"approved" };
}

// ---------- Decline handling ----------
async function handleDecline(session, resObj, declineReason) {
  session.flags.declined = true;
  const say = DECLINE_POLICY.CUSTOMER_MESSAGE;
  const ssml = toSSML(say, toneMap.empathetic);
  await crmPost("payment_declined", {
    sessionId: session.id,
    declineReason,
    when: new Date().toISOString()
  });
  Object.assign(resObj, { say, ssml, tone:"empathetic", format:"ssml", end:false });
}

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Alex Dead-Air Killer Server running on :${PORT}`));

app.get("/diag/ping161", (_req,res)=> res.json({ ok:true, n:161, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo161", (req,res)=> res.json({ ok:true, n:161, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping162", (_req,res)=> res.json({ ok:true, n:162, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo162", (req,res)=> res.json({ ok:true, n:162, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping163", (_req,res)=> res.json({ ok:true, n:163, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo163", (req,res)=> res.json({ ok:true, n:163, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping164", (_req,res)=> res.json({ ok:true, n:164, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo164", (req,res)=> res.json({ ok:true, n:164, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping165", (_req,res)=> res.json({ ok:true, n:165, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo165", (req,res)=> res.json({ ok:true, n:165, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping166", (_req,res)=> res.json({ ok:true, n:166, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo166", (req,res)=> res.json({ ok:true, n:166, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping167", (_req,res)=> res.json({ ok:true, n:167, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo167", (req,res)=> res.json({ ok:true, n:167, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping168", (_req,res)=> res.json({ ok:true, n:168, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo168", (req,res)=> res.json({ ok:true, n:168, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping169", (_req,res)=> res.json({ ok:true, n:169, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo169", (req,res)=> res.json({ ok:true, n:169, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping170", (_req,res)=> res.json({ ok:true, n:170, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo170", (req,res)=> res.json({ ok:true, n:170, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping171", (_req,res)=> res.json({ ok:true, n:171, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo171", (req,res)=> res.json({ ok:true, n:171, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping172", (_req,res)=> res.json({ ok:true, n:172, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo172", (req,res)=> res.json({ ok:true, n:172, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping173", (_req,res)=> res.json({ ok:true, n:173, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo173", (req,res)=> res.json({ ok:true, n:173, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping174", (_req,res)=> res.json({ ok:true, n:174, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo174", (req,res)=> res.json({ ok:true, n:174, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping175", (_req,res)=> res.json({ ok:true, n:175, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo175", (req,res)=> res.json({ ok:true, n:175, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping176", (_req,res)=> res.json({ ok:true, n:176, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo176", (req,res)=> res.json({ ok:true, n:176, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping177", (_req,res)=> res.json({ ok:true, n:177, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo177", (req,res)=> res.json({ ok:true, n:177, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping178", (_req,res)=> res.json({ ok:true, n:178, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo178", (req,res)=> res.json({ ok:true, n:178, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping179", (_req,res)=> res.json({ ok:true, n:179, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo179", (req,res)=> res.json({ ok:true, n:179, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping180", (_req,res)=> res.json({ ok:true, n:180, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo180", (req,res)=> res.json({ ok:true, n:180, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping181", (_req,res)=> res.json({ ok:true, n:181, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo181", (req,res)=> res.json({ ok:true, n:181, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping182", (_req,res)=> res.json({ ok:true, n:182, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo182", (req,res)=> res.json({ ok:true, n:182, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping183", (_req,res)=> res.json({ ok:true, n:183, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo183", (req,res)=> res.json({ ok:true, n:183, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping184", (_req,res)=> res.json({ ok:true, n:184, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo184", (req,res)=> res.json({ ok:true, n:184, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping185", (_req,res)=> res.json({ ok:true, n:185, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo185", (req,res)=> res.json({ ok:true, n:185, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping186", (_req,res)=> res.json({ ok:true, n:186, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo186", (req,res)=> res.json({ ok:true, n:186, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping187", (_req,res)=> res.json({ ok:true, n:187, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo187", (req,res)=> res.json({ ok:true, n:187, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping188", (_req,res)=> res.json({ ok:true, n:188, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo188", (req,res)=> res.json({ ok:true, n:188, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping189", (_req,res)=> res.json({ ok:true, n:189, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo189", (req,res)=> res.json({ ok:true, n:189, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping190", (_req,res)=> res.json({ ok:true, n:190, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo190", (req,res)=> res.json({ ok:true, n:190, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping191", (_req,res)=> res.json({ ok:true, n:191, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo191", (req,res)=> res.json({ ok:true, n:191, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping192", (_req,res)=> res.json({ ok:true, n:192, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo192", (req,res)=> res.json({ ok:true, n:192, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping193", (_req,res)=> res.json({ ok:true, n:193, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo193", (req,res)=> res.json({ ok:true, n:193, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping194", (_req,res)=> res.json({ ok:true, n:194, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo194", (req,res)=> res.json({ ok:true, n:194, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping195", (_req,res)=> res.json({ ok:true, n:195, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo195", (req,res)=> res.json({ ok:true, n:195, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping196", (_req,res)=> res.json({ ok:true, n:196, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo196", (req,res)=> res.json({ ok:true, n:196, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping197", (_req,res)=> res.json({ ok:true, n:197, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo197", (req,res)=> res.json({ ok:true, n:197, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping198", (_req,res)=> res.json({ ok:true, n:198, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo198", (req,res)=> res.json({ ok:true, n:198, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping199", (_req,res)=> res.json({ ok:true, n:199, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo199", (req,res)=> res.json({ ok:true, n:199, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping200", (_req,res)=> res.json({ ok:true, n:200, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo200", (req,res)=> res.json({ ok:true, n:200, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping201", (_req,res)=> res.json({ ok:true, n:201, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo201", (req,res)=> res.json({ ok:true, n:201, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping202", (_req,res)=> res.json({ ok:true, n:202, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo202", (req,res)=> res.json({ ok:true, n:202, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping203", (_req,res)=> res.json({ ok:true, n:203, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo203", (req,res)=> res.json({ ok:true, n:203, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping204", (_req,res)=> res.json({ ok:true, n:204, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo204", (req,res)=> res.json({ ok:true, n:204, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping205", (_req,res)=> res.json({ ok:true, n:205, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo205", (req,res)=> res.json({ ok:true, n:205, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping206", (_req,res)=> res.json({ ok:true, n:206, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo206", (req,res)=> res.json({ ok:true, n:206, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping207", (_req,res)=> res.json({ ok:true, n:207, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo207", (req,res)=> res.json({ ok:true, n:207, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping208", (_req,res)=> res.json({ ok:true, n:208, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo208", (req,res)=> res.json({ ok:true, n:208, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping209", (_req,res)=> res.json({ ok:true, n:209, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo209", (req,res)=> res.json({ ok:true, n:209, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping210", (_req,res)=> res.json({ ok:true, n:210, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo210", (req,res)=> res.json({ ok:true, n:210, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping211", (_req,res)=> res.json({ ok:true, n:211, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo211", (req,res)=> res.json({ ok:true, n:211, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping212", (_req,res)=> res.json({ ok:true, n:212, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo212", (req,res)=> res.json({ ok:true, n:212, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping213", (_req,res)=> res.json({ ok:true, n:213, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo213", (req,res)=> res.json({ ok:true, n:213, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping214", (_req,res)=> res.json({ ok:true, n:214, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo214", (req,res)=> res.json({ ok:true, n:214, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping215", (_req,res)=> res.json({ ok:true, n:215, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo215", (req,res)=> res.json({ ok:true, n:215, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping216", (_req,res)=> res.json({ ok:true, n:216, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo216", (req,res)=> res.json({ ok:true, n:216, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping217", (_req,res)=> res.json({ ok:true, n:217, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo217", (req,res)=> res.json({ ok:true, n:217, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping218", (_req,res)=> res.json({ ok:true, n:218, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo218", (req,res)=> res.json({ ok:true, n:218, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping219", (_req,res)=> res.json({ ok:true, n:219, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo219", (req,res)=> res.json({ ok:true, n:219, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping220", (_req,res)=> res.json({ ok:true, n:220, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo220", (req,res)=> res.json({ ok:true, n:220, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping221", (_req,res)=> res.json({ ok:true, n:221, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo221", (req,res)=> res.json({ ok:true, n:221, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping222", (_req,res)=> res.json({ ok:true, n:222, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo222", (req,res)=> res.json({ ok:true, n:222, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping223", (_req,res)=> res.json({ ok:true, n:223, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo223", (req,res)=> res.json({ ok:true, n:223, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping224", (_req,res)=> res.json({ ok:true, n:224, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo224", (req,res)=> res.json({ ok:true, n:224, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping225", (_req,res)=> res.json({ ok:true, n:225, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo225", (req,res)=> res.json({ ok:true, n:225, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping226", (_req,res)=> res.json({ ok:true, n:226, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo226", (req,res)=> res.json({ ok:true, n:226, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping227", (_req,res)=> res.json({ ok:true, n:227, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo227", (req,res)=> res.json({ ok:true, n:227, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping228", (_req,res)=> res.json({ ok:true, n:228, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo228", (req,res)=> res.json({ ok:true, n:228, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping229", (_req,res)=> res.json({ ok:true, n:229, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo229", (req,res)=> res.json({ ok:true, n:229, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping230", (_req,res)=> res.json({ ok:true, n:230, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo230", (req,res)=> res.json({ ok:true, n:230, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping231", (_req,res)=> res.json({ ok:true, n:231, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo231", (req,res)=> res.json({ ok:true, n:231, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping232", (_req,res)=> res.json({ ok:true, n:232, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo232", (req,res)=> res.json({ ok:true, n:232, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping233", (_req,res)=> res.json({ ok:true, n:233, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo233", (req,res)=> res.json({ ok:true, n:233, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping234", (_req,res)=> res.json({ ok:true, n:234, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo234", (req,res)=> res.json({ ok:true, n:234, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping235", (_req,res)=> res.json({ ok:true, n:235, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo235", (req,res)=> res.json({ ok:true, n:235, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping236", (_req,res)=> res.json({ ok:true, n:236, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo236", (req,res)=> res.json({ ok:true, n:236, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping237", (_req,res)=> res.json({ ok:true, n:237, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo237", (req,res)=> res.json({ ok:true, n:237, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping238", (_req,res)=> res.json({ ok:true, n:238, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo238", (req,res)=> res.json({ ok:true, n:238, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping239", (_req,res)=> res.json({ ok:true, n:239, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo239", (req,res)=> res.json({ ok:true, n:239, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping240", (_req,res)=> res.json({ ok:true, n:240, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo240", (req,res)=> res.json({ ok:true, n:240, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping241", (_req,res)=> res.json({ ok:true, n:241, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo241", (req,res)=> res.json({ ok:true, n:241, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping242", (_req,res)=> res.json({ ok:true, n:242, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo242", (req,res)=> res.json({ ok:true, n:242, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping243", (_req,res)=> res.json({ ok:true, n:243, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo243", (req,res)=> res.json({ ok:true, n:243, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping244", (_req,res)=> res.json({ ok:true, n:244, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo244", (req,res)=> res.json({ ok:true, n:244, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping245", (_req,res)=> res.json({ ok:true, n:245, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo245", (req,res)=> res.json({ ok:true, n:245, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping246", (_req,res)=> res.json({ ok:true, n:246, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo246", (req,res)=> res.json({ ok:true, n:246, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping247", (_req,res)=> res.json({ ok:true, n:247, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo247", (req,res)=> res.json({ ok:true, n:247, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping248", (_req,res)=> res.json({ ok:true, n:248, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo248", (req,res)=> res.json({ ok:true, n:248, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping249", (_req,res)=> res.json({ ok:true, n:249, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo249", (req,res)=> res.json({ ok:true, n:249, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping250", (_req,res)=> res.json({ ok:true, n:250, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo250", (req,res)=> res.json({ ok:true, n:250, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping251", (_req,res)=> res.json({ ok:true, n:251, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo251", (req,res)=> res.json({ ok:true, n:251, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping252", (_req,res)=> res.json({ ok:true, n:252, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo252", (req,res)=> res.json({ ok:true, n:252, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping253", (_req,res)=> res.json({ ok:true, n:253, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo253", (req,res)=> res.json({ ok:true, n:253, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping254", (_req,res)=> res.json({ ok:true, n:254, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo254", (req,res)=> res.json({ ok:true, n:254, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping255", (_req,res)=> res.json({ ok:true, n:255, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo255", (req,res)=> res.json({ ok:true, n:255, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping256", (_req,res)=> res.json({ ok:true, n:256, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo256", (req,res)=> res.json({ ok:true, n:256, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping257", (_req,res)=> res.json({ ok:true, n:257, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo257", (req,res)=> res.json({ ok:true, n:257, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping258", (_req,res)=> res.json({ ok:true, n:258, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo258", (req,res)=> res.json({ ok:true, n:258, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping259", (_req,res)=> res.json({ ok:true, n:259, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo259", (req,res)=> res.json({ ok:true, n:259, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping260", (_req,res)=> res.json({ ok:true, n:260, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo260", (req,res)=> res.json({ ok:true, n:260, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping261", (_req,res)=> res.json({ ok:true, n:261, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo261", (req,res)=> res.json({ ok:true, n:261, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping262", (_req,res)=> res.json({ ok:true, n:262, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo262", (req,res)=> res.json({ ok:true, n:262, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping263", (_req,res)=> res.json({ ok:true, n:263, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo263", (req,res)=> res.json({ ok:true, n:263, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping264", (_req,res)=> res.json({ ok:true, n:264, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo264", (req,res)=> res.json({ ok:true, n:264, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping265", (_req,res)=> res.json({ ok:true, n:265, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo265", (req,res)=> res.json({ ok:true, n:265, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping266", (_req,res)=> res.json({ ok:true, n:266, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo266", (req,res)=> res.json({ ok:true, n:266, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping267", (_req,res)=> res.json({ ok:true, n:267, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo267", (req,res)=> res.json({ ok:true, n:267, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping268", (_req,res)=> res.json({ ok:true, n:268, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo268", (req,res)=> res.json({ ok:true, n:268, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping269", (_req,res)=> res.json({ ok:true, n:269, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo269", (req,res)=> res.json({ ok:true, n:269, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping270", (_req,res)=> res.json({ ok:true, n:270, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo270", (req,res)=> res.json({ ok:true, n:270, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping271", (_req,res)=> res.json({ ok:true, n:271, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo271", (req,res)=> res.json({ ok:true, n:271, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping272", (_req,res)=> res.json({ ok:true, n:272, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo272", (req,res)=> res.json({ ok:true, n:272, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping273", (_req,res)=> res.json({ ok:true, n:273, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo273", (req,res)=> res.json({ ok:true, n:273, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping274", (_req,res)=> res.json({ ok:true, n:274, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo274", (req,res)=> res.json({ ok:true, n:274, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping275", (_req,res)=> res.json({ ok:true, n:275, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo275", (req,res)=> res.json({ ok:true, n:275, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping276", (_req,res)=> res.json({ ok:true, n:276, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo276", (req,res)=> res.json({ ok:true, n:276, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping277", (_req,res)=> res.json({ ok:true, n:277, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo277", (req,res)=> res.json({ ok:true, n:277, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping278", (_req,res)=> res.json({ ok:true, n:278, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo278", (req,res)=> res.json({ ok:true, n:278, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping279", (_req,res)=> res.json({ ok:true, n:279, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo279", (req,res)=> res.json({ ok:true, n:279, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping280", (_req,res)=> res.json({ ok:true, n:280, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo280", (req,res)=> res.json({ ok:true, n:280, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping281", (_req,res)=> res.json({ ok:true, n:281, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo281", (req,res)=> res.json({ ok:true, n:281, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping282", (_req,res)=> res.json({ ok:true, n:282, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo282", (req,res)=> res.json({ ok:true, n:282, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping283", (_req,res)=> res.json({ ok:true, n:283, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo283", (req,res)=> res.json({ ok:true, n:283, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping284", (_req,res)=> res.json({ ok:true, n:284, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo284", (req,res)=> res.json({ ok:true, n:284, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping285", (_req,res)=> res.json({ ok:true, n:285, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo285", (req,res)=> res.json({ ok:true, n:285, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping286", (_req,res)=> res.json({ ok:true, n:286, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo286", (req,res)=> res.json({ ok:true, n:286, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping287", (_req,res)=> res.json({ ok:true, n:287, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo287", (req,res)=> res.json({ ok:true, n:287, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping288", (_req,res)=> res.json({ ok:true, n:288, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo288", (req,res)=> res.json({ ok:true, n:288, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping289", (_req,res)=> res.json({ ok:true, n:289, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo289", (req,res)=> res.json({ ok:true, n:289, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping290", (_req,res)=> res.json({ ok:true, n:290, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo290", (req,res)=> res.json({ ok:true, n:290, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping291", (_req,res)=> res.json({ ok:true, n:291, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo291", (req,res)=> res.json({ ok:true, n:291, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping292", (_req,res)=> res.json({ ok:true, n:292, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo292", (req,res)=> res.json({ ok:true, n:292, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping293", (_req,res)=> res.json({ ok:true, n:293, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo293", (req,res)=> res.json({ ok:true, n:293, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping294", (_req,res)=> res.json({ ok:true, n:294, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo294", (req,res)=> res.json({ ok:true, n:294, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping295", (_req,res)=> res.json({ ok:true, n:295, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo295", (req,res)=> res.json({ ok:true, n:295, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping296", (_req,res)=> res.json({ ok:true, n:296, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo296", (req,res)=> res.json({ ok:true, n:296, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping297", (_req,res)=> res.json({ ok:true, n:297, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo297", (req,res)=> res.json({ ok:true, n:297, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping298", (_req,res)=> res.json({ ok:true, n:298, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo298", (req,res)=> res.json({ ok:true, n:298, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping299", (_req,res)=> res.json({ ok:true, n:299, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo299", (req,res)=> res.json({ ok:true, n:299, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping300", (_req,res)=> res.json({ ok:true, n:300, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo300", (req,res)=> res.json({ ok:true, n:300, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping301", (_req,res)=> res.json({ ok:true, n:301, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo301", (req,res)=> res.json({ ok:true, n:301, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping302", (_req,res)=> res.json({ ok:true, n:302, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo302", (req,res)=> res.json({ ok:true, n:302, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping303", (_req,res)=> res.json({ ok:true, n:303, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo303", (req,res)=> res.json({ ok:true, n:303, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping304", (_req,res)=> res.json({ ok:true, n:304, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo304", (req,res)=> res.json({ ok:true, n:304, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping305", (_req,res)=> res.json({ ok:true, n:305, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo305", (req,res)=> res.json({ ok:true, n:305, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping306", (_req,res)=> res.json({ ok:true, n:306, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo306", (req,res)=> res.json({ ok:true, n:306, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping307", (_req,res)=> res.json({ ok:true, n:307, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo307", (req,res)=> res.json({ ok:true, n:307, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping308", (_req,res)=> res.json({ ok:true, n:308, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo308", (req,res)=> res.json({ ok:true, n:308, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping309", (_req,res)=> res.json({ ok:true, n:309, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo309", (req,res)=> res.json({ ok:true, n:309, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping310", (_req,res)=> res.json({ ok:true, n:310, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo310", (req,res)=> res.json({ ok:true, n:310, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping311", (_req,res)=> res.json({ ok:true, n:311, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo311", (req,res)=> res.json({ ok:true, n:311, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping312", (_req,res)=> res.json({ ok:true, n:312, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo312", (req,res)=> res.json({ ok:true, n:312, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping313", (_req,res)=> res.json({ ok:true, n:313, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo313", (req,res)=> res.json({ ok:true, n:313, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping314", (_req,res)=> res.json({ ok:true, n:314, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo314", (req,res)=> res.json({ ok:true, n:314, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping315", (_req,res)=> res.json({ ok:true, n:315, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo315", (req,res)=> res.json({ ok:true, n:315, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping316", (_req,res)=> res.json({ ok:true, n:316, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo316", (req,res)=> res.json({ ok:true, n:316, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping317", (_req,res)=> res.json({ ok:true, n:317, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo317", (req,res)=> res.json({ ok:true, n:317, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping318", (_req,res)=> res.json({ ok:true, n:318, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo318", (req,res)=> res.json({ ok:true, n:318, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping319", (_req,res)=> res.json({ ok:true, n:319, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo319", (req,res)=> res.json({ ok:true, n:319, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping320", (_req,res)=> res.json({ ok:true, n:320, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo320", (req,res)=> res.json({ ok:true, n:320, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping321", (_req,res)=> res.json({ ok:true, n:321, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo321", (req,res)=> res.json({ ok:true, n:321, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping322", (_req,res)=> res.json({ ok:true, n:322, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo322", (req,res)=> res.json({ ok:true, n:322, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping323", (_req,res)=> res.json({ ok:true, n:323, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo323", (req,res)=> res.json({ ok:true, n:323, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping324", (_req,res)=> res.json({ ok:true, n:324, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo324", (req,res)=> res.json({ ok:true, n:324, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping325", (_req,res)=> res.json({ ok:true, n:325, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo325", (req,res)=> res.json({ ok:true, n:325, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping326", (_req,res)=> res.json({ ok:true, n:326, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo326", (req,res)=> res.json({ ok:true, n:326, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping327", (_req,res)=> res.json({ ok:true, n:327, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo327", (req,res)=> res.json({ ok:true, n:327, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping328", (_req,res)=> res.json({ ok:true, n:328, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo328", (req,res)=> res.json({ ok:true, n:328, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping329", (_req,res)=> res.json({ ok:true, n:329, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo329", (req,res)=> res.json({ ok:true, n:329, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping330", (_req,res)=> res.json({ ok:true, n:330, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo330", (req,res)=> res.json({ ok:true, n:330, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping331", (_req,res)=> res.json({ ok:true, n:331, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo331", (req,res)=> res.json({ ok:true, n:331, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping332", (_req,res)=> res.json({ ok:true, n:332, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo332", (req,res)=> res.json({ ok:true, n:332, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping333", (_req,res)=> res.json({ ok:true, n:333, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo333", (req,res)=> res.json({ ok:true, n:333, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping334", (_req,res)=> res.json({ ok:true, n:334, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo334", (req,res)=> res.json({ ok:true, n:334, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping335", (_req,res)=> res.json({ ok:true, n:335, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo335", (req,res)=> res.json({ ok:true, n:335, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping336", (_req,res)=> res.json({ ok:true, n:336, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo336", (req,res)=> res.json({ ok:true, n:336, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping337", (_req,res)=> res.json({ ok:true, n:337, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo337", (req,res)=> res.json({ ok:true, n:337, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping338", (_req,res)=> res.json({ ok:true, n:338, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo338", (req,res)=> res.json({ ok:true, n:338, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping339", (_req,res)=> res.json({ ok:true, n:339, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo339", (req,res)=> res.json({ ok:true, n:339, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping340", (_req,res)=> res.json({ ok:true, n:340, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo340", (req,res)=> res.json({ ok:true, n:340, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping341", (_req,res)=> res.json({ ok:true, n:341, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo341", (req,res)=> res.json({ ok:true, n:341, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping342", (_req,res)=> res.json({ ok:true, n:342, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo342", (req,res)=> res.json({ ok:true, n:342, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping343", (_req,res)=> res.json({ ok:true, n:343, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo343", (req,res)=> res.json({ ok:true, n:343, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping344", (_req,res)=> res.json({ ok:true, n:344, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo344", (req,res)=> res.json({ ok:true, n:344, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping345", (_req,res)=> res.json({ ok:true, n:345, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo345", (req,res)=> res.json({ ok:true, n:345, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping346", (_req,res)=> res.json({ ok:true, n:346, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo346", (req,res)=> res.json({ ok:true, n:346, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping347", (_req,res)=> res.json({ ok:true, n:347, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo347", (req,res)=> res.json({ ok:true, n:347, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping348", (_req,res)=> res.json({ ok:true, n:348, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo348", (req,res)=> res.json({ ok:true, n:348, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping349", (_req,res)=> res.json({ ok:true, n:349, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo349", (req,res)=> res.json({ ok:true, n:349, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping350", (_req,res)=> res.json({ ok:true, n:350, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo350", (req,res)=> res.json({ ok:true, n:350, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping351", (_req,res)=> res.json({ ok:true, n:351, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo351", (req,res)=> res.json({ ok:true, n:351, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping352", (_req,res)=> res.json({ ok:true, n:352, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo352", (req,res)=> res.json({ ok:true, n:352, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping353", (_req,res)=> res.json({ ok:true, n:353, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo353", (req,res)=> res.json({ ok:true, n:353, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping354", (_req,res)=> res.json({ ok:true, n:354, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo354", (req,res)=> res.json({ ok:true, n:354, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping355", (_req,res)=> res.json({ ok:true, n:355, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo355", (req,res)=> res.json({ ok:true, n:355, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping356", (_req,res)=> res.json({ ok:true, n:356, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo356", (req,res)=> res.json({ ok:true, n:356, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping357", (_req,res)=> res.json({ ok:true, n:357, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo357", (req,res)=> res.json({ ok:true, n:357, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping358", (_req,res)=> res.json({ ok:true, n:358, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo358", (req,res)=> res.json({ ok:true, n:358, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping359", (_req,res)=> res.json({ ok:true, n:359, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo359", (req,res)=> res.json({ ok:true, n:359, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping360", (_req,res)=> res.json({ ok:true, n:360, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo360", (req,res)=> res.json({ ok:true, n:360, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping361", (_req,res)=> res.json({ ok:true, n:361, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo361", (req,res)=> res.json({ ok:true, n:361, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping362", (_req,res)=> res.json({ ok:true, n:362, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo362", (req,res)=> res.json({ ok:true, n:362, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping363", (_req,res)=> res.json({ ok:true, n:363, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo363", (req,res)=> res.json({ ok:true, n:363, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping364", (_req,res)=> res.json({ ok:true, n:364, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo364", (req,res)=> res.json({ ok:true, n:364, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping365", (_req,res)=> res.json({ ok:true, n:365, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo365", (req,res)=> res.json({ ok:true, n:365, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping366", (_req,res)=> res.json({ ok:true, n:366, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo366", (req,res)=> res.json({ ok:true, n:366, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping367", (_req,res)=> res.json({ ok:true, n:367, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo367", (req,res)=> res.json({ ok:true, n:367, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping368", (_req,res)=> res.json({ ok:true, n:368, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo368", (req,res)=> res.json({ ok:true, n:368, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping369", (_req,res)=> res.json({ ok:true, n:369, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo369", (req,res)=> res.json({ ok:true, n:369, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping370", (_req,res)=> res.json({ ok:true, n:370, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo370", (req,res)=> res.json({ ok:true, n:370, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping371", (_req,res)=> res.json({ ok:true, n:371, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo371", (req,res)=> res.json({ ok:true, n:371, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping372", (_req,res)=> res.json({ ok:true, n:372, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo372", (req,res)=> res.json({ ok:true, n:372, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping373", (_req,res)=> res.json({ ok:true, n:373, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo373", (req,res)=> res.json({ ok:true, n:373, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping374", (_req,res)=> res.json({ ok:true, n:374, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo374", (req,res)=> res.json({ ok:true, n:374, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping375", (_req,res)=> res.json({ ok:true, n:375, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo375", (req,res)=> res.json({ ok:true, n:375, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping376", (_req,res)=> res.json({ ok:true, n:376, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo376", (req,res)=> res.json({ ok:true, n:376, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping377", (_req,res)=> res.json({ ok:true, n:377, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo377", (req,res)=> res.json({ ok:true, n:377, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping378", (_req,res)=> res.json({ ok:true, n:378, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo378", (req,res)=> res.json({ ok:true, n:378, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping379", (_req,res)=> res.json({ ok:true, n:379, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo379", (req,res)=> res.json({ ok:true, n:379, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping380", (_req,res)=> res.json({ ok:true, n:380, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo380", (req,res)=> res.json({ ok:true, n:380, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping381", (_req,res)=> res.json({ ok:true, n:381, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo381", (req,res)=> res.json({ ok:true, n:381, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping382", (_req,res)=> res.json({ ok:true, n:382, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo382", (req,res)=> res.json({ ok:true, n:382, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping383", (_req,res)=> res.json({ ok:true, n:383, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo383", (req,res)=> res.json({ ok:true, n:383, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping384", (_req,res)=> res.json({ ok:true, n:384, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo384", (req,res)=> res.json({ ok:true, n:384, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping385", (_req,res)=> res.json({ ok:true, n:385, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo385", (req,res)=> res.json({ ok:true, n:385, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping386", (_req,res)=> res.json({ ok:true, n:386, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo386", (req,res)=> res.json({ ok:true, n:386, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping387", (_req,res)=> res.json({ ok:true, n:387, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo387", (req,res)=> res.json({ ok:true, n:387, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping388", (_req,res)=> res.json({ ok:true, n:388, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo388", (req,res)=> res.json({ ok:true, n:388, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping389", (_req,res)=> res.json({ ok:true, n:389, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo389", (req,res)=> res.json({ ok:true, n:389, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping390", (_req,res)=> res.json({ ok:true, n:390, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo390", (req,res)=> res.json({ ok:true, n:390, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping391", (_req,res)=> res.json({ ok:true, n:391, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo391", (req,res)=> res.json({ ok:true, n:391, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping392", (_req,res)=> res.json({ ok:true, n:392, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo392", (req,res)=> res.json({ ok:true, n:392, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping393", (_req,res)=> res.json({ ok:true, n:393, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo393", (req,res)=> res.json({ ok:true, n:393, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping394", (_req,res)=> res.json({ ok:true, n:394, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo394", (req,res)=> res.json({ ok:true, n:394, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping395", (_req,res)=> res.json({ ok:true, n:395, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo395", (req,res)=> res.json({ ok:true, n:395, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping396", (_req,res)=> res.json({ ok:true, n:396, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo396", (req,res)=> res.json({ ok:true, n:396, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping397", (_req,res)=> res.json({ ok:true, n:397, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo397", (req,res)=> res.json({ ok:true, n:397, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping398", (_req,res)=> res.json({ ok:true, n:398, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo398", (req,res)=> res.json({ ok:true, n:398, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping399", (_req,res)=> res.json({ ok:true, n:399, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo399", (req,res)=> res.json({ ok:true, n:399, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping400", (_req,res)=> res.json({ ok:true, n:400, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo400", (req,res)=> res.json({ ok:true, n:400, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping401", (_req,res)=> res.json({ ok:true, n:401, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo401", (req,res)=> res.json({ ok:true, n:401, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping402", (_req,res)=> res.json({ ok:true, n:402, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo402", (req,res)=> res.json({ ok:true, n:402, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping403", (_req,res)=> res.json({ ok:true, n:403, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo403", (req,res)=> res.json({ ok:true, n:403, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping404", (_req,res)=> res.json({ ok:true, n:404, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo404", (req,res)=> res.json({ ok:true, n:404, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping405", (_req,res)=> res.json({ ok:true, n:405, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo405", (req,res)=> res.json({ ok:true, n:405, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping406", (_req,res)=> res.json({ ok:true, n:406, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo406", (req,res)=> res.json({ ok:true, n:406, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping407", (_req,res)=> res.json({ ok:true, n:407, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo407", (req,res)=> res.json({ ok:true, n:407, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping408", (_req,res)=> res.json({ ok:true, n:408, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo408", (req,res)=> res.json({ ok:true, n:408, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping409", (_req,res)=> res.json({ ok:true, n:409, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo409", (req,res)=> res.json({ ok:true, n:409, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping410", (_req,res)=> res.json({ ok:true, n:410, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo410", (req,res)=> res.json({ ok:true, n:410, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping411", (_req,res)=> res.json({ ok:true, n:411, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo411", (req,res)=> res.json({ ok:true, n:411, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping412", (_req,res)=> res.json({ ok:true, n:412, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo412", (req,res)=> res.json({ ok:true, n:412, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping413", (_req,res)=> res.json({ ok:true, n:413, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo413", (req,res)=> res.json({ ok:true, n:413, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping414", (_req,res)=> res.json({ ok:true, n:414, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo414", (req,res)=> res.json({ ok:true, n:414, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping415", (_req,res)=> res.json({ ok:true, n:415, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo415", (req,res)=> res.json({ ok:true, n:415, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping416", (_req,res)=> res.json({ ok:true, n:416, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo416", (req,res)=> res.json({ ok:true, n:416, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping417", (_req,res)=> res.json({ ok:true, n:417, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo417", (req,res)=> res.json({ ok:true, n:417, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping418", (_req,res)=> res.json({ ok:true, n:418, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo418", (req,res)=> res.json({ ok:true, n:418, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping419", (_req,res)=> res.json({ ok:true, n:419, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo419", (req,res)=> res.json({ ok:true, n:419, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping420", (_req,res)=> res.json({ ok:true, n:420, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo420", (req,res)=> res.json({ ok:true, n:420, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping421", (_req,res)=> res.json({ ok:true, n:421, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo421", (req,res)=> res.json({ ok:true, n:421, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping422", (_req,res)=> res.json({ ok:true, n:422, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo422", (req,res)=> res.json({ ok:true, n:422, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping423", (_req,res)=> res.json({ ok:true, n:423, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo423", (req,res)=> res.json({ ok:true, n:423, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping424", (_req,res)=> res.json({ ok:true, n:424, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo424", (req,res)=> res.json({ ok:true, n:424, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping425", (_req,res)=> res.json({ ok:true, n:425, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo425", (req,res)=> res.json({ ok:true, n:425, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping426", (_req,res)=> res.json({ ok:true, n:426, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo426", (req,res)=> res.json({ ok:true, n:426, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping427", (_req,res)=> res.json({ ok:true, n:427, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo427", (req,res)=> res.json({ ok:true, n:427, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping428", (_req,res)=> res.json({ ok:true, n:428, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo428", (req,res)=> res.json({ ok:true, n:428, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping429", (_req,res)=> res.json({ ok:true, n:429, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo429", (req,res)=> res.json({ ok:true, n:429, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping430", (_req,res)=> res.json({ ok:true, n:430, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo430", (req,res)=> res.json({ ok:true, n:430, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping431", (_req,res)=> res.json({ ok:true, n:431, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo431", (req,res)=> res.json({ ok:true, n:431, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping432", (_req,res)=> res.json({ ok:true, n:432, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo432", (req,res)=> res.json({ ok:true, n:432, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping433", (_req,res)=> res.json({ ok:true, n:433, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo433", (req,res)=> res.json({ ok:true, n:433, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping434", (_req,res)=> res.json({ ok:true, n:434, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo434", (req,res)=> res.json({ ok:true, n:434, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping435", (_req,res)=> res.json({ ok:true, n:435, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo435", (req,res)=> res.json({ ok:true, n:435, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping436", (_req,res)=> res.json({ ok:true, n:436, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo436", (req,res)=> res.json({ ok:true, n:436, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping437", (_req,res)=> res.json({ ok:true, n:437, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo437", (req,res)=> res.json({ ok:true, n:437, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping438", (_req,res)=> res.json({ ok:true, n:438, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo438", (req,res)=> res.json({ ok:true, n:438, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping439", (_req,res)=> res.json({ ok:true, n:439, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo439", (req,res)=> res.json({ ok:true, n:439, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping440", (_req,res)=> res.json({ ok:true, n:440, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo440", (req,res)=> res.json({ ok:true, n:440, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping441", (_req,res)=> res.json({ ok:true, n:441, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo441", (req,res)=> res.json({ ok:true, n:441, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping442", (_req,res)=> res.json({ ok:true, n:442, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo442", (req,res)=> res.json({ ok:true, n:442, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping443", (_req,res)=> res.json({ ok:true, n:443, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo443", (req,res)=> res.json({ ok:true, n:443, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping444", (_req,res)=> res.json({ ok:true, n:444, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo444", (req,res)=> res.json({ ok:true, n:444, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping445", (_req,res)=> res.json({ ok:true, n:445, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo445", (req,res)=> res.json({ ok:true, n:445, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping446", (_req,res)=> res.json({ ok:true, n:446, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo446", (req,res)=> res.json({ ok:true, n:446, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping447", (_req,res)=> res.json({ ok:true, n:447, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo447", (req,res)=> res.json({ ok:true, n:447, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping448", (_req,res)=> res.json({ ok:true, n:448, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo448", (req,res)=> res.json({ ok:true, n:448, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping449", (_req,res)=> res.json({ ok:true, n:449, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo449", (req,res)=> res.json({ ok:true, n:449, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping450", (_req,res)=> res.json({ ok:true, n:450, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo450", (req,res)=> res.json({ ok:true, n:450, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping451", (_req,res)=> res.json({ ok:true, n:451, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo451", (req,res)=> res.json({ ok:true, n:451, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping452", (_req,res)=> res.json({ ok:true, n:452, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo452", (req,res)=> res.json({ ok:true, n:452, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping453", (_req,res)=> res.json({ ok:true, n:453, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo453", (req,res)=> res.json({ ok:true, n:453, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping454", (_req,res)=> res.json({ ok:true, n:454, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo454", (req,res)=> res.json({ ok:true, n:454, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping455", (_req,res)=> res.json({ ok:true, n:455, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo455", (req,res)=> res.json({ ok:true, n:455, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping456", (_req,res)=> res.json({ ok:true, n:456, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo456", (req,res)=> res.json({ ok:true, n:456, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping457", (_req,res)=> res.json({ ok:true, n:457, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo457", (req,res)=> res.json({ ok:true, n:457, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping458", (_req,res)=> res.json({ ok:true, n:458, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo458", (req,res)=> res.json({ ok:true, n:458, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping459", (_req,res)=> res.json({ ok:true, n:459, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo459", (req,res)=> res.json({ ok:true, n:459, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping460", (_req,res)=> res.json({ ok:true, n:460, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo460", (req,res)=> res.json({ ok:true, n:460, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping461", (_req,res)=> res.json({ ok:true, n:461, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo461", (req,res)=> res.json({ ok:true, n:461, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping462", (_req,res)=> res.json({ ok:true, n:462, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo462", (req,res)=> res.json({ ok:true, n:462, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping463", (_req,res)=> res.json({ ok:true, n:463, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo463", (req,res)=> res.json({ ok:true, n:463, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping464", (_req,res)=> res.json({ ok:true, n:464, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo464", (req,res)=> res.json({ ok:true, n:464, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping465", (_req,res)=> res.json({ ok:true, n:465, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo465", (req,res)=> res.json({ ok:true, n:465, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping466", (_req,res)=> res.json({ ok:true, n:466, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo466", (req,res)=> res.json({ ok:true, n:466, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping467", (_req,res)=> res.json({ ok:true, n:467, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo467", (req,res)=> res.json({ ok:true, n:467, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping468", (_req,res)=> res.json({ ok:true, n:468, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo468", (req,res)=> res.json({ ok:true, n:468, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping469", (_req,res)=> res.json({ ok:true, n:469, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo469", (req,res)=> res.json({ ok:true, n:469, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping470", (_req,res)=> res.json({ ok:true, n:470, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo470", (req,res)=> res.json({ ok:true, n:470, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping471", (_req,res)=> res.json({ ok:true, n:471, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo471", (req,res)=> res.json({ ok:true, n:471, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping472", (_req,res)=> res.json({ ok:true, n:472, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo472", (req,res)=> res.json({ ok:true, n:472, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping473", (_req,res)=> res.json({ ok:true, n:473, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo473", (req,res)=> res.json({ ok:true, n:473, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping474", (_req,res)=> res.json({ ok:true, n:474, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo474", (req,res)=> res.json({ ok:true, n:474, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping475", (_req,res)=> res.json({ ok:true, n:475, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo475", (req,res)=> res.json({ ok:true, n:475, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping476", (_req,res)=> res.json({ ok:true, n:476, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo476", (req,res)=> res.json({ ok:true, n:476, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping477", (_req,res)=> res.json({ ok:true, n:477, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo477", (req,res)=> res.json({ ok:true, n:477, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping478", (_req,res)=> res.json({ ok:true, n:478, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo478", (req,res)=> res.json({ ok:true, n:478, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping479", (_req,res)=> res.json({ ok:true, n:479, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo479", (req,res)=> res.json({ ok:true, n:479, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping480", (_req,res)=> res.json({ ok:true, n:480, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo480", (req,res)=> res.json({ ok:true, n:480, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping481", (_req,res)=> res.json({ ok:true, n:481, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo481", (req,res)=> res.json({ ok:true, n:481, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping482", (_req,res)=> res.json({ ok:true, n:482, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo482", (req,res)=> res.json({ ok:true, n:482, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping483", (_req,res)=> res.json({ ok:true, n:483, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo483", (req,res)=> res.json({ ok:true, n:483, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping484", (_req,res)=> res.json({ ok:true, n:484, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo484", (req,res)=> res.json({ ok:true, n:484, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping485", (_req,res)=> res.json({ ok:true, n:485, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo485", (req,res)=> res.json({ ok:true, n:485, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping486", (_req,res)=> res.json({ ok:true, n:486, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo486", (req,res)=> res.json({ ok:true, n:486, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping487", (_req,res)=> res.json({ ok:true, n:487, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo487", (req,res)=> res.json({ ok:true, n:487, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping488", (_req,res)=> res.json({ ok:true, n:488, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo488", (req,res)=> res.json({ ok:true, n:488, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping489", (_req,res)=> res.json({ ok:true, n:489, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo489", (req,res)=> res.json({ ok:true, n:489, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping490", (_req,res)=> res.json({ ok:true, n:490, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo490", (req,res)=> res.json({ ok:true, n:490, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping491", (_req,res)=> res.json({ ok:true, n:491, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo491", (req,res)=> res.json({ ok:true, n:491, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping492", (_req,res)=> res.json({ ok:true, n:492, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo492", (req,res)=> res.json({ ok:true, n:492, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping493", (_req,res)=> res.json({ ok:true, n:493, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo493", (req,res)=> res.json({ ok:true, n:493, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping494", (_req,res)=> res.json({ ok:true, n:494, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo494", (req,res)=> res.json({ ok:true, n:494, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping495", (_req,res)=> res.json({ ok:true, n:495, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo495", (req,res)=> res.json({ ok:true, n:495, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping496", (_req,res)=> res.json({ ok:true, n:496, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo496", (req,res)=> res.json({ ok:true, n:496, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping497", (_req,res)=> res.json({ ok:true, n:497, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo497", (req,res)=> res.json({ ok:true, n:497, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping498", (_req,res)=> res.json({ ok:true, n:498, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo498", (req,res)=> res.json({ ok:true, n:498, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping499", (_req,res)=> res.json({ ok:true, n:499, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo499", (req,res)=> res.json({ ok:true, n:499, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping500", (_req,res)=> res.json({ ok:true, n:500, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo500", (req,res)=> res.json({ ok:true, n:500, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping501", (_req,res)=> res.json({ ok:true, n:501, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo501", (req,res)=> res.json({ ok:true, n:501, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping502", (_req,res)=> res.json({ ok:true, n:502, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo502", (req,res)=> res.json({ ok:true, n:502, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping503", (_req,res)=> res.json({ ok:true, n:503, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo503", (req,res)=> res.json({ ok:true, n:503, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping504", (_req,res)=> res.json({ ok:true, n:504, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo504", (req,res)=> res.json({ ok:true, n:504, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping505", (_req,res)=> res.json({ ok:true, n:505, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo505", (req,res)=> res.json({ ok:true, n:505, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping506", (_req,res)=> res.json({ ok:true, n:506, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo506", (req,res)=> res.json({ ok:true, n:506, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping507", (_req,res)=> res.json({ ok:true, n:507, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo507", (req,res)=> res.json({ ok:true, n:507, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping508", (_req,res)=> res.json({ ok:true, n:508, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo508", (req,res)=> res.json({ ok:true, n:508, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping509", (_req,res)=> res.json({ ok:true, n:509, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo509", (req,res)=> res.json({ ok:true, n:509, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping510", (_req,res)=> res.json({ ok:true, n:510, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo510", (req,res)=> res.json({ ok:true, n:510, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping511", (_req,res)=> res.json({ ok:true, n:511, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo511", (req,res)=> res.json({ ok:true, n:511, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping512", (_req,res)=> res.json({ ok:true, n:512, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo512", (req,res)=> res.json({ ok:true, n:512, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping513", (_req,res)=> res.json({ ok:true, n:513, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo513", (req,res)=> res.json({ ok:true, n:513, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping514", (_req,res)=> res.json({ ok:true, n:514, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo514", (req,res)=> res.json({ ok:true, n:514, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping515", (_req,res)=> res.json({ ok:true, n:515, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo515", (req,res)=> res.json({ ok:true, n:515, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping516", (_req,res)=> res.json({ ok:true, n:516, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo516", (req,res)=> res.json({ ok:true, n:516, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping517", (_req,res)=> res.json({ ok:true, n:517, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo517", (req,res)=> res.json({ ok:true, n:517, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping518", (_req,res)=> res.json({ ok:true, n:518, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo518", (req,res)=> res.json({ ok:true, n:518, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping519", (_req,res)=> res.json({ ok:true, n:519, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo519", (req,res)=> res.json({ ok:true, n:519, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping520", (_req,res)=> res.json({ ok:true, n:520, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo520", (req,res)=> res.json({ ok:true, n:520, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping521", (_req,res)=> res.json({ ok:true, n:521, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo521", (req,res)=> res.json({ ok:true, n:521, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping522", (_req,res)=> res.json({ ok:true, n:522, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo522", (req,res)=> res.json({ ok:true, n:522, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping523", (_req,res)=> res.json({ ok:true, n:523, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo523", (req,res)=> res.json({ ok:true, n:523, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping524", (_req,res)=> res.json({ ok:true, n:524, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo524", (req,res)=> res.json({ ok:true, n:524, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping525", (_req,res)=> res.json({ ok:true, n:525, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo525", (req,res)=> res.json({ ok:true, n:525, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping526", (_req,res)=> res.json({ ok:true, n:526, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo526", (req,res)=> res.json({ ok:true, n:526, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping527", (_req,res)=> res.json({ ok:true, n:527, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo527", (req,res)=> res.json({ ok:true, n:527, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping528", (_req,res)=> res.json({ ok:true, n:528, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo528", (req,res)=> res.json({ ok:true, n:528, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping529", (_req,res)=> res.json({ ok:true, n:529, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo529", (req,res)=> res.json({ ok:true, n:529, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping530", (_req,res)=> res.json({ ok:true, n:530, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo530", (req,res)=> res.json({ ok:true, n:530, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping531", (_req,res)=> res.json({ ok:true, n:531, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo531", (req,res)=> res.json({ ok:true, n:531, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping532", (_req,res)=> res.json({ ok:true, n:532, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo532", (req,res)=> res.json({ ok:true, n:532, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping533", (_req,res)=> res.json({ ok:true, n:533, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo533", (req,res)=> res.json({ ok:true, n:533, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping534", (_req,res)=> res.json({ ok:true, n:534, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo534", (req,res)=> res.json({ ok:true, n:534, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping535", (_req,res)=> res.json({ ok:true, n:535, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo535", (req,res)=> res.json({ ok:true, n:535, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping536", (_req,res)=> res.json({ ok:true, n:536, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo536", (req,res)=> res.json({ ok:true, n:536, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping537", (_req,res)=> res.json({ ok:true, n:537, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo537", (req,res)=> res.json({ ok:true, n:537, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping538", (_req,res)=> res.json({ ok:true, n:538, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo538", (req,res)=> res.json({ ok:true, n:538, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping539", (_req,res)=> res.json({ ok:true, n:539, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo539", (req,res)=> res.json({ ok:true, n:539, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping540", (_req,res)=> res.json({ ok:true, n:540, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo540", (req,res)=> res.json({ ok:true, n:540, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping541", (_req,res)=> res.json({ ok:true, n:541, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo541", (req,res)=> res.json({ ok:true, n:541, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping542", (_req,res)=> res.json({ ok:true, n:542, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo542", (req,res)=> res.json({ ok:true, n:542, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping543", (_req,res)=> res.json({ ok:true, n:543, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo543", (req,res)=> res.json({ ok:true, n:543, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping544", (_req,res)=> res.json({ ok:true, n:544, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo544", (req,res)=> res.json({ ok:true, n:544, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping545", (_req,res)=> res.json({ ok:true, n:545, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo545", (req,res)=> res.json({ ok:true, n:545, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping546", (_req,res)=> res.json({ ok:true, n:546, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo546", (req,res)=> res.json({ ok:true, n:546, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping547", (_req,res)=> res.json({ ok:true, n:547, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo547", (req,res)=> res.json({ ok:true, n:547, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping548", (_req,res)=> res.json({ ok:true, n:548, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo548", (req,res)=> res.json({ ok:true, n:548, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping549", (_req,res)=> res.json({ ok:true, n:549, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo549", (req,res)=> res.json({ ok:true, n:549, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping550", (_req,res)=> res.json({ ok:true, n:550, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo550", (req,res)=> res.json({ ok:true, n:550, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping551", (_req,res)=> res.json({ ok:true, n:551, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo551", (req,res)=> res.json({ ok:true, n:551, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping552", (_req,res)=> res.json({ ok:true, n:552, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo552", (req,res)=> res.json({ ok:true, n:552, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping553", (_req,res)=> res.json({ ok:true, n:553, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo553", (req,res)=> res.json({ ok:true, n:553, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping554", (_req,res)=> res.json({ ok:true, n:554, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo554", (req,res)=> res.json({ ok:true, n:554, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping555", (_req,res)=> res.json({ ok:true, n:555, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo555", (req,res)=> res.json({ ok:true, n:555, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping556", (_req,res)=> res.json({ ok:true, n:556, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo556", (req,res)=> res.json({ ok:true, n:556, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping557", (_req,res)=> res.json({ ok:true, n:557, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo557", (req,res)=> res.json({ ok:true, n:557, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping558", (_req,res)=> res.json({ ok:true, n:558, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo558", (req,res)=> res.json({ ok:true, n:558, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping559", (_req,res)=> res.json({ ok:true, n:559, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo559", (req,res)=> res.json({ ok:true, n:559, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping560", (_req,res)=> res.json({ ok:true, n:560, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo560", (req,res)=> res.json({ ok:true, n:560, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping561", (_req,res)=> res.json({ ok:true, n:561, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo561", (req,res)=> res.json({ ok:true, n:561, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping562", (_req,res)=> res.json({ ok:true, n:562, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo562", (req,res)=> res.json({ ok:true, n:562, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping563", (_req,res)=> res.json({ ok:true, n:563, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo563", (req,res)=> res.json({ ok:true, n:563, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping564", (_req,res)=> res.json({ ok:true, n:564, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo564", (req,res)=> res.json({ ok:true, n:564, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping565", (_req,res)=> res.json({ ok:true, n:565, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo565", (req,res)=> res.json({ ok:true, n:565, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping566", (_req,res)=> res.json({ ok:true, n:566, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo566", (req,res)=> res.json({ ok:true, n:566, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping567", (_req,res)=> res.json({ ok:true, n:567, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo567", (req,res)=> res.json({ ok:true, n:567, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping568", (_req,res)=> res.json({ ok:true, n:568, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo568", (req,res)=> res.json({ ok:true, n:568, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping569", (_req,res)=> res.json({ ok:true, n:569, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo569", (req,res)=> res.json({ ok:true, n:569, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping570", (_req,res)=> res.json({ ok:true, n:570, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo570", (req,res)=> res.json({ ok:true, n:570, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping571", (_req,res)=> res.json({ ok:true, n:571, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo571", (req,res)=> res.json({ ok:true, n:571, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping572", (_req,res)=> res.json({ ok:true, n:572, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo572", (req,res)=> res.json({ ok:true, n:572, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping573", (_req,res)=> res.json({ ok:true, n:573, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo573", (req,res)=> res.json({ ok:true, n:573, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping574", (_req,res)=> res.json({ ok:true, n:574, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo574", (req,res)=> res.json({ ok:true, n:574, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping575", (_req,res)=> res.json({ ok:true, n:575, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo575", (req,res)=> res.json({ ok:true, n:575, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping576", (_req,res)=> res.json({ ok:true, n:576, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo576", (req,res)=> res.json({ ok:true, n:576, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping577", (_req,res)=> res.json({ ok:true, n:577, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo577", (req,res)=> res.json({ ok:true, n:577, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping578", (_req,res)=> res.json({ ok:true, n:578, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo578", (req,res)=> res.json({ ok:true, n:578, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping579", (_req,res)=> res.json({ ok:true, n:579, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo579", (req,res)=> res.json({ ok:true, n:579, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping580", (_req,res)=> res.json({ ok:true, n:580, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo580", (req,res)=> res.json({ ok:true, n:580, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping581", (_req,res)=> res.json({ ok:true, n:581, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo581", (req,res)=> res.json({ ok:true, n:581, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping582", (_req,res)=> res.json({ ok:true, n:582, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo582", (req,res)=> res.json({ ok:true, n:582, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping583", (_req,res)=> res.json({ ok:true, n:583, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo583", (req,res)=> res.json({ ok:true, n:583, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping584", (_req,res)=> res.json({ ok:true, n:584, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo584", (req,res)=> res.json({ ok:true, n:584, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping585", (_req,res)=> res.json({ ok:true, n:585, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo585", (req,res)=> res.json({ ok:true, n:585, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping586", (_req,res)=> res.json({ ok:true, n:586, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo586", (req,res)=> res.json({ ok:true, n:586, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping587", (_req,res)=> res.json({ ok:true, n:587, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo587", (req,res)=> res.json({ ok:true, n:587, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping588", (_req,res)=> res.json({ ok:true, n:588, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo588", (req,res)=> res.json({ ok:true, n:588, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping589", (_req,res)=> res.json({ ok:true, n:589, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo589", (req,res)=> res.json({ ok:true, n:589, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping590", (_req,res)=> res.json({ ok:true, n:590, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo590", (req,res)=> res.json({ ok:true, n:590, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping591", (_req,res)=> res.json({ ok:true, n:591, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo591", (req,res)=> res.json({ ok:true, n:591, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping592", (_req,res)=> res.json({ ok:true, n:592, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo592", (req,res)=> res.json({ ok:true, n:592, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping593", (_req,res)=> res.json({ ok:true, n:593, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo593", (req,res)=> res.json({ ok:true, n:593, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping594", (_req,res)=> res.json({ ok:true, n:594, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo594", (req,res)=> res.json({ ok:true, n:594, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping595", (_req,res)=> res.json({ ok:true, n:595, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo595", (req,res)=> res.json({ ok:true, n:595, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping596", (_req,res)=> res.json({ ok:true, n:596, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo596", (req,res)=> res.json({ ok:true, n:596, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping597", (_req,res)=> res.json({ ok:true, n:597, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo597", (req,res)=> res.json({ ok:true, n:597, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping598", (_req,res)=> res.json({ ok:true, n:598, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo598", (req,res)=> res.json({ ok:true, n:598, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping599", (_req,res)=> res.json({ ok:true, n:599, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo599", (req,res)=> res.json({ ok:true, n:599, size: JSON.stringify(req.body||{}).length }));


app.get("/diag/ping600", (_req,res)=> res.json({ ok:true, n:600, ts: Date.now(), rand: Math.random() }));
app.post("/diag/echo600", (req,res)=> res.json({ ok:true, n:600, size: JSON.stringify(req.body||{}).length }));
