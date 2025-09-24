
// server.js – XXL pause-aware server
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const fetch = require("node-fetch");
const path = require("path");

let salesFlow;
try {
  salesFlow = require(path.join(__dirname, "flows", "flows_alex_sales.json"));
  console.log("✅ Loaded flow with", Object.keys(salesFlow.states||{}).length, "states");
} catch (e) {
  console.error("Flow load failed", e.message);
  salesFlow = { states: { start: { say: "Hello from Alex", tone: "neutral", end: true } } };
}

const app = express();
app.use(bodyParser.json());

const YES = new Set(["yes","yeah","yep","yup","sure","ok","okay","correct","affirmative"]);
const NO  = new Set(["no","nope","nah","negative"]);

function toSSML(text, settings) {
  const pitch = settings.pitch || "0%";
  const rate = settings.rate || "0%";
  const vol = settings.volume || "medium";
  const safe = String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<speak><prosody pitch="${pitch}" rate="${rate}" volume="${vol}">${safe}</prosody></speak>`;
}

const sessions = {};
function getSession(id){ if(!sessions[id]) sessions[id] = { state: "start", data: {} }; return sessions[id]; }

function nextFromBranches(branches, text){
  if(!branches) return null;
  const t = String(text||"").trim().toLowerCase();
  if (YES.has(t)) return branches.yes;
  if (NO.has(t)) return branches.no;
  if (t.includes("service")||t.includes("support")||t.includes("agent")||t.includes("operator")) return branches.service || "hotline_offer";
  if (t.includes("later")||t.includes("another day")) return branches.later || branches.no;
  return branches.hesitate || null;
}

function handleTransition(session, userInput=""){
  const current = salesFlow.states[session.state];
  if(current && current.capture) session.data[current.capture] = userInput;
  let next = null;
  if(current && current.branches) next = nextFromBranches(current.branches, userInput);
  if(!next && current && current.next) next = current.next;
  session.state = next || "catch_all";
}

app.post("/vapi-webhook",(req,res)=>{
  const { sessionId, userInput } = req.body || {};
  if(!sessionId) return res.status(400).json({ error: "Missing sessionId" });
  const session = getSession(sessionId);
  if(typeof userInput === "string" && userInput.trim()) handleTransition(session, userInput);
  let current = salesFlow.states[session.state] || salesFlow.states["catch_all"];
  const tone = current.tone || "neutral";
  const settings = (salesFlow.meta && salesFlow.meta.tones && salesFlow.meta.tones[tone]) || { pitch:"0%", rate:"0%", volume:"medium" };
  let text = current.say || "Let’s continue.";
  text = text.replace(/five[\s-]*seven/g, "five to seven"); // shipping ETA rule
  const payload = { say: text, tone, voice: settings, ssml: toSSML(text, settings), pauseMs: current.pauseMs||0, format:"ssml", end: !!current.end };
  res.json(payload);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log("🚀 Server on", PORT));
