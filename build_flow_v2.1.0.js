// build_flow_v2.1.0.js
// Build massive persuasion and sales flow JSON for Alex

'use strict';

const fs = require('fs');
const path = require('path');

function buildFlow() {
  const flow = {
    version: '2.1.0',
    created: new Date().toISOString(),
    stages: []
  };

  // Massive stages (simplified example, expand as needed)
  const intro = {
    id: 'intro',
    prompt: "Hello, can you hear me okay? Great! The reason for the call today is to follow up on the health information we sent you. Did you get that?",
    next: 'qualify'
  };
  const qualify = {
    id: 'qualify',
    prompt: "Can I ask you a couple quick questions about your health today?",
    next: 'discovery'
  };
  const discovery = {
    id: 'discovery',
    prompt: "Tell me about any health concerns—energy, sleep, joints, blood pressure, or something else.",
    next: 'pitch'
  };
  const pitch = {
    id: 'pitch',
    prompt: "Based on what you told me, here’s the program I recommend…",
    next: 'close'
  };
  const close = {
    id: 'close',
    prompt: "Which works best for you—card or bank?",
    next: 'end'
  };
  flow.stages.push(intro, qualify, discovery, pitch, close);

  return flow;
}

function saveFlow(outPath) {
  const flow = buildFlow();
  fs.writeFileSync(outPath, JSON.stringify(flow, null, 2));
  console.log('[build_flow] flow saved to', outPath);
}

if (require.main === module) {
  const outPath = path.join(__dirname, 'flows_alex_sales.json');
  saveFlow(outPath);
}

module.exports = { buildFlow, saveFlow };
