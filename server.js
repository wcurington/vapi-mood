// ===========================================================================
// server.js — XXXXL Robust Conversational Guardrail Build (Fully Expanded)
// ===========================================================================
//
// PURPOSE:
// A fortified, production-grade webhook server for Vapi Agent Alex.
// It merges your Guardrail Edition with conversational upgrades and preserves
// every endpoint. It is intentionally verbose for auditability.
//
// ---------------------------------------------------------------------------
// CORE CONVERSATIONAL GUARANTEES
// ---------------------------------------------------------------------------
// 1. Greeting Pause: Always pause 1200ms after greeting.
// 2. "if yes/no" stripped → replaced with natural human acknowledgments.
// 3. Adaptive silence handling for health questions with re-ask potential.
// 4. No robotic labels: never say "Mark 1/2", "Robot Model A", "Unit 3".
// 5. Prices: expanded into full words, spoken slowly and clearly.
// 6. Internal stage directions ("(pause)", "Long Pause") never vocalized.
//
// ---------------------------------------------------------------------------
// CORE TECHNICAL GUARANTEES
// ---------------------------------------------------------------------------
// • Non-destructive: Never overwrite flows_alex_sales.json on disk.
// • Hardened input validation on every entry point.
// • Security: Helmet, rate limiting, JSON body size limits.
// • Resilient state machine: guards against premature payment.
// • Google Sheets integration for outbound call batches + logging.
// • Optional CRM/webhook forwarding (Apps Script, Zoho, etc).
// • Payments: Stripe + Authorize.net stubs for integration.
// • Comprehensive error handling: never crash on malformed input.
// • “Maximum value before price” respected by server and flow.
//
// ===========================================================================

// -------------------- Imports --------------------
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const fetch = require("node-fetch");
const crypto = require("crypto");
const path = require("path");

// Security middleware
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Stripe (optional, lazy load)
let Stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try { Stripe = require("stripe"); } catch { Stripe = null; }
}

// -------------------- Express Init --------------------
const app = express();
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use(bodyParser.json({ limit: "2mb", strict: true }));

// -------------------- Constants --------------------
const HOTLINE = "1-866-379-5131";

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

// Regex helpers
const PROCESSING_LINE = /let me get that processed for you/i;
const NUMBER_WORDS = /point\s*(\d{1,2})/i;

// -------------------- Load Flow JSON --------------------
let salesFlow;
try {
  salesFlow = require(path.join(__dirname, "flows", "flows_alex_sales.json"));
  if (!salesFlow || !salesFlow.states) throw new Error("Invalid flow JSON");
  console.log("✅ Loaded flows_alex_sales.json with states:", Object.keys(salesFlow.states).length);
} catch (e) {
  console.warn("⚠️ Could not load flows JSON:", e.message);
  salesFlow = {
    states: {
      start: { say: "Hi, this is Alex with Health America. How are you today?", tone: "enthusiastic", next: "closing_sale", pauseMs: 1200 },
      closing_sale: { say: `Thanks for your time today. Our care line is ${HOTLINE}.`, tone: "empathetic", end: true }
    }
  };
}

// -------------------- Google Sheets --------------------
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

// -------------------- CRM Hook --------------------
async function crmPost(eventName, payload) {
  const url = process.env.CRM_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ event: eventName, payload })
    });
  } catch (e) {
    console.warn("CRM webhook failed:", e.message);
  }
}

// -------------------- Speech Utilities --------------------
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
    .replace(/\blong\s*pause\b/gi, ""); // never say "Long Pause"
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
function standardizeSpeech(text="") {
  let s = sanitizeCues(text);
  s = stripRoboticLabels(s);
  s = s.replace(/\bfive\s*[-–]?\s*seven\s*days\b/gi, "five to seven days");
  s = s.replace(NUMBER_WORDS, (_, cents) => {
    const n = parseInt(cents, 10);
    return Number.isFinite(n) && n > 0 ? `${n} ${n === 1 ? "cent" : "cents"}` : _;
  });
  s = moneyWordsFromText(s); // expand $… to words (prevents slurring)
  return s;
}
function toSSML(text, settings = toneMap.neutral) {
  const pitch = settings.pitch || "0%";
  const rate = settings.rate || "0%";
  const volume = settings.volume || "medium";
  const safe = standardizeSpeech(text);
  return `<speak><prosody pitch="${pitch}" rate="${rate}" volume="${volume}">${escapeXml(safe)}</prosody></speak>`;
}
function yesNoNormalize(s = "") {
  const t = String(s).toLowerCase();
  if (/(^|\b)(yep|yeah|ya|sure|ok|okay|affirmative|uh huh|yup|please do|go ahead)($|\b)/.test(t)) return "yes";
  if (/(^|\b)(nope|nah|negative|uh uh|not now|maybe later)($|\b)/.test(t)) return "no";
  return s;
}
function acknowledgmentForResponse(resp = "yes") {
  if (resp === "yes") {
    const options = ["Got it.", "Perfect.", "Alright, I see.", "Okay, understood."];
    return options[Math.floor(Math.random()*options.length)];
  } else if (resp === "no") {
    const options = ["No problem.", "That’s okay, we can adjust.", "Alright, I’ll disregard that.", "Got it, moving on."];
    return options[Math.floor(Math.random()*options.length)];
  }
  return "";
}
function isHealthQuestion(nodeId="") {
  return /q\d+_(joint|bp|sleep|health)/i.test(nodeId);
}

// -------------------- SSML Rendering --------------------
function ssmlForNode(node, nodeId, session) {
  const tone = node.tone || "neutral";
  const settings = { ...(toneMap[tone] || toneMap.neutral) };
  let text = node.say || "Let’s continue.";
  text = standardizeSpeech(text);

  // Acknowledgments injected (no literal "if yes/no")
  if (session.lastBranch === "yes") {
    text = acknowledgmentForResponse("yes") + " " + text;
  } else if (session.lastBranch === "no") {
    text = acknowledgmentForResponse("no") + " " + text;
  }

  // Price cadence: slow slightly for clarity
  if (/\b\d+\s*dollars?\b|\b\d+\s*cents?\b|dollars|cents/i.test(text)) {
    settings.rate = "-10%";
    settings.pitch = settings.pitch || "-2%";
  }

  // Greeting pause (hardcoded)
  if (nodeId === "start") {
    return `<speak>${escapeXml(text)}<break time="1200ms"/></speak>`;
  }

  // Processing pause (4s)
  if (PROCESSING_LINE.test(text)) {
    return `<speak>${escapeXml(text)}<break time="4000ms"/></speak>`;
  }

  // Health Qs: extended pause to encourage response (2.5s)
  if (isHealthQuestion(nodeId)) {
    return `<speak>${escapeXml(text)}<break time="2500ms"/></speak>`;
  }

  // Generic per-node pauseMs support
  if (node.pauseMs) {
    return `<speak>${escapeXml(text)}<break time="${Number(node.pauseMs)}ms"/></speak>`;
  }

  return toSSML(text, settings);
}

// -------------------- Currency Helpers --------------------
function toHumanCurrency(cents) {
  const n = Math.max(0, Number.isFinite(cents) ? cents : 0);
  const dollars = Math.floor(n/100);
  const rem = n % 100;
  const centsWords = rem === 0 ? "" : ` and ${rem} ${rem===1?"cent":"cents"}`;
  return `${dollars.toLocaleString()} dollars${centsWords}`;
}
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

// -------------------- Sessions --------------------
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
      lastBranch: null
    };
  }
  return sessions[sessionId];
}

// -------------------- State Machine --------------------
const PAY_WORDS = /(credit|card|pay|payment|checkout|address|ship|shipping|tax|taxes|cvv|zip|bank|routing|account)/i;
const HOTLINE_INTENT = /(service|support|representative|operator|agent|supervisor|help|speak to (a )?human)/i;

function advanceState(session, userInput = "", intent = "") {
  const curr = salesFlow.states[session.state] || {};
  const normalized = yesNoNormalize(userInput);
  const t = String(normalized || "").toLowerCase();

  // Hotline intent at any time
  if (HOTLINE_INTENT.test(t) || HOTLINE_INTENT.test(String(intent))) {
    session.state = "hotline_offer";
    return;
  }

  // Enforce identity capture before any payment pathway if value not completed
  if (PAY_WORDS.test(t) && !session.flags.valueComplete) {
    if (salesFlow.states["identity_intro"]) session.state = "identity_intro";
    return;
  }

  // Normal branch handling (yes/no/hesitate/silence via webhook-level policy)
  if (curr.branches) {
    if (t.includes("yes")) {
      session.state = curr.branches.yes;
      session.lastBranch = "yes";
    } else if (t.includes("no")) {
      session.state = curr.branches.no;
      session.lastBranch = "no";
    } else {
      // hesitate or silence fallback
      session.state = curr.branches.hesitate || curr.branches.silence || curr.next || session.state;
      session.lastBranch = null;
    }
  } else if (curr.next) {
    session.state = curr.next;
    session.lastBranch = null;
  }

  // Mark value complete after we reach identity capture or post-offer accept
  if (session.state === "identity_intro") session.flags.valueComplete = true;
}

// -------------------- Input Validation Middleware --------------------
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

// -------------------- Endpoints --------------------

// Health check / info
app.get("/", (_req, res) => {
  res.send("✅ Alex XXXXL Server online. Endpoints: GET /start-batch, POST /vapi-webhook, POST /vapi-callback, POST /test-price");
});

// Batch Dialer: start next 5 "pending" from Google Sheet
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

      const vapiResp = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: { "Content-Type":"application/json", Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
        body: JSON.stringify(payload)
      });
      const text = await vapiResp.text();
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      results.push({ id, phone, response: parsed });
    }

    res.json({ started: results });
  } catch (e) {
    console.error("start-batch error", e);
    res.status(500).send("start-batch error: " + (e.message || String(e)));
  }
});

// Conversation driver (Vapi webhook)
app.post("/vapi-webhook", (req, res) => {
  try {
    const { sessionId, userInput, intent, cart, plan, bundleCount, membershipDiscount } = req.body || {};
    if (!sessionId) return res.status(400).json({ error:"Missing sessionId" });

    // Load session
    const s = getSession(sessionId);

    // Track cart/plan context if provided
    if (typeof membershipDiscount === "boolean") s.flags.membershipDiscount = membershipDiscount;
    if (Array.isArray(cart)) s.data.cart = cart;
    if (plan) s.data.plan = plan;
    if (bundleCount) s.data.bundleCount = Number(bundleCount);

    // Advance state machine (honors yes/no/hesitate, hotline, value-before-payment)
    const normalized = typeof userInput === "string" ? yesNoNormalize(userInput) : "";
    advanceState(s, normalized, intent);

    // Render node with SSML
    const node = salesFlow.states[s.state] || { say:"Let’s continue.", tone:"neutral" };
    const ssml = ssmlForNode(node, s.state, s);
    const response = {
      say: standardizeSpeech(node.say || "Let’s continue."),
      ssml,
      tone: node.tone || "neutral",
      format: "ssml",
      end: !!node.end
    };

    // Special processing → force 4s pause and route to closing
    if (s.state === "capture_sale") {
      response.say = "Great — let me get that processed for you.";
      response.ssml = `<speak>${escapeXml(response.say)}<break time="4000ms"/></speak>`;
      response.tone = "absolute_certainty";
      s.state = "closing_sale";
    }

    // Ensure shipping window phrasing is present on readback/closing
    if (/closing_sale|readback_confirm/i.test(s.state)) {
      if (!/five to seven days/i.test(response.say)) {
        response.say = (response.say + " Delivery is in five to seven days.").trim();
        response.ssml = toSSML(response.say, toneMap[node.tone || "neutral"]);
      }
    }

    return res.json(response);
  } catch (e) {
    console.error("vapi-webhook error", e);
    return res.status(200).json({
      say: "Thanks for your time today.",
      ssml: toSSML("Thanks for your time today.", toneMap.neutral),
      tone: "neutral",
      format: "ssml",
      end: true
    });
  }
});

// Callback after call ends; log to Google Sheets (+ optional Apps Script + CRM)
app.post("/vapi-callback", async (req, res) => {
  try {
    const { metadata, status, result, summary, outcome, declineReason } = req.body || {};
    const id = metadata?.id;
    const rowIndex = metadata?.rowIndex;
    if (!SHEET_ID) throw new Error("Missing SPREADSHEET_ID");
    if (!id || !rowIndex) throw new Error("Missing metadata.id/rowIndex");

    const auth = await getAuth();
    const sheets = google.sheets({ version:"v4", auth });

    // Read header indices
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

    const updates = [
      { range: `${SHEET_NAME}!R${rowIndex}C${statusIdx}`,       values: [[status || "completed"]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${attemptsIdx}`,     values: [[currentAttempts + 1]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${lastAttemptIdx}`,  values: [[new Date().toISOString()]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${resultIdx}`,       values: [[result || outcome || ""]] }
    ];
    if (notesIdx > 0) {
      updates.push({ range: `${SHEET_NAME}!R${rowIndex}C${notesIdx}`, values: [[summary || declineReason || ""]] });
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption:"RAW", data: updates }
    });

    // Optional forwards
    if (process.env.APPS_SCRIPT_URL) {
      try {
        await fetch(process.env.APPS_SCRIPT_URL, {
          method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(req.body)
        });
      } catch (err) { console.warn("Apps Script forward failed:", err.message); }
    }
    await crmPost("call_callback", { id, status, outcome, summary, declineReason });

    res.send("ok");
  } catch (e) {
    console.error("vapi-callback error", e);
    res.status(500).send("callback error: " + (e.message || String(e)));
  }
});

// Dev Tool: Price Probe
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

// -------------------- Payments (stubs) --------------------
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
async function chargeWithAuthorizeNet({ amountCents, description, metadata }) {
  if (!process.env.AUTHNET_LOGIN_ID || !process.env.AUTHNET_TRANSACTION_KEY) {
    return { ok:false, reason:"authnet_unconfigured" };
  }
  // For sandboxing: artificially decline odd cents totals to simulate failures.
  const fail = (amountCents % 2) === 1;
  if (fail) return { ok:false, reason:"card_declined" };
  return { ok:true, id: crypto.randomUUID(), status:"approved" };
}

// Decline flow helper
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

// -------------------- Start Server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Alex XXXXL Server running on :${PORT}`));
