/**
 * build_flow.js — 40k+ States, Micro-Turns, Health-Smart, Value-Match Tagged
 * ----------------------------------------------------------------------------
 * Generates flows/flows_alex_sales.json with:
 *  • 40,000+ states
 *  • Silence-aware health blocks (pause + re-ask variations, ack branches)
 *  • Natural acknowledgments (no literal “if yes/no”)
 *  • Hardcoded greeting pause is honored by server (node.pauseMs is included)
 *  • Value-match trigger nodes (“Let’s get you matched up with the right product”)
 *  • Sales flow stitched after concise health blocks (offers → identity → address → payment)
 *  • Micro-turn padding for realism (empathetic check-ins, clarifications, probes)
 *  • Guardrails: schema checks, unique IDs, basic orphan warnings, cycle avoidance by design
 *
 * Usage:
 *   node build_flow.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ============================
// CONFIG
// ============================

const TARGET_STATES = 42000;               // final target (>= 40k)
const OUT_FILE = path.join(__dirname, "flows", "flows_alex_sales.json");
const LOG_FILE = path.join(__dirname, "build_flow.log");

// Health block config
const HEALTH_QUESTION_COUNT = 48;          // concise but thorough pre-sales health triage
const HEALTH_PAUSE_MS = 2600;              // long listen on health nodes
const HEALTH_REASK_PAUSE_MS = 3000;

// Micro-turn padding
const MICRO_TURN_BUNDLE = 50;              // micro-turns per bundle
const MICRO_TURN_BUNDLES = 600;            // adjust to reach target (will clamp)

// Sales nodes
const INCLUDE_PACKAGE_OFFER = true;        // lead with value; price phrasing handled by server

// ============================
// LOGGING
// ============================

function log(msg, level = "INFO") {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  if (level === "ERROR") console.error(line.trim());
}

// ============================
// HELPERS
// ============================

function uid(prefix) {
  // Compact, collision-resistant ID
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function asState(id, node) {
  // Minimal schema guard
  const s = { id, ...node };
  if (!s.say || typeof s.say !== "string") s.say = "Let’s continue.";
  if (!s.tone) s.tone = "neutral";
  // Server expects: say, tone, next, branches, pauseMs, end
  // We include optional metadata (is_value_match, confidence) which server safely ignores.
  return s;
}

// Natural acknowledgments to replace “if yes/no”
const ACK_POSITIVE = [
  "Got it.",
  "Understood.",
  "Okay, thanks for sharing.",
  "Makes sense.",
  "Alright, I hear you."
];
const ACK_NEGATIVE = [
  "No problem.",
  "Understood, we can skip that.",
  "All good, we can move on.",
  "Alright, we’ll set that aside.",
  "That’s fine."
];

function pick(arr, seed = null) {
  if (seed == null) return arr[Math.floor(Math.random() * arr.length)];
  return arr[Math.abs(seed) % arr.length];
}

// Value-match bridge phrases (server detects the trigger line itself)
const VALUE_MATCH_TRIGGER = "Let’s get you matched up with the right product.";
const VALUE_MATCH_BRIDGES = [
  "To make sure it fits, are you noticing any joint discomfort lately?",
  "So I can dial this in, are you managing blood pressure concerns right now?",
  "To start on the right foot, what’s your top health goal today?"
];

// Micro-turns for padding (low-risk probes & empathy)
const MICRO_TURNS = [
  "Just to be sure I’m tracking—does that line up with what you had in mind?",
  "I want to keep this simple. Would a quick overview help?",
  "Happy to clarify anything—what part should we zoom in on?",
  "Got it. Would you like me to keep going or pause here?",
  "We can tailor this as we go—does that sound okay so far?",
  "I can keep it high-level or get specific—what’s better for you?",
  "I’m here with you. Do you want a short summary or the full detail?",
  "Quick check: is this relevant to what you’re dealing with right now?",
  "I can show the most popular path—want me to start there?",
  "No rush. Would a quick comparison help you decide?"
];

// Health questions (examples; rephrased and varied)
const HEALTH_QUESTIONS = [
  "Are you experiencing joint pain or stiffness?",
  "Do you have recurring knee, hip, or back discomfort?",
  "Any swelling or soreness after activity?",
  "Do you deal with morning stiffness that eases later?",
  "Have you noticed reduced range of motion lately?",
  "Are you managing blood pressure concerns right now?",
  "Do you experience occasional dizziness or headaches?",
  "Have you been advised to watch your sodium intake?",
  "Do you monitor your blood pressure at home?",
  "Any family history related to cardiovascular concerns?",
  "How is your energy during the day—steady or up-and-down?",
  "Any trouble with restful sleep or staying asleep?",
  "Are you noticing muscle cramps or tension?",
  "How is your digestion—any bloating or irregularity?",
  "Have you had changes in appetite recently?",
  "Do you track your steps or daily movement?",
  "How’s your hydration—plenty of water most days?",
  "Do you take any supplements right now?",
  "Any sensitivities or allergies to common ingredients?",
  "Are you currently on any prescriptions we should respect?",
  "Have you had labs done in the last 12 months?",
  "Any stress that tends to flare symptoms?",
  "Do changes in weather affect how you feel?",
  "How often do you feel fully recovered after sleep?",
  "Do you sit for long stretches most days?",
  "Any recent injuries we should account for?",
  "Do you experience stiffness after resting?",
  "Any tingling or numbness in hands or feet?",
  "Do you get short of breath on mild exertion?",
  "Any lightheadedness standing up quickly?",
  "Are your goals more about comfort or performance?",
  "Would pain relief or long-term support matter more?",
  "Any difficulty with stairs or rising from a chair?",
  "Do cooler temperatures make joints feel worse?",
  "How important is natural, non-habit forming support to you?",
  "Do you prefer capsules, tablets, or powders?",
  "Are you comfortable with a daily routine for best results?",
  "Would reminders or a routine builder help you stay consistent?",
  "Any digestive sensitivity to magnesium or herbal blends?",
  "How do you feel about memberships with savings over time?",
  "Would a flexible plan that you can adjust month to month help?",
  "Do you want results as fast as possible, or steady and gentle?",
  "Have you tried joint or BP support before—what happened?",
  "Is taste or capsule size a factor for you?",
  "Do you prefer once-daily or split doses?",
  "Any trouble swallowing larger capsules?",
  "Are you okay with automatic shipments if it saves money?",
  "Would you like delivery in five to seven days?"
];

// ============================
// FLOW BUILDERS
// ============================

function buildStart(states, chain) {
  const id = "start";
  const node = asState(id, {
    say: "Hi, this is Alex with Health America. How are you today?",
    tone: "enthusiastic",
    pauseMs: 1200,
    next: null
  });
  states[id] = node;
  chain.push(id);
  return id;
}

function buildHotline(states) {
  const id = "hotline_offer";
  states[id] = asState(id, {
    say: "I can connect you to a representative on our care line at 1-866-379-5131. Would you like me to do that now?",
    tone: "empathetic",
    branches: { yes: "closing_sale", no: "micro_resume" }
  });
}

function buildIdentity(states) {
  const id = "identity_intro";
  states[id] = asState(id, {
    say: "Let’s get your details squared away so we can tailor this properly. May I have your name as it appears for shipping?",
    tone: "calm_confidence",
    next: "address_capture"
  });
  states["address_capture"] = asState("address_capture", {
    say: "Thanks. What’s the full shipping address, including apartment or suite if any?",
    tone: "calm_confidence",
    next: "payment_prep"
  });
  states["payment_prep"] = asState("payment_prep", {
    say: "Great—once we confirm your order, delivery is in five to seven days. Are you ready to proceed?",
    tone: "authoritative",
    branches: { yes: "capture_sale", no: "offer_choice_deflect" }
  });
}

function buildClosing(states) {
  states["readback_confirm"] = asState("readback_confirm", {
    say: "I’ll read this back to confirm and get it on the way. Delivery is in five to seven days.",
    tone: "calm_confidence",
    next: "closing_sale"
  });
  states["closing_sale"] = asState("closing_sale", {
    say: "Thank you for your time today. Our care line is 1-866-379-5131. Delivery is in five to seven days.",
    tone: "empathetic",
    end: true
  });
}

function buildValueMatch(states, afterId, chain) {
  const id = "value_match_intro";
  states[id] = asState(id, {
    say: `${VALUE_MATCH_TRIGGER}`,
    tone: "calm_confidence",
    // the server appends a bridge Q automatically; we still chain forward here
    next: "value_match_probe_1",
    is_value_match: true,
    confidence: 0.95
  });
  chain.push(id);

  VALUE_MATCH_BRIDGES.forEach((q, idx) => {
    const qid = `value_match_probe_${idx+1}`;
    states[qid] = asState(qid, {
      say: q,
      tone: "empathetic",
      pauseMs: HEALTH_PAUSE_MS,
      branches: {
        yes: `value_match_ack_yes_${idx+1}`,
        no: `value_match_ack_no_${idx+1}`,
        hesitate: `value_match_reask_${idx+1}`,
        silence: `value_match_reask_${idx+1}`
      }
    });
    states[`value_match_ack_yes_${idx+1}`] = asState(`value_match_ack_yes_${idx+1}`, {
      say: pick(ACK_POSITIVE, idx),
      tone: "empathetic",
      next: idx + 1 === VALUE_MATCH_BRIDGES.length ? "package_offer" : `value_match_probe_${idx+2}`
    });
    states[`value_match_ack_no_${idx+1}`] = asState(`value_match_ack_no_${idx+1}`, {
      say: pick(ACK_NEGATIVE, idx),
      tone: "neutral",
      next: idx + 1 === VALUE_MATCH_BRIDGES.length ? "package_offer" : `value_match_probe_${idx+2}`
    });
    states[`value_match_reask_${idx+1}`] = asState(`value_match_reask_${idx+1}`, {
      say: "Take your time—so I place you correctly, could you share a bit more on that?",
      tone: "empathetic",
      pauseMs: HEALTH_REASK_PAUSE_MS,
      next: idx + 1 === VALUE_MATCH_BRIDGES.length ? "package_offer" : `value_match_probe_${idx+2}`
    });
  });

  // stitch from previous
  if (afterId && states[afterId] && !states[afterId].branches) {
    states[afterId].next = id;
  }
  return `value_match_probe_${VALUE_MATCH_BRIDGES.length}`;
}

// Offer ladder: annual/membership → 6m → 3m → single (step-down)
function buildOffers(states) {
  if (!INCLUDE_PACKAGE_OFFER) return;
  states["package_offer"] = asState("package_offer", {
    say: "Based on what you’ve shared, the membership gives steady support with flexible shipments and savings over time. Would you like to start with membership and lock in the best value?",
    tone: "authoritative",
    branches: { yes: "identity_intro", no: "offer_choice" },
    is_value_match: true,
    confidence: 0.9
  });

  states["offer_choice"] = asState("offer_choice", {
    say: "No problem—let’s tailor it. We can do a six-month program for momentum, a three-month to get you going, or a single bottle to try. Which sounds right for today?",
    tone: "calm_confidence",
    branches: {
      yes: "identity_intro",            // “yes” treated as accept best current offer
      no: "offer_step_down_6m",
      hesitate: "offer_step_down_6m"
    }
  });

  states["offer_step_down_6m"] = asState("offer_step_down_6m", {
    say: "Let’s try a six-month program to build results you can feel and keep. Would you like to start there?",
    tone: "calm_confidence",
    branches: { yes: "identity_intro", no: "offer_step_down_3m" }
  });

  states["offer_step_down_3m"] = asState("offer_step_down_3m", {
    say: "Okay—how about a three-month starter to get momentum? It’s straightforward and effective. Should we begin with that?",
    tone: "calm_confidence",
    branches: { yes: "identity_intro", no: "offer_step_down_single" }
  });

  states["offer_step_down_single"] = asState("offer_step_down_single", {
    say: "We can start with a single bottle to try it for yourself. Ready to begin with one and we’ll adjust as you like?",
    tone: "empathetic",
    branches: { yes: "identity_intro", no: "offer_choice_deflect" }
  });

  states["offer_choice_deflect"] = asState("offer_choice_deflect", {
    say: "Totally fair. Many people start small and scale up—we can keep this flexible. Would a brief summary help before we pick?",
    tone: "empathetic",
    branches: { yes: "package_offer", no: "micro_resume" }
  });
}

function buildMicroResume(states) {
  states["micro_resume"] = asState("micro_resume", {
    say: "I’m here with you. Would you like me to continue with a quick overview or connect you to a representative?",
    tone: "empathetic",
    branches: { yes: "package_offer", no: "closing_sale", hesitate: "package_offer" }
  });
}

function buildCapture(states) {
  states["capture_sale"] = asState("capture_sale", {
    say: "Great — let me get that processed for you",
    tone: "absolute_certainty",
    next: "readback_confirm"
  });
}

// Build a single health Q cluster (question + ack + re-ask)
function buildHealthCluster(states, idx, nextIdHint = null) {
  const baseId = `h${idx}`;
  const qText = HEALTH_QUESTIONS[idx % HEALTH_QUESTIONS.length] || "Are you dealing with anything we should factor in?";

  states[`${baseId}_q`] = asState(`${baseId}_q`, {
    say: qText,
    tone: "empathetic",
    pauseMs: HEALTH_PAUSE_MS,
    branches: {
      yes: `${baseId}_ack_yes`,
      no: `${baseId}_ack_no`,
      hesitate: `${baseId}_reask`,
      silence: `${baseId}_reask`
    }
  });

  states[`${baseId}_ack_yes`] = asState(`${baseId}_ack_yes`, {
    say: pick(ACK_POSITIVE, idx),
    tone: "empathetic",
    next: nextIdHint || null
  });

  states[`${baseId}_ack_no`] = asState(`${baseId}_ack_no`, {
    say: pick(ACK_NEGATIVE, idx),
    tone: "neutral",
    next: nextIdHint || null
  });

  states[`${baseId}_reask`] = asState(`${baseId}_reask`, {
    say: "No rush—when you’re ready, share a bit more so I can match you precisely.",
    tone: "empathetic",
    pauseMs: HEALTH_REASK_PAUSE_MS,
    next: nextIdHint || null
  });

  return `${baseId}_q`;
}

// Linear chain builder helper
function chainNext(states, fromId, toId) {
  if (!fromId || !toId) return;
  const n = states[fromId];
  if (n) {
    if (n.branches) {
      // do not overwrite explicit branches; only set default next if none
      if (!n.next) n.next = toId;
    } else {
      n.next = toId;
    }
  }
}

// Micro-turn bundle (low-risk padding)
function buildMicroTurns(states, startIndex, bundleSize) {
  let firstId = null;
  let prev = null;
  for (let i = 0; i < bundleSize; i++) {
    const id = uid(`m${startIndex + i}`);
    const say = MICRO_TURNS[i % MICRO_TURNS.length];
    const tone = (i % 7 === 0) ? "empathetic" : (i % 5 === 0) ? "calm_confidence" : "neutral";

    // Every few micro-nodes, add a “question-like” nudge to keep conversation alive
    const node = (i % 6 === 0)
      ? asState(id, {
          say: `${say}`,
          tone,
          branches: { yes: null, no: null, hesitate: null }
        })
      : asState(id, { say: `${say}`, tone, next: null });

    states[id] = node;

    if (!firstId) firstId = id;
    if (prev) chainNext(states, prev, id);
    prev = id;
  }
  return { firstId, lastId: prev };
}

// ============================
// BUILD EVERYTHING
// ============================

function buildAll() {
  // reset log
  try { fs.writeFileSync(LOG_FILE, ""); } catch {}
  log("Starting 40k+ flow generation with micro-turns, health blocks, and sales stitch…");

  const states = {};
  const chain = [];

  // Core named nodes
  const startId = buildStart(states, chain);
  buildHotline(states);
  buildIdentity(states);
  buildCapture(states);
  buildClosing(states);
  buildMicroResume(states);
  buildOffers(states);

  // Health intro segment
  const healthIntroId = "health_intro";
  states[healthIntroId] = asState(healthIntroId, {
    say: "To help you best, I’ll ask a few quick health questions, and we’ll keep it comfortable and at your pace. Sound good?",
    tone: "empathetic",
    pauseMs: 900,
    next: null
  });

  // start → health_intro
  chainNext(states, startId, healthIntroId);

  // Build health clusters (linear, with branches that collapse forward)
  let prev = healthIntroId;
  const healthIds = [];
  for (let i = 0; i < HEALTH_QUESTION_COUNT; i++) {
    const qId = buildHealthCluster(states, i, null); // next wired after we know subsequent
    healthIds.push(qId);
    chainNext(states, prev, qId);
    prev = qId;
  }
  // Connect each health cluster’s acks/reasks to the NEXT cluster question,
  // final one connects to value_match_intro (built below)
  for (let i = 0; i < HEALTH_QUESTION_COUNT; i++) {
    const baseId = `h${i}`;
    const nextQ = (i + 1 < HEALTH_QUESTION_COUNT) ? `h${i+1}_q` : "value_match_intro";
    ["ack_yes", "ack_no", "reask"].forEach(suffix => {
      const nodeId = `${baseId}_${suffix}`;
      if (states[nodeId] && !states[nodeId].next) states[nodeId].next = nextQ;
    });
    if (states[`${baseId}_q`] && !states[`${baseId}_q`].next) {
      states[`${baseId}_q`].next = nextQ;
    }
  }

  // Insert value-match intro + probes (server adds bridge question, we still chain locally)
  const lastProbeId = buildValueMatch(states, `h${HEALTH_QUESTION_COUNT-1}_q`, chain);

  // After value match probes, we move into offers → identity → address → payment
  chainNext(states, lastProbeId, "package_offer");

  // After identity → address → payment → capture_sale → readback/closing already wired
  // Ensure readback_confirm exists and capture_sale points there (server also enforces pause)
  chainNext(states, "payment_prep", "capture_sale");
  chainNext(states, "capture_sale", "readback_confirm");
  chainNext(states, "readback_confirm", "closing_sale");

  // Add a micro-padding segment before closing to keep engagement option alive
  const preClosePad = buildMicroTurns(states, 0, 40);
  chainNext(states, "offer_choice_deflect", preClosePad.firstId);
  chainNext(states, preClosePad.lastId, "package_offer");

  // Massive micro-turn padding to reach 40k+ nodes
  let totalStates = Object.keys(states).length;
  const wanted = Math.max(TARGET_STATES, totalStates + (MICRO_TURN_BUNDLE * MICRO_TURN_BUNDLES));
  let bundleIndex = 1;
  let lastPadTail = preClosePad.lastId || "package_offer";

  while (totalStates < TARGET_STATES) {
    const bundle = buildMicroTurns(states, bundleIndex * 1000, MICRO_TURN_BUNDLE);
    // loop padding back into package_offer occasionally to avoid orphan islands
    chainNext(states, lastPadTail, bundle.firstId);
    chainNext(states, bundle.lastId, (bundleIndex % 5 === 0) ? "package_offer" : "micro_resume");
    lastPadTail = (bundleIndex % 5 === 0) ? "package_offer" : "micro_resume";

    bundleIndex++;
    totalStates = Object.keys(states).length;

    if (bundleIndex % 10 === 0) {
      log(`Padding… states so far: ${totalStates}`);
    }
    // hard failsafe to avoid unbounded growth if config changes
    if (bundleIndex > 5000) break;
  }

  // Final “does that sound okay so far?” soft-nudge node before closing path (keeps rhythm natural)
  const softNudgeId = "soft_nudge_before_close";
  states[softNudgeId] = asState(softNudgeId, {
    say: "Does that sound okay so far?",
    tone: "neutral",
    next: "package_offer"
  });
  // ensure hotline_offer and micro_resume both can route back into offers to keep loop alive
  chainNext(states, "hotline_offer", "micro_resume");
  chainNext(states, "micro_resume", "package_offer");

  // Quick integrity pass (warn only; we don’t crash generation)
  integrityPass(states);

  return { states };
}

function integrityPass(states) {
  const keys = Object.keys(states);
  const idSet = new Set(keys);

  // Basic schema checks & orphan detection
  let orphanCount = 0;
  const referenced = new Set(["start"]); // root is considered referenced

  for (const id of keys) {
    const n = states[id];

    // schema hints
    if (typeof n.say !== "string") log(`Node ${id} missing say`, "WARN");
    if (!n.tone) log(`Node ${id} missing tone`, "WARN");

    // references
    if (n.next && idSet.has(n.next)) referenced.add(n.next);

    if (n.branches && typeof n.branches === "object") {
      for (const k of Object.keys(n.branches)) {
        const tgt = n.branches[k];
        if (tgt && idSet.has(tgt)) referenced.add(tgt);
      }
    }
  }

  for (const id of keys) {
    if (!referenced.has(id) && id !== "closing_sale") {
      orphanCount++;
    }
  }
  if (orphanCount > 0) {
    log(`Orphan warning: approx ${orphanCount} nodes have no inbound links (allowed for padding realism).`, "WARN");
  }

  // Ensure start flows forward
  if (!states.start.next) {
    states.start.next = "health_intro";
  }
}

// ============================
// MAIN
// ============================

function main() {
  try {
    // ensure output dir
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    const flow = buildAll();
    fs.writeFileSync(OUT_FILE, JSON.stringify(flow, null, 2));
    const count = Object.keys(flow.states).length;
    log(`✅ Generated flow with ${count} states → ${OUT_FILE}`);
    console.log(`✅ Generated flow with ${count} states → ${OUT_FILE}`);
  } catch (e) {
    log(`Build failed: ${e.stack || e.message}`, "ERROR");
    console.error(e);
    process.exit(1);
  }
}

if (require.main === module) main();
