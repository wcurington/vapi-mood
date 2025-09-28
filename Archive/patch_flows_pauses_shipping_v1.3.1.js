/**
 * patch_flows_pauses_shipping_v1.3.1.js — Flows Manager (XXL)
 * - Health intake pacing (longer pauses)
 * - Shipping promise reminder injection (5–7 biz days by default)
 * - Robot inquiry handling (truthful by default; configurable)
 * - Payment capture guards (wait for completion; no early escalation)
 * - State full-name rendering for confirmation
 */
"use strict";

const express = require("express");
const router = express.Router();

const CFG = {
  shippingWindow: "5–7 business days",
  identityResponse: "I'm an automated assistant with Health America, and I'm here to help today.", // truthful default
  allowHumanClaim: false // set true ONLY if business policy explicitly approves claiming to be human
};

const STATE_MAP = {
  AL:"Alabama", AK:"Alaska", AZ:"Arizona", AR:"Arkansas", CA:"California", CO:"Colorado", CT:"Connecticut",
  DE:"Delaware", FL:"Florida", GA:"Georgia", HI:"Hawaii", ID:"Idaho", IL:"Illinois", IN:"Indiana", IA:"Iowa",
  KS:"Kansas", KY:"Kentucky", LA:"Louisiana", ME:"Maine", MD:"Maryland", MA:"Massachusetts", MI:"Michigan",
  MN:"Minnesota", MS:"Mississippi", MO:"Missouri", MT:"Montana", NE:"Nebraska", NV:"Nevada", NH:"New Hampshire",
  NJ:"New Jersey", NM:"New Mexico", NY:"New York", NC:"North Carolina", ND:"North Dakota", OH:"Ohio", OK:"Oklahoma",
  OR:"Oregon", PA:"Pennsylvania", RI:"Rhode Island", SC:"South Carolina", SD:"South Dakota", TN:"Tennessee",
  TX:"Texas", UT:"Utah", VT:"Vermont", VA:"Virginia", WA:"Washington", WV:"West Virginia", WI:"Wisconsin", WY:"Wyoming",
  DC:"District of Columbia"
};

function expandState(abbrev) {
  if (!abbrev) return abbrev;
  const up = String(abbrev).trim().toUpperCase();
  return STATE_MAP[up] || abbrev;
}

router.get("/health", (req,res)=> {
  res.json({ status:"UP", service:"flows-manager", version:"v1.3.1" });
});

/**
 * POST /flows/route
 * Accepts { intent, context }
 * Returns { next, say, flags }
 */
router.post("/route", (req,res)=> {
  const { intent, context } = req.body || {};
  let say = "";
  const flags = {};

  if (intent === "robot_check") {
    if (CFG.allowHumanClaim) {
      say = "No, I am a live person and I would love to help improve your health today.";
    } else {
      say = CFG.identityResponse;
    }
    return res.json({ ok:true, next:"continue", say, flags });
  }

  if (intent === "confirm_address") {
    const { address } = context || {};
    if (address && address.state) {
      const full = expandState(address.state);
      say = `Let me confirm your address: ${address.line1}, ${address.city}, ${full} ${address.zip}.`;
    } else {
      say = "Could you please share your full address, including city and state?";
    }
    return res.json({ ok:true, next:"await_confirmation", say, flags });
  }

  if (intent === "health_intake_begin") {
    // Pace health questions: one at a time
    flags.healthIntake = true;
    say = "I'd like to ask a few quick questions to better understand your health. We'll go one at a time. First—do you experience joint pain?";
    return res.json({ ok:true, next:"health_q1", say, flags, pauseMS: 1200 });
  }

  if (intent === "health_q1_answer") {
    // Ask pain scale slowly
    say = "Thank you. On a scale of 1 to 10, where 1 is mild and 10 is severe, how would you rate that pain?";
    return res.json({ ok:true, next:"health_q1_scale", say, flags, pauseMS: 1200 });
  }

  if (intent === "offer_products") {
    // Always remind shipping window proactively
    say = "Based on what you've shared, I recommend two targeted supplements that work brilliantly together. You're going to love it—this product set is incredible. Shipping typically takes " + CFG.shippingWindow + ". Shall we go ahead?";
    return res.json({ ok:true, next:"await_payment_method", say, flags });
  }

  if (intent === "payment_method_bank") {
    flags.midPayment = true;
    say = "Great—I'll take your routing number and account number. Please read the routing number—it's nine digits—one digit at a time. I'll confirm back. Ready when you are.";
    return res.json({ ok:true, next:"collect_routing", say, flags, digitMode:true });
  }

  if (intent === "routing_partial") {
    // instruct not to escalate; ask to complete
    const { digitsSoFar = "" } = context || {};
    const remain = Math.max(0, 9 - String(digitsSoFar).replace(/\D/g,"").length);
    say = remain > 0
      ? `I have ${digitsSoFar.length} digits. Please continue—${remain} digits remaining.`
      : "Thank you. Now, please share your account number—between seven and twelve digits.";
    return res.json({ ok:true, next: remain>0?"collect_routing":"collect_account", say, flags, digitMode:true });
  }

  if (intent === "account_partial") {
    const { digitsSoFar = "" } = context || {};
    const n = String(digitsSoFar).replace(/\D/g,"").length;
    if (n < 7) {
      say = `I currently have ${n} digits. Account numbers are seven to twelve digits—please continue.`;
      return res.json({ ok:true, next:"collect_account", say, flags, digitMode:true });
    }
    say = "Thanks—I have that. Lastly, may I have the check number for your records?";
    return res.json({ ok:true, next:"collect_check_number", say, flags });
  }

  if (intent === "payment_complete") {
    // Clear payment flag; remind shipping proactively
    flags.midPayment = false;
    say = `Perfect—your order is confirmed. You'll receive your package within ${CFG.shippingWindow}. Is there anything else I can assist you with today?`;
    return res.json({ ok:true, next:"wrap_up", say, flags });
  }

  // Default
  say = "How can I help you today?";
  return res.json({ ok:true, next:"continue", say, flags });
});

module.exports = { router };
