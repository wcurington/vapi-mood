//
// integrations_v1.8.0.js
// Health America Integrations — flows + CRM/shipping/payment stubs, QA helpers
//
// Upgrades vs 1.7.0:
//  - Defensive wiring for flow adapters
//  - Thin, composable integration stubs with consistent error contracts
//  - Ready to plug real CRM/Shipping/Payments when credentials land
//
'use strict';

const axios = require('axios');

class Integrations {
  constructor() {
    // External services (stubs; wire real ones as needed)
    this.vtigerBase  = process.env.VTIGER_BASE   || 'http://localhost:8080/vtiger';
    this.vtigerKey   = process.env.VTIGER_KEY    || 'changeme';
    this.shippingBase= process.env.SHIPPING_BASE || 'http://localhost:8080/shipping';
    this.uspsKey     = process.env.USPS_KEY      || 'changeme';

    // Flow adapters (wired by server)
    this.flowGetById = null;
    this.flowSearch  = null;
    this.flowRandom  = null;
  }

  // ---- Flow Adapters ----
  setFlowAdapters({ getById, search, random }) {
    this.flowGetById = typeof getById === 'function' ? getById : null;
    this.flowSearch  = typeof search  === 'function' ? search  : null;
    this.flowRandom  = typeof random  === 'function' ? random  : null;
    console.log('[integrations] Flow adapters wired:', {
      getById: !!this.flowGetById, search: !!this.flowSearch, random: !!this.flowRandom
    });
  }
  getFlowById(id)  { return this.flowGetById ? this.flowGetById(id) : null; }
  searchFlows(q,l) { return this.flowSearch  ? this.flowSearch(q,l) : []; }
  getRandomFlow()  { return this.flowRandom  ? this.flowRandom()    : null; }

  // ---- CRM / Shipping / Payments (stubs) ----
  async logOrderToVtiger(order) {
    try {
      const res = await axios.post(`${this.vtigerBase}/orders`, { ...order, key: this.vtigerKey });
      return res.data;
    } catch (err) {
      return { error:true, system:'vtiger', message: err.response?.data || err.message };
    }
  }

  async createShippingLabel(order) {
    try {
      const res = await axios.post(`${this.shippingBase}/labels`, { ...order, key: this.uspsKey });
      return res.data;
    } catch (err) {
      return { error:true, system:'shipping', message: err.response?.data || err.message };
    }
  }

  async processPayment(paymentInfo) {
    // Replace with real processor (Stripe, Authorize.net, etc.)
    return { ok:true, txId: 'tx_' + Date.now(), authorized: true };
  }

  async logCallEvent(call) {
    // Replace with actual analytics sink (DB, Kafka, etc.)
    return { ok:true, logged:true, at: Date.now() };
  }
}

module.exports = new Integrations();
