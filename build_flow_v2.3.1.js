// build_flow_v2.3.1.js
// Health America AI Sales Flow — updated alongside server_v2.6.3.js

'use strict';
const fs = require('fs');
const path = require('path');

function buildFlow() {
  const flow = {
    version: '2.3.1',
    created: new Date().toISOString(),
    meta: {
      min_value_build_ms: 6 * 60 * 1000,
      max_value_build_ms: 10 * 60 * 1000,
      min_qualifying_qs: 4,
      max_qualifying_qs: 10,
      pricing_tiers: {
        membership_monthly: 79,
        membership_discounted: 59,
        three_month: 199,
        six_month: 299,
        twelve_month: 499
      },
      discount_unlock_conditions: ["senior_citizen", "veteran", "haggled_twice"]
    },
    stages: []
  };

  flow.stages.push({
    id: 'intro', type: 'speak',
    prompt: "Hello, can you hear me okay? The reason for the call today is to follow up on the health information we sent you. Did you get that okay?",
    next: 'bridge'
  });

  flow.stages.push({
    id: 'bridge', type: 'speak',
    prompt: "Great. May I ask you a couple of quick questions about your health?",
    next: 'discovery'
  });

  flow.stages.push({
    id: 'discovery', type: 'gather',
    rules: { min_ms: 6 * 60 * 1000, min_questions: 4 },
    questions: [
      "How are your energy levels lately?",
      "Do you experience any joint stiffness or pain?",
      "How is your blood pressure right now, and what are you doing to manage it?",
      "How restful is your sleep?",
      "Any other health issues you want support with?",
      "Are you currently taking any supplements? What do you like or dislike about them?",
      "Do you deal with diabetes or blood sugar concerns?",
      "Are you happy with your current weight? If not, how many pounds would you like to lose?",
      "Any breathing issues or shortness of breath?",
      "How would you rate your pain today from 1 to 10?"
    ],
    next: 'synthesis'
  });

  flow.stages.push({
    id: 'synthesis', type: 'speak',
    prompt: "Thank you for sharing that. You mentioned {{issues_list}}. Based on that, I have two proprietary blends that fit perfectly, and I’ll explain why.",
    next: 'pitch_value'
  });

  flow.stages.push({
    id: 'pitch_value', type: 'speak',
    prompt: "Thousands nationwide are seeing great results with our proprietary blends. For {{issue_a}} and {{issue_b}}, these two work together to support mobility, circulation, and overall vitality. You’re going to love it.",
    next: 'pricing_gate'
  });

  flow.stages.push({
    id: 'pricing_gate', type: 'guard',
    check: 'value_time_met',
    fail_next: 'continue_value',
    pass_next: 'pricing_tree'
  });

  flow.stages.push({
    id: 'continue_value', type: 'speak',
    prompt: "Let me add a little more detail so you have the full picture. These formulas are designed to work together over time—most people feel a difference in just a few weeks.",
    next: 'pricing_tree'
  });

  flow.stages.push({
    id: 'pricing_tree', type: 'branch',
    branches: [
      {
        id: 'offer_6m',
        prompt: "The 6-Month Rejuvenation Program is $299 — no shipping, no taxes.",
        on_reject_next: 'offer_3m',
        on_accept_next: 'close_payment'
      },
      {
        id: 'offer_3m',
        prompt: "No problem. The 3-Month Supply is $199 — also no shipping, no taxes.",
        on_reject_next: 'offer_membership',
        on_accept_next: 'close_payment'
      },
      {
        id: 'offer_membership',
        prompt: "We can start with the Monthly Membership at $79, and today you can qualify for $59.",
        on_reject_next: 'objection_handler',
        on_accept_next: 'close_payment'
      }
    ]
  });

  flow.stages.push({
    id: 'objection_handler', type: 'rebuttal_router',
    prompt: "I hear you. Let me address that.",
    next: 'close_payment'
  });

  flow.stages.push({
    id: 'close_payment', type: 'gather_payment',
    prompt: "Which works best for you—card or bank? I’ll just need your name, billing and shipping address, phone, and email.",
    validators: {
      card: "POST /api/ai/validate/card",
      bank: "POST /api/ai/validate/bank"
    },
    next: 'confirmation'
  });

  flow.stages.push({
    id: 'confirmation', type: 'speak',
    prompt: "Excellent. Your order is confirmed. Your order will arrive in five to seven days. Thank you for choosing Health America. If you ever need anything, our number is 1-866-379-5131.",
    next: 'end'
  });

  return flow;
}

function saveFlow(outPath) {
  const flow = buildFlow();
  fs.writeFileSync(outPath, JSON.stringify(flow, null, 2));
  console.log('[build_flow] flow saved to', outPath);
}

if (require.main === module) {
  const outPath = path.join(__dirname, 'flows', 'flows_alex_sales.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  saveFlow(outPath);
}

module.exports = { buildFlow, saveFlow };
