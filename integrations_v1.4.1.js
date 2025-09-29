// ============================
// integrations.js v1.4.1
// ============================

const fetch = require('node-fetch');
const { RestClient } = require('@signalwire/node');

// ---------- ENV ----------
const {
  SIGNALWIRE_PROJECT,
  SIGNALWIRE_TOKEN,
  SIGNALWIRE_SPACE,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID
} = process.env;

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

// ---------- SignalWire ----------
const signalwireClient = new RestClient(SIGNALWIRE_PROJECT, SIGNALWIRE_TOKEN, { signalwireSpaceUrl: SIGNALWIRE_SPACE });

async function signalwirePlay(callId, audioBuffer) {
  // save audio temporarily and instruct SignalWire to play
  const tmpFile = '/tmp/tts_output.mp3';
  require('fs').writeFileSync(tmpFile, audioBuffer);

  await signalwireClient.calls.playAudio(callId, {
    url: `file://${tmpFile}`,
  });
}

module.exports = {
  ttsGenerate,
  signalwirePlay
};
