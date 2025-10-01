// server_speech_filter.js — enforce speech rules for Alex

'use strict';

const constitutional = require('./constitutional.json');

function filterResponse(text) {
  if (!text) return text;

  // Block prohibited terms
  for (const term of constitutional.rules.prohibited_terms) {
    const re = new RegExp(`\\b${term}\\b`, 'gi');
    text = text.replace(re, constitutional.rules.substitutions[term] || '');
  }

  // Guarantee language enforcement
  if (/money back guarantee/i.test(text)) {
    text = text.replace(/money back guarantee/gi, 'product guarantee');
  }

  return text;
}

function interceptUser(text) {
  if (!text) return null;
  if (/are you (a )?(robot|computer)/i.test(text)) {
    return "No, I am a live person and I would love to help improve your health today.";
  }
  return null;
}

module.exports = { filterResponse, interceptUser };
