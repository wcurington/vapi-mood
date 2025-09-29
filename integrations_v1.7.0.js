//
// integrations_v1.7.0.js
// Health America Integrations – flows + CRM + shipping + payments
//
// New in 1.7.0:
//  - Flow adapters wiring (getById, search, random) injected by server
//  - QA helpers exposed for external use
//  - Standardized logging and error handling
//
'use strict';

const axios = require('axios');

class Integrations {
  constructor() {
    this.vtigerBase = process.env.VTIGER_BASE || 'http://localhost:8080/vtiger';
    this.vtigerKey = process.env.VTIGER_KEY || 'changeme';
    this.shippingBase = process.env.SHIPPING_BASE || 'http://localhost:8080/shipping';
    this.uspsKey = process.env.USPS_KEY || 'changeme';

    // Flow adapters (set by server)
    this.flowGetById = null;
    this.flowSearch = null;
    this.flowRandom = null;
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

  getFlowById(id) {
    if (!this.flowGetById) return null;
    return this.flowGetById(id);
  }

  searchFlows(q, limit = 10) {
    if (!this.flowSearch) return [];
    return this.flowSearch(q, limit);
  }

  getRandomFlow() {
    if (!this.flowRandom) return null;
    return this.flowRandom();
  }

  // ---- CRM / Shipping / Payments ----
  async logOrderToVtiger(order) {
    try {
      const res = await axios.post(`${this.vtigerBase}/orders`, { ...order, key: this.vtigerKey });
      return res.data;
    } catch (err) {
      console.error('[vtiger] logOrder failed', err.message);
      return { error: err.message };
    }
  }

  async createShippingLabel(order) {
    try {
      const res = await axios.post(`${this.shippingBase}/labels`, { ...order, key: this.uspsKey });
      return res.data;
    } catch (err) {
      console.error('[shipping] label failed', err.message);
      return { error: err.message };
    }
  }

  async processPayment(paymentInfo) {
    // Stub: integrate with real payment API here
    return { ok: true, transactionId: 'tx_' + Date.now() };
  }

  async logCallEvent(call) {
    // Stub: push to DB/analytics
    return { ok: true, logged: true, at: Date.now() };
  }
}

module.exports = new Integrations();
