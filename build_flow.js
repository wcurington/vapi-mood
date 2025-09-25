// ==========================================================================
// build_flow.js — XXXXL Flow Generator (30k+ States, Silence-Aware, Ack-Smart)
// ==========================================================================
//
// PURPOSE: Generate flows_alex_sales.json with 30,000+ conversational states.
// All flows obey Guardrail principles defined in server.js.
//
// GUARANTEES:
// • Start greeting has a hardcoded pause (server enforces SSML).
// • Branches remove literal "if yes/no" — replaced with natural acknowledgments.
// • Health questions have extended pauses and re-ask variations if silence occurs.
// • Expands flows dynamically to huge size without hand-writing JSON.
// ==========================================================================

const fs = require("fs");
const path = require("path");

// Root output file
const OUT_FILE = path.join(__dirname, "flows", "flows_alex_sales.json");

// Helpers
function makeState(id, say, tone="neutral", next=null, branches=null, pauseMs=null, end=false) {
  const node = { say, tone };
  if (next) node.next = next;
  if (branches) node.branches = branches;
  if (pauseMs) node.pauseMs = pauseMs;
  if (end) node.end = true;
  return [id, node];
}

// Silence-aware health question state
function makeHealthState(id, say, nextId) {
  return [
    id,
    {
      say,
      tone: "empathetic",
      pauseMs: 2500, // enforce long wait
      branches: {
        yes: `${id}_ack_yes`,
        no: `${id}_ack_no`,
        hesitate: `${id}_repeat`,
        silence: `${id}_repeat`
      }
    }
  ];
}

// Re-ask state
function makeReaskState(id, originalSay, nextId) {
  const variations = [
    "Could you tell me a bit more about that, when you have a moment?",
    "Just to confirm, could you please elaborate?",
    "I want to make sure I understand correctly — could you describe that in more detail?",
    "Taking your time is fine. When you’re ready, could you share a little more?"
  ];
  const reSay = variations[Math.floor(Math.random()*variations.length)];
  return [
    id,
    {
      say: reSay,
      tone: "empathetic",
      pauseMs: 3000,
      next: nextId
    }
  ];
}

// Generate a massive flow
function buildFlow(totalStates=30000) {
  const states = {};

  // Entry state (greeting)
  Object.assign(states, Object.fromEntries([
    makeState("start", "Hi, this is Alex with Health America. How are you today?", "enthusiastic", "q1_intro", null, 1200)
  ]));

  // Generate sequential Q&A states
  let lastId = "start";
  let counter = 1;

  while (counter < totalStates) {
    const id = `q${counter}_intro`;
    const isHealth = counter % 5 === 0; // every 5th question is health-related
    const nextId = `q${counter+1}_intro`;

    if (isHealth) {
      // Health question with silence/hesitate support
      const [mainId, mainNode] = makeHealthState(id, `Can you tell me about issue number ${counter}?`, nextId);
      states[mainId] = mainNode;

      // Acknowledgment branches
      states[`${id}_ack_yes`] = { say: "Got it. Thanks for sharing.", tone: "empathetic", next: nextId };
      states[`${id}_ack_no`] = { say: "No problem, we’ll move on.", tone: "neutral", next: nextId };

      // Silence re-ask
      const [reaskId, reaskNode] = makeReaskState(`${id}_repeat`, mainNode.say, nextId);
      states[reaskId] = reaskNode;
    } else {
      // Standard node
      const [qid, node] = makeState(id, `Here’s a standard question number ${counter}.`, "neutral", nextId);
      states[qid] = node;
    }

    lastId = id;
    counter++;
  }

  // Closing state
  states["closing_sale"] = {
    say: "Thank you for your time today. Our care line is 1-866-379-5131. Delivery is in five to seven days.",
    tone: "empathetic",
    end: true
  };

  return { states };
}

// Main run
function main() {
  const flow = buildFlow(30000);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(flow, null, 2));
  console.log(`✅ Generated flow with ${Object.keys(flow.states).length} states → ${OUT_FILE}`);
}

if (require.main === module) main();