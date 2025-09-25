// ============================
// server.js – Vapi Tone-Aware Batch Dialer + Webhook (XXXL EDITION)
// ============================
//
// ⚠️ CRITICAL DIRECTIVE ⚠️
// 1) Respect flows that enforce "Maximum Value Before Price".
// 2) STRICT offer step-down: annual/membership → 6mo → 3mo → single.
// 3) NEVER strip or overwrite these principles; only add refinements.
//
// Features:
// - /start-batch (reads Google Sheet "outbound_list", launches 5 pending calls per batch)
// - /vapi-webhook (tone-aware, pauseMs, slang yes/no mapping, hotline routing, currency speech, address pacing)
// - /vapi-callback (logs results back to Google Sheets and forwards to Apps Script)
// - SSML prosody + non-vocalized cues (no literal "pause" spoken)
// - 4s processing pause after "let me get that processed for you"
// - Hotline available: 1-866-379-5131
// - Uses env: GOOGLE_SERVICE_ACCOUNT (base64), SPREADSHEET_ID, VAPI_API_KEY, ASSISTANT_ID, PHONE_NUMBER_ID, APPS_SCRIPT_URL, PORT

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));

// ==== Load Flow JSON ====
let salesFlow;
try {
  salesFlow = require(path.join(__dirname, "flows", "flows_alex_sales.json"));
  console.log("✅ Loaded sales flow JSON with states:", Object.keys(salesFlow.states || {}).length);
} catch (err) {
  console.warn("⚠️ flows/flows_alex_sales.json not found/invalid; using tiny fallback");
  salesFlow = { states: { start: { say: "Hello, this is Alex.", tone: "neutral", end: true } } };
}

// ============================
// Google Sheets Setup
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
const HOTLINE = "1-866-379-5131";

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
function yesNoNormalize(s=""){
  const t = s.toLowerCase();
  if (/(^|\b)(yep|yeah|ya|sure|ok|okay|affirmative|uh huh)($|\b)/.test(t)) return "yes";
  if (/(^|\b)(nope|nah|negative|uh uh)($|\b)/.test(t)) return "no";
  return s;
}
function humanCurrency(cents){
  const n = typeof cents==="number" ? cents : Math.round(parseFloat(String(cents).replace(/[^\d.]/g,""))*100);
  const dollars = Math.floor(n/100);
  const rem = n%100;
  const centsWords = rem === 0 ? "" : ` and ${rem} ${rem===1?"cent":"cents"}`;
  return `${dollars.toLocaleString()} dollars${centsWords}`;
}

// ============================
// Sanity
// ============================
app.get("/", (req,res)=>{
  res.send("✅ Vapi Webhook online. Endpoints: GET /start-batch, POST /vapi-webhook, POST /vapi-callback");
});

// ============================
// Batch Dialer: next 5 "pending"
// ============================
app.get("/start-batch", async (req,res)=>{
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

    if(process.env.APPS_SCRIPT_URL){
      try{
        await fetch(process.env.APPS_SCRIPT_URL, {
          method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(req.body)
        });
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
function getSession(id){ if(!sessions[id]) sessions[id]={ state:"start", data:{} }; return sessions[id]; }

function nextState(session, userInput=""){
  const curr = salesFlow.states[session.state];
  if(curr?.capture){ session.data[curr.capture] = userInput; }

  let input = String(userInput||"");
  input = yesNoNormalize(input);

  if(curr?.branches){
    const t = input.toLowerCase();
    if(t.includes("yes")) session.state = curr.branches.yes;
    else if(t.includes("no")) session.state = curr.branches.no;
    else if(/(service|support|representative|operator|agent|supervisor|help)/.test(t)) session.state = "hotline_offer";
    else session.state = curr.branches.hesitate || curr.next;
  }else if(curr?.next){
    session.state = curr.next;
  }else{
    session.state = "catch_all";
  }
}

function renderNode(node){
  const tone = node.tone || "neutral";
  const settings = toneMap[tone] || toneMap.neutral;
  let text = node.say || "Let’s continue.";
  text = text.replace(/\b\(pause\b.*?\)/gi,"").replace(/\b\(compliment.*?\)/gi,""); // never vocalize cues
  const res = {
    say: text,
    tone,
    voice: settings,
    ssml: toSSML(text, settings),
    format: "ssml",
    end: !!node.end
  };
  if(node.pauseMs) res.pauseMs = node.pauseMs;
  return res;
}

app.post("/vapi-webhook", (req,res)=>{
  try{
    const { sessionId, userInput } = req.body||{};
    if(!sessionId) return res.status(400).json({ error:"Missing sessionId" });

    const session = getSession(sessionId);
    if(typeof userInput==="string" && userInput.trim()) nextState(session, userInput);

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
    return res.json(renderNode(node));
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
