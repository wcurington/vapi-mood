/**
 * server_v1.3.1.js — Alex Core Server (XXL)
 * - Dead-air guard & keep-alive
 * - Health-question pacing
 * - Speech sanitization hooks
 * - Digit articulation & numeric stream stabilizer
 * - Payment validation (cards, routing/account)
 * - Bundle pricing logic with discounts
 * - State-name expansion (speak full names)
 * - Static docs download (force download)
 * - Versioned health/info endpoints
 */
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");

// Routers
const speechFilter = require("./server_speech_filter_v1.3.1.js");
const flows = require("./patch_flows_pauses_shipping_v1.3.1.js");

// ---- Config ----
const VERSION = "v1.3.1";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 10000;
const DOCS_DIR = path.join(__dirname, "docs");
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

// ---- Utilities ----
function expandStateAbbrev(abbrev) {
  if (!abbrev) return abbrev;
  const up = String(abbrev).trim().toUpperCase();
  return STATE_MAP[up] || abbrev;
}

function validateCard(payload) {
  // payload = { brand, number, expMonth, expYear, cvv }
  const digits = String(payload.number || "").replace(/\D/g, "");
  const brand = String(payload.brand || "").toLowerCase();
  const cvv = String(payload.cvv || "").trim();
  const expMonth = parseInt(payload.expMonth, 10);
  const expYear = parseInt(payload.expYear, 10);

  const checks = { ok: true, reason: [] };

  // basic brand-length validation
  const brandSpec = {
    visa: { len:[16], cvv:3, prefix:/^4/ },
    mastercard: { len:[16], cvv:3, prefix:/^(5[1-5]|2[2-7])/ },
    discover: { len:[16], cvv:3, prefix:/^(6011|65|64[4-9])/ },
    amex: { len:[15], cvv:4, prefix:/^(34|37)/ }
  };

  const spec = brandSpec[brand] || null;
  if (!spec) {
    checks.ok = false; checks.reason.push("Unsupported or missing card brand.");
    return checks;
  }
  if (!spec.len.includes(digits.length)) {
    checks.ok = false; checks.reason.push(`Invalid length for ${brand.toUpperCase()}.`);
  }
  if (!spec.prefix.test(digits)) {
    checks.ok = false; checks.reason.push(`Number does not match ${brand.toUpperCase()} pattern.`);
  }
  if (!cvv || cvv.length !== spec.cvv || !/^\d+$/.test(cvv)) {
    checks.ok = false; checks.reason.push(`Invalid CVV for ${brand.toUpperCase()}.`);
  }
  // Expiration validation: month 1-12, year >= current, and not expired
  const now = new Date();
  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth() + 1;
  if (!(expMonth >=1 && expMonth <=12)) {
    checks.ok = false; checks.reason.push("Invalid expiration month.");
  }
  if (!(expYear >= nowYear && expYear <= nowYear + 20)) {
    checks.ok = false; checks.reason.push("Invalid expiration year.");
  } else {
    if (expYear === nowYear && expMonth < nowMonth) {
      checks.ok = false; checks.reason.push("Card has expired.");
    }
  }

  // Luhn check (basic)
  function luhn(num) {
    let sum = 0, alt = false;
    for (let i = num.length - 1; i >= 0; i--) {
      let n = parseInt(num[i], 10);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return (sum % 10) === 0;
  }
  if (!luhn(digits)) {
    checks.ok = false; checks.reason.push("Luhn check failed.");
  }

  return checks;
}

function validateBank(payload) {
  // payload = { routing, account, checkNumber? }
  const out = { ok:true, reason:[] };
  const routing = String(payload.routing||"").replace(/\D/g,"");
  const account = String(payload.account||"").replace(/\D/g,"");
  if (routing.length !== 9) { out.ok=false; out.reason.push("Routing number must be 9 digits."); }
  if (!(account.length>=7 && account.length<=12)) { out.ok=false; out.reason.push("Account number must be 7–12 digits."); }
  if (payload.checkNumber != null) {
    const cn = String(payload.checkNumber).replace(/\D/g,"");
    if (cn.length===0) { out.ok=false; out.reason.push("Check number must be numeric."); }
  }
  return out;
}

// pricing: sum item prices + bundle discount tiers (e.g., 2 items 5%, 3+ items 10%)
function priceBundle(items) {
  // items: [{sku, name, price, months}]
  const subtotal = items.reduce((s,i)=> s + (Number(i.price)||0), 0);
  const count = items.length;
  let discount = 0;
  if (count===2) discount = 0.05;
  else if (count>=3) discount = 0.10;
  const total = Math.round((subtotal * (1-discount))*100)/100;
  return { subtotal, discountPct: discount, total };
}

// dead-air guard: if engine wants to end early, add a one-time re-engage opportunity
function shouldKeepAlive(session) {
  if (!session) return false;
  if (session.hardEnd === true) return false;
  // If user showed interest or mid-transaction keep alive
  const engaged = Boolean(session.flags && (session.flags.engaged || session.flags.midPayment || session.flags.healthIntake));
  return engaged && !session.keepAliveUsed;
}

// ---- App ----
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended:true }));
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(morgan("tiny"));

// Rate limit on sensitive routes
const limiter = rateLimit({ windowMs: 60*1000, max: 120 });
app.use(limiter);

// Static docs (also force-download endpoints below)
app.use("/docs", express.static(DOCS_DIR, { dotfiles: "ignore", fallthrough: true }));

// ---- Health/info ----
app.get("/", (req,res)=> {
  res.status(200).send("✅ Alex Core " + VERSION + " is running. Static docs at /docs");
});
app.get("/health", (req,res)=> {
  res.json({ status:"UP", service:"alex-core", version:VERSION, now: new Date().toISOString() });
});
app.get("/version", (req,res)=> res.json({ version: VERSION }));

// ---- Speech filter + Flows routers ----
app.use("/speech-filter", speechFilter.router);
app.use("/flows", flows.router);

// ---- Payments endpoints (server-side validation only; vault/processor is external) ----
app.post("/payments/validate-card", (req,res)=> {
  const result = validateCard(req.body||{});
  res.status(result.ok?200:400).json(result);
});
app.post("/payments/validate-bank", (req,res)=> {
  const result = validateBank(req.body||{});
  res.status(result.ok?200:400).json(result);
});

// ---- Pricing endpoint ----
app.post("/pricing/bundle", (req,res)=> {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const calc = priceBundle(items);
  res.json(calc);
});

// ---- Address speech helper ----
app.post("/speech/expand-state", (req,res)=> {
  const { state } = req.body||{};
  res.json({ spoken: expandStateAbbrev(state) });
});

// ---- Keep-alive guard ----
const SESS = new Map();
app.post("/session/update", (req,res)=>{
  const { sessionId, flags, hardEnd } = req.body||{};
  if (!sessionId) return res.status(400).json({ ok:false, reason:"Missing sessionId"});
  const s = SESS.get(sessionId) || { id: sessionId, flags:{} };
  if (flags && typeof flags==="object") s.flags = { ...s.flags, ...flags };
  if (hardEnd === true) s.hardEnd = true;
  SESS.set(sessionId, s);
  res.json({ ok:true, session: s });
});
app.post("/session/should-keep-alive", (req,res)=>{
  const { sessionId } = req.body||{};
  if (!sessionId) return res.status(400).json({ ok:false, reason:"Missing sessionId"});
  const s = SESS.get(sessionId);
  const keep = shouldKeepAlive(s);
  if (keep) { s.keepAliveUsed = true; SESS.set(sessionId, s); }
  res.json({ ok:true, keepAlive: keep });
});

// ---- Forced download endpoints ----
function sendDownload(res, absPath, downloadName) {
  if (!fs.existsSync(absPath)) return res.status(404).send("Not Found");
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
  res.setHeader("Content-Type", "application/octet-stream");
  fs.createReadStream(absPath).pipe(res);
}

const GUIDE = path.join(DOCS_DIR, "Alex_Agent_Testing_Guide_v1.3.1.pdf");
const CHECK = path.join(DOCS_DIR, "Alex_Testing_Checklist_v1.7.pdf");

app.get("/docs/testing-guide.pdf", (req,res)=> sendDownload(res, GUIDE, "Alex_Agent_Testing_Guide_v1.3.1.pdf"));
app.get("/docs/testing-checklist.pdf", (req,res)=> sendDownload(res, CHECK, "Alex_Testing_Checklist_v1.7.pdf"));

// ---- Start ----
app.listen(PORT, ()=> {
  console.log(`🚀 Alex Core ${VERSION} running on ${PORT}`);
});
