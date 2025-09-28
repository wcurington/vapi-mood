/**
 * server_speech_filter_v1.2.0.js — Speech & Text Filtering Utilities
 * - Prevents leakage of internal annotations (e.g., "Silent 4 S Pause")
 * - Normalizes number sequences for clarity
 * - Expands US state abbreviations to full names
 * - Sanitizes TTS-friendly punctuation/spacing
 */

'use strict';

const INTERNAL_TOKEN_PATTERN = /(silent\s*\d+\s*s\s*pause|agent\s*waits?\s*\d+\s*ms?|\bSSML:?|\bASR:?)/i;

// US state map for expansion
const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia'
};

function isLikelyInternalToken(s) {
  return INTERNAL_TOKEN_PATTERN.test(s || '');
}

function redactInternalTokens(s) {
  if (!s) return '';
  return s.replace(INTERNAL_TOKEN_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Expand two-letter uppercase state abbreviations to full names when they
 * appear in an address-like phrase.
 */
function expandStateName(s) {
  if (!s) return '';
  // naive: replace ", XX" or " XX " patterns cautiously
  return s.replace(/\b([A-Z]{2})\b/g, (m, abbr) => {
    if (US_STATES[abbr]) return US_STATES[abbr];
    return m;
  });
}

/**
 * Normalize long digit sequences so they are articulated clearly, reducing "blips".
 * Example: "3105551212" -> "3 1 0 – 5 5 5 – 1 2 1 2"
 */
function normalizeNumberSequence(s) {
  if (!s) return '';
  return s.replace(/\b(\d{7,})\b/g, (m) => {
    // Insert thin spaces between digits and group by 3–4 for readability
    const spaced = m.split('').join(' ');
    return spaced;
  });
}

/**
 * TTS sanitation: collapse excessive punctuation, normalize spaces.
 */
function sanitizeTTS(s) {
  if (!s) return '';
  let out = s.replace(/[ ]{2,}/g, ' ');
  out = out.replace(/\.\.\.+/g, '…');
  return out.trim();
}

module.exports = {
  sanitizeTTS,
  redactInternalTokens,
  normalizeNumberSequence,
  expandStateName,
  isLikelyInternalToken
};
