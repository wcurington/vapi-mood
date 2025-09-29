'use strict';
/**
 * patch_flows_pauses_shipping_v1.3.3.js
 * Express router that:
 *  - Enforces "maximum value before price" with a 6–10 minute value-building window
 *  - Provides persuasive closing lines (as requested)
 *  - Adds vtiger + shipping (EasyPost-style) stubs
 *  - Provides pricing calculator guarded by value-building completion
 *  - Provides ACH capture validation and identity endpoints
 *  - Micro-turn health discovery with paced questions
 *
 * Mount at e.g.:
 *   const flowsPatch = require('./patch_flows_pauses_shipping_v1.3.3');
 *   app.use('/flows', flowsPatch);
 */

const express = require('express');
const router = express.Router();

// ====== Config ======
const VALUE_MIN_MS = (process.env.VALUE_MIN_MINUTES ? Number(process.env.VALUE_MIN_MINUTES) : 6) * 60 * 1000; // 6 min
const VALUE_MAX_MS = (process.env.VALUE_MAX_MINUTES ? Number(process.env.VALUE_MAX_MINUTES) : 10) * 60 * 1000; // 10 min
const MAX_DISCOUNT_PERCENT = 15;

// in-memory value-building tracker (per caller/session). Replace with Redis in prod if needed.
const valueTimers = new Map();
function now() { return Date.now(); }
function startValueTimer(sessionId) {
  valueTimers.set(sessionId, { startedAt: now(), completedAt: null });
}
function completeValueTimer(sessionId) {
  const t = valueTimers.get(sessionId) || {};
  t.completedAt = now();
  valueTimers.set(sessionId, t);
}
function getValueStatus(sessionId) {
  const t = valueTimers.get(sessionId);
  if (!t) return { ok:false, reason:'not_started' };
  const elapsed = (t.completedAt || now()) - t.startedAt;
  const okMin = elapsed >= VALUE_MIN_MS;
  const withinMax = elapsed <= VALUE_MAX_MS + (5*60*1000); // soft grace
  return { ok: okMin, elapsedMs: elapsed, withinMax, startedAt: t.startedAt, completedAt: t.completedAt || null };
}

// ====== Utilities ======
function withPause(s) { return `${s} …`; }
function seconds(n) { return n * 1000; }

// ====== Micro-turn discovery ======
const HEALTH_QUESTIONS = [
  'What are the top two or three health issues you want to improve first?',
  'How long have you been dealing with these symptoms?',
  'On a scale of 1–10, where are you most days?',
  'What have you tried already, and what helped even a little?',
  'Which times of day are your symptoms the worst?',
  'Are there triggers—foods, stress, sleep—that spike symptoms?',
  'What would a good 30‑day outcome look like for you?'
];

router.get('/health', (req, res) => {
  res.json({ status: 'UP', module: 'flows v1.3.3' });
});

// start the "value" window; pass ?sessionId=xyz
router.post('/value/start', (req, res) => {
  const sessionId = String((req.query.sessionId || req.body?.sessionId || req.ip));
  startValueTimer(sessionId);
  const seq = HEALTH_QUESTIONS.map(q => withPause(q));
  res.json({
    ok:true,
    sessionId,
    cadence: 'micro-turns',
    minMinutes: VALUE_MIN_MS/60000,
    maxMinutes: VALUE_MAX_MS/60000,
    questions: seq
  });
});

// mark value building complete (after 6–10 minutes)
router.post('/value/complete', (req, res) => {
  const sessionId = String((req.query.sessionId || req.body?.sessionId || req.ip));
  completeValueTimer(sessionId);
  const status = getValueStatus(sessionId);
  res.json({ ok:true, sessionId, status });
});

router.get('/value/status', (req, res) => {
  const sessionId = String((req.query.sessionId || req.body?.sessionId || req.ip));
  const status = getValueStatus(sessionId);
  res.json({ sessionId, status });
});

// ====== Pricing (guarded by value window) ======
router.post('/pricing', (req, res) => {
  const sessionId = String((req.query.sessionId || req.body?.sessionId || req.ip));
  const status = getValueStatus(sessionId);
  if (!status.ok) {
    return res.status(425).json({
      ok:false,
      error:'value_window_incomplete',
      detail:`Must build value for at least ${VALUE_MIN_MS/60000} minutes before offering price.`,
      status
    });
  }

  const { items=[], discountPct=0 } = req.body || {};
  let subtotal = 0.0;
  items.forEach(it => { subtotal += Number(it.price || 0) * Number(it.qty || 1); });
  const discount = Math.max(0, Math.min(MAX_DISCOUNT_PERCENT, Number(discountPct || 0)));
  const total = +(subtotal * (1 - discount/100)).toFixed(2);
  res.json({
    ok:true,
    policy: {
      maximum_value_before_price: true,
      free_shipping: true,
      no_taxes: true,
      maxDiscountPercent: MAX_DISCOUNT_PERCENT
    },
    subtotal: +subtotal.toFixed(2),
    discountPct: discount,
    total
  });
});

// ====== Payments / ACH capture ======
router.post('/payments/bank/capture', (req, res) => {
  const { routingNumber='', accountNumber='', checkNumber } = req.body || {};
  const r = (routingNumber || '').replace(/\D/g,'');
  const a = (accountNumber || '').replace(/\D/g,'');
  const okRouting = /^\d{9}$/.test(r);
  const okAccount = /^\d{7,12}$/.test(a);
  const hasCheck = (checkNumber !== undefined && String(checkNumber).trim() !== '');
  const ok = okRouting && okAccount && hasCheck;
  res.json({ ok, okRouting, okAccount, hasCheck });
});

// ====== Identity and persuasive close ======
router.get('/identity', (req, res) => {
  res.json({
    identity: "Alex, Senior Escalation Sales Health Expert at Health America.",
    preferredResponse: "I'm Alex, a Senior Escalation Sales Health Expert here at Health America—I'll help you map your issues to a concrete plan today."
  });
});

router.get('/close/shipping', (req, res) => {
  // Deeper persuasive script as requested
  const lines = [
    "Fantastic—your order is confirmed. Shipping in 5–7 business days.",
    "Free shipping today, and there are no taxes on your order.",
    "This product is wonderful.",
    "You're going to love it!",
    "I use it everyday.",
    "If anything feels off, we adjust. You're not stuck.",
  ];
  res.json({ message: lines.join(' ') });
});

// ====== vtiger + shipping stubs (to be wired) ======
router.post('/crm/vtiger/lead', (req,res)=>{
  res.json({ ok:true, info:'vtiger lead created (stub)', payload:req.body||{} });
});

router.post('/crm/vtiger/order', (req,res)=>{
  res.json({ ok:true, info:'vtiger order created (stub)', payload:req.body||{} });
});

router.post('/shipping/label', (req,res)=>{
  res.json({ ok:true, info:'label created (stub)', tracking:'TRACK'+Date.now(), payload:req.body||{} });
});

router.get('/shipping/track/:code', (req,res)=>{
  res.json({ ok:true, code:req.params.code, status:'in_transit' });
});

module.exports = router;
