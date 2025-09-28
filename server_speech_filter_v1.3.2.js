'use strict';
const express = require('express');
const router = express.Router();

// Remove internal tokens from TTS
function stripInternal(text='') {
  return text.replace(/\bSilent\s+\d+\s*S\s+Pause\b/gi, '').replace(/\bSILENT_PAUSE_[0-9]+S\b/gi, '');
}

// Smooth digit strings: insert soft commas and ensure even pacing hints
function smoothDigits(text='') {
  return text.replace(/\b(\d[\s-]?){5,20}\b/g, (match) => {
    const digits = match.replace(/\D/g,'');
    return digits.split('').join(', ');
  });
}

// Slow cadence for health Qs by inserting ellipses markers harmless to STT/TTS
function slowHealthCadence(text='') {
  return text.replace(/(On a scale of 1-10|Do you have|How often|Are you experiencing)/gi, m => `${m}...`);
}

router.get('/health', (req, res) => {
  res.json({ status: 'UP', module: 'speech-filter v1.3.2' });
});

router.post('/sanitize', (req, res) => {
  const { text='' } = req.body || {};
  let out = stripInternal(text);
  out = smoothDigits(out);
  out = slowHealthCadence(out);
  res.json({ sanitized: out });
});

module.exports = router;
