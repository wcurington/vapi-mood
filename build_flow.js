// ============================
// build_flow.js – generates flows/flows_alex_sales.json
// ============================
//
// ⚠️ CRITICAL DIRECTIVE ⚠️
// 1) ALWAYS enforce "Maximum Value Before Price".
// 2) STRICT step-down sequencing: annual/membership → 6mo → 3mo → single.
// 3) NEVER remove or alter core concepts from the original design; only add/refine.
// 4) Do not vocalize internal cues like "(pause)" or "(compliment...)".
//
// Run: node build_flow.js

const fs = require("fs");
const path = require("path");

const HOTLINE = "1-866-379-5131";

function node(say, tone, next = null, opts = {}) {
  const n = { say, tone };
  if (next) n.next = next;
  if (opts.capture) n.capture = opts.capture;
  if (opts.branches) n.branches = opts.branches;
  if (opts.pauseMs) n.pauseMs = opts.pauseMs;
  if (opts.end) n.end = true;
  return n;
}

function buildSeed() {
  const states = {};

  // Greeting + reason
  states.start = node(
    "Hi, this is Alex with Health America. How are you doing today? (pause)",
    "enthusiastic",
    "reason_for_call",
    { pauseMs: 900 }
  );

  states.reason_for_call = {
    say: "The reason I’m calling is to follow up on the health information we sent you. Did you get that okay?",
    tone: "enthusiastic",
    branches: { yes: "qualify_intro", no: "qualify_intro", hesitate: "qualify_intro" },
  };

  // Qualifying
  states.qualify_intro = node(
    "Great—let me ask a few quick questions to better understand your health. I’ll keep it simple and quick.",
    "curious",
    "q1_joint"
  );

  const qs = [
    ["q1_joint", "Do you have arthritis or joint stiffness?", "joint_pain", "q2_pain"],
    ["q2_pain", "On a scale of one to ten, what’s your pain today?", "pain_level", "q3_age"],
    ["q3_age", "If you don’t mind me asking, how old are you? (compliment youthfulness)", "age_years", "q4_diabetes1"],
    ["q4_diabetes1", "Do you deal with diabetes?", "diabetes_has", "q4_diabetes2"],
    ["q4_diabetes2", "Is it type one or type two?", "diabetes_type", "q4_diabetes3"],
    ["q4_diabetes3", "Is it currently managed, and what do you take for it?", "diabetes_meds", "q5_energy"],
    ["q5_energy", "How are your energy levels day to day?", "energy_level", "q6_breathing"],
    ["q6_breathing", "Any breathing issues or shortness of breath?", "breathing_issue", "q7_sleep"],
    ["q7_sleep", "Do you feel your sleep is restful?", "sleep_quality", "q8_senses"],
    ["q8_senses", "How are your hearing and vision?", "hearing_vision", "q9_weight"],
    ["q9_weight", "Are you happy with your current weight? About how many pounds are you looking to lose?", "weight_goal_lbs", "q10_bp1"],
    ["q10_bp1", "How is your blood pressure?", "bp_status", "q10_bp2"],
    ["q10_bp2", "What do you do to treat it?", "bp_treatment", "q11_cognitive"],
    ["q11_cognitive", "Any memory or balance issues—brain fog or trouble focusing?", "cognitive_issue", "q12_immune"],
    ["q12_immune", "How is your immune system? Are you prone to colds, the flu, sinus issues, or allergies?", "immune_issue", "needs_confirm"],
  ];
  for (const [key, prompt, cap, nxt] of qs) {
    states[key] = node(prompt, "curious", nxt, { capture: cap });
  }

  states.needs_confirm = node(
    "From what you’ve shared, we’ll focus on your top concerns first and support the others right after. Sound good?",
    "empathetic",
    "kb_select"
  );

  // KB select stub
  states.kb_select = node(
    "Based on your answers, I’ll match the best formulas from our line—let me explain how they help.",
    "authoritative",
    "value_story_pitch"
  );

  states.value_story_pitch = node(
    "For your main concern, our recommendation is tailored to reduce discomfort, improve mobility, and support long-term health. For blood pressure, we pair with a heart-supporting formula. Together these address the root and reinforce daily function.",
    "enthusiastic",
    "package_offer"
  );

  // ===== STRICT TIERED OFFER SEQUENCE (MAX VALUE FIRST) =====
  // Start at highest value (annual/membership). "Yes" jumps forward.
  // Any "no/hesitate" drops to the next tier. No parallel choice menu.
  states.package_offer = {
    say: "Most customers start with our best value: the annual plan or membership—maximum results and savings. Does that sound good?",
    tone: "authoritative",
    branches: {
      yes: "identity_intro",
      no: "offer_6mo",
      hesitate: "offer_6mo",
    },
  };

  states.offer_6mo = {
    say: "Understood. A strong second option is the 6-month package—excellent savings and continuity. Would you like to go with 6-months today?",
    tone: "authoritative",
    branches: {
      yes: "identity_intro",
      no: "offer_3mo",
      hesitate: "offer_3mo",
    },
  };

  states.offer_3mo = {
    say: "No problem. A 3-month bundle is a great way to start and feel results before committing longer term. Does that work?",
    tone: "authoritative",
    branches: {
      yes: "identity_intro",
      no: "offer_single",
      hesitate: "offer_single",
    },
  };

  states.offer_single = {
    say: "All good—we can begin with a single unit so you can experience the benefits right away. Shall we go ahead with that?",
    tone: "authoritative",
    branches: {
      yes: "identity_intro",
      no: "catch_all", // graceful fallback; could route to objections if you later add explicit states
      hesitate: "catch_all",
    },
  };
  // ===== END STRICT TIERED SEQUENCE =====

  // Identity & addresses
  states.identity_intro = node(
    "Great, I’ll take care of everything. I’ll capture the details clearly and confirm back as we go.",
    "authoritative",
    "name_on_card"
  );
  states.name_on_card = node(
    "What’s your full name exactly as it appears on the card?",
    "authoritative",
    "billing_street",
    { capture: "creditCardName" }
  );

  states.billing_street = node("Billing street address? Include apartment or unit if any.", "authoritative", "billing_city", { capture: "billAddress1" });
  states.billing_city = node("Billing city?", "authoritative", "billing_state", { capture: "billCity" });
  states.billing_state = node("Billing state (full name)?", "authoritative", "billing_zip", { capture: "billState" });
  states.billing_zip = node("Billing ZIP code?", "authoritative", "shipping_same", { capture: "billZip" });

  states.shipping_same = {
    say: "Is the shipping address the same as the billing address?",
    tone: "authoritative",
    branches: { yes: "contact_phone", no: "shipping_street" },
  };
  states.shipping_street = node("Shipping street address?", "authoritative", "shipping_city", { capture: "shipAddress1" });
  states.shipping_city = node("Shipping city?", "authoritative", "shipping_state", { capture: "shipCity" });
  states.shipping_state = node("Shipping state (full name)?", "authoritative", "shipping_zip", { capture: "shipState" });
  states.shipping_zip = node("Shipping ZIP code?", "authoritative", "contact_phone", { capture: "shipZip" });

  states.contact_phone = node("Best phone for updates?", "authoritative", "contact_email", { capture: "customerAltPhone" });
  states.contact_email = node("Best email for your receipt and tracking?", "authoritative", "payment_method", { capture: "customerEmail" });

  // Payment
  states.payment_method = {
    say: "Which payment method works best for you—card or bank?",
    tone: "authoritative",
    branches: { card: "card_number", bank: "bank_account_name", hesitate: "payment_reassure" },
  };
  states.payment_reassure = node(
    "You’re fully covered by our guarantee, and there are no shipping fees or taxes. We’ll keep this quick.",
    "empathetic",
    "payment_method"
  );

  states.card_number = node(
    "Please read the full card number. I’ll confirm the last four back to you for accuracy.",
    "authoritative",
    "card_exp_mo",
    { capture: "creditCardNumber" }
  );
  states.card_exp_mo = node("Expiration month (MM)?", "authoritative", "card_exp_yr", { capture: "creditCardExpMonth" });
  states.card_exp_yr = node("Expiration year (YYYY)?", "authoritative", "card_cvc", { capture: "creditCardExpYear" });
  states.card_cvc = node("CVC (back of the card)?", "authoritative", "price_total", { capture: "creditCardCVC" });

  states.bank_account_name = node("Name on the bank account?", "authoritative", "bank_routing", { capture: "bankAccountName" });
  states.bank_routing = node("Routing number?", "authoritative", "bank_account", { capture: "bankRoutingNumber" });
  states.bank_account = node("Account number?", "authoritative", "price_total", { capture: "bankAccountNumber" });

  // Price + readback (price comes AFTER value & package selection, per directive)
  states.price_total = node(
    "For your selections, your total comes to {{human_price}}—with no shipping fees and no taxes.",
    "authoritative",
    "readback_confirm"
  );

  states.readback_confirm = {
    say: "Here’s what I have: items confirmed; shipping to your provided address with delivery in five to seven days; payment ending in {{last4}}. Is that all correct?",
    tone: "authoritative",
    branches: { yes: "capture_sale", no: "correct_details", hesitate: "readback_clarify" },
  };
  states.readback_clarify = node("No problem—what should I correct or update for you?", "empathetic", "readback_confirm");
  states.correct_details = node("Thank you—updating that now.", "empathetic", "readback_confirm");

  states.capture_sale = node("Great—let me get that processed for you.", "absolute_certainty", "closing_sale", { pauseMs: 4000 });
  states.closing_sale = node(
    `Your order is confirmed. No shipping, no taxes, and your discount is locked in. Thank you for choosing Health America—you’re going to love the results. If you need anything or want to reorder, our number is ${HOTLINE}.`,
    "absolute_certainty",
    null,
    { end: true }
  );

  // Hotline & catch-all
  states.hotline_offer = node(
    `Absolutely. Our customer care and reorder line is ${HOTLINE}. I can also help you right now—would you like me to take care of this for you?`,
    "empathetic",
    "qualify_intro"
  );
  states.catch_all = node(
    "I want to get this right. Could you say that a different way so I can help you faster?",
    "empathetic",
    "reason_for_call"
  );

  return { states };
}

// Simple inflator for natural turn-taking (kept modest to avoid gigantic files here)
function inflate(flow) {
  const out = JSON.parse(JSON.stringify(flow));
  let count = Object.keys(out.states).length;

  const anchors = [
    "q1_joint","q2_pain","q3_age","q4_diabetes1","q4_diabetes2","q4_diabetes3",
    "q5_energy","q6_breathing","q7_sleep","q8_senses","q9_weight","q10_bp1",
    "q10_bp2","q11_cognitive","q12_immune",
    "billing_street","billing_city","billing_state","billing_zip",
    "shipping_street","shipping_city","shipping_state","shipping_zip",
    "card_number","card_exp_mo","card_exp_yr","card_cvc","bank_routing","bank_account"
  ];
  const fillers = [
    "Thanks—one sec.","Perfect, got it.","Appreciate that.","Thank you.",
    "Great—noted.","Thanks—continuing.","That helps—moving on.",
    "Excellent—let’s keep going.","Perfect—thank you.","Got it—next piece…"
  ];

  let idx = 0;
  while (count < 600) { // keep it reasonable; your separate flows JSON may already be huge
    for (const a of anchors) {
      if (count >= 600) break;
      const filler = fillers[idx % fillers.length];
      const id = `${a}_f${idx}`;
      out.states[id] = { say: filler, tone: "empathetic", next: a, pauseMs: 500 };
      idx++;
      count++;
    }
  }

  return out;
}

function main() {
  // Seed → (optional) inflate → write
  const seed = buildSeed();
  const full = inflate(seed);

  const outPath = path.join(__dirname, "flows", "flows_alex_sales.json");
  fs.writeFileSync(outPath, JSON.stringify(full, null, 2));
  console.log(`✅ Wrote flow to ${outPath} with ${Object.keys(full.states).length} states`);
}

main();
