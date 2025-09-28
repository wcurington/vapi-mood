/**
 * patch_flows_pauses_shipping_v1.2.0.js — Flow Policies & Pricing/Payment Rules
 * Responsibilities:
 *  - Health Q&A pacing policy (no rapid-fire; natural pauses)
 *  - Offer/price computation for multi-SKU bundles (no naive multiples)
 *  - Payment envelope validation (CC types, CVV, expiry; bank routing/account)
 *  - Shipping disclosure enforcement ("5–7 business days" baseline)
 *  - Hang-up guard semantics
 *  - Minimal in-memory catalog for demonstration
 */

'use strict';

const state = { flowEngineReady: false };

// Minimal SKU catalog (demo). In real usage, hydrate from DB or file.
const CATALOG = {
  'SKU-JOINT-A': { price: 49.99, label: 'Joint Support A' },
  'SKU-HEART-B': { price: 59.99, label: 'Heart Health B' },
  'SKU-IMMUNE-C': { price: 39.99, label: 'Immune Support C' },
  'SKU-SLEEP-D': { price: 29.99, label: 'Sleep Well D' }
};

// Bundle discount tiers (example)
const BUNDLE_RULES = [
  { minItems: 2, discountPct: 5 },
  { minItems: 3, discountPct: 10 },
  { minItems: 4, discountPct: 12 }
];

function initFlowEngine() {
  // In real use, load and preprocess flows_alex_sales.json with pacing patches
  return Promise.resolve();
}

/**
 * Health pacing policy: recommended min gaps between prompts (ms)
 */
const healthQuestionPacingPolicy = Object.freeze({
  betweenQuestionsMs: 1200,
  afterScalePromptMs: 900,
  microAcks: [
    'Thanks for that.',
    'Got it, thank you.',
    'I appreciate you sharing that.'
  ]
});

function computeOfferFromSKUs(skus, months = 6) {
  if (!Array.isArray(skus) || skus.length === 0) {
    throw new Error('No SKUs provided');
  }
  const items = [];
  let subtotal = 0;
  for (const sku of skus) {
    const item = CATALOG[sku];
    if (!item) throw new Error(`Unknown SKU: ${sku}`);
    items.push({ sku, label: item.label, unitPrice: item.price });
    subtotal += item.price;
  }
  // Apply bundle discount
  let discountPct = 0;
  for (const rule of BUNDLE_RULES) {
    if (skus.length >= rule.minItems) discountPct = rule.discountPct;
  }
  const discount = +(subtotal * (discountPct / 100)).toFixed(2);
  const monthly = +(((subtotal - discount) / months)).toFixed(2);
  const total = +((subtotal - discount)).toFixed(2);

  return {
    items,
    months,
    subtotal: +subtotal.toFixed(2),
    discountPct,
    discount,
    total,
    monthly,
    copy: [
      'You’re going to love it.',
      'It is Absolutely Amazing.',
      'This Product is incredible.'
    ]
  };
}

// Payment validation
const CC_BRANDS = {
  visa: { lengths: [16], cvv: [3], iin: /^4/ },
  mastercard: { lengths: [16], cvv: [3], iin: /^(5[1-5]|2[2-7])/ },
  discover: { lengths: [16], cvv: [3], iin: /^(6011|65|64[4-9])/ },
  amex: { lengths: [15], cvv: [4], iin: /^3[47]/ }
};

function stripNonDigits(s) {
  return (s || '').replace(/\D+/g, '');
}

function detectBrand(cc) {
  for (const [brand, meta] of Object.entries(CC_BRANDS)) {
    if (meta.iin.test(cc)) return brand;
  }
  return 'unknown';
}

function luhnCheck(num) {
  let sum = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = parseInt(num[i], 10);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

function validatePaymentEnvelope(payload) {
  const mode = payload?.mode || 'card';
  if (mode === 'card') {
    const number = stripNonDigits(payload.cardNumber);
    const brand = detectBrand(number);
    if (!['visa','mastercard','discover','amex'].includes(brand)) {
      throw new Error('Unsupported or invalid card brand');
    }
    const meta = CC_BRANDS[brand];
    if (!meta.lengths.includes(number.length)) {
      throw new Error(`Invalid ${brand.toUpperCase()} length`);
    }
    if (!luhnCheck(number)) throw new Error('Card number failed Luhn check');
    const cvv = stripNonDigits(payload.cvv);
    if (!meta.cvv.includes(cvv.length)) throw new Error(`Invalid ${brand.toUpperCase()} CVV length`);
    // expiry MM/YY
    const exp = String(payload.expiry || '');
    const m = exp.match(/^\s*(0[1-9]|1[0-2])\/(\d{2})\s*$/);
    if (!m) throw new Error('Invalid expiry format (MM/YY)');
    const month = parseInt(m[1], 10);
    const year = 2000 + parseInt(m[2], 10);
    const now = new Date();
    const lastDay = new Date(year, month, 0); // end of expiry month
    if (lastDay < new Date(now.getFullYear(), now.getMonth(), 1)) {
      throw new Error('Card is expired');
    }
    return { mode, brand, last4: number.slice(-4) };
  }

  if (mode === 'bank') {
    const routing = stripNonDigits(payload.routingNumber);
    const account = stripNonDigits(payload.accountNumber);
    const checkNumber = stripNonDigits(payload.checkNumber || '');
    if (routing.length !== 9) throw new Error('Routing number must be 9 digits');
    if (account.length < 7 || account.length > 12) throw new Error('Account number must be 7–12 digits');
    // optional checkNumber recommended
    return { mode, routing, accountLen: account.length, checkNumber: checkNumber || null };
  }

  throw new Error('Unsupported payment mode');
}

function enforceShippingDisclosure(text) {
  const snippet = 'Your order ships in approximately 5–7 business days.';
  if (!text || !text.trim()) return snippet;
  if (text.toLowerCase().includes('5–7 business days') || text.toLowerCase().includes('5-7 business days')) {
    return text;
  }
  return text.trim().endsWith('.') ? `${text} ${snippet}` : `${text}. ${snippet}`;
}

function hangupGuard(event) {
  // Only allow explicit 'user_end' or verified technical failure
  const normalized = String(event || '').toLowerCase();
  if (normalized === 'user_end' || normalized === 'fatal_error') {
    return 'allow-end';
  }
  return 'keep-alive';
}

module.exports = {
  initFlowEngine,
  healthQuestionPacingPolicy,
  computeOfferFromSKUs,
  validatePaymentEnvelope,
  enforceShippingDisclosure,
  hangupGuard,
  state
};
