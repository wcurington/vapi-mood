'use strict';
const express = require('express');
const router = express.Router();

// pacing helpers
function withPause(s) { return `${s} …`; }
const HEALTH_QUESTIONS = [
  'Are you experiencing joint pain today?',
  'On a scale of 1–10, how would you rate your discomfort?',
  'Do you have any mobility limitations affecting daily tasks?',
  'How long have you been experiencing these symptoms?'
];

router.get('/health', (req, res) => {
  res.json({ status: 'UP', module: 'flows v1.3.2' });
});

// deliver micro-turn health questions with pacing
router.get('/health/questions', (req, res) => {
  const seq = HEALTH_QUESTIONS.map(q => withPause(q));
  res.json({ questions: seq, cadence: 'micro-turns' });
});

// pricing calculator (delegate compatible with core)
router.post('/pricing', (req, res) => {
  const { items=[], discountPct=0 } = req.body || {};
  let subtotal = 0.0;
  items.forEach(it => { subtotal += Number(it.price || 0) * Number(it.qty || 1); });
  const discount = Math.max(0, Math.min(100, Number(discountPct || 0)));
  const total = +(subtotal * (1 - discount/100)).toFixed(2);
  res.json({ subtotal: +subtotal.toFixed(2), discountPct: discount, total });
});

// ACH capture requires strict lengths + checkNumber
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

// identity + persuasive closing
router.get('/identity', (req, res) => {
  res.json({
    identity: "Alex, Senior Escalation Sales Health Expert at Health America.",
    preferredResponse: "I'm Alex, a Senior Escalation Sales Health Expert here at Health America—I'm ready to help you improve your health today."
  });
});

router.get('/close/shipping', (req, res) => {
  const lines = [
    'Fantastic—your order is confirmed. Shipping in 5–7 business days.',
    "You're going to love it.", "It is Absolutely Amazing.", "This Product is incredible."
  ];
  res.json({ message: lines.join(' ') });
});

module.exports = router;
