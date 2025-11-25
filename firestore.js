import { Firestore } from '@google-cloud/firestore';

let db;

export function initDb() {
  // Emulator support: set FIRESTORE_EMULATOR_HOST=localhost:8080x and GOOGLE_CLOUD_PROJECT
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
  db = new Firestore({ projectId });
  return db;
}

function col(name) { return db.collection(name); }

// --- Sessions ---
export async function getSession(userId) {
  const doc = await col('sessions').doc(userId).get();
  return doc.exists ? doc.data() : { state: 'start', mode: null, locale: 'en', cart: [] };
}
export async function saveSession(userId, data) {
  const nowIso = new Date().toISOString();
  const payload = {
    ...data,
    // Preserve existing created_at if caller provided it; otherwise set it on first save.
    created_at: data && data.created_at ? data.created_at : nowIso,
    updated_at: nowIso,
  };
  await col('sessions').doc(userId).set(payload, { merge: true });
}

// --- Carts ---
export async function getCart(userId) {
  const doc = await col('carts').doc(userId).get();
  return doc.exists ? doc.data() : { items: [], currency: 'INR', updated_at: new Date().toISOString() };
}
export async function saveCart(userId, cart) {
  await col('carts').doc(userId).set({ ...cart, updated_at: new Date().toISOString() }, { merge: true });
}
export async function clearCart(userId) {
  await col('carts').doc(userId).delete().catch(() => {});
}

// --- Catalog ---
export async function upsertCatalogItems(items) {
  const batch = db.batch();
  for (const it of items) {
    const ref = col('catalog').doc(it.sku);
    batch.set(ref, it, { merge: true });
  }
  await batch.commit();
}
export async function listCatalog(limit = 3) {
  const snap = await col('catalog').where('active', '==', true).orderBy('updated_at', 'desc').limit(limit).get();
  return snap.docs.map(d => d.data());
}
export async function getCatalogItem(sku) {
  const doc = await col('catalog').doc(sku).get();
  return doc.exists ? doc.data() : null;
}

// --- Orders ---
export async function createOrderDoc(order) {
  const ref = col('orders').doc(order.id);
  await ref.set(order);
}

// --- Checkout tokens ---
// Stored separately from sessions to avoid races with session state machine.
// Doc ID is the token string.
export async function createCheckoutTokenDoc(token, waId, expiresAt) {
  const ref = col('checkout_tokens').doc(token);
  await ref.set({
    token,
    wa_id: waId,
    expires_at: expiresAt,
    used_at: null,
    created_at: new Date().toISOString()
  });
}

export async function getCheckoutTokenDoc(token) {
  const doc = await col('checkout_tokens').doc(token).get();
  return doc.exists ? doc.data() : null;
}

export async function markCheckoutTokenUsed(token) {
  try {
    const ref = col('checkout_tokens').doc(token);
    await ref.set({ used_at: new Date().toISOString() }, { merge: true });
  } catch (_) { }
}

// --- WhatsApp media cache ---
// key: hash or path string (we will use the full GCS path as key)
export async function getMediaCache(key) {
  const doc = await col('whatsapp_media_cache').doc(encodeKey(key)).get();
  return doc.exists ? doc.data() : null;
}
export async function setMediaCache(key, data) {
  await col('whatsapp_media_cache').doc(encodeKey(key)).set({ ...data, updated_at: new Date().toISOString() }, { merge: true });
}
function encodeKey(key) {
  // Firestore doc IDs cannot contain forward slashes, replace with a safe token
  return String(key).replaceAll('/', '__');
}

// --- Optional: products (for future GCS indexer) ---
export async function upsertProduct(prod) {
  const ref = col('products').doc(prod.sku);
  await ref.set({ ...prod, updated_at: new Date().toISOString() }, { merge: true });
}
export async function listProductsByType(type, limit = 10, startAfterTitle = null) {
  let q = col('products').where('type', '==', type).orderBy('title');
  if (startAfterTitle) q = q.startAfter(startAfterTitle);
  const snap = await q.limit(limit).get();
  return snap.docs.map(d => d.data());
}
