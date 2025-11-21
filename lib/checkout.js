import crypto from 'crypto';
import { createCheckoutTokenDoc, getCheckoutTokenDoc } from '../firestore.js';

const CHECKOUT_TOKEN_SECRET = process.env.CHECKOUT_TOKEN_SECRET || '';
const BASE_URL = process.env.BASE_URL || '';
// Default TTL: 30 minutes
const CHECKOUT_TOKEN_TTL_MS = parseInt(process.env.CHECKOUT_TOKEN_TTL_MS || '1800000', 10);

// Legacy HMAC-based helpers (still used by existing code paths)
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

export async function buildCheckoutUrl(waId) {
  const base = (BASE_URL || '').replace(/\/$/, '');
  // New model: use a random, stored token. Fallback to legacy HMAC if creation fails.
  let token;
  try {
    token = await createCheckoutToken(waId);
  } catch (_) {
    token = makeCheckoutToken(waId);
  }
  if (!base) return `/checkout/?u=${encodeURIComponent(waId)}&t=${token}`;
  return `${base}/checkout/?u=${encodeURIComponent(waId)}&t=${token}`;
}

// --- New infrastructure for random, short-lived checkout tokens ---

/**
 * Create and persist a random checkout token for the given waId.
 * Does not yet affect existing callers; wiring will happen in a later step.
 */
export async function createCheckoutToken(waId) {
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const expiresAt = new Date(now + CHECKOUT_TOKEN_TTL_MS).toISOString();

  try {
    await createCheckoutTokenDoc(token, waId, expiresAt);
    console.log('CREATE_CHECKOUT_TOKEN_OK', { waId, token, expiresAt });
  } catch (e) {
    console.error('CREATE_CHECKOUT_TOKEN_ERROR', { waId, error: String(e) });
    // If session persistence fails, we still return a token, but
    // callers should treat failures conservatively when wiring this.
  }

  return token;
}

/**
 * Get the status of a checkout token for a given waId.
 * Returns one of: 'ok', 'invalid', 'expired', 'used', or 'no_session'.
 * This is an async helper for future API enforcement; not used yet by routes.
 */
export async function getCheckoutTokenStatus(waId, token) {
  try {
    if (!token) return 'invalid';
    const doc = await getCheckoutTokenDoc(token);
    if (!doc) {
      console.log('CHECKOUT_TOKEN_STATUS_NO_DOC', { waId, token });
      return 'no_session';
    }

    if (doc.wa_id !== waId) {
      console.log('CHECKOUT_TOKEN_STATUS_WA_MISMATCH', { waId, token, docWaId: doc.wa_id });
      return 'invalid';
    }

    if (doc.used_at) {
      console.log('CHECKOUT_TOKEN_STATUS_USED', { waId, token, usedAt: doc.used_at });
      return 'used';
    }

    const exp = (doc.expires_at || '').toString();
    if (exp) {
      const expMs = Date.parse(exp);
      if (!Number.isNaN(expMs) && expMs < Date.now()) {
        console.log('CHECKOUT_TOKEN_STATUS_EXPIRED', { waId, token, exp });
        return 'expired';
      }
    }

    console.log('CHECKOUT_TOKEN_STATUS_OK', { waId, token, exp: doc.expires_at });
    return 'ok';
  } catch (e) {
    console.error('CHECKOUT_TOKEN_STATUS_ERROR', { waId, token, error: String(e) });
    return 'invalid';
  }
}
