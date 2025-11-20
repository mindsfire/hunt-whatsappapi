import crypto from 'crypto';

const CHECKOUT_TOKEN_SECRET = process.env.CHECKOUT_TOKEN_SECRET || '';
const BASE_URL = process.env.BASE_URL || '';

export function makeCheckoutToken(waId) {
  if (!CHECKOUT_TOKEN_SECRET) return 'dev';
  return crypto.createHmac('sha256', CHECKOUT_TOKEN_SECRET).update(String(waId)).digest('hex');
}

export function verifyCheckoutToken(waId, token) {
  if (!CHECKOUT_TOKEN_SECRET) return true;
  try {
    const expected = makeCheckoutToken(waId);
    return token === expected;
  } catch (_) { return false; }
}

export function buildCheckoutUrl(waId) {
  const base = (BASE_URL || '').replace(/\/$/, '');
  const token = makeCheckoutToken(waId);
  if (!base) return `/checkout/?u=${encodeURIComponent(waId)}&t=${token}`;
  return `${base}/checkout/?u=${encodeURIComponent(waId)}&t=${token}`;
}
