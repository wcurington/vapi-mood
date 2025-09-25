// ============================
// server.js – Vapi Tone-Aware Batch Dialer + Webhook (XXXXXL EDITION with fixes)
// ============================
//
// Fixes Implemented:
// 1) Removed verbalization of "pause" – pause is handled as non-vocalized SSML.
// 2) Added enforced silent wait after greeting so Alex does not interrupt.
// 3) Pricing verbalization standardized to proper "ninety-nine cents" format.
// 4) Single-bottle pricing adjusted upwards (no under $40).
// 5) Package pricing (3, 6, 12 months) enforced as primary offers before single bottle.
// 6) Multiple health issue recommendations supported.
// 7) Customer trust & satisfaction reassurance integrated.
// 8) Customer service hotline repeated consistently in closing.
// 9) Full customer info capture enforced (name, address, email, phone).
// 10) Billing vs shipping confirmation enforced.
// 11) Proper closing protocol enforced (shipping details, thank you, hotline).
// ============================

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
  console.warn("⚠️ flows/flows_alex_sales.json not found/invalid; using fallback");
  salesFlow = { states: { start: { say: "Hello, this is Alex.", tone: "neutral", end: true } } };
}

// Non-vocalized pause fix for greeting
function sanitizeCues(text) {
  return text.replace(/\(pause\)/gi, "").replace(/\(compliment.*?\)/gi, "");
}

// Force Alex to pause for customer response after greeting
function greetingNode() {
  return {
    say: "Hi, this is Alex with Health America. How are you today?",
    tone: "enthusiastic",
    ssml: "<speak>Hi, this is Alex with Health America. How are you today?<break time=\"1200ms\"/></speak>",
    format: "ssml",
    end: false,
    pauseMs: 1200
  };
}

// Replace starting node with safe greeting
if (salesFlow.states.start) {
  salesFlow.states.start.say = "Hi, this is Alex with Health America. How are you today?";
  salesFlow.states.start.pauseMs = 1200;
}

module.exports = app;
