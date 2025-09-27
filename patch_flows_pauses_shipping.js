
/**
 * patch_flows_pauses_shipping.js — XXL Edition (flow helpers & shipping disclosure)
 * ----------------------------------------------------------------------------
 * PURPOSE
 *   Flow-safe helpers to improve conversational pacing, address readback quality,
 *   shipping disclosure consistency, and soft-close anti-hangup behaviors.
 */
const speechFilter = require('./server_speech_filter');
const SHIPPING_SENTENCE = 'Delivery is in five to seven days.';
function sentenceHasShipping(text = '') { return /\bfive\s+to\s+seven\s+days\b/i.test(String(text)); }
function ensureShippingDisclosure(text = '') {
  const s = String(text || '').trim();
  if (!s) return SHIPPING_SENTENCE;
  if (sentenceHasShipping(s)) return s;
  const sep = s.endsWith('.') ? ' ' : '. ';
  return `${s}${sep}${SHIPPING_SENTENCE}`;
}
function enrichAddressReadback(text = '') { return speechFilter.safeUtterance(text, { addressMode: true }); }
function softCloseWrap(text = '') {
  const s = speechFilter.sanitizeOutput(text);
  const tail = ' Before we wrap up, is there anything else I can help you with?';
  return s.endsWith('?') || s.endsWith('.') ? s + tail : s + '. ' + tail;
}
function makeHealthQuestionNode(id, say, nextId) {
  const baseSay = String(say || 'Can you tell me more about that?');
  const paced = speechFilter.applyHealthPacing(baseSay, { minPauseMs: 2600 });
  return { id, say: paced.text, tone: 'empathetic', meta: paced.meta,
    branches:{ yes:`${id}_ack_yes`, no:`${id}_ack_no`, hesitate:`${id}_repeat`, silence:`${id}_repeat` },
    next: nextId || null };
}
function deriveNextState(node, normalizedReply) {
  if (!node || !node.branches) return node?.next || null;
  const cls = String(normalizedReply || 'other');
  if (cls === 'yes') return node.branches.yes;
  if (cls === 'no')  return node.branches.no;
  return node.branches.hesitate || node.branches.silence || node.next || null;
}
function router() {
  const express = require('express'); const r = express.Router();
  r.get('/health', (req, res) => { res.json({ status: 'UP', module: 'patch_flows_pauses_shipping', ts: new Date().toISOString() }); });
  r.post('/test/shipping', (req, res) => { const { text } = req.body || {}; return res.json({ out: ensureShippingDisclosure(text || '') }); });
  r.post('/test/address', (req, res) => { const { text } = req.body || {}; return res.json({ out: enrichAddressReadback(text || '') }); });
  r.post('/test/health-node', (req, res) => {
    const { id, say, nextId, reply } = req.body || {};
    const node = makeHealthQuestionNode(id || 'qX', say || 'Example?', nextId || 'qY');
    const norm = speechFilter.normalizeAffirmation(reply || '');
    const next = deriveNextState(node, norm);
    return res.json({ node, normalizedReply: norm, next });
  });
  return r;
}
module.exports = {
  ensureShippingDisclosure,
  enrichAddressReadback,
  softCloseWrap,
  makeHealthQuestionNode,
  deriveNextState,
  router
};
/* Long-form runbooks omitted here for brevity in code block generation. */
