// ============================
// integrations.js v1.4.2 (patched)
// - Adds handleInboundVoice(req, res, rawBody, salesFlows)
// - Saves ElevenLabs TTS to /media and returns a public HTTPS URL
// - Keeps ttsGenerate() for raw Buffer usage when needed
// ============================

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { RestClient } = require('@signalwire/node');

// ---------- ENV ----------
const {
  SIGNALWIRE_PROJECT,
  SIGNALWIRE_TOKEN,
  SIGNALWIRE_SPACE,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  PUBLIC_BASE_URL
} = process.env;

const MEDIA_DIR = path.join(process.cwd(), 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ---------- ElevenLabs TTS ----------
async function ttsGenerate(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({ text, model_id: 'eleven_monolingual_v1' })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`ElevenLabs TTS failed: ${t}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

// Save TTS to /media and return absolute URL
async function ttsSaveAndUrl(text) {
  const buf = await ttsGenerate(text);
  const fname = `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`;
  const fpath = path.join(MEDIA_DIR, fname);
  fs.writeFileSync(fpath, buf);
  if (!PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is not set; cannot construct media URL.');
  }
  return `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/media/${fname}`;
}

// ---------- SignalWire low-level (optional) ----------
const signalwireClient = (SIGNALWIRE_PROJECT && SIGNALWIRE_TOKEN && SIGNALWIRE_SPACE)
  ? new RestClient(SIGNALWIRE_PROJECT, SIGNALWIRE_TOKEN, { signalwireSpaceUrl: SIGNALWIRE_SPACE })
  : null;

async function signalwirePlay(callId, audioBuffer) {
  // Prefer hosted URL; file:// is not accessible by SignalWire cloud.
  const tmpName = `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`;
  const tmpPath = path.join(MEDIA_DIR, tmpName);
  fs.writeFileSync(tmpPath, audioBuffer);
  if (!PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is not set; cannot construct media URL.');
  }
  const url = `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/media/${tmpName}`;
  if (!signalwireClient) {
    throw new Error('SignalWire client not configured.');
  }
  await signalwireClient.calls.playAudio(callId, { url });
}

// ---------- Inbound webhook handler ----------
// Generates simple LaML to greet and optionally play TTS from hosted URL.
async function handleInboundVoice(req, res, rawBody, salesFlows) {
  try {
    const caller = (req.body && (req.body.From || req.body.from)) || 'caller';
    const greeting = `This is Alex with Health America. How are you today?`;
    // Create hosted TTS URL for better audio quality
    let playUrl;
    try {
      playUrl = await ttsSaveAndUrl(greeting);
    } catch (_) {
      playUrl = null; // fallback to <Say>
    }

    res.set('Content-Type', 'text/xml; charset=utf-8');
    if (playUrl) {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${playUrl}</Play>
  <Say>Let's continue.</Say>
</Response>`);
    } else {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${greeting}</Say>
</Response>`);
    }
  } catch (e) {
    console.error('[handleInboundVoice] error:', e);
    return res.status(200).set('Content-Type', 'text/xml; charset=utf-8').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, an internal error occurred.</Say></Response>`);
  }
}

module.exports = {
  ttsGenerate,
  ttsSaveAndUrl,
  signalwirePlay,
  handleInboundVoice
};
