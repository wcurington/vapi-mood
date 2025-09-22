// ============================
// server.js – XXL Vapi Tone-Aware Batch Dialer + Webhook + Tool API
// ============================
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

let salesFlow;
try {
  salesFlow = require(path.join(__dirname, "flows", "flows_alex_sales.json"));
  console.log("✅ Loaded sales flow JSON with", Object.keys(salesFlow.states || {}).length, "states");
} catch (err) {
  console.warn("⚠️ flows/flows_alex_sales.json missing or invalid. Using minimal fallback.");
  salesFlow = { states: { start: { say: "Hello, this is Alex.", tone: "neutral", end: true } } };
}

const {
  VAPI_API_KEY,
  ASSISTANT_ID,
  PHONE_NUMBER_ID,
  GOOGLE_SERVICE_ACCOUNT,
  SPREADSHEET_ID,
  APPS_SCRIPT_URL,
  PORT = 3000,
  ZOHO_API_BASE,
  ZOHO_REFRESH_TOKEN,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  PB_SHIP_BASE,
  PB_API_KEY,
  PB_SECRET,
  AUTHNET_API_LOGIN_ID,
  AUTHNET_TRANSACTION_KEY,
  STRIPE_SECRET_KEY
} = process.env;

function getAuth() {
  const base64Key = GOOGLE_SERVICE_ACCOUNT;
  if (!base64Key) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT env var (base64 JSON).");
  const jsonKey = JSON.parse(Buffer.from(base64Key, "base64").toString("utf8"));
  return new google.auth.GoogleAuth({
    credentials: jsonKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}
const SHEET_NAME = "outbound_list";

app.get("/", (req, res) => {
  res.send("✅ Alex XXL ready: /start-batch /vapi-webhook /vapi-callback /api/v1/*");
});

const toneMap = {
  enthusiastic: { pitch: "+5%", rate: "+15%", volume: "loud" },
  empathetic: { pitch: "-5%", rate: "-10%", volume: "soft" },
  authoritative: { pitch: "-3%", rate: "0%", volume: "loud" },
  calm_confidence: { pitch: "0%", rate: "-5%", volume: "medium" },
  absolute_certainty: { pitch: "-8%", rate: "-5%", volume: "x-loud" },
  neutral: { pitch: "0%", rate: "0%", volume: "medium" },
};
function escapeXml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function toSSML(text, settings){
  const pitch=settings.pitch||"0%", rate=settings.rate||"0%", volume=settings.volume||"medium";
  return `<speak><prosody pitch="${pitch}" rate="${rate}" volume="${volume}">${escapeXml(text)}</prosody></speak>`;
}

app.get("/start-batch", async (req, res) => {
  try {
    if (!SPREADSHEET_ID) throw new Error("Missing SPREADSHEET_ID");
    if (!VAPI_API_KEY) throw new Error("Missing VAPI_API_KEY");
    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const range = `${SHEET_NAME}!A:Z`;
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    const rows = data.values || [];
    if (rows.length < 2) return res.json({ started: [], note: "No rows" });

    const headers = rows[0].map(h => (h || "").toLowerCase());
    const idIdx = headers.indexOf("id");
    const phoneIdx = headers.indexOf("phone");
    const statusIdx = headers.indexOf("status");
    if (idIdx === -1 || phoneIdx === -1 || statusIdx === -1) throw new Error("Missing id, phone, status");

    const pending = rows.slice(1).map((row, i) => ({ row, i: i + 2 })).filter(r => {
      const v = (r.row[statusIdx] || "").toLowerCase();
      return !v || v === "pending";
    });

    const batch = pending.slice(0, 5);
    const results = [];
    for (const entry of batch) {
      const id = entry.row[idIdx];
      const phone = entry.row[phoneIdx];
      if (!phone) { results.push({ id, error: "No phone" }); continue; }
      const payload = { assistantId: ASSISTANT_ID, phoneNumberId: PHONE_NUMBER_ID, customer: { number: phone }, metadata: { id, rowIndex: entry.i } };
      const resp = await fetch("https://api.vapi.ai/call", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${VAPI_API_KEY}` }, body: JSON.stringify(payload) });
      const text = await resp.text(); let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
      results.push({ id, phone, response: json });
    }
    res.json({ started: results, batchSize: results.length });
  } catch (e) { console.error("start-batch error:", e); res.status(500).send("Error: " + e.message); }
});

app.post("/vapi-callback", async (req, res) => {
  try {
    const { metadata, status, result } = req.body || {};
    const id = metadata?.id;
    const rowIndex = metadata?.rowIndex;
    const timestamp = new Date().toISOString();
    if (!SPREADSHEET_ID) throw new Error("Missing SPREADSHEET_ID");
    if (!id || !rowIndex) throw new Error("Missing metadata.id or rowIndex");
    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:Z1` });
    const headers = (headerResp.data.values?.[0] || []).map(h => (h || "").toLowerCase());
    const idx = { status: headers.indexOf("status") + 1, attempts: headers.indexOf("attempts") + 1, lastAttemptAt: headers.indexOf("lastattemptat") + 1, result: headers.indexOf("result") + 1 };
    if (Object.values(idx).some(v => v <= 0)) throw new Error("Missing required headers in sheet");
    const attemptsResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!R${rowIndex}C${idx.attempts}` });
    const currentAttempts = parseInt(attemptsResp.data.values?.[0]?.[0] || "0", 10);
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: "RAW", data: [
      { range: `${SHEET_NAME}!R${rowIndex}C${idx.status}`, values: [[status || "completed"]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${idx.attempts}`, values: [[currentAttempts + 1]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${idx.lastAttemptAt}`, values: [[timestamp]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${idx.result}`, values: [[result || ""]] },
    ] } });
    if (APPS_SCRIPT_URL) { try { await fetch(APPS_SCRIPT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body) }); } catch (err) {} }
    res.send("OK");
  } catch (e) { console.error("callback error:", e); res.status(500).send("Error: " + e.message); }
});

const sessions = {};
function getSession(sessionId){ if(!sessions[sessionId]) sessions[sessionId] = { state:"start", data:{} }; return sessions[sessionId]; }
function handleTransition(session, userInput=""){
  const current = salesFlow.states[session.state];
  if (!current) { session.state = "catch_all"; return; }
  if (current.capture) session.data[current.capture] = userInput;
  const input = (userInput || "").toLowerCase();
  const hot = ["service","support","help","representative","agent","operator","supervisor","customer service","reorder"];
  if (current.branches && hot.some(t=>input.includes(t))) { session.state = "hotline_offer"; return; }
  if (current.branches){
    if (input.includes("yes")) session.state = current.branches.yes;
    else if (input.includes("no")) session.state = current.branches.no;
    else session.state = current.branches.hesitate || current.next || "catch_all";
  } else if (current.next) { session.state = current.next; }
  else { session.state = "catch_all"; }
}

app.post("/vapi-webhook", (req, res) => {
  const { sessionId, userInput } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  const session = getSession(sessionId);
  if (typeof userInput === "string" && userInput.trim()) handleTransition(session, userInput);
  const current = salesFlow.states[session.state];
  if (!current){
    const txt = "I didn’t catch that. You can also reach us at 1-866-379-5131.";
    const settings = toneMap.neutral;
    return res.json({ say: txt, tone: "neutral", voice: settings, ssml: toSSML(txt, settings), pauseMs: 600, format: "ssml", end: false });
  }
  const tone = current.tone || "neutral";
  const settings = toneMap[tone] || toneMap.neutral;
  let text = current.say || "Let’s continue.";
  text = text.replace(/point\s+(\d{2})/gi, "$1 cents");
  res.json({ say: text, tone, voice: settings, ssml: toSSML(text, settings), pauseMs: current.pauseMs || 900, format: "ssml", end: !!current.end });
});

function requireJSONBody(req, res){ if (!req.is("application/json")) { res.status(400).json({ error: "Content-Type must be application/json" }); return false; } return true; }
app.post("/api/v1/mood/log", (req,res)=>{ if(!requireJSONBody(req,res))return; console.log("🧠 mood log:", JSON.stringify(req.body||{})); res.json({ok:true}); });
app.post("/api/v1/payments/authorize-net/charge", (req,res)=>{ if(!requireJSONBody(req,res))return; const b=req.body||{}; const last4=(b.cardNumber||"").slice(-4); res.json({ok:true, transactionId:"AUTHNET-"+Date.now(), last4}); });
app.post("/api/v1/payments/authorize-net/schedule", (req,res)=>{ if(!requireJSONBody(req,res))return; const b=req.body||{}; const last4=(b.cardNumber||b.card?.number||"").slice(-4); res.json({ok:true, subscriptionId:"AUTHNET-SCHED-"+Date.now(), last4}); });
app.post("/api/v1/payments/stripe/create-link", (req,res)=>{ if(!requireJSONBody(req,res))return; res.json({ok:true, url:"https://pay.stripe.com/link/example_"+Date.now()}); });
app.post("/api/v1/orders/zoho/create", (req,res)=>{ if(!requireJSONBody(req,res))return; const o=req.body||{}; res.json({ok:true, zohoOrderId:"ZORDER-"+Date.now(), shipment: o.create_shipment ? { carrier: o.shipment_carrier||"usps", labelId:"PB-LABEL-"+Date.now() } : null }); });

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
