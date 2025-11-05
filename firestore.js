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
  await col('sessions').doc(userId).set({ ...data, updated_at: new Date().toISOString() }, { merge: true });
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
