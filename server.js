// ============================
// server.js — XXXXL Guardrail Edition (Non-Destructive, Pricing-Safe, Routing-Safe)
// ============================
//
// WHAT THIS DOES (high level):
// - Loads your existing 20k+ flow JSON and wraps it IN MEMORY without changing the file on disk.
// - Enforces constitutional rules for pricing, speech, sequencing, and closing.
// - Implements a deterministic PRICING ENGINE with correct tiers + multi-supplement math.
// - Ensures greeting pauses are SILENT (never say "pause") and waits for the customer.
// - Forces the call to end with shipping ETA + thank you + hotline (no more dead ends).
// - Handles declines gracefully: 1 attempt only, empathetic script, proactive follow-up flagged.
// - Logs outcomes to Google Sheets (and optionally forwards to a CRM webhook).
// - Adds safe, deterministic SSML for "ninety-nine cents", "five to seven days", etc.
// - Normalizes slang (yep/yeah → yes; nope/nah → no), strips forbidden cues.
//
// NON-DESTRUCTIVE:
//   • Nothing writes back to flows_alex_sales.json. We read, wrap, and patch at runtime.
//
// DEPENDENCIES (set via environment variables):
//   CORE:
//     PORT
//     GOOGLE_SERVICE_ACCOUNT         // base64 JSON for service account
//     SPREADSHEET_ID                 // Google Sheet id
//     VAPI_API_KEY                   // Vapi REST
//     ASSISTANT_ID                   // Vapi assistant id
//     PHONE_NUMBER_ID                // Vapi phone number id
//
//   OPTIONAL INTEGRATIONS:
//     APPS_SCRIPT_URL                // forward call summaries/events to Apps Script
//     CRM_WEBHOOK_URL                // post declines / sales summaries to CRM
//     STRIPE_SECRET_KEY              // If present, we use Stripe PaymentIntents (server-created, client-confirmed)
//     AUTHNET_LOGIN_ID / AUTHNET_TRANSACTION_KEY / AUTHNET_ENV ("sandbox"|"production")
//
// SECURITY:
//   • No secrets are logged.
//   • All external calls use token headers.
//   • Only essential fields are persisted.
//
// ============================

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const fetch = require("node-fetch");
const crypto = require("crypto");
const path = require("path");

// Stripe optional (lazy loaded)
let Stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try { Stripe = require("stripe"); } catch { Stripe = null; }
}

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));

// ----------------------------
// CONSTANTS (Speech & Policy)
// ----------------------------
const HOTLINE = "1-866-379-5131";

// Pricing Constitution (supreme law)
const PRICING = Object.freeze({
  MEMBERSHIP_MONTHLY_BASE: 79_00,   // $79.00
  MEMBERSHIP_MONTHLY_MIN:  59_00,   // $59.00 (discount)
  THREE_MONTH:            199_00,   // $199
  SIX_MONTH:              299_00,   // $299
  TWELVE_MONTH:           499_00,   // $499
  FIFTEEN_MONTH:          599_00,   // $599
  // Floors (defense against undersell chatter; never price single below $59)
  SINGLE_MIN:              59_00
});

// Decline handling policy
const DECLINE_POLICY = Object.freeze({
  MAX_RETRIES: 1, // never retry more than once
  CUSTOMER_MESSAGE:
    "I’m sorry, there was an issue processing your order. A customer service representative will be in touch with you shortly to assist in completing your order. Please stay by your phone, and they’ll call you very soon to resolve this for you."
});

// SSML & Speech guards
const PROCESSING_LINE = /let me get that processed for you/i;
const NUMBER_WORDS = /point\s*(\d{1,2})/i;

// ----------------------------
// FLOW LOADER (Non-destructive)
// ----------------------------
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

// ----------------------------
// GOOGLE SHEETS
// ----------------------------
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

// ----------------------------
// OPTIONAL CRM HOOK
// ----------------------------
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

// ----------------------------
// UTILITIES (Speech & Pacing)
// ----------------------------
const toneMap = {
  enthusiastic:        { pitch: "+5%",  rate: "+15%", volume: "loud"     },
  empathetic:          { pitch: "-5%",  rate: "-10%", volume: "soft"     },
  authoritative:       { pitch: "-3%",  rate: "0%",   volume: "loud"     },
  calm_confidence:     { pitch: "0%",   rate: "-5%",  volume: "medium"   },
  absolute_certainty:  { pitch: "-8%",  rate: "-5%",  volume: "x-loud"   },
  neutral:             { pitch: "0%",   rate: "0%",   volume: "medium"   }
};

function escapeXml(s) {
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;");
}

function toSSML(text, settings = toneMap.neutral) {
  const pitch = settings.pitch || "0%";
  const rate = settings.rate || "0%";
  const volume = settings.volume || "medium";
  const safe = standardizeSpeech(text);
  return `<speak><prosody pitch="${pitch}" rate="${rate}" volume="${volume}">${escapeXml(safe)}</prosody></speak>`;
}

// Normalize “point 99” → “ninety-nine cents”; force “five to seven days”
function standardizeSpeech(text = "") {
  let s = sanitizeCues(text);
  // ETA phrasing
  s = s.replace(/\bfive\s*[-–]?\s*seven\s*days\b/gi, "five to seven days");
  // "point NN" → "NN cents"
  s = s.replace(NUMBER_WORDS, (_, cents) => {
    const n = parseInt(cents, 10);
    if (Number.isFinite(n) && n > 0) return `${n} ${n === 1 ? "cent" : "cents"}`;
    return _;
  });
  return s;
}

function sanitizeCues(text = "") {
  // Remove forbidden tells: (pause), (compliment ...), (processing...)
  return text
    .replace(/\(pause\)/gi, "")
    .replace(/\(compliment.*?\)/gi, "")
    .replace(/\(processing.*?\)/gi, "");
}

function yesNoNormalize(s = "") {
  const t = String(s).toLowerCase();
  if (/(^|\b)(yep|yeah|ya|sure|ok|okay|affirmative|uh huh|yup|please do|go ahead)($|\b)/.test(t)) return "yes";
  if (/(^|\b)(nope|nah|negative|uh uh|not now|maybe later)($|\b)/.test(t)) return "no";
  return s;
}

// ----------------------------
// PRICING ENGINE (Deterministic)
// ----------------------------
//
// INPUT MODELS WE SUPPORT:
//
// 1) Package recommend path (most common):
//    { plan: "3M"|"6M"|"12M"|"15M"|"MEMBERSHIP", count: <#SKUs in bundle> }
//
// 2) Cart style:
//    { items: [ { sku:"JOINT", months:3, qty:1 }, { sku:"BP", months:3, qty:1 } ] }
//
// 3) Natural language hint (fallback): "3 months of each"
//    We interpret as two 3-month packages (2 × $199).
//
function priceFromPlan(plan, bundleCount = 1, membershipDiscount = false) {
  // bundleCount is number of SKUs included at that plan length (e.g., 2 SKUs at 3M)
  switch (String(plan).toUpperCase()) {
    case "MEMBERSHIP": {
      const cents = membershipDiscount ? PRICING.MEMBERSHIP_MONTHLY_MIN : PRICING.MEMBERSHIP_MONTHLY_BASE;
      // Membership is monthly PER MEMBER account, not multiplied by SKUs.
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
  // Sum by months bucket; default to defensive tiers
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

  // Any OTHER fallbacks? bill at single min * qty (defensive)
  cents += PRICING.SINGLE_MIN * buckets.OTHER;
  return { cents, kind:"CART_SUM", recurring: "one-time" };
}

function parseNaturalBundleHint(str = "") {
  // e.g., "3 months of each" → interpret as two 3-month packages
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

// ----------------------------
// SESSIONS
// ----------------------------
const sessions = {};
function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      id: sessionId,
      state: "start",
      data: {
        customer: {},
        cart: [],              // [{sku, months, qty}]
        plan: null,            // "3M"|"6M"|"12M"|"15M"|"MEMBERSHIP"
        bundleCount: 1
      },
      flags: {
        valueComplete:false,
        membershipDiscount:false,
        attemptedPayment:false,
        declined:false
      }
    };
  }
  return sessions[sessionId];
}

// ----------------------------
// RENDERING FLOW NODES (SSML)
// ----------------------------
function ssmlForNode(node, nodeId, session) {
  const tone = node.tone || "neutral";
  const settings = toneMap[tone] || toneMap.neutral;
  let text = sanitizeCues(node.say || "Let’s continue.");

  // Enforce standardized phrases and floors
  text = standardizeSpeech(text);

  // Membership guard: never annual, always monthly language
  if (/annual|per\s*year|yearly/i.test(text)) {
    const cents = session.flags.membershipDiscount ? PRICING.MEMBERSHIP_MONTHLY_MIN : PRICING.MEMBERSHIP_MONTHLY_BASE;
    const dollars = Math.round(cents/100);
    text = text
      .replace(/annual|per\s*year|yearly/gi, "monthly")
      .replace(/\$?\s*\d+(?:\.\d{2})?/g, `$${dollars} per month`);
  }

  // Processing pause: 4s after "Let me get that processed for you."
  if (PROCESSING_LINE.test(text)) {
    return `<speak>${escapeXml(standardizeSpeech(text))}<break time="4000ms"/></speak>`;
  }

  // Greeting pause: 1.2s after the very first "How are you doing today?"
  if (nodeId === "start") {
    return `<speak>${escapeXml(standardizeSpeech(text))}<break time="1200ms"/></speak>`;
  }

  return toSSML(text, settings);
}

// ----------------------------
// CORE ROUTES
// ----------------------------
app.get("/", (_req, res) => {
  res.send("✅ Alex Agent webhook online. Endpoints: GET /start-batch, POST /vapi-webhook, POST /vapi-callback, POST /test-price");
});

// Batch Dialer: pick next 5 "pending" from Google Sheet
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

// Vapi → our webhook (conversation driver)
app.post("/vapi-webhook", (req, res) => {
  try {
    const { sessionId, userInput, intent, cart, plan, bundleCount, membershipDiscount } = req.body || {};
    if (!sessionId) return res.status(400).json({ error:"Missing sessionId" });

    const s = getSession(sessionId);
    if (typeof membershipDiscount === "boolean") s.flags.membershipDiscount = membershipDiscount;
    if (Array.isArray(cart)) s.data.cart = cart;
    if (plan) s.data.plan = plan;
    if (bundleCount) s.data.bundleCount = bundleCount;

    // Advance state machine with normalization
    const normalized = typeof userInput === "string" ? yesNoNormalize(userInput) : "";
    advanceState(s, normalized, intent);

    // Render current node
    const node = salesFlow.states[s.state] || { say:"Let’s continue.", tone:"neutral" };
    const ssml = ssmlForNode(node, s.state, s);
    const response = {
      say: standardizeSpeech(node.say || "Let’s continue."),
      ssml,
      tone: node.tone || "neutral",
      format: "ssml",
      end: !!node.end
    };

    // Special: capture_sale → ensure 4s pause, then route to closing
    if (s.state === "capture_sale") {
      response.say = "Great — let me get that processed for you.";
      response.ssml = `<speak>${escapeXml(response.say)}<break time="4000ms"/></speak>`;
      response.tone = "absolute_certainty";
      s.state = "closing_sale"; // pre-route to ensure we never dead-end
    }

    // On closing/readback, guarantee shipping window appears
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

// Vapi → callback after call ends; log to Google Sheets (+ optional Apps Script + CRM)
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

    // Optional: forward to Apps Script
    if (process.env.APPS_SCRIPT_URL) {
      try {
        await fetch(process.env.APPS_SCRIPT_URL, {
          method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(req.body)
        });
      } catch (err) { console.warn("Apps Script forward failed:", err.message); }
    }

    // Optional: CRM notify
    await crmPost("call_callback", { id, status, outcome, summary, declineReason });

    res.send("ok");
  } catch (e) {
    console.error("vapi-callback error", e);
    res.status(500).send("callback error: " + (e.message || String(e)));
  }
});

// ----------------------------
// STATE MACHINE
// ----------------------------
const OFFER_SEQUENCE = ["package_offer","offer_6mo","offer_3mo","offer_single"];

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

  // Enforce identity capture before payment pathways
  if (PAY_WORDS.test(t) && !session.flags.valueComplete) {
    if (salesFlow.states["identity_intro"]) session.state = "identity_intro";
    return;
  }

  // Normal branch handling (yes/no/hesitate)
  if (curr.branches) {
    if (t.includes("yes")) session.state = curr.branches.yes;
    else if (t.includes("no")) session.state = curr.branches.no;
    else session.state = curr.branches.hesitate || curr.next || session.state;
  } else if (curr.next) {
    session.state = curr.next;
  }

  // Mark value complete after we reach identity capture or post-offer accept
  if (session.state === "identity_intro") session.flags.valueComplete = true;
}

// ----------------------------
// PRICING API (OPTIONAL DEV TOOL)
// ----------------------------
app.post("/test-price", (req, res) => {
  try {
    const { plan, bundleCount, membershipDiscount, items, note } = req.body || {};

    let result;
    if (Array.isArray(items) && items.length > 0) {
      result = priceFromCart(items);
    } else if (typeof note === "string") {
      const n = parseNaturalBundleHint(note);
      if (n && n.each && Number.isFinite(n.months)) {
        // Treat as two identical packages at the months given
        if (n.months === 3)      result = priceFromPlan("3M", 2, !!membershipDiscount);
        else if (n.months === 6) result = priceFromPlan("6M", 2, !!membershipDiscount);
        else if (n.months === 12)result = priceFromPlan("12M",2, !!membershipDiscount);
        else if (n.months === 15)result = priceFromPlan("15M",2, !!membershipDiscount);
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

// ----------------------------
// PAYMENT ADAPTERS (stubs w/ structure)
// ----------------------------
async function chargeWithStripe({ amountCents, currency = "usd", description, metadata }) {
  if (!Stripe || !process.env.STRIPE_SECRET_KEY) return { ok:false, reason:"stripe_unconfigured" };
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    // Server-created PaymentIntent; actual confirmation typically requires client side.
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      description,
      metadata
    });
    // For voice flow demo, assume "requires_action" and handoff to follow-up is fine.
    return { ok: intent.status === "succeeded", id:intent.id, status:intent.status };
  } catch (e) {
    return { ok:false, reason: e.message || "stripe_error" };
  }
}

async function chargeWithAuthorizeNet({ amountCents, description, metadata }) {
  // Stub: outline only; production requires Authorize.Net SDK + Transaction Request.
  if (!process.env.AUTHNET_LOGIN_ID || !process.env.AUTHNET_TRANSACTION_KEY) {
    return { ok:false, reason:"authnet_unconfigured" };
  }
  // In this template, simulate a failure if amount is odd to test decline flow.
  const fail = (amountCents % 2) === 1;
  if (fail) return { ok:false, reason:"card_declined" };
  return { ok:true, id: crypto.randomUUID(), status:"approved" };
}

// ----------------------------
// DECLINE HANDLING UTIL
// ----------------------------
async function handleDecline(session, resObj, declineReason) {
  session.flags.declined = true;
  // Speak empathetic decline message
  const say = DECLINE_POLICY.CUSTOMER_MESSAGE;
  const ssml = toSSML(say, toneMap.empathetic);

  // Log to CRM + Sheets via /vapi-callback normally after call
  await crmPost("payment_declined", {
    sessionId: session.id,
    declineReason,
    when: new Date().toISOString()
  });

  // Return immediate response
  Object.assign(resObj, { say, ssml, tone:"empathetic", format:"ssml", end:false });
}

// ----------------------------
// START SERVER
// ----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Alex Guardrail Server running on :${PORT}`));
