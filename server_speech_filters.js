
/**
 * server_speech_filters.js
 * Drop-in speech sanitation & address normalization helpers for Alex.
 *
 * USAGE (in server.js):
 *   const filters = require('./server_speech_filters');
 *   ...
 *   const cleanText = filters.sanitizeOutbound(node.say || "");
 *   const ssml = filters.toSSML(cleanText, settings);
 *
 * This module:
 *  - Blocks internal stage directions leaking to TTS (e.g., "Silent 4 S Pause", "(pause)")
 *  - Expands US state abbreviations to full names when used in address-like contexts
 *  - Normalizes money words and delivery phrasing helpers
 *  - Provides a safe toSSML wrapper
 */

const STATE_MAP = Object.freeze({
  "AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas","CA":"California","CO":"Colorado",
  "CT":"Connecticut","DE":"Delaware","DC":"District of Columbia","FL":"Florida","GA":"Georgia",
  "HI":"Hawaii","ID":"Idaho","IL":"Illinois","IN":"Indiana","IA":"Iowa","KS":"Kansas","KY":"Kentucky",
  "LA":"Louisiana","ME":"Maine","MD":"Maryland","MA":"Massachusetts","MI":"Michigan","MN":"Minnesota",
  "MS":"Mississippi","MO":"Missouri","MT":"Montana","NE":"Nebraska","NV":"Nevada","NH":"New Hampshire",
  "NJ":"New Jersey","NM":"New Mexico","NY":"New York","NC":"North Carolina","ND":"North Dakota",
  "OH":"Ohio","OK":"Oklahoma","OR":"Oregon","PA":"Pennsylvania","RI":"Rhode Island","SC":"South Carolina",
  "SD":"South Dakota","TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont","VA":"Virginia",
  "WA":"Washington","WV":"West Virginia","WI":"Wisconsin","WY":"Wyoming"
});

function escapeXml(s) {
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;");
}

// Remove anything that smells like an internal cue/instruction.
function stripInternalCues(text="") {
  return text
    // Parenthetical stage notes like "(pause 2s)", "(processing)", "(compliment)"
    .replace(/\((?:\s*(?:pause|processing|hold|compliment|aside)[^)]*)\)/gi, "")
    // Variants like "Silent 4 S Pause", "Long Pause", "Pause 2000ms"
    .replace(/\b(?:silent|pause|hold)\s*\d+\s*(?:s|sec|ms)?\s*(?:pause)?\b/gi, "")
    .replace(/\blong\s*pause\b/gi, "")
    // Markdown-like brackets
    .replace(/\[(?:pause|processing|hold)[^\]]*\]/gi, "");
}

// Expand "..., CA 94105" → "..., California 94105"
function expandUSStateAbbreviations(text="") {
  return text.replace(/,\s*([A-Z]{2})(\s+\d{5}(?:-\d{4})?)?\b/g, (m, abbr, zip) => {
    const full = STATE_MAP[abbr];
    return full ? `, ${full}${zip || ""}` : m;
  });
}

// Convert amounts like "$299.99" to "two hundred ninety nine dollars and ninety nine cents"
function numberToWordsUnder100(n) {
  const ones = ["zero","one","two","three","four","five","six","seven","eight","nine"];
  const teens = ["ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
  const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
  if (n < 10) return ones[n];
  if (n < 20) return teens[n-10];
  const t = Math.floor(n/10), o = n%10;
  return o ? `${tens[t]} ${ones[o]}` : tens[t];
}
function integerToWords(n) {
  if (n === 0) return "zero";
  const chunks = [];
  const groups = [""," thousand"," million"," billion"];
  let i = 0;
  while (n > 0 && i < groups.length) {
    const part = n % 1000;
    if (part) {
      chunks.unshift(threeDigitToWords(part) + groups[groups.length-1 - i]);
    }
    n = Math.floor(n/1000);
    i++;
  }
  return chunks.join(" ").replace(/\s+/g," ").trim();
}
function threeDigitToWords(n) {
  const ones = ["","one","two","three","four","five","six","seven","eight","nine"];
  const teens = ["ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
  const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
  const h = Math.floor(n/100), r = n%100;
  let out = "";
  if (h) out += `${ones[h]} hundred`;
  if (r) {
    if (out) out += " ";
    if (r < 10) out += ones[r];
    else if (r < 20) out += teens[r-10];
    else {
      const t = Math.floor(r/10), o = r%10;
      out += tens[t] + (o ? ` ${ones[o]}` : "");
    }
  }
  return out;
}

function expandMoney(text="") {
  return text.replace(/\$ ?(\d{1,3}(?:,\d{3})*)(?:\.(\d{1,2}))?/g, (_, dollarsStr, centsStr) => {
    const dollars = parseInt(dollarsStr.replace(/,/g,""), 10) || 0;
    const cents = centsStr ? parseInt(centsStr.padEnd(2,"0"), 10) : 0;
    let spoken = `${integerToWords(dollars)} dollars`;
    if (cents) {
      spoken += ` and ${integerToWords(cents)} ${cents === 1 ? "cent" : "cents"}`;
    }
    return spoken;
  });
}

// Public: sanitize text before TTS
function sanitizeOutbound(text="") {
  let s = String(text);
  s = stripInternalCues(s);
  s = expandUSStateAbbreviations(s);
  s = expandMoney(s);
  // normalize hyphen or range phrasing
  s = s.replace(/\b5\s*[-–]\s*7\s*business\s*days\b/gi, "five to seven business days");
  return s.replace(/\s+/g," ").trim();
}

function ensureShippingWindowLine(text="") {
  const has = /five to seven business days/i.test(text);
  return has ? text : `${text} Delivery is in five to seven business days.`.trim();
}

function toSSML(text, settings={ rate: "0%", pitch: "0%", volume: "medium" }) {
  const safe = sanitizeOutbound(text);
  // Slow slightly if numbers/money words detected
  const needsSlow = /\bdollars?\b|\bcents?\b|\b\d{1,3}(?:,\d{3})*\b/.test(safe);
  const rate = needsSlow ? "-10%" : (settings.rate || "0%");
  const pitch = settings.pitch || "0%";
  const volume = settings.volume || "medium";
  return `<speak><prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${escapeXml(safe)}</prosody></speak>`;
}

module.exports = {
  sanitizeOutbound,
  ensureShippingWindowLine,
  toSSML
};
