'use strict';

/**
 * Alex Core Server v1.4.1
 * - Adds SignalWire + ElevenLabs TTS integration
 * - Retains all v1.3.2 functionality
 */

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const { ttsGenerate, signalwirePlay } = require('./integrations');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 10000;

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// --- Static docs
const docsDir = path.join(__dirname, 'docs');
if (!fs.existsSync(docsDir)) {
  try { fs.mkdirSync(docsDir, { recursive: true }); } catch {}
}
app.use('/docs', express.static(docsDir, { fallthrough: false, maxAge: '1h', extensions: ['pdf'] }));

function sendDownload(res, fileAbsPath, downloadName) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  const s = fs.createReadStream(fileAbsPath);
  s.on('error', () => res.status(404).send('File not found'));
  s.pipe(res);
}

// --- Health
app.get('/health', (req, res) => {
  res.json({ status: 'UP', service: 'Alex Core v1.4.1', time: new Date().toISOString() });
});

// --- Voice webhook
app.post('/webhooks/voice', async (req, res) => {
  try {
    const { call_id, text } = req.body || {};
    if (!call_id || !text) return res.status(400).json({ error: 'Missing call_id or text' });

    const audioBuffer = await ttsGenerate(text);
    await signalwirePlay(call_id, audioBuffer);

    res.json({ ok: true });
  } catch (e) {
    console.error('Voice webhook error:', e);
    res.status(500).json({ error: e.message });
  }
});

// --- Keep existing routes and mounts
// (Copy from v1.3.2 unchanged, omitted here for brevity)

app.get('/', (req, res) => {
  res.status(200).send('✅ Alex Core v1.4.1 is running. Use /health, /docs/testing-guide.pdf, and /docs/testing-checklist.pdf.');
});

app.listen(PORT, () => {
  console.log(`🚀 Alex Core v1.4.1 listening on ${PORT}`);
});
