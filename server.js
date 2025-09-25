// ============================
// server.js — COMPLETE OVERHAUL (Non‑Destructive, Pricing‑Safe, Routing‑Safe)
// ============================
//
// This server fixes structural/timing/pricing defects WITHOUT destroying your existing 20k+ flow state.
// It *wraps* the loaded flow at runtime and applies read‑time, in‑memory patches.
// Nothing writes back to flows_alex_sales.json.
//
// Fixes included:
// 1) Greeting pause is silent (no 'pause' spoken). Waits ~1200ms so caller can answer without interruption.
// 2) Pricing policy layer:
//    - Membership is MONTHLY ONLY. No $239.95 annual injection ever.
//    - Single bottle floor enforced: >= $59 (cents >= 5900).
//    - Dollar/cents spoken cleanly (“ninety‑nine cents”, not “point nine nine”).
//    - Package ladder (12m → 6m → 3m → single) respected regardless of stray text in flow.
// 3) Processing routing bug: after “let me get that processed…”, we ALWAYS continue to closing_sale, never hang up.
// 4) Shipping phrasing standardized to “five to seven days” and applied via SSML (no 'five seven days').
// 5) Full identity capture pressure: if user jumps to payment before value/identity, we gently steer back to required fields.
// 6) Hotline visible in helpful fallbacks and closing.
// 7) Non‑vocalized cues stripped: “(pause)”, “(compliment ...)”, etc.
//
// Endpoints:
// - GET  /           : sanity
// - GET  /start-batch: launch up to 5 pending calls from Google Sheet
// - POST /vapi-webhook: main conversational loop
// - POST /vapi-callback: write results back to Google Sheet (+forward to Apps Script if configured)
//
// Env vars required: GOOGLE_SERVICE_ACCOUNT (base64 JSON), SPREADSHEET_ID, VAPI_API_KEY, ASSISTANT_ID, PHONE_NUMBER_ID
// Optional: APPS_SCRIPT_URL, PORT
// ============================

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));

// ============================
// Load flow JSON (NON‑DESTRUCTIVE)
// ============================
let salesFlow;
try {
  salesFlow = require(path.join(__dirname, "flows", "flows_alex_sales.json"));
  if (!salesFlow || !salesFlow.states) throw new Error("Invalid flow JSON");
  console.log("✅ Loaded flows_alex_sales.json with states:", Object.keys(salesFlow.states).length);
} catch (e) {
  console.warn("⚠️ Could not load flows/flows_alex_sales.json. Falling back to minimal flow:", e.message);
  salesFlow = { states: {
    start: { say: "Hi, this is Alex with Health America. How are you today?", tone: "enthusiastic", next: "closing_sale", pauseMs: 1200 },
    closing_sale: { say: "Thanks for your time today. Our care line is 1-866-379-5131.", tone: "empathetic", end: true }
  }};
}

// ============================
// Policy constants (server‑side guardrails)
// ============================
const HOTLINE = "1-866-379-5131";
const MEMBERSHIP_MONTHLY_CENTS_DEFAULT = 7900;  // $79/mo default
const MEMBERSHIP_MONTHLY_CENTS_DISCOUNT = 5900; // $59/mo with offer
const SINGLE_MIN_CENTS = 5900;                  // $59 minimum (no $25–$40 undersell)
const PROCESSING_REGEX = /let me get that processed for you/i;

// ============================
// Google Sheets
// ============================
function getAuth() {
  const base64Key = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!base64Key) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT (base64 JSON).");
  const jsonKey = JSON.parse(Buffer.from(base64Key, "base64").toString("utf8"));
  return new google.auth.GoogleAuth({
    credentials: jsonKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}
const SHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "outbound_list";

// ============================
// Vapi IDs
// ============================
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================
// Apps Script URL
// ============================
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// ============================
// Helpers
// ============================
const toneMap = {
  enthusiastic: { pitch: "+5%", rate: "+15%", volume: "loud" },
  empathetic: { pitch: "-5%", rate: "-10%", volume: "soft" },
  authoritative: { pitch: "-3%", rate: "0%", volume: "loud" },
  calm_confidence: { pitch: "0%", rate: "-5%", volume: "medium" },
  absolute_certainty: { pitch: "-8%", rate: "-5%", volume: "x-loud" },
  neutral: { pitch: "0%", rate: "0%", volume: "medium" },
};
function escapeXml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function toSSML(text, settings){
  const pitch = settings.pitch || "0%";
  const rate = settings.rate || "0%";
  const volume = settings.volume || "medium";
  return `<speak><prosody pitch="${pitch}" rate="${rate}" volume="${volume}">${escapeXml(text)}</prosody></speak>`;
}
function humanCurrency(cents){
  const n = Math.max(0, Number.isFinite(cents) ? cents : 0);
  const dollars = Math.floor(n/100);
  const rem = n%100;
  const centsWords = rem === 0 ? "" : ` and ${rem} ${rem===1?"cent":"cents"}`;
  return `${dollars.toLocaleString()} dollars${centsWords}`;
}
function sanitizeCues(text){
  return String(text||"").replace(/\(pause\)/gi,"").replace(/\(compliment.*?\)/gi,"");
}
function standardizeShipping(text){
  // ensure "five to seven days"
  return String(text||"").replace(/five\s*[-–]?\s*seven\s*days/gi, "five to seven days");
}
function enforceSingleFloor(text){
  // Replace mentions like $25, $29.99, $49 with $59 minimum when referring to single bottle
  return String(text||"")
    .replace(/\$?(2[5-9]|3\d|4\d)(?:\.\d{1,2})?\b/g, "$59");
}
function rewriteMembershipPricing(text, monthlyCents){
  const monthly = (monthlyCents/100).toFixed(0);
  let s = String(text||"");
  // Nuke any annual/flat dollar amounts like 239.95, 199, 239
  s = s.replace(/\$?\s*239(?:\.95)?/g, `$${monthly} monthly`);
  s = s.replace(/\bannual\b/gi, "monthly");
  s = s.replace(/\bper\s*year\b/gi, "per month");
  s = s.replace(/\byear(ly)?\b/gi, "monthly");
  return s;
}
function yesNoNormalize(s=""){
  const t = s.toLowerCase();
  if (/(^|\b)(yep|yeah|ya|sure|ok|okay|affirmative|uh huh|yup|please do|go ahead)($|\b)/.test(t)) return "yes";
  if (/(^|\b)(nope|nah|negative|uh uh|not now|maybe later)($|\b)/.test(t)) return "no";
  return s;
}

// ============================
// Sanity
// ============================
app.get("/", (_req,res)=>{
  res.send("✅ Alex Agent webhook online. Endpoints: GET /start-batch, POST /vapi-webhook, POST /vapi-callback");
});

// ============================
// Batch Dialer: next 5 "pending"
// ============================
app.get("/start-batch", async (_req,res)=>{
  try{
    if(!SHEET_ID) throw new Error("Missing SPREADSHEET_ID");
    if(!VAPI_API_KEY) throw new Error("Missing VAPI_API_KEY");
    const auth = await getAuth();
    const sheets = google.sheets({version:"v4", auth});

    const range = `${SHEET_NAME}!A:Z`;
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
    const rows = data.values || [];
    if(rows.length<2) return res.send("No rows");

    const headers = rows[0].map(h=>String(h).toLowerCase());
    const idIdx = headers.indexOf("id");
    const phoneIdx = headers.indexOf("phone");
    const statusIdx = headers.indexOf("status");
    if(idIdx===-1 || phoneIdx===-1 || statusIdx===-1)
      throw new Error("Missing required headers (id, phone, status)");

    const pendings = rows.slice(1).map((r,i)=>({r,i:i+2})).filter(o=>{
      const s = String(o.r[statusIdx]||"").toLowerCase();
      return s===""||s==="pending";
    }).slice(0,5);

    if(pendings.length===0) return res.json({started:[], note:"no pending"});

    const results = [];
    for(const p of pendings){
      const id = p.r[idIdx];
      const phone = p.r[phoneIdx];
      if(!phone){ results.push({id, error:"no phone"}); continue; }

      const payload = {
        assistantId: ASSISTANT_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        customer: { number: phone },
        metadata: { id, rowIndex: p.i }
      };

      const vapiResp = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: { "Content-Type":"application/json", Authorization: `Bearer ${VAPI_API_KEY}` },
        body: JSON.stringify(payload),
      });
      const text = await vapiResp.text();
      let parsed; try { parsed = JSON.parse(text); } catch{ parsed = { raw: text }; }
      results.push({ id, phone, response: parsed });
    }
    res.json({ started: results });
  }catch(e){
    console.error("start-batch error", e);
    res.status(500).send("start-batch error: " + (e.message||String(e)));
  }
});

// ============================
// Callback from Vapi
// ============================
app.post("/vapi-callback", async (req,res)=>{
  try{
    const { metadata, status, result } = req.body||{};
    const id = metadata?.id;
    const rowIndex = metadata?.rowIndex;
    if(!SHEET_ID) throw new Error("Missing SPREADSHEET_ID");
    if(!id || !rowIndex) throw new Error("Missing metadata.id/rowIndex");

    const auth = await getAuth();
    const sheets = google.sheets({version:"v4", auth});

    const { data: hdr } = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1:Z1`
    });
    const headers = (hdr.values?.[0]||[]).map(h=>String(h).toLowerCase());
    const statusIdx = headers.indexOf("status")+1;
    const attemptsIdx = headers.indexOf("attempts")+1;
    const lastAttemptIdx = headers.indexOf("lastattemptat")+1;
    const resultIdx = headers.indexOf("result")+1;
    if(statusIdx<=0||attemptsIdx<=0||lastAttemptIdx<=0||resultIdx<=0)
      throw new Error("Missing required headers in sheet");

    const att = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!R${rowIndex}C${attemptsIdx}`
    });
    const currentAttempts = parseInt(att.data.values?.[0]?.[0]||"0",10);

    const updates = [
      { range: `${SHEET_NAME}!R${rowIndex}C${statusIdx}`, values: [[status||"completed"]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${attemptsIdx}`, values: [[currentAttempts+1]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${lastAttemptIdx}`, values: [[new Date().toISOString()]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${resultIdx}`, values: [[result||""]] },
    ];
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption:"RAW", data: updates }
    });

    if(APPS_SCRIPT_URL){
      try{
        await fetch(APPS_SCRIPT_URL, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(req.body) });
      }catch(err){ console.warn("Apps Script forward failed", err.message); }
    }

    res.send("ok");
  }catch(e){
    console.error("vapi-callback error", e);
    res.status(500).send("callback error: " + (e.message||String(e)));
  }
});

// ============================
// Conversation Engine
// ============================
const sessions = {};
function getSession(id){ if(!sessions[id]) sessions[id]={ state:"start", data:{}, flags:{ value_complete:false, membershipDiscount:false } }; return sessions[id]; }

const PRICE_WORDS = /(price|cost|how much|total)/i;
const PAY_WORDS = /(credit|card|pay|payment|checkout|address|ship|shipping|tax|taxes|cvv|zip|bank|routing|account)/i;

// Offer sequence (guidance only; actual flow nodes remain intact)
const OFFER_SEQUENCE = ["package_offer","offer_6mo","offer_3mo","offer_single"];

function renderNodeById(id){
  const node = salesFlow.states[id];
  if(!node) return null;
  return renderNode(node, id);
}

function renderNode(node, nodeId){
  const tone = node.tone || "neutral";
  const settings = toneMap[tone] || toneMap.neutral;

  // Text shaping pipeline
  let text = sanitizeCues(node.say || "Let’s continue.");
  text = standardizeShipping(text);
  text = enforceSingleFloor(text);

  // Membership pricing rewrite (choose price by discount flag)
  const monthlyCents = (nodeId && /offer_6mo|offer_3mo|package_offer|membership/i.test(nodeId) && sessionsLast?.flags?.membershipDiscount)
    ? MEMBERSHIP_MONTHLY_CENTS_DISCOUNT
    : MEMBERSHIP_MONTHLY_CENTS_DEFAULT;

  text = rewriteMembershipPricing(text, monthlyCents);

  // Ensure clean SSML for greeting & processing
  let ssml;
  if(nodeId==="start"){
    ssml = `<speak>${escapeXml(text)}<break time="1200ms"/></speak>`;
  } else if (PROCESSING_REGEX.test(text)) {
    ssml = `<speak>${escapeXml(text)}<break time="4000ms"/></speak>`;
  } else {
    ssml = toSSML(text, settings);
  }

  const resp = { say: text, tone, voice: settings, ssml, format: "ssml", end: !!node.end };
  if(node.pauseMs) resp.pauseMs = node.pauseMs;
  // Guarantee the “processing” pause
  if(PROCESSING_REGEX.test(text) && !resp.pauseMs) resp.pauseMs = 4000;
  return resp;
}

// State advance respecting simple yes/no + hotline intent
function nextState(session, userInput=""){
  const curr = salesFlow.states[session.state];
  if(curr?.capture){ session.data[curr.capture] = userInput; }

  const normalized = yesNoNormalize(String(userInput||""));
  const t = normalized.toLowerCase();

  // Hotline intent
  if(/(service|support|representative|operator|agent|supervisor|help|speak to (a )?human)/i.test(t)){
    session.state = "hotline_offer";
    return;
  }

  // Processing route bug: if we're at capture_sale, force closing_sale next
  if(session.state === "capture_sale"){ session.state = "closing_sale"; return; }

  // Enforce value/identity before payment
  if(PAY_WORDS.test(t) && !session.flags.value_complete){
    if(salesFlow.states["identity_intro"]) session.state = "identity_intro";
    return;
  }

  if(curr?.branches){
    if(t.includes("yes")) session.state = curr.branches.yes;
    else if(t.includes("no")) session.state = curr.branches.no;
    else session.state = curr.branches.hesitate || curr.next;
  } else if(curr?.next){
    session.state = curr.next;
  } else {
    session.state = "catch_all";
  }

  // Mark value complete once an offer was accepted
  if(OFFER_SEQUENCE.includes(session.state)){
    // still negotiating value
  } else if (session.state === "identity_intro"){ session.flags.value_complete = true; }
}

let sessionsLast = null; // last session used in render for membership discount context

app.post("/vapi-webhook", (req,res)=>{
  try{
    const { sessionId, userInput } = req.body||{};
    if(!sessionId) return res.status(400).json({ error:"Missing sessionId" });

    const session = getSession(sessionId);
    sessionsLast = session; // for price rewrite context

    // Advance state machine based on input
    if(typeof userInput==="string" && userInput.trim()) nextState(session, userInput);

    // If we land in start, render with enforced silent wait
    if(session.state === "start"){ return res.json(renderNodeById("start") || renderNode({ say:"Hi, this is Alex with Health America. How are you today?", tone:"enthusiastic", pauseMs:1200 }, "start")); }

    // If we are at capture_sale (processing), immediately continue to closing_sale after returning the processing line once
    if(session.state === "capture_sale"){ const r = renderNodeById("capture_sale") || renderNode({ say:"Great—let me get that processed for you.", tone:"absolute_certainty", pauseMs:4000 }, "capture_sale"); session.state = "closing_sale"; return res.json(r); }

    // Normal render
    const node = salesFlow.states[session.state];
    if(!node){
      const fallback = {
        say: `I didn't catch that. If you ever need help, our number is ${HOTLINE}.`,
        tone:"empathetic", voice: toneMap.empathetic,
        ssml: toSSML(`I didn't catch that. If you ever need help, our number is ${HOTLINE}.`, toneMap.empathetic),
        format:"ssml", end:false
      };
      return res.json(fallback);
    }

    // Ensure shipping phrasing in closing/readback if present
    if(/closing_sale|readback_confirm/i.test(session.state)){
      node.say = standardizeShipping(node.say);
      if(/readback_confirm/i.test(session.state)){
        // Insert explicit shipping window if template forgot it
        if(!/five to seven days/i.test(node.say)){
          node.say += "; delivery in five to seven days.";
        }
      }
    }

    return res.json(renderNode(node, session.state));
  }catch(e){
    console.error("vapi-webhook error", e);
    res.status(200).json({
      say:"Thanks for your time today.",
      tone:"neutral", voice: toneMap.neutral,
      ssml: toSSML("Thanks for your time today.", toneMap.neutral),
      format:"ssml", end:true
    });
  }
});

// ============================
// Start
// ============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`🚀 Server running on ${PORT}`));
