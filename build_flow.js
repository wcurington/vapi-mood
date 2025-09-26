// ==========================================================================
// build_flow.js — Systemic Health Flow + Sales Stitch + 30k Padding
// ==========================================================================
//
// GOAL
// - Systemic fix: EVERY health question uses golden pattern
//   (yes/no/silence branches, extended pauses, empathetic re-asks).
// - Insert full sales journey AFTER a concise, informative health section.
// - Pad with low-risk "micro-turns" to ~30,000+ states (configurable).
// - Never prints "Agent waits 900ms" or any stage directions as text.
// - Only uses pauseMs, which your server.js converts to SSML <break/>.
//
// OUTPUT
// - flows/flows_alex_sales.json
//
// CONFIG (env or defaults)
// - TARGET_STATES: total graph size target (default 30000)
// - HEALTH_BLOCKS: number of golden health questions before sales (default 40)
// - MICRO_TURN_BATCH: size of each micro-turn batch (default 50)
//
// ==========================================================================

const fs = require("fs");
const path = require("path");

const OUT_FILE = path.join(__dirname, "flows", "flows_alex_sales.json");

// ---------- Config ----------
const TARGET_STATES    = Number(process.env.TARGET_STATES || 30000);
const HEALTH_BLOCKS    = Math.max(10, Number(process.env.HEALTH_BLOCKS || 40));     // concise but meaningful health pass
const MICRO_TURN_BATCH = Math.max(10, Number(process.env.MICRO_TURN_BATCH || 50));  // batch size used to pad to target

// ---------- Utilities ----------
function nodeObj(say, tone = "neutral", next = null, branches = null, pauseMs = null, end = false) {
  const n = { say, tone };
  if (next) n.next = next;
  if (branches) n.branches = branches;
  if (pauseMs) n.pauseMs = pauseMs;
  if (end) n.end = true;
  return n;
}
function addState(states, id, obj) { states[id] = obj; }
function exists(states, id) { return Object.prototype.hasOwnProperty.call(states, id); }

function randomPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function ackYes() {
  const opts = ["Got it.", "Perfect.", "Okay, understood.", "Alright, I see."];
  return randomPick(opts);
}
function ackNo() {
  const opts = ["No problem.", "That’s okay, we can adjust.", "Got it, moving on.", "Alright, we’ll skip that."];
  return randomPick(opts);
}

// ---------- Health Q Content Banks (rotate to avoid repetition) ----------
const HEALTH_BANK = [
  "Do you experience joint pain or stiffness?",
  "How has your blood pressure been lately?",
  "Are you generally sleeping through the night?",
  "Have you felt persistent fatigue over the last few weeks?",
  "Any recent changes in stress, mood, or focus?",
  "Any digestive discomfort or irregularity you’ve noticed?",
  "Do you get muscle cramps or weakness after activity?",
  "Any swelling in ankles or hands recently?",
  "Any episodes of dizziness or lightheadedness?",
  "Have you noticed any changes in appetite or weight?"
];

const REASK_A = [
  "No rush—could you tell me a bit more about that?",
  "Just to confirm, could you elaborate for me?",
  "I want to make sure I understand—could you share a little more detail?"
];
const REASK_B = [
  "Whenever you're ready, are you experiencing this right now?",
  "Taking your time is fine—should we note that as an ongoing concern?",
  "If you're unsure, we can mark it for follow-up—does that work?"
];

// ---------- Health Block (Golden Pattern) ----------
// Returns { firstId, addedIds[] }
function addHealthBlock(states, index, nextAfterBlockId) {
  // 7 nodes per block:
  // ask → ack_yes | ack_no | repeat1 → (ack_yes2 | ack_no2 | repeat2) → next
  const base = `hq${index}`;
  const askId = `${base}_ask`;
  const ackYesId = `${base}_ack_yes`;
  const ackNoId  = `${base}_ack_no`;
  const repeat1Id = `${base}_repeat1`;
  const ackYes2Id = `${base}_ack_yes2`;
  const ackNo2Id  = `${base}_ack_no2`;
  const repeat2Id = `${base}_repeat2`;

  const qText = HEALTH_BANK[(index - 1) % HEALTH_BANK.length];

  // Primary ask — extended pause, branched listening
  addState(states, askId, nodeObj(
    qText,
    "empathetic",
    null,
    {
      yes: ackYesId,
      no: ackNoId,
      hesitate: repeat1Id,
      silence: repeat1Id
    },
    2500
  ));

  // Acknowledgments route onward
  addState(states, ackYesId, nodeObj(`${ackYes()} Thanks for sharing.`, "empathetic", nextAfterBlockId));
  addState(states, ackNoId,  nodeObj(`${ackNo()} Let’s move forward.`, "neutral", nextAfterBlockId));

  // Repeat #1 — empathetic re-ask with branches again
  addState(states, repeat1Id, nodeObj(
    randomPick(REASK_A),
    "empathetic",
    null,
    {
      yes: ackYes2Id,
      no: ackNo2Id,
      hesitate: repeat2Id,
      silence: repeat2Id
    },
    3000
  ));
  addState(states, ackYes2Id, nodeObj(ackYes(), "empathetic", nextAfterBlockId));
  addState(states, ackNo2Id,  nodeObj(ackNo(),  "neutral", nextAfterBlockId));

  // Repeat #2 — final gentle nudge, then proceed regardless
  addState(states, repeat2Id, nodeObj(
    randomPick(REASK_B),
    "empathetic",
    nextAfterBlockId,
    null,
    3000
  ));

  return { firstId: askId, addedIds: [askId, ackYesId, ackNoId, repeat1Id, ackYes2Id, ackNo2Id, repeat2Id] };
}

// ---------- Sales Section ----------
// Enforce "maximum value before price": start at membership/annual,
// then degrade to 6M → 3M → single upon rejection.
// Includes light identity/address capture and payment intent nodes.

function addSalesSequence(states, entryIdAfterHealth) {
  // Value intro (non-price framing)
  const valueIntro = "value_intro";
  addState(states, valueIntro, nodeObj(
    "Based on what you’ve shared, I have a plan that focuses on long-term support and better consistency.",
    "calm_confidence",
    "offer_membership",
    null,
    600
  ));

  // Offer ladder
  // 1) Membership / Annual-first
  addState(states, "offer_membership", nodeObj(
    "Would you like to start with our membership plan? It provides ongoing support and convenience.",
    "authoritative",
    null,
    {
      yes: "membership_ack_yes",
      no: "offer_6m",
      hesitate: "offer_membership_clarify",
      silence: "offer_membership_clarify"
    },
    1000
  ));
  addState(states, "offer_membership_clarify", nodeObj(
    "In short, membership means steady progress without gaps, plus preferred fulfillment.",
    "calm_confidence",
    null,
    {
      yes: "membership_ack_yes",
      no: "offer_6m",
      hesitate: "offer_6m",
      silence: "offer_6m"
    },
    1600
  ));
  addState(states, "membership_ack_yes", nodeObj(
    "Excellent. I’ll note membership as your plan.",
    "absolute_certainty",
    "identity_intro"
  ));

  // 2) 6-Month
  addState(states, "offer_6m", nodeObj(
    "Would a six-month plan be a better fit for you?",
    "authoritative",
    null,
    {
      yes: "offer_6m_ack_yes",
      no: "offer_3m",
      hesitate: "offer_6m_clarify",
      silence: "offer_6m_clarify"
    },
    900
  ));
  addState(states, "offer_6m_clarify", nodeObj(
    "Six months gives a meaningful runway to see and sustain improvements.",
    "calm_confidence",
    null,
    {
      yes: "offer_6m_ack_yes",
      no: "offer_3m",
      hesitate: "offer_3m",
      silence: "offer_3m"
    },
    1400
  ));
  addState(states, "offer_6m_ack_yes", nodeObj(
    "Great choice. I’ll note the six-month plan.",
    "absolute_certainty",
    "identity_intro"
  ));

  // 3) 3-Month
  addState(states, "offer_3m", nodeObj(
    "Would you like to begin with a three-month plan?",
    "authoritative",
    null,
    {
      yes: "offer_3m_ack_yes",
      no: "offer_single",
      hesitate: "offer_3m_clarify",
      silence: "offer_3m_clarify"
    },
    900
  ));
  addState(states, "offer_3m_clarify", nodeObj(
    "Three months is a concise, focused window to establish momentum.",
    "calm_confidence",
    null,
    {
      yes: "offer_3m_ack_yes",
      no: "offer_single",
      hesitate: "offer_single",
      silence: "offer_single"
    },
    1400
  ));
  addState(states, "offer_3m_ack_yes", nodeObj(
    "Understood. I’ll note the three-month plan.",
    "absolute_certainty",
    "identity_intro"
  ));

  // 4) Single Unit
  addState(states, "offer_single", nodeObj(
    "Would you like to start with a single order to try it out?",
    "authoritative",
    null,
    {
      yes: "offer_single_ack_yes",
      no: "offer_decline_path",
      hesitate: "offer_single_clarify",
      silence: "offer_single_clarify"
    },
    900
  ));
  addState(states, "offer_single_clarify", nodeObj(
    "A single order is a simple way to begin and evaluate how you feel.",
    "calm_confidence",
    null,
    {
      yes: "offer_single_ack_yes",
      no: "offer_decline_path",
      hesitate: "offer_decline_path",
      silence: "offer_decline_path"
    },
    1200
  ));
  addState(states, "offer_single_ack_yes", nodeObj(
    "Sounds good. I’ll note a single order.",
    "absolute_certainty",
    "identity_intro"
  ));

  // Decline path (soft landing)
  addState(states, "offer_decline_path", nodeObj(
    "No problem—happy to help with information anytime.",
    "empathetic",
    "closing_sale"
  ));

  // Identity & address capture (value-before-payment respected — this occurs AFTER plan chosen)
  addState(states, "identity_intro", nodeObj(
    "To make sure your order is accurate, let’s confirm your details.",
    "calm_confidence",
    "capture_name",
    null,
    600
  ));
  addState(states, "capture_name", nodeObj(
    "What’s the full name for the order?",
    "empathetic",
    null,
    {
      yes: "capture_address_line1",
      no: "capture_name_repeat",
      hesitate: "capture_name_repeat",
      silence: "capture_name_repeat"
    },
    1200
  ));
  addState(states, "capture_name_repeat", nodeObj(
    "When you’re ready, please share the full name, including any middle initial.",
    "empathetic",
    null,
    {
      yes: "capture_address_line1",
      no: "capture_address_line1", // proceed anyway; ops can reconcile
      hesitate: "capture_address_line1",
      silence: "capture_address_line1"
    },
    1500
  ));

  addState(states, "capture_address_line1", nodeObj(
    "What’s the street address?",
    "empathetic",
    null,
    {
      yes: "capture_address_line2",
      no: "capture_address_line2",
      hesitate: "capture_address_line2",
      silence: "capture_address_line2"
    },
    1200
  ));
  addState(states, "capture_address_line2", nodeObj(
    "Any apartment or unit number?",
    "empathetic",
    null,
    {
      yes: "capture_city",
      no: "capture_city",
      hesitate: "capture_city",
      silence: "capture_city"
    },
    800
  ));
  addState(states, "capture_city", nodeObj(
    "Which city is that?",
    "empathetic",
    null,
    {
      yes: "capture_state",
      no: "capture_state",
      hesitate: "capture_state",
      silence: "capture_state"
    },
    800
  ));
  addState(states, "capture_state", nodeObj(
    "And the state?",
    "empathetic",
    null,
    {
      yes: "capture_zip",
      no: "capture_zip",
      hesitate: "capture_zip",
      silence: "capture_zip"
    },
    800
  ));
  addState(states, "capture_zip", nodeObj(
    "Lastly, what’s the ZIP code?",
    "empathetic",
    null,
    {
      yes: "readback_confirm",
      no: "readback_confirm",
      hesitate: "readback_confirm",
      silence: "readback_confirm"
    },
    800
  ));

  // Readback/confirm with shipping window phrase (server will enforce if missing)
  addState(states, "readback_confirm", nodeObj(
    "Thanks. I’ve got that noted. I’ll read back details next.",
    "calm_confidence",
    "capture_payment"
  ));

  // Payment intent (server-level guardrails will slow price words)
  addState(states, "capture_payment", nodeObj(
    "When you’re ready, we’ll take care of payment securely.",
    "authoritative",
    null,
    {
      yes: "capture_sale",
      no: "payment_deferral",
      hesitate: "payment_clarify",
      silence: "payment_clarify"
    },
    900
  ));
  addState(states, "payment_clarify", nodeObj(
    "We’ll process it safely and respect your preferences.",
    "calm_confidence",
    null,
    {
      yes: "capture_sale",
      no: "payment_deferral",
      hesitate: "payment_deferral",
      silence: "payment_deferral"
    },
    1200
  ));
  addState(states, "payment_deferral", nodeObj(
    "Understood. You can complete payment later—your information is saved.",
    "empathetic",
    "closing_sale"
  ));

  // capture_sale: your server injects processing pause + routes to closing
  addState(states, "capture_sale", nodeObj(
    "Great — let me get that processed for you.",
    "absolute_certainty",
    "closing_sale"
  ));

  // Closing
  addState(states, "closing_sale", nodeObj(
    "Thank you for your time today. Delivery is in five to seven days. Our care line is 1-866-379-5131.",
    "empathetic",
    null,
    null,
    null,
    true
  ));

  return { entry: entryIdAfterHealth };
}

// ---------- Micro-Turn Padding ----------
// Adds gentle, low-risk nodes to reach TARGET_STATES without breaking flow.
// Each batch creates a chain of short acknowledgments/clarifications with optional hesitation.
function addMicroTurnsUntil(states, startId, targetCount) {{
  let total = Object.keys(states).length;
  let cursor = startId;
  let batchIndex = 1;

  while (total < targetCount) {
    const batchId = `mt${batchIndex}`;
    const nodes = [];

    // Build one batch chain of MICRO_TURN_BATCH nodes
    let last = cursor;
    for (let i = 1; i <= MICRO_TURN_BATCH; i++) {
      const id = `${batchId}_${i}`;
      const say = randomPick([
        "Sounds good.",
        "Thanks for that.",
        "I appreciate the detail.",
        "That makes sense.",
        "Alright.",
        "Okay."
      ]);
      const tone = randomPick(["empathetic", "calm_confidence", "neutral"]);
      const useBranch = Math.random() < 0.15;
      const pauseMs = Math.random() < 0.25 ? 500 + Math.floor(Math.random() * 500) : null;

      const nextId = (i === MICRO_TURN_BATCH) ? null : `${batchId}_${i+1}`;
      const branches = useBranch
        ? { yes: nextId || "closing_sale", no: nextId || "closing_sale", hesitate: nextId || "closing_sale", silence: nextId || "closing_sale" }
        : null;

      nodes.push({ id, obj: nodeObj(say, tone, branches ? null : nextId, branches, pauseMs) });

      // Safe chaining: only link if last exists
      if (last && states[last]) {
        if (!states[last].branches && !states[last].end) {
          states[last].next = id;
        }
      }
      last = id;
    }

    // Commit nodes
    for (const n of nodes) addState(states, n.id, n.obj);

    cursor = `${batchId}_${MICRO_TURN_BATCH}`;
    total = Object.keys(states).length;
    batchIndex++;
  }

  // Finally, land on closing if cursor not terminal
  if (cursor && states[cursor] && !states[cursor].end) {
    states[cursor].next = "closing_sale";
  }
}

// ---------- Main Flow Builder ----------
function buildFlow() {
  const states = {};

  // 1) Start → Proven health opener
  addState(states, "start", nodeObj(
    "Hi, this is Alex with Health America. How are you today?",
    "enthusiastic",
    "health_open",
    null,
    1200
  ));

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

  // 2) Concise Health Section (systemic golden pattern)
  let nextAfterBlock = "sales_entry_switch";
  for (let i = 1; i <= HEALTH_BLOCKS; i++) {
    const blockNext = (i === HEALTH_BLOCKS) ? nextAfterBlock : `hq${i+1}_ask`;
    addHealthBlock(states, i, blockNext);
  }

  // 3) Sales Section (stitched AFTER health)
  //    We enter the sales ladder from this node:
  addState(states, "sales_entry_switch", nodeObj(
    "Thanks for sharing those details.",
    "calm_confidence",
    "value_intro",
    null,
    600
  ));
  addSalesSequence(states, "sales_entry_switch");

  // 4) Pad to TARGET_STATES with low-risk micro-turns (after closing paths)
  //    Create a small bridge from closing → micro-turns if needed
  if (!exists(states, "post_closing_pad")) {
    addState(states, "post_closing_pad", nodeObj(
      "Before we wrap, I’ll include a brief summary marker.",
      "neutral",
      "mt1_1",
      null,
      500
    ));
  }
  // Link from closing_sale to post_closing_pad only if closing is not terminal in your runtime.
  // We’ll keep closing_sale as end:true but the micro-turn chain will be reachable through
  // non-terminal routes (e.g., payment deferral). To guarantee padding, anchor from offer_decline_path:
  if (exists(states, "offer_decline_path") && !states["offer_decline_path"].end) {
    states["offer_decline_path"].next = "post_closing_pad";
  }

  // Now pad to TARGET_STATES via micro-turns
  addMicroTurnsUntil(states, "post_closing_pad", TARGET_STATES);

  // Safety: ensure a terminal exists
  if (!exists(states, "closing_sale")) {
    addState(states, "closing_sale", nodeObj(
      "Thank you for your time today. Delivery is in five to seven days. Our care line is 1-866-379-5131.",
      "empathetic",
      null,
      null,
      null,
      true
    ));
  }

  return { states };
}

// ---------- Run ----------
(function main() {
  const flow = buildFlow();
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(flow, null, 2));
  const count = Object.keys(flow.states).length;
  console.log(`✅ Generated flow with ${count} states → ${OUT_FILE}`);
  if (count < TARGET_STATES) {
    console.warn(`⚠️ State count (${count}) below TARGET_STATES (${TARGET_STATES}). Consider increasing HEALTH_BLOCKS or MICRO_TURN_BATCH.`);
  }
})();
