import { Firestore } from '@google-cloud/firestore';
import { getOrCreateMediaIdForGcsPath } from './media.js';
import { sendImageByMediaId } from './wa.js';

const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
const adminDb = new Firestore({ projectId });

async function getCheapestIndianHeroProducts(limit = 4) {
  try {
    const typeDoc = await adminDb.collection('products_by_type').doc('indian').get();
    const data = typeDoc.exists ? (typeDoc.data() || {}) : {};
    const items = Array.isArray(data.items) ? data.items : [];
    const prods = [];
    for (const it of items) {
      if (!it) continue;
      const rawSku = (it.sku || '').toString();
      if (!rawSku) continue;
      const sku = rawDataToSku(rawSku);
      try {
        const doc = await adminDb.collection('products').doc(sku).get();
        if (!doc.exists) continue;
        const p = doc.data() || {};
        const images = Array.isArray(p.images) ? p.images : [];
        const heroIdx = Number.isInteger(p.hero_image_index) ? p.hero_image_index : 0;
        const hero = images[heroIdx] || '';
        if (!hero) continue;
        const price = Number(p.price || 0) || 0;
        const currency = (p.currency || 'INR').toString();
        const title = (p.title || rawSku.toUpperCase()).toString();
        prods.push({ title, price, currency, hero });
      } catch (e) {
        console.error('reengage.getCheapestIndianHeroProducts: product fetch error', { sku, error: e });
      }
    }
    prods.sort((a, b) => (a.price || 0) - (b.price || 0));
    return prods.slice(0, limit);
  } catch (e) {
    console.error('reengage.getCheapestIndianHeroProducts error', e);
    return [];
  }
}

function rawDataToSku(raw) {
  return String(raw).toLowerCase();
}

export async function reengageWebNoOrderUsers(sendCheckoutLink, { limit = 4 } = {}) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  const snap = await adminDb.collection('sessions')
    .where('state', '==', 'web_checkout')
    .get();

  const heroProds = await getCheapestIndianHeroProducts(limit);
  if (!heroProds.length) {
    console.warn('reengageWebNoOrderUsers: no hero products found for Indian type');
  }

  const batch = adminDb.batch();
  let processed = 0;

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (data.web_reengaged === true) continue;
    const updatedAtRaw = (data.updated_at || '').toString();
    if (!updatedAtRaw || updatedAtRaw < (cutoffIso)) continue;

    const waUserId = doc.id;

    // Skip if any order exists for this wa_user_id
    const ordSnap = await adminDb.collection('orders')
      .where('wa_user_id', '==', waUserId)
      .limit(1)
      .get();
    if (!ordSnap.empty) continue;

    // First: send hero images (if available)
    if (heroProds.length) {
      for (const p of heroProds) {
        const gcsPath = (p.hero || '').toString();
        if (!gcsPath || !gcsPath.startsWith('gs://')) continue;
        try {
          const mediaId = await getOrCreateMediaIdForGcsPath(gcsPath);
          const caption = `${p.title}\nPrice: ${p.price} ${p.currency}`;
          await sendImageByMediaId(waUserId, mediaId, caption);
        } catch (e) {
          console.error('reengageWebNoOrderUsers: failed to send hero image', { waUserId, gcsPath, error: e });
        }
      }
    }

    // Small delay before sending the checkout message so images land first.
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (_) {}

    try {
      await sendCheckoutLink(waUserId);
    } catch (e) {
      console.error('reengageWebNoOrderUsers: sendCheckoutLink failed', { waUserId, error: e });
    }

    batch.set(doc.ref, { web_reengaged: true, web_reengaged_at: now.toISOString() }, { merge: true });
    processed++;
  }

  if (processed > 0) {
    await batch.commit();
  }

  return { processed };
}

export async function reengageCartNoOrderUsers(sendCheckoutLink) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  const snap = await adminDb.collection('carts')
    .where('updated_at', '>=', cutoffIso)
    .get();

  const batch = adminDb.batch();
  let processed = 0;

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (data.cart_reengaged === true) continue;
    
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) continue;

    const waUserId = doc.id;
    const cartUpdatedAt = (data.updated_at || '').toString();
    if (!cartUpdatedAt || cartUpdatedAt < cutoffIso) continue;

    // Check if an order was placed AFTER the cart was last updated
    // This ensures we only skip if the current cart items might have been ordered
    // (User may have past orders, but we only care about orders placed after cart was updated)
    const ordSnap = await adminDb.collection('orders')
      .where('wa_user_id', '==', waUserId)
      .get();
    
    // Filter in code to find orders created after cart was updated
    let hasRecentOrder = false;
    for (const ordDoc of ordSnap.docs) {
      const ordData = ordDoc.data() || {};
      const orderCreatedAt = (ordData.created_at || '').toString();
      if (orderCreatedAt && orderCreatedAt > cartUpdatedAt) {
        hasRecentOrder = true;
        break;
      }
    }
    if (hasRecentOrder) continue;

    // Send checkout link (no hero images for cart re-engagement)
    try {
      await sendCheckoutLink(waUserId);
    } catch (e) {
      console.error('reengageCartNoOrderUsers: sendCheckoutLink failed', { waUserId, error: e });
    }

    batch.set(doc.ref, { cart_reengaged: true, cart_reengaged_at: now.toISOString() }, { merge: true });
    processed++;
  }

  if (processed > 0) {
    await batch.commit();
  }

  return { processed };
}


