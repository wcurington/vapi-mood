/**
 * server_speech_filter_v1.3.1.js — Speech & Text Filters (XXL)
 * Responsibilities:
 * - Remove internal tokens from ASR (e.g., "SILENT 4 S PAUSE")
 * - Normalize digit streams (reduce blips; stabilize "niiiine"→"nine")
 * - Provide pacing hints for health intake
 * - Offer health-question cadence defaults (configurable)
 */
"use strict";

const express = require("express");
const router = express.Router();

const DEFAULTS = {
  healthPauseMS: 1200, // default pause between health questions
  digitGapMS: 150,     // recommended inter-digit silence when reading numbers
};

function stripInternalTokens(text) {
  if (!text) return text;
  return text
    .replace(/\bSILENT\s*\d+\s*S\s*PAUSE\b/gi, "")
    .replace(/\bSILENCE\s*\d+\s*S\b/gi, "")
    .replace(/\bPAUSE\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeProlongations(text) {
  if (!text) return text;
  // collapse long runs of same letters (niiiine -> nine)
  return text.replace(/([a-zA-Z])\1{2,}/g, "$1$1");
}

function stabilizeDigitStream(text) {
  if (!text) return text;
  // convert spoken variants to canonical digits and remove stray hyphens/commas
  const map = {
    "zero":"0","oh":"0","one":"1","two":"2","to":"2","too":"2","three":"3","four":"4","for":"4","five":"5",
    "six":"6","seven":"7","eight":"8","ate":"8","nine":"9"
  };
  const tokens = text.toLowerCase().split(/[\s,-]+/);
  const out = [];
  for (const t of tokens) {
    if (map[t] !== undefined) out.push(map[t]);
    else if (/^\d+$/.test(t)) out.push(t);
    else out.push(t);
  }
  // join digits with single spaces for clarity
  return out.join(" ").replace(/\s{2,}/g," ").trim();
}

router.get("/health", (req,res)=> {
  res.json({ status:"UP", service:"speech-filter", version:"v1.3.1" });
});

router.post("/process", (req,res)=> {
  const { text, options } = req.body || {};
  let out = String(text||"");
  out = stripInternalTokens(out);
  out = normalizeProlongations(out);
  // Only stabilize if caller indicates numeric streams or if looks numeric-heavy
  const looksNumeric = /\d/.test(out) || /\b(zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/i.test(out);
  if (options?.stabilizeDigits || looksNumeric) {
    out = stabilizeDigitStream(out);
  }
  const hints = {
    healthPauseMS: options?.healthPauseMS || DEFAULTS.healthPauseMS,
    digitGapMS: options?.digitGapMS || DEFAULTS.digitGapMS
  };
  res.json({ ok:true, text: out, hints });
});

module.exports = { router };
