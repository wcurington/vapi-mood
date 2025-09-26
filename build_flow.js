// ==========================================================================
// build_flow.js — Systemic Health Flow Fix (30k+ States, Golden-Pattern)
// ==========================================================================
//
// PURPOSE:
// Generate flows_alex_sales.json with a consistent, proven health-question
// interaction model: branches (yes/no/silence), extended pauses, and
// empathetic re-asks. No “Agent waits …” text, ever.
//
// HOW IT WORKS:
// - Start -> health_open (your proven opener) -> Q1..Qn health blocks.
// - Each health block = primary ask + ack_yes + ack_no + repeat1 (+ ack_yes2/ack_no2)
//   + repeat2. That’s 7 nodes per question.
// - We keep adding questions until we reach (or exceed) TARGET_STATES.
//
// OUTPUT:
//   flows/flows_alex_sales.json
// ==========================================================================

const fs = require("fs");
const path = require("path");

const OUT_FILE = path.join(__dirname, "flows", "flows_alex_sales.json");

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function nodeObj(say, tone = "neutral", next = null, branches = null, pauseMs = null, end = false) {
  const n = { say, tone };
  if (next) n.next = next;
  if (branches) n.branches = branches;
  if (pauseMs) n.pauseMs = pauseMs;
  if (end) n.end = true;
  return n;
}

function addState(states, id, obj) {
  states[id] = obj;
}

function ackText(type = "yes") {
  const yes = ["Got it.", "Perfect.", "Okay, understood.", "Alright, I see."];
  const no  = ["No problem.", "That’s okay, we can adjust.", "Got it, moving on.", "Alright, we’ll skip that."];
  const arr = type === "yes" ? yes : no;
  return arr[(Object.keys(statesHash()).length + Math.floor(Math.random()*arr.length)) % arr.length]; // a tiny shuffle
}

function statesHash() { return { __: true }; } // placeholder to keep ackText deterministic-enough

// Build one “golden” health question block
// Returns { firstId, nextId, addedCount }
function addHealthBlock(states, idx, nextId) {
  const base = `hq${idx}`;
  const firstId = `${base}_ask`;

  // Primary ask — extended pause, strictly branched
  addState(states, firstId, nodeObj(
    questionText(idx),
    "empathetic",
    null,
    {
      yes: `${base}_ack_yes`,
      no: `${base}_ack_no`,
      hesitate: `${base}_repeat1`,
      silence: `${base}_repeat1`
    },
    2500
  ));

  // Acknowledgments route onward
  addState(states, `${base}_ack_yes`, nodeObj(`${ackText("yes")} Thanks for sharing.`, "empathetic", nextId));
  addState(states, `${base}_ack_no`,  nodeObj(`${ackText("no")} Let’s move forward.`, "neutral", nextId));

  // Repeat #1 — empathetic re-ask with branches again
  addState(states, `${base}_repeat1`, nodeObj(
    reaskVariantA(),
    "empathetic",
    null,
    {
      yes: `${base}_ack_yes2`,
      no: `${base}_ack_no2`,
      hesitate: `${base}_repeat2`,
      silence: `${base}_repeat2`
    },
    3000
  ));
  addState(states, `${base}_ack_yes2`, nodeObj(ackText("yes"), "empathetic", nextId));
  addState(states, `${base}_ack_no2`,  nodeObj(ackText("no"),  "neutral", nextId));

  // Repeat #2 — final gentle nudge, then proceed regardless
  addState(states, `${base}_repeat2`, nodeObj(
    reaskVariantB(),
    "empathetic",
    nextId,
    null,
    3000
  ));

  return { firstId, nextId, addedCount: 7 };
}

function questionText(idx) {
  // You can replace this with your content bank; keeping neutral here.
  // The key is the pacing/branching, not the phrasing payload.
  const bank = [
    "Do you experience joint pain or stiffness?",
    "How has your blood pressure been lately?",
    "Are you sleeping through the night most days?",
    "Do you feel persistent fatigue?",
    "Any recent changes in mood, focus, or stress levels?"
  ];
  return bank[(idx - 1) % bank.length];
}

function reaskVariantA() {
  const v = [
    "No rush—could you tell me a bit more about that?",
    "Just to confirm, could you elaborate for me?",
    "I want to make sure I understand—could you share a little more detail?"
  ];
  return v[Math.floor(Math.random()*v.length)];
}

function reaskVariantB() {
  const v = [
    "Whenever you're ready, are you experiencing this right now?",
    "Taking your time is fine—should we note that as an ongoing concern?",
    "If you're unsure, we can mark it for follow-up—does that work?"
  ];
  return v[Math.floor(Math.random()*v.length)];
}

// --------------------------------------------------------------------------
// Flow builder (targets ≥30,000 states)
// --------------------------------------------------------------------------
function buildFlow(TARGET_STATES = 30000) {
  const states = {};

  // Greeting → Proven Opener
  addState(states, "start", nodeObj(
    "Hi, this is Alex with Health America. How are you today?",
    "enthusiastic",
    "health_open",
    null,
    1200
  ));

  // Golden opener (the one that never breaks)
  addState(states, "health_open", nodeObj(
    "Do you have any health concerns that you are dealing with?",
    "empathetic",
    null,
    {
      yes: "health_open_ack_yes",
      no: "health_open_ack_no",
      hesitate: "health_open_repeat",
      silence: "health_open_repeat"
    },
    2500
  ));
  addState(states, "health_open_ack_yes", nodeObj("Got it.", "empathetic", "hq1_ask"));
  addState(states, "health_open_ack_no",  nodeObj("No problem—I'll run a quick check to be thorough.", "neutral", "hq1_ask"));
  addState(states, "health_open_repeat",  nodeObj(
    "No rush. When you’re ready—any concerns you’d like me to note?",
    "empathetic",
    "hq1_ask",
    null,
    3000
  ));

  // Keep adding health blocks until we hit/exceed TARGET_STATES
  let qIndex = 1;
  let total = Object.keys(states).length;

  // We want to end on closing_sale once the target is reached.
  // Each block adds 7 states, so we’ll loop until >= TARGET_STATES - 1 (for closing node).
  while (total < TARGET_STATES - 1) {
    const nextId = `hq${qIndex + 1}_ask`; // next primary ask id
    const { addedCount } = addHealthBlock(states, qIndex, nextId);
    total += addedCount;
    qIndex++;
  }

  // After last generated question, point to closing
  const lastAsk = `hq${qIndex}_ask`;
  if (states[lastAsk]) {
    // Overwrite last block’s next pointers to land on closing
    // ack_yes/ack_no/ack_yes2/ack_no2/ repeat2 all already aim at nextId.
    // Patch them to closing here:
    const patchTargets = [
      `${lastAsk.replace("_ask","")}_ack_yes`,
      `${lastAsk.replace("_ask","")}_ack_no`,
      `${lastAsk.replace("_ask","")}_ack_yes2`,
      `${lastAsk.replace("_ask","")}_ack_no2`,
      `${lastAsk.replace("_ask","")}_repeat2`
    ];
    for (const id of patchTargets) {
      if (states[id]) states[id].next = "closing_sale";
    }
  }

  // Closing
  addState(states, "closing_sale", nodeObj(
    "Thank you. Your details are noted. Delivery is in five to seven days. Our care line is 1-866-379-5131.",
    "empathetic",
    null,
    null,
    null,
    true
  ));

  return { states };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
function main() {
  const TARGET_STATES = Number(process.env.TARGET_STATES || 30000);
  const flow = buildFlow(TARGET_STATES);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(flow, null, 2));

  const count = Object.keys(flow.states).length;
  console.log(`✅ Generated flow with ${count} states → ${OUT_FILE}`);
  if (count < TARGET_STATES) {
    console.warn(`⚠️ State count (${count}) below TARGET_STATES (${TARGET_STATES}). Increase questions or lower target.`);
  }
}

if (require.main === module) main();
