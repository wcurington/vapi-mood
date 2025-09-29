'use strict';
/**
 * integrations_v1.5.3.js (corrected)
 * - Inbound voice: return LaML <Response> with ElevenLabs MP3 or fallback <Say>
 * - Outbound voice (helper): create call via SignalWire REST (optional)
 * - Payments: Stripe + Authorize.Net placeholders
 * - Enhanced: accepts salesFlows + alexPrompt arguments
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch'); // v2 in package.json
const { URLSearchParams } = require('url');

// ----- Env -----
const {
  PUBLIC_BASE_URL,
  SIGNALWIRE_SPACE,
  SIGNALWIRE_PROJECT,
  SIGNALWIRE_TOKEN,
  SIGNALWIRE_WEBHOOK_SECRET,
  SIGNALWIRE_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  STRIPE_API_KEY,
  AUTHNET_API_LOGIN_ID,
  AUTHNET_TRANSACTION_KEY,
} = process.env;

const VERSION = '1.5.3';

// ----- Utils -----
const MEDIA_DIR = path.resolve(process.cwd(), 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

function log(...args) {
  console.log(`[integrations v${VERSION}]`, ...args);
}

function absoluteMediaUrl(filename) {
  const base = (PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/media/${filename}`;
}

function randomId(n = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// ----- Webhook signature -----
function verifySignalWireSignature(reqRawBody, headers) {
  if (!SIGNALWIRE_WEBHOOK_SECRET) {
    return { ok: true, reason: 'no-secret' };
  }
  const h =
    headers['x-signalwire-signature'] ||
    headers['x-signalwire-signature-hmac-sha256'] ||
    headers['x-hook-signature'] ||
    '';

  if (!h) return { ok: false, reason: 'missing-signature-header' };

  const mac = crypto.createHmac('sha256', SIGNALWIRE_WEBHOOK_SECRET);
  mac.update(reqRawBody || '');
  const digest = mac.digest('hex');

  const match = crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(h));
  return match ? { ok: true } : { ok: false, reason: 'sig-mismatch' };
}

// ----- ElevenLabs TTS -----
async function elevenLabsTTS(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error('Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID');
  }
  const filename = `tts_${Date.now()}_${randomId()}.mp3`;
  const outPath = path.join(MEDIA_DIR, filename);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}`;
  const body = {
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.4, similarity_boost: 0.7 },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`ElevenLabs TTS failed: ${resp.status} ${t}`);
  }

  const buff = await resp.buffer();
  fs.writeFileSync(outPath, buff);
  const mediaUrl = absoluteMediaUrl(filename);
  log('Generated TTS:', mediaUrl);
  return { filename, mediaUrl, size: buff.length };
}

// ----- LaML helpers -----
function buildPlayXml(mediaUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${mediaUrl}</Play>
</Response>`;
}

function buildSayXml(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeXml(text)}</Say>
</Response>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ----- Inbound handler -----
async function handleInboundVoice(req, res, rawBody, flows = {}, prompt = '') {
  try {
    const verdict = verifySignalWireSignature(rawBody, req.headers || {});
    if (!verdict.ok) {
      log('WARNING: webhook signature check failed:', verdict.reason);
    }
  } catch (e) {
    log('WARN signature verifier errored (continuing):', e.message);
  }

  const isCompat = !!(req.body && (req.body.CallSid || req.body.AccountSid));
  const isJsonEvent = !!(req.body && req.body.event_type);

  if (isCompat || isJsonEvent) {
    const from = ((req.body && req.body.From) || '').trim();
    const to = ((req.body && req.body.To) || '').trim();
    log('Inbound voice webhook:', {
      from, to,
      type: isCompat ? 'compat' : 'json',
      flowsLoaded: Object.keys(flows || {}).length,
      promptLen: prompt ? prompt.length : 0
    });

    let xml;
    try {
      const greeting = `Hello. This is Alex on a secure line. How can I help you today?`;
      const { mediaUrl } = await elevenLabsTTS(greeting);
      xml = buildPlayXml(mediaUrl);
    } catch (e) {
      log('ElevenLabs error, falling back to <Say>:', e.message);
      xml = buildSayXml('Hello. This is Alex. How can I help you today?');
    }

    res.set('Content-Type', 'text/xml; charset=utf-8').status(200).send(xml);
    return;
  }

  res.set('Content-Type', 'text/xml; charset=utf-8').status(200)
     .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// ----- Outbound example -----
async function createOutboundCall({ to, from = SIGNALWIRE_PHONE_NUMBER, url }) {
  if (!SIGNALWIRE_SPACE || !SIGNALWIRE_PROJECT || !SIGNALWIRE_TOKEN)
    throw new Error('Missing SignalWire credentials');

  const endpoint = `https://${SIGNALWIRE_SPACE}/api/laml/2010-04-01/Accounts/${SIGNALWIRE_PROJECT}/Calls.json`;
  const auth = Buffer.from(`${SIGNALWIRE_PROJECT}:${SIGNALWIRE_TOKEN}`).toString('base64');

  const form = new URLSearchParams();
  form.set('To', to);
  form.set('From', from);
  form.set('Url', url);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Create call failed ${resp.status}: ${text}`);
  log('Outbound call created:', text);
  return JSON.parse(text);
}

// ----- Payments stubs -----
function processPaymentStripe(amountCents, currency, sourceOrPaymentMethodId, meta = {}) {
  log('Stripe charge requested (stub).', { amountCents, currency, meta });
  return { ok: true, id: 'stripe_txn_stub' };
}

function processPaymentAuthorizeNet(amount, cardOrProfile, meta = {}) {
  log('Authorize.Net charge requested (stub).', { amount, meta });
  return { ok: true, id: 'authnet_txn_stub' };
}

module.exports = {
  VERSION,
  handleInboundVoice,
  createOutboundCall,
  processPaymentStripe,
  processPaymentAuthorizeNet,
};
