// validator.js — enforce strict payment input rules

'use strict';

function validateCard(cardNumber, cvv, expMonth, expYear, type) {
  if (!cardNumber || !cvv || !expMonth || !expYear) return { ok: false, reason: 'missing_fields' };

  const digitsOnly = cardNumber.replace(/\D/g, '');
  const cvvDigits = cvv.replace(/\D/g, '');

  switch (type.toLowerCase()) {
    case 'visa':
    case 'mastercard':
    case 'discover':
      if (digitsOnly.length !== 16) return { ok: false, reason: 'card_length' };
      if (cvvDigits.length !== 3) return { ok: false, reason: 'cvv_length' };
      break;
    case 'amex':
      if (digitsOnly.length !== 15) return { ok: false, reason: 'card_length' };
      if (cvvDigits.length !== 4) return { ok: false, reason: 'cvv_length' };
      break;
    default:
      return { ok: false, reason: 'unsupported_type' };
  }
  return { ok: true };
}

function validateBank(routing, account, checkNumber) {
  if (!routing || !account || !checkNumber) return { ok: false, reason: 'missing_fields' };
  if (!/^\d{9}$/.test(routing)) return { ok: false, reason: 'routing_invalid' };
  if (!/^\d{7,12}$/.test(account)) return { ok: false, reason: 'account_invalid' };
  if (!/^\d+$/.test(checkNumber)) return { ok: false, reason: 'check_invalid' };
  return { ok: true };
}

module.exports = { validateCard, validateBank };
