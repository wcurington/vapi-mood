'use strict';
/**
 * server_speech_filter_v1.3.3.js
 * Express router that normalizes text for TTS:
 *  - Strips internal control tokens (SILENT markers, etc.)
 *  - Removes common fillers (um, uh, like, you know, kinda, sorta, actually)
 *  - Smooths long digit strings with gentle comma pacing
 *  - Adds natural pause markers for health questions and value-building lines
 *
 * Mount at e.g.:
 *   const speechFilter = require('./server_speech_filter_v1.3.3');
 *   app.use('/filter', speechFilter);
 */

const express = require('express');
const router = express.Router();

// ====== Regex banks ======
const CONTROL_TOKENS = [
  /\bSilent\s+\d+\s*S\s+Pause\b/gi,
  /\bSILENT_PAUSE_[0-9]+S\b/gi,
  /<break[^>]*>/gi
];

const FILLERS = [
  /\bum\b/gi, /\buh\b/gi, /\blike\b/gi, /\byou know\b/gi,
  /\bkinda\b/gi, /\bsorta\b/gi, /\bactually\b/gi, /\bjust\b/gi
];

const HEALTH_LEADS = /(On a scale of 1[-–]10|Do you have|How often|Are you experiencing|What have you tried|Which times of day|What would a good 30)/gi;

// ====== Helpers ======
function stripInternal(text='') {
  let s = text;
  CONTROL_TOKENS.forEach(rx => s = s.replace(rx, ' '));
  return s;
}

function removeFillers(text='') {
  let s = text;
  FILLERS.forEach(rx => s = s.replace(rx, ' '));
  return s;
}

function smoothDigits(text='') {
  return text.replace(/\b(\d[\s-]?){5,20}\b/g, (match) => {
    const digits = match.replace(/\D/g,'');
    return digits.split('').join(', ');
  });
}

function addNaturalPauses(text='') {
  // Insert gentle ellipses after leading health/value phrases
  return text.replace(HEALTH_LEADS, m => `${m}…`);
}

// ====== Router ======
router.get('/health', (req, res) => {
  res.json({ status: 'UP', module: 'speech-filter v1.3.3' });
});

router.post('/sanitize', (req, res) => {
  const { text='' } = req.body || {};
  let out = stripInternal(text);
  out = removeFillers(out);
  out = smoothDigits(out);
  out = addNaturalPauses(out);
  // whitespace collapse
  out = out.replace(/\s+/g,' ').trim();
  res.json({ sanitized: out });
});

module.exports = router;
