// ============================
// server.js – Vapi Tone-Aware Batch Dialer + Webhook
// ============================

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const fetch = require("node-fetch"); // v2, pinned in package.json
const path = require("path");

// ==== Load Straight-Line Flow (tone-aware JSON) ====
let salesFlow;
try {
  salesFlow = require(path.join(__dirname, "flows", "flows_alex_sales.json"));
  console.log("✅ Loaded sales flow JSON");
} catch (err) {
  console.warn("⚠️ Warning: flows/flows_alex_sales.json not found or invalid");
  salesFlow = { states: { start: { say: "Hello, this is Alex.", tone: "neutral", end: true } } };
}

const app = express();
app.use(bodyParser.json());

// ============================
// Google Sheets Setup
// ============================
function getAuth() {
  const base64Key = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!base64Key) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT env var (base64 JSON).");

  const jsonKey = JSON.parse(Buffer.from(base64Key, "base64").toString("utf8"));

  return new google.auth.GoogleAuth({
    credentials: jsonKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

const SHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "outbound_list"; // must match tab name in Google Sheets

// ============================
// Vapi IDs (from .env)
// ============================
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VAPI_API_KEY = process.env.VAPI_API_KEY;

// ============================
// Apps Script URL
// ============================
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// ============================
// Sanity check route
// ============================
app.get("/", (req, res) => {
  res.send("✅ Vapi Webhook is running! Endpoints: /start-batch, /vapi-webhook, /vapi-callback");
});

// ============================
// Batch Dialer: trigger next 3 calls
// ============================
app.get("/start-batch", async (req, res) => {
  try {
    if (!SHEET_ID) throw new Error("Missing SPREADSHEET_ID");
    if (!VAPI_API_KEY) throw new Error("Missing VAPI_API_KEY");

    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const range = `${SHEET_NAME}!A:Z`;
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) return res.send("No rows found");

    const headers = rows[0].map((h) => h.toLowerCase());
    const dataRows = rows.slice(1);

    const idIdx = headers.indexOf("id");
    const phoneIdx = headers.indexOf("phone");
    const statusIdx = headers.indexOf("status");

    if (idIdx === -1 || phoneIdx === -1 || statusIdx === -1) {
      throw new Error("❌ Missing required headers in outbound_list (need id, phone, status).");
    }

    const nextThree = dataRows
      .map((row, i) => ({ row, i }))
      .filter((r) => !r.row[statusIdx] || r.row[statusIdx].toLowerCase() === "pending")
      .slice(0, 3);

    if (nextThree.length === 0) return res.send("No pending contacts");

    const results = [];

    for (let entry of nextThree) {
      const row = entry.row;
      const rowIndex = entry.i + 2;
      const id = row[idIdx];
      const phone = row[phoneIdx];

      if (!phone) {
        console.warn(`⚠️ Skipping id=${id} (no phone)`);
        results.push({ id, phone, error: "No phone number" });
        continue;
      }

      console.log(`📞 Starting call for id=${id}, phone=${phone}`);

      const payload = {
        assistantId: ASSISTANT_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        customer: { number: phone },
        metadata: { id, rowIndex },
      };

      const vapiResp = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${VAPI_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      const vapiResultText = await vapiResp.text();
      console.log("Vapi response:", vapiResultText);

      let vapiJson;
      try {
        vapiJson = JSON.parse(vapiResultText);
      } catch {
        vapiJson = { raw: vapiResultText };
      }

      results.push({ id, phone, response: vapiJson });
    }

    res.json({ started: results });
  } catch (err) {
    console.error("Batch error:", err);
    res.status(500).send("Error starting batch: " + (err.message || String(err)));
  }
});

// ============================
// Callback Logger (from Vapi)
// ============================
app.post("/vapi-callback", async (req, res) => {
  try {
    console.log("📩 Incoming Vapi callback:", JSON.stringify(req.body, null, 2));

    const { metadata, status, result } = req.body || {};
    const id = metadata?.id;
    const rowIndex = metadata?.rowIndex;
    const timestamp = new Date().toISOString();

    if (!SHEET_ID) throw new Error("Missing SPREADSHEET_ID");
    if (!id || !rowIndex) throw new Error("Missing metadata.id or rowIndex");

    const auth = await getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1:Z1`,
    });
    const headers = headerResp.data.values[0].map((h) => h.toLowerCase());

    const statusIdx = headers.indexOf("status") + 1;
    const attemptsIdx = headers.indexOf("attempts") + 1;
    const lastAttemptIdx = headers.indexOf("lastattemptat") + 1;
    const resultIdx = headers.indexOf("result") + 1;

    if (statusIdx <= 0 || attemptsIdx <= 0 || lastAttemptIdx <= 0 || resultIdx <= 0) {
      throw new Error("❌ Missing required headers (status, attempts, lastattemptat, result)");
    }

    const attemptsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!R${rowIndex}C${attemptsIdx}`,
    });
    const currentAttempts = parseInt(attemptsResp.data.values?.[0]?.[0] || "0", 10);

    const updates = [
      { range: `${SHEET_NAME}!R${rowIndex}C${statusIdx}`, values: [[status || "completed"]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${attemptsIdx}`, values: [[currentAttempts + 1]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${lastAttemptIdx}`, values: [[timestamp]] },
      { range: `${SHEET_NAME}!R${rowIndex}C${resultIdx}`, values: [[result || ""]] },
    ];

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: "RAW", data: updates },
    });

    try {
      await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      console.log("📤 Forwarded callback to Apps Script");
    } catch (forwardErr) {
      console.error("⚠️ Forward to Apps Script failed:", forwardErr);
    }

    res.send("Row updated + callback forwarded");
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("Error handling callback: " + err.message);
  }
});

// ============================
// Conversation Flow State Machine
// ============================
const sessions = {};
function getSession(sessionId) {
  if (!sessions[sessionId]) sessions[sessionId] = { state: "start", data: {} };
  return sessions[sessionId];
}

function handleTransition(session, userInput = "") {
  const current = salesFlow.states[session.state];
  if (current && current.capture) {
    session.data[current.capture] = userInput;
  }

  if (current && current.branches) {
    const input = (userInput || "").toLowerCase();

    if (input.includes("yes")) {
      session.state = current.branches.yes;
    } else if (input.includes("no")) {
      session.state = current.branches.no;
    } else if (
      input.includes("service") ||
      input.includes("support") ||
      input.includes("help") ||
      input.includes("representative") ||
      input.includes("agent") ||
      input.includes("operator") ||
      input.includes("supervisor")
    ) {
      session.state = "hotline_offer"; // force hotline branch
    } else {
      session.state = current.branches.hesitate || current.next;
    }
  } else if (current && current.next) {
    session.state = current.next;
  } else {
    session.state = "catch_all"; // fallback if nothing matches
  }
}

// ============================
// Tone Map + SSML Builder
// ============================
const toneMap = {
  enthusiastic: { pitch: "+5%", rate: "+15%", volume: "loud" },
  empathetic: { pitch: "-5%", rate: "-10%", volume: "soft" },
  authoritative: { pitch: "-3%", rate: "default", volume: "loud" },
  calm_confidence: { pitch: "default", rate: "-5%", volume: "medium" },
  absolute_certainty: { pitch: "-8%", rate: "-5%", volume: "x-loud" },
  neutral: { pitch: "default", rate: "default", volume: "medium" },
};

function toSSML(text, settings) {
  const pitch = settings.pitch === "default" ? "0%" : settings.pitch;
  const rate = settings.rate === "default" ? "0%" : settings.rate;
  const vol = settings.volume === "default" ? "medium" : settings.volume;
  return `<speak><prosody pitch="${pitch}" rate="${rate}" volume="${vol}">${escapeXml(text)}</prosody></speak>`;
}

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================
// Tone-Aware Webhook
// ============================
app.post("/vapi-webhook", (req, res) => {
  const { sessionId, userInput } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });

  const session = getSession(sessionId);
  if (typeof userInput === "string" && userInput.trim()) handleTransition(session, userInput);

  const current = salesFlow.states[session.state];

  if (!current) {
    // fallback catch-all
    const text = "I didn’t quite catch that. For assistance, you can also call our support line at 1-866-379-5131.";
    const settings = toneMap.neutral;
    return res.json({
      say: text,
      tone: "neutral",
      voice: settings,
      ssml: toSSML(text, settings),
      format: "ssml",
      end: false
    });
  }

  const tone = current.tone || "neutral";
  const settings = toneMap[tone] || toneMap.neutral;
  const text = current.say || "Let’s continue.";

  return res.json({
    say: text,
    tone,
    voice: settings,
    ssml: toSSML(text, settings),
    format: "ssml",
    end: !!current.end
  });
});

// ============================
// Start Server
// ============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
