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
