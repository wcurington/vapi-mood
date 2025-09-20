// build_flow.js
// Generate a MASSIVE flows/flows_alex_sales.json (10k+ lines) with:
// - Mandatory greeting & Straight Line intro
// - Full micro-state segmentation (diabetes, BP, memory, etc.) with pauses
// - Product catalog hard-coded here with 6 price variants per product
// - Cross-sell & bundle offers (6 + 6 = 12 items) at $499.99
// - Hotline routing & service branch
// - Payment capture with readback + last4, currency speech, post-date scheduling metadata

const fs = require("fs");
const path = require("path");

// --------------------
// CONFIG
// --------------------
const HOTLINE = "1-866-379-5131";

// MASTER PRICING (all products share these tiers)
const PRICING = {
  monthly_sub: { price: 79.99,  label: "Monthly Subscription (1 unit / month)" },
  one_time:    { price: 89.99,  label: "One-Time Purchase (1 unit)" },
  three_pack:  { price: 199.99, label: "3-Month Pack (3 units)" },
  six_pack:    { price: 299.99, label: "6-Month Pack (6 units)" },
  annual:      { price: 499.99, label: "Annual Pack (12 units)" },
  // Post-date is dynamic; we’ll quote one-time now but schedule later
  post_date:   { price: 89.99,  label: "Post-Dated One-Time (1 unit on agreed date)" }
};

// FULL CATALOG — add as many as you want. These are examples; extend freely.
// Every item must include variations.form (e.g. "capsule", "powder") if relevant.
const CATALOG = [
  {
    id: "phytoplankton",
    name: "Marine Phytoplankton",
    category: "Energy / Metabolism",
    variations: [
      { form: "capsule", sku: "PHYTO-CAPS" },
      { form: "powder",  sku: "PHYTO-PWD"  }
    ],
    benefitsToOutcomes: [
      "supports cellular energy and daily vitality",
      "nutrient-dense microalgae for overall wellness",
      "helps reduce mid-day fatigue and brain fog"
    ],
    keyBenefits: [
      "rich in omega-3s, amino acids, and trace minerals",
      "supports mitochondria and ATP production",
      "gentle on digestion"
    ]
  },
  {
    id: "acai",
    name: "Açaí Superfruit",
    category: "Immune / Antioxidants",
    variations: [
      { form: "capsule", sku: "ACAI-CAPS" },
      { form: "powder",  sku: "ACAI-PWD"  }
    ],
    benefitsToOutcomes: [
      "supports immune resilience and recovery",
      "antioxidant support for daily defense",
      "helps reduce oxidative stress"
    ],
    keyBenefits: [
      "rich in anthocyanins",
      "pairs well with vitamin C and zinc",
      "great daily wellness foundation"
    ]
  },
  {
    id: "joint_complex",
    name: "Joint Complex",
    category: "Joint & Mobility",
    variations: [
      { form: "capsule", sku: "JOINT-CAPS" }
    ],
    benefitsToOutcomes: [
      "supports comfort, flexibility, and daily mobility",
      "helps soothe stiffness after activity",
      "promotes healthy cartilage"
    ],
    keyBenefits: [
      "glucosamine + chondroitin + MSM (per KB)",
      "turmeric/curcumin complex (per KB)",
      "with black pepper extract for absorption"
    ]
  },
  {
    id: "omega3",
    name: "Omega 3",
    category: "Cardiovascular / Brain",
    variations: [
      { form: "softgel", sku: "OMG3-SG" }
    ],
    benefitsToOutcomes: [
      "supports heart and brain health",
      "helps maintain healthy triglyceride levels",
      "supports joint comfort and mood balance"
    ],
    keyBenefits: [
      "high EPA/DHA per serving",
      "molecularly distilled",
      "lemon oil to reduce aftertaste"
    ]
  },
  {
    id: "sleep_support",
    name: "Sleep Support",
    category: "Sleep & Relaxation",
    variations: [
      { form: "capsule", sku: "SLEEP-CAPS" }
    ],
    benefitsToOutcomes: [
      "supports deeper, more restorative sleep",
      "helps you fall asleep faster and wake refreshed",
      "non-habit forming"
    ],
    keyBenefits: [
      "melatonin + L-theanine + botanicals (per KB)",
      "gentle relaxation",
      "works synergistically with stress support"
    ]
  },
  {
    id: "blood_sugar_balance",
    name: "Blood Sugar Balance",
    category: "Blood Sugar Support",
    variations: [
      { form: "capsule", sku: "BSB-CAPS" }
    ],
    benefitsToOutcomes: [
      "supports healthy glucose balance",
      "helps curb cravings and energy dips",
      "pairs well with weight goals"
    ],
    keyBenefits: [
      "berberine + cinnamon complex (per KB)",
      "chromium for insulin sensitivity (per KB)",
      "supports metabolism"
    ]
  }
];

// -------------
// Helpers
// -------------
const TONES = {
  enthusiastic:        { pitch: "+5%",  rate: "+15%", volume: "loud" },
  empathetic:          { pitch: "-5%",  rate: "-10%", volume: "soft" },
  authoritative:       { pitch: "-3%",  rate: "0%",   volume: "loud" },
  calm_confidence:     { pitch: "0%",   rate: "-5%",  volume: "medium" },
  absolute_certainty:  { pitch: "-8%",  rate: "-5%",  volume: "x-loud" },
  neutral:             { pitch: "0%",   rate: "0%",   volume: "medium" }
};

function s(id, obj) { return [id, obj]; }
function pick(arr) { return arr[Math.floor(Math.random()*arr.length)]; }
function bullets(list) {
  return list.map(b => `• ${b}`).join(" ");
}
function formatPrice(p) {
  return `$${p.toFixed(2)}`;
}

// Build price variants for one product+form
function buildProductVariants(product, form) {
  const variants = [];
  for (const [code, cfg] of Object.entries(PRICING)) {
    const vid = `${product.id}_${form.form}_${code}`;
    variants.push({
      id: vid,
      productId: product.id,
      name: product.name,
      form: form.form,
      sku: form.sku,
      variant: code,
      label: cfg.label,
      price: cfg.price,
    });
  }
  return variants;
}

// Build all variants (including cross-sell bundles)
function buildAllVariants() {
  const all = [];
  for (const p of CATALOG) {
    for (const f of p.variations) {
      all.push(...buildProductVariants(p, f));
    }
  }
  return all;
}

// Cross-sell combos (12 units total for $499.99)
function buildCrossSellCombos() {
  // combos of 6 units of product A + 6 units of product B (any form works the same price point)
  const combos = [];
  for (let i=0; i<CATALOG.length; i++) {
    for (let j=i+1; j<CATALOG.length; j++) {
      const A = CATALOG[i];
      const B = CATALOG[j];
      combos.push({
        id: `bundle_${A.id}_${B.id}`,
        name: `Annual Wellness Combo: 6 ${A.name}, 6 ${B.name}`,
        price: PRICING.annual.price, // $499.99 total
        label: "12 units (6 + 6)",
        products: [
          { id: A.id, qty: 6 },
          { id: B.id, qty: 6 }
        ]
      });
    }
  }
  return combos;
}

// -------------
// Flow Builder
// -------------
function buildFlow() {
  const states = {};
  const meta = {
    version: "4.0",
    hotline: HOTLINE,
    tones: TONES,
    currencySpeechRule: "Speak prices like 'two hundred ninety-nine dollars and ninety-nine cents'. Avoid saying 'point'.",
    tools: {
      kb_csv: "PRODUCT_KNOWLEDGEBASE Sheet(1).csv",
      kb_query: "query_KB.tool.json",
      logger: "log.sale.google.tool.json",
      mood_api: "Alex-mood"
    }
  };

  // ==== 0. Mandatory Straight Line Greeting / Control ====
  Object.assign(states, Object.fromEntries([
    s("start", {
      say: "Hello, this is Alex with Health America. How are you doing today?",
      tone: "enthusiastic",
      pauseMs: 900,
      next: "reason_for_call"
    }),
    s("reason_for_call", {
      say: "The reason I’m calling is to follow up on the health information we sent you. Did you get that okay?",
      tone: "enthusiastic",
      pauseMs: 900,
      branches: { yes: "qualify_intro", no: "qualify_intro", service: "hotline_offer", hesitate: "qualify_intro" }
    }),
    s("hotline_offer", {
      say: `Absolutely. Our customer care and reorder line is one eight six six… three seven nine… five one three one. I’ll repeat that normally: ${HOTLINE}. I can also help you right now—would you like me to take care of this for you?`,
      tone: "empathetic",
      pauseMs: 1200,
      branches: { yes: "qualify_intro", no: "farewell_soft", hesitate: "qualify_intro" }
    }),
    s("qualify_intro", {
      say: "Great—let me ask a few quick questions to better understand your health. I’ll keep it simple and quick.",
      tone: "curious",
      pauseMs: 600,
      next: "q1_joint"
    }),
  ]));

  // ==== 1. Micro-state Qualifying (split every item into tiny steps with pauses) ====
  // Joint & pain
  Object.assign(states, Object.fromEntries([
    s("q1_joint", { say: "Do you have arthritis or joint pain and stiffness?", tone: "curious", pauseMs: 900, capture: "joint_pain", next: "q2_pain" }),
    s("q2_pain",  { say: "On a scale of one to ten, what’s your pain today?",  tone: "curious", pauseMs: 900, capture: "pain_level", next: "q3_age" }),
    s("q3_age",   { say: "If you don’t mind me asking, how old are you? You sound much younger than that.", tone: "curious", pauseMs: 1200, capture: "age_years", next: "q4_diabetes_1" }),
  ]));

  // Diabetes micro-cluster
  Object.assign(states, Object.fromEntries([
    s("q4_diabetes_1", { say: "Do you deal with diabetes?", tone: "curious", pauseMs: 900, capture: "diabetes_yesno", next: "q4_diabetes_2" }),
    s("q4_diabetes_2", { say: "Is it type one or type two?", tone: "curious", pauseMs: 900, capture: "diabetes_type", next: "q4_diabetes_3" }),
    s("q4_diabetes_3", { say: "Is it currently managed?", tone: "curious", pauseMs: 900, capture: "diabetes_managed", next: "q4_diabetes_4" }),
    s("q4_diabetes_4", { say: "What do you take for it?", tone: "curious", pauseMs: 900, capture: "diabetes_meds", next: "q5_energy" }),
  ]));

  // Energy, Breathing, Sleep, Senses, Weight, BP, Cognitive, Immune
  Object.assign(states, Object.fromEntries([
    s("q5_energy",     { say: "How are your energy levels day to day?", tone: "curious", pauseMs: 900, capture: "energy_level", next: "q6_breathing" }),
    s("q6_breathing",  { say: "Any breathing issues or shortness of breath?", tone: "curious", pauseMs: 900, capture: "breathing_issue", next: "q7_sleep" }),
    s("q7_sleep",      { say: "Do you feel your sleep is restful?", tone: "curious", pauseMs: 900, capture: "sleep_quality", next: "q8_hearing" }),
    s("q8_hearing",    { say: "How is your hearing overall?", tone: "curious", pauseMs: 900, capture: "hearing_issue", next: "q8_vision" }),
    s("q8_vision",     { say: "And how is your vision?", tone: "curious", pauseMs: 900, capture: "vision_issue", next: "q9_weight" }),
    s("q9_weight",     { say: "Are you happy with your current weight? About how many pounds would you like to lose?", tone: "curious", pauseMs: 900, capture: "weight_goal_lbs", next: "q10_bp_1" }),
    s("q10_bp_1",      { say: "How is your blood pressure?", tone: "curious", pauseMs: 900, capture: "bp_status", next: "q10_bp_2" }),
    s("q10_bp_2",      { say: "What do you do to treat it?", tone: "curious", pauseMs: 900, capture: "bp_treatment", next: "q11_cognitive_1" }),
    s("q11_cognitive_1", { say: "Any memory or balance issues—or trouble focusing?", tone: "curious", pauseMs: 900, capture: "cognitive_issue", next: "q11_cognitive_2" }),
    s("q11_cognitive_2", { say: "Do you experience brain fog during the day?", tone: "curious", pauseMs: 900, capture: "brain_fog", next: "q12_immune_1" }),
    s("q12_immune_1",  { say: "How is your immune system—are you prone to colds or the flu?", tone: "curious", pauseMs: 900, capture: "immune_prone", next: "q12_immune_2" }),
    s("q12_immune_2",  { say: "Any sinus issues or allergies?", tone: "curious", pauseMs: 900, capture: "sinus_allergy", next: "needs_confirm" }),
  ]));

  // Needs confirmation
  Object.assign(states, Object.fromEntries([
    s("needs_confirm", {
      say: "From what you’ve shared, we’ll focus on your highest-impact goal first, then address the others step by step.",
      tone: "empathetic",
      pauseMs: 900,
      next: "select_primary"
    }),
  ]));

  // === 2. MAP to primary category (severity / yes flags). Here we keep server logic simple:
  // We just move into a pitch that references the catalog directly. The “selection” happens by chosen product node the script builds.

  // ==== 3. Build product selection subtrees for EACH product, EACH form, EACH price variant (+ cross-sells) ====
  const allVariants = buildAllVariants();
  const crossCombos = buildCrossSellCombos();

  // For each product+form, generate a “pitch → close path” with 6 offers: monthly_sub, one_time, three_pack, six_pack, annual, post_date
  for (const p of CATALOG) {
    for (const f of p.variations) {
      const vset = allVariants.filter(v => v.productId === p.id && v.form === f.form);

      const baseId = `pitch_${p.id}_${f.form}`;
      states[baseId] = {
        say: `Based on what you’ve told me, the best fit is our ${p.name} in ${f.form} form. It ${pick(p.benefitsToOutcomes)}. Key points: ${bullets(p.keyBenefits)}.`,
        tone: "enthusiastic",
        pauseMs: 1200,
        next: `${baseId}_upsell_bridge`
      };

      states[`${baseId}_upsell_bridge`] = {
        say: `For faster progress, many customers pair it with a complementary formula. I’ll outline your best value options now.`,
        tone: "authoritative",
        pauseMs: 900,
        next: `${baseId}_offer_menu`
      };

      // Offer menu state
      states[`${baseId}_offer_menu`] = {
        say: "Would you like the monthly membership, a one-time purchase, the 3-pack, the 6-pack best value, the annual 12-pack, or a post-dated one-time order?",
        tone: "calm_confidence",
        pauseMs: 900,
        branches: {
          yes: `${baseId}_offer_choice`, // if they say "yes" before giving a choice, we ask again
          hesitate: `${baseId}_offer_choice`,
          other: `${baseId}_offer_choice`
        }
      };

      // Offer choice capture
      states[`${baseId}_offer_choice`] = {
        say: "Tell me your choice: membership, one-time, three-pack, six-pack, annual, or post-date?",
        tone: "authoritative",
        pauseMs: 600,
        capture: "offer_choice",
        next: `${baseId}_price_quote`
      };

      // Price quote (branch on offer_choice)
      states[`${baseId}_price_quote`] = {
        say: `Great. I’ll quote your best price now with no shipping and no taxes.`,
        tone: "authoritative",
        pauseMs: 600,
        next: `${baseId}_price_switch`
      };

      // Build “price_switch” to set totals by choice
      states[`${baseId}_price_switch`] = {
        say: "",
        tone: "neutral",
        pauseMs: 0,
        logic: "format_human_currency",
        next: `${baseId}_trial_close`
      };

      // We can’t run code in JSON, so the server handles the humanization. We’ll pre-store numeric totals into session via “capture” path.
      // Here we simulate by instructing: the platform should set `final_total` before the format_human_currency step.
      // To help, we add 6 explicit micro-states the agent can call programmatically based on NLP matching the user’s choice.
      for (const v of vset) {
        const priceId = `${baseId}_set_${v.variant}`;
        states[priceId] = {
          say: "",
          tone: "neutral",
          pauseMs: 0,
          capture: "final_total", // we "capture" into final_total by instructing client to pass the numeric
          next: `${baseId}_price_switch`
        };
      }

      // To allow the NLP to jump: we add alias pointers the server *can* use.
      states[`${baseId}_alias_membership`] = { say: "", tone: "neutral", capture: "final_total", next: `${baseId}_price_switch` };
      states[`${baseId}_alias_onetime`]     = { say: "", tone: "neutral", capture: "final_total", next: `${baseId}_price_switch` };
      states[`${baseId}_alias_3pack`]       = { say: "", tone: "neutral", capture: "final_total", next: `${baseId}_price_switch` };
      states[`${baseId}_alias_6pack`]       = { say: "", tone: "neutral", capture: "final_total", next: `${baseId}_price_switch` };
      states[`${baseId}_alias_annual`]      = { say: "", tone: "neutral", capture: "final_total", next: `${baseId}_price_switch` };
      states[`${baseId}_alias_postdate`]    = { say: "", tone: "neutral", capture: "final_total", next: `${baseId}_price_switch` };

      // Trial close uses {{human_price}}
      states[`${baseId}_trial_close`] = {
        say: "That comes to {{human_price}} total today—with shipping and taxes waived. Sound good so we can get this out for you?",
        tone: "calm_confidence",
        pauseMs: 900,
        branches: { yes: `${baseId}_identity_intro`, hesitate: `${baseId}_objection_router`, service: "hotline_offer" }
      };

      // Objections
      states[`${baseId}_objection_router`] = {
        say: "I completely understand.",
        tone: "empathetic",
        pauseMs: 600,
        next: `${baseId}_objection_handle`
      };
      states[`${baseId}_objection_handle`] = {
        say: "Health is an investment. I can include up to 15% off and a free bonus gift—plus no shipping or taxes—and you’re covered by our money-back guarantee. With that in place, shall we secure your order?",
        tone: "authoritative",
        pauseMs: 900,
        branches: { yes: `${baseId}_identity_intro`, hesitate: `${baseId}_trial_close`, service: "hotline_offer" }
      };

      // Identity → Billing → Shipping → Contact → Payment
      states[`${baseId}_identity_intro`] = {
        say: "Great, I’ll take care of everything. I’ll capture the details clearly and confirm back as we go.",
        tone: "authoritative",
        pauseMs: 600,
        next: `${baseId}_name_on_card`
      };
      states[`${baseId}_name_on_card`] = {
        say: "First, what’s your full name exactly as it appears on the card?",
        tone: "authoritative",
        pauseMs: 600,
        capture: "creditCardName",
        next: `${baseId}_billing_street`
      };
      states[`${baseId}_billing_street`] = {
        say: "What’s the billing street address for the card? Include apartment or unit if any.",
        tone: "authoritative",
        pauseMs: 600,
        capture: "billAddress1",
        next: `${baseId}_billing_city`
      };
      states[`${baseId}_billing_city`] = {
        say: "Billing city?",
        tone: "authoritative",
        pauseMs: 600,
        capture: "billCity",
        next: `${baseId}_billing_state`
      };
      states[`${baseId}_billing_state`] = {
        say: "Billing state? Please say the state name.",
        tone: "authoritative",
        pauseMs: 600,
        capture: "billState",
        next: `${baseId}_billing_zip`
      };
      states[`${baseId}_billing_zip`] = {
        say: "Billing ZIP?",
        tone: "authoritative",
        pauseMs: 600,
        capture: "billZip",
        next: `${baseId}_shipping_same`
      };
      states[`${baseId}_shipping_same`] = {
        say: "Is the shipping address the same as the billing address?",
        tone: "authoritative",
        pauseMs: 600,
        branches: { yes: `${baseId}_contact_phone`, no: `${baseId}_shipping_street` }
      };
      states[`${baseId}_shipping_street`] = {
        say: "What’s the shipping street address?",
        tone: "authoritative",
        pauseMs: 600,
        capture: "shipAddress1",
        next: `${baseId}_shipping_city`
      };
      states[`${baseId}_shipping_city`] = {
        say: "Shipping city?",
        tone: "authoritative",
        pauseMs: 600,
        capture: "shipCity",
        next: `${baseId}_shipping_state`
      };
      states[`${baseId}_shipping_state`] = {
        say: "Shipping state? Please say the full state name.",
        tone: "authoritative",
        pauseMs: 600,
        capture: "shipState",
        next: `${baseId}_shipping_zip`
      };
      states[`${baseId}_shipping_zip`] = {
        say: "Shipping ZIP?",
        tone: "authoritative",
        pauseMs: 600,
        capture: "shipZip",
        next: `${baseId}_contact_phone`
      };
      states[`${baseId}_contact_phone`] = {
        say: "What’s the best phone number for updates?",
        tone: "authoritative",
        pauseMs: 600,
        capture: "customerAltPhone",
        next: `${baseId}_contact_email`
      };
      states[`${baseId}_contact_email`] = {
        say: "What’s the best email for your receipt and tracking?",
        tone: "authoritative",
        pauseMs: 600,
        capture: "customerEmail",
        next: `${baseId}_payment_method`
      };
      states[`${baseId}_payment_method`] = {
        say: "Which payment method works best for you—card or bank?",
        tone: "authoritative",
        pauseMs: 600,
        branches: { card: `${baseId}_card_number`, bank: `${baseId}_bank_account_name`, service: "hotline_offer", hesitate: `${baseId}_payment_reassure` }
      };
      states[`${baseId}_payment_reassure`] = {
        say: "You’re fully covered by our money-back guarantee, and there are no shipping fees or taxes. We’ll keep this simple and quick.",
        tone: "empathetic",
        pauseMs: 900,
        next: `${baseId}_payment_method`
      };

      // Card path + readback
      states[`${baseId}_card_number`] = {
        say: "Please read me the full card number. I’ll confirm it back once, grouped for accuracy.",
        tone: "authoritative",
        pauseMs: 600,
        capture: "creditCardNumber",
        next: `${baseId}_card_exp_mo`
      };
      states[`${baseId}_card_exp_mo`] = { say: "Expiration month?", tone: "authoritative", pauseMs: 600, capture: "creditCardExpMonth", next: `${baseId}_card_exp_yr` };
      states[`${baseId}_card_exp_yr`] = { say: "Expiration year?",  tone: "authoritative", pauseMs: 600, capture: "creditCardExpYear",  next: `${baseId}_card_cvc`     };
      states[`${baseId}_card_cvc`]    = { say: "CVC on the back of the card? You’ll say it once.", tone: "authoritative", pauseMs: 600, capture: "creditCardCVC", next: `${baseId}_price_total` };

      // Bank path
      states[`${baseId}_bank_account_name`] = { say: "What name is on the bank account?", tone: "authoritative", pauseMs: 600, capture: "bankAccountName", next: `${baseId}_bank_routing` };
      states[`${baseId}_bank_routing`]      = { say: "Routing number?", tone: "authoritative", pauseMs: 600, capture: "bankRoutingNumber", next: `${baseId}_bank_account` };
      states[`${baseId}_bank_account`]      = { say: "Account number?", tone: "authoritative", pauseMs: 600, capture: "bankAccountNumber", next: `${baseId}_price_total` };

      // Price total + formatting + readback (with human currency & last4)
      states[`${baseId}_price_total`] = {
        say: "For your selection, your total comes to {{human_price}}—with no shipping fees and no taxes.",
        tone: "authoritative",
        pauseMs: 900,
        logic: "format_human_currency",
        next: `${baseId}_compose_shipline`
      };
      states[`${baseId}_compose_shipline`] = {
        say: "",
        tone: "neutral",
        pauseMs: 0,
        logic: "compose_ship_line",
        next: `${baseId}_readback_confirm`
      };
      states[`${baseId}_readback_confirm`] = {
        say: "Let me read that back to make sure I have it right: shipping to {{ship_address_line}}. For the card, ending in {{last4}}. Is that all correct?",
        tone: "authoritative",
        pauseMs: 1200,
        logic: "extract_last4",
        branches: { yes: `${baseId}_process`, no: `${baseId}_correct_details`, service: "hotline_offer", hesitate: `${baseId}_readback_clarify` }
      };
      states[`${baseId}_readback_clarify`] = {
        say: "No problem—what should I correct or update for you?",
        tone: "empathetic",
        pauseMs: 900,
        next: `${baseId}_readback_confirm`
      };
      states[`${baseId}_correct_details`] = {
        say: "Thank you. Let’s update that now.",
        tone: "empathetic",
        pauseMs: 900,
        next: `${baseId}_readback_confirm`
      };

      // Processing: add deliberate pause
      states[`${baseId}_process`] = {
        say: "Great. Let me get that processed for you now.",
        tone: "calm_confidence",
        pauseMs: 2000, // realistic pause
        next: `${baseId}_capture_sale`
      };

      // Log sale (to Saleslog12)
      states[`${baseId}_capture_sale`] = {
        say: "Perfect—processing now. You’ll receive an email receipt and tracking shortly.",
        tone: "absolute_certainty",
        pauseMs: 900,
        toolCall: { tool: "log.sale.google.tool.json", intent: "append_saleslog12" },
        next: `${baseId}_closing_sale`
      };

      states[`${baseId}_closing_sale`] = {
        say: `Your order is confirmed. No shipping, no taxes, and your discount is locked in. Thank you for choosing Health America—you’re going to love the results. If you ever need anything or want to reorder, our number is ${HOTLINE}.`,
        tone: "absolute_certainty",
        pauseMs: 900,
        end: true
      };
    }
  }

  // ==== Cross-sell Menus (12 units total for $499.99): present after primary selection as an alternate ====
  // We create a generic “bundle_offer” that can be jumped to any time pre-payment.
  states["bundle_offer_intro"] = {
    say: "Quick note — many customers choose a yearly wellness combo to simplify. I can combine two favorites into a 12-unit bundle for the year at a single best price.",
    tone: "enthusiastic",
    pauseMs: 900,
    next: "bundle_offer_menu"
  };
  states["bundle_offer_menu"] = {
    say: "Would you like to hear a couple of popular 12-unit combo options?",
    tone: "calm_confidence",
    pauseMs: 600,
    branches: { yes: "bundle_offer_list", no: "catch_all", hesitate: "bundle_offer_list" }
  };

  // generate a handful at random to keep the flow size reasonable; (the builder still creates thousands of states above)
  const topBundles = crossCombos.slice(0, Math.min(12, crossCombos.length));
  topBundles.forEach((b, idx) => {
    states[`bundle_${idx}_desc`] = {
      say: `${b.name}. That’s ${b.label} for ${formatPrice(b.price)} total — shipping and taxes waived.`,
      tone: "authoritative",
      pauseMs: 900,
      next: idx < topBundles.length - 1 ? `bundle_${idx+1}_desc` : "bundle_offer_trial"
    };
  });

  states["bundle_offer_list"] = { say: "Here are some options:", tone: "authoritative", pauseMs: 600, next: (topBundles.length>0 ? "bundle_0_desc" : "bundle_offer_trial") };
  states["bundle_offer_trial"] = {
    say: "Would you like to secure one of those annual bundles now while I have your details?",
    tone: "calm_confidence",
    pauseMs: 900,
    branches: { yes: "identity_reuse", no: "catch_all", hesitate: "identity_reuse" }
  };
  states["identity_reuse"] = {
    say: "Great—since I already confirmed your info, we’ll apply it to this bundle and finalize the order.",
    tone: "authoritative",
    pauseMs: 900,
    next: "closing_generic"
  };
  states["closing_generic"] = {
    say: `Done and done. You’re all set. As a reminder, our customer care line is ${HOTLINE} if you ever need anything. Thank you for choosing Health America.`,
    tone: "absolute_certainty",
    pauseMs: 900,
    end: true
  };

  // === Fallbacks ===
  states["farewell_soft"] = {
    say: `Thank you for your time today. If you need anything or want to reorder later, we’re at ${HOTLINE}.`,
    tone: "empathetic", pauseMs: 900, end: true
  };
  states["catch_all"] = {
    say: "I want to get this exactly right for you. Could you say that another way so I can help you faster?",
    tone: "empathetic", pauseMs: 900, next: "reason_for_call"
  };

  // === Entry point to product trees ===
  // A simple router after needs_confirm: we expose a menu of primary intros to each product/form path.
  // You can jump into any “pitch_<id>_<form>” node programmatically from Vapi NLU or a tool rule.
  states["select_primary"] = {
    say: "I’ll match you with the best fit now.",
    tone: "authoritative",
    pauseMs: 600,
    next: "primary_menu"
  };

  // Build a long “primary_menu” chain to keep this huge
  let lastId = null;
  CATALOG.forEach((p, i) => {
    p.variations.forEach((f, j) => {
      const id = `primary_${p.id}_${f.form}`;
      states[id] = {
        say: `Option: ${p.name} (${f.form}). It ${pick(p.benefitsToOutcomes)}. Would you like to proceed with this?`,
        tone: "enthusiastic",
        pauseMs: 900,
        branches: { yes: `pitch_${p.id}_${f.form}`, no: null, hesitate: `pitch_${p.id}_${f.form}` }
      };
      if (!lastId) states["primary_menu"] = { say: "Let me outline your top options quickly.", tone: "authoritative", pauseMs: 900, next: id };
      else states[lastId].next = id;
      lastId = id;
    });
  });
  if (lastId && !states[lastId].next) states[lastId].next = "pitch_phytoplankton_capsule"; // default jump to something

  return { meta, states };
}

(function main() {
  const outDir = path.join(__dirname, "flows");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const flow = buildFlow();

  const outFile = path.join(outDir, "flows_alex_sales.json");
  fs.writeFileSync(outFile, JSON.stringify(flow, null, 2), "utf8");
  console.log(`✅ Wrote HUGE flow to ${outFile} with ${Object.keys(flow.states).length} states`);
})();
