// ============================
// integrations.js
// ============================
//
// ⚠️ CRITICAL DIRECTIVE ⚠️
// Do not remove or alter core sales principles enforced by the flow:
// 1) Maximum Value Before Price.
// 2) STRICT step-down: annual/membership → 6mo → 3mo → single.
// API integrations must support, not subvert, these rules.
// Only additive refinements are allowed.
//
// Drop-in router: Zoho Inventory (with Pitney Bowes USPS via Zoho), Authorize.Net, Stripe Payment Links
// All responses are JSON. No secrets are logged. PCI-sensitive fields trimmed from logs.

const express = require("express");
const fetch = require("node-fetch"); // v2
const Stripe = require("stripe");
const router = express.Router();

// ---------- ENV ----------
const {
  ZOHO_DC = "us",
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_ORG_ID,
  AUTHNET_LOGIN_ID,
  AUTHNET_TRANSACTION_KEY,
  AUTHNET_ENV = "sandbox",
  STRIPE_SECRET_KEY,
  STRIPE_PAYMENT_LINK_DOMAIN,
} = process.env;

// ---------- Helpers ----------
const ZOHO_BASE = (() => {
  switch (ZOHO_DC) {
    case "eu": return "https://inventory.zoho.eu/api/v1";
    case "in": return "https://inventory.zoho.in/api/v1";
    case "au": return "https://inventory.zoho.com.au/api/v1";
    case "jp": return "https://inventory.zoho.jp/api/v1";
    default:   return "https://inventory.zoho.com/api/v1";
  }
})();

const ZOHO_ACCOUNTS_BASE = (() => {
  switch (ZOHO_DC) {
    case "eu": return "https://accounts.zoho.eu";
    case "in": return "https://accounts.zoho.in";
    case "au": return "https://accounts.zoho.com.au";
    case "jp": return "https://accounts.zoho.jp";
    default:   return "https://accounts.zoho.com";
  }
})();

let _zohoAccessToken = null;
let _zohoAccessTokenExpiry = 0;

async function getZohoAccessToken() {
  const now = Date.now();
  if (_zohoAccessToken && now < _zohoAccessTokenExpiry) return _zohoAccessToken;

  const tokenURL = `${ZOHO_ACCOUNTS_BASE}/oauth/v2/token?refresh_token=${encodeURIComponent(
    ZOHO_REFRESH_TOKEN
  )}&client_id=${encodeURIComponent(ZOHO_CLIENT_ID)}&client_secret=${encodeURIComponent(
    ZOHO_CLIENT_SECRET
  )}&grant_type=refresh_token`;

  const r = await fetch(tokenURL, { method: "POST" });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Zoho token refresh failed: ${t}`);
  }
  const j = await r.json();
  _zohoAccessToken = j.access_token;
  _zohoAccessTokenExpiry = Date.now() + (j.expires_in || 3500) * 1000;
  return _zohoAccessToken;
}

async function zohoGet(path, params = {}) {
  const at = await getZohoAccessToken();
  const url = new URL(`${ZOHO_BASE}${path}`);
  url.searchParams.set("organization_id", ZOHO_ORG_ID);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Zoho-oauthtoken ${at}` },
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`Zoho GET ${path} failed: ${text}`);
  return j;
}

async function zohoPost(path, body) {
  const at = await getZohoAccessToken();
  const url = new URL(`${ZOHO_BASE}${path}`);
  url.searchParams.set("organization_id", ZOHO_ORG_ID);
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${at}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`Zoho POST ${path} failed: ${text}`);
  return j;
}

function currencyToCents(amount) {
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  return Math.round(n * 100);
}

function safeCardForLog(x) {
  if (!x) return undefined;
  return {
    last4: (x.number || "").slice(-4),
    expMonth: x.exp_month,
    expYear: x.exp_year,
  };
}

// ---------- Health ----------
router.get("/v1/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---------- ZOHO: Item Lookup by SKU ----------
router.post("/v1/zoho/item/search", async (req, res) => {
  try {
    const { sku } = req.body || {};
    if (!sku) return res.status(400).json({ error: "Missing sku" });

    const j = await zohoGet("/items", { search_text: sku });

    const items = (j.items || []).filter((it) => it.sku && it.sku.toLowerCase() === sku.toLowerCase());
    if (!items.length) return res.status(404).json({ error: "Item not found" });

    const item = items[0];
    res.json({
      ok: true,
      item: {
        item_id: item.item_id,
        name: item.name,
        sku: item.sku,
        rate: item.rate,
        description: item.description,
        available_stock: item.available_stock,
      },
      raw: j,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- ZOHO: Create Sales Order (+ optional Package + Shipment) ----------
router.post("/v1/zoho/order", async (req, res) => {
  try {
    const {
      customer = {},
      billing_address = {},
      shipping_address = {},
      line_items = [],
      reference_number,
      notes,
      create_shipment = false,
      shipment_carrier = "usps",
      shipment_date
    } = req.body || {};

    if (!line_items.length) return res.status(400).json({ error: "Missing line_items" });

    const soPayload = {
      customer_name: `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || customer.company || "Unknown Customer",
      reference_number,
      custom_body: notes,
      line_items: line_items.map((li) => ({
        item_id: li.item_id,
        name: li.name,
        rate: li.rate,
        quantity: li.quantity || 1,
        description: li.description,
        sku: li.sku,
      })),
      billing_address: {
        address: billing_address.address,
        city: billing_address.city,
        state: billing_address.state,
        zip: billing_address.zip,
        country: billing_address.country || "US",
      },
      shipping_address: {
        address: shipping_address.address,
        city: shipping_address.city,
        state: shipping_address.state,
        zip: shipping_address.zip,
        country: shipping_address.country || "US",
      }
    };

    const soResp = await zohoPost("/salesorders", soPayload);
    if (!soResp || !soResp.salesorder) throw new Error("Zoho SO create failed");
    const salesorder = soResp.salesorder;

    let packageResp = null;
    let shipmentResp = null;

    if (create_shipment) {
      const pkgPayload = {
        salesorder_id: salesorder.salesorder_id,
        package_number: undefined,
        line_items: (salesorder.line_items || []).map((li) => ({
          line_item_id: li.line_item_id,
          quantity: li.quantity,
        })),
      };
      packageResp = await zohoPost("/packages", pkgPayload);
      if (!packageResp || !packageResp.package) throw new Error("Zoho package create failed");

      const shipmentPayload = {
        date: shipment_date || new Date().toISOString().slice(0, 10),
        carrier: shipment_carrier,
        packages: [{ package_id: packageResp.package.package_id }],
      };
      shipmentResp = await zohoPost("/shipments", shipmentPayload);
      if (!shipmentResp || !shipmentResp.shipment) throw new Error("Zoho shipment create failed");
    }

    res.json({
      ok: true,
      salesorder: {
        id: salesorder.salesorder_id,
        number: salesorder.salesorder_number,
        status: salesorder.status,
        total: salesorder.total,
      },
      package: packageResp ? {
        id: packageResp.package.package_id,
        number: packageResp.package.package_number,
      } : null,
      shipment: shipmentResp ? {
        id: shipmentResp.shipment.shipment_id,
        number: shipmentResp.shipment.shipment_number,
        tracking_number: shipmentResp.shipment.tracking_number || null,
        documents: shipmentResp.shipment.documents || null,
      } : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Authorize.Net: card-not-present charge ----------
router.post("/v1/payments/authorize-net/charge", async (req, res) => {
  try {
    const {
      amount,
      card = {},
      billing_address = {},
      invoice_number,
      description
    } = req.body || {};

    if (!process.env.AUTHNET_LOGIN_ID || !process.env.AUTHNET_TRANSACTION_KEY) {
      return res.status(500).json({ error: "Authorize.Net credentials missing" });
    }
    if (!amount || !card.number || !card.exp_month || !card.exp_year || !card.cvc) {
      return res.status(400).json({ error: "Missing payment details" });
    }

    const endpoint =
      (process.env.AUTHNET_ENV || "sandbox") === "production"
        ? "https://api2.authorize.net/xml/v1/request.api"
        : "https://apitest.authorize.net/xml/v1/request.api";

    const payload = {
      createTransactionRequest: {
        merchantAuthentication: {
          name: process.env.AUTHNET_LOGIN_ID,
          transactionKey: process.env.AUTHNET_TRANSACTION_KEY
        },
        transactionRequest: {
          transactionType: "authCaptureTransaction",
          amount: amount,
          payment: {
            creditCard: {
              cardNumber: card.number,
              expirationDate: `${String(card.exp_year).padStart(4, "0")}-${String(card.exp_month).padStart(2, "0")}`,
              cardCode: card.cvc
            }
          },
          billTo: {
            firstName: billing_address.first_name,
            lastName: billing_address.last_name,
            address: billing_address.address,
            city: billing_address.city,
            state: billing_address.state,
            zip: billing_address.zip,
            country: billing_address.country || "US"
          },
          order: {
            invoiceNumber: invoice_number || undefined,
            description: description || undefined
          }
        }
      }
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }

    if (!r.ok) return res.status(502).json({ error: "Authorize.Net request failed", raw: j });

    const rsp = j.transactionResponse || (j.createTransactionResponse && j.createTransactionResponse.transactionResponse);
    const ok = rsp && (rsp.responseCode === "1" || rsp.responseCode === 1);

    res.json({
      ok: !!ok,
      transaction_id: rsp && rsp.transId,
      auth_code: rsp && rsp.authCode,
      messages: rsp && rsp.messages,
      errors: rsp && rsp.errors,
      card: safeCardForLog(card)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Stripe: create Payment Link (hosted checkout) ----------
router.post("/v1/payments/stripe/payment-link", async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY" });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const {
      amount,
      currency = "usd",
      product_name = "Health America Order",
      description,
      quantity = 1,
      metadata = {}
    } = req.body || {};

    if (!amount) return res.status(400).json({ error: "Missing amount" });

    const product = await stripe.products.create({ name: product_name });
    const price = await stripe.prices.create({
      unit_amount: currencyToCents(amount),
      currency,
      product: product.id,
    });

    const pl = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity }],
      after_completion: { type: "hosted_confirmation" },
      metadata
    });

    res.json({
      ok: true,
      payment_link_url: pl.url,
      product_id: product.id,
      price_id: price.id,
      link_id: pl.id
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ---------- Authorize.Net Profile & Schedule (unchanged logic below) ----------
/* ... keep your existing profile and schedule endpoints here verbatim ... */
