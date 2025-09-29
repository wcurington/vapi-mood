// discountRules.js
// This file enforces the rule: Alex can only unlock a 15% discount or gift
// if the customer qualifies under one of the hard rules:
// 1) Senior citizen, 2) Veteran, or 3) Haggles over price twice.

class DiscountRules {
  constructor() {
    this.priceObjectionCount = 0;
    this.isSenior = false;
    this.isVeteran = false;
  }

  registerSenior() {
    this.isSenior = true;
  }

  registerVeteran() {
    this.isVeteran = true;
  }

  registerPriceObjection() {
    this.priceObjectionCount += 1;
  }

  canOfferDiscount() {
    return this.isSenior || this.isVeteran || this.priceObjectionCount >= 2;
  }

  reset() {
    this.priceObjectionCount = 0;
    this.isSenior = false;
    this.isVeteran = false;
  }
}

module.exports = DiscountRules;
