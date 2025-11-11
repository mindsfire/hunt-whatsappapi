import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import process from 'process';
import { google } from 'googleapis';
import { Storage } from '@google-cloud/storage';
import { Firestore } from '@google-cloud/firestore';
import {
  initDb,
  getSession as dbGetSession,
  saveSession as dbSaveSession,
  getCart as dbGetCart,
  saveCart as dbSaveCart,
  clearCart as dbClearCart,
  upsertCatalogItems,
  listCatalog,
  getCatalogItem,
  createOrderDoc
} from './firestore.js';

const app = express();

// Capture raw body for signature verification
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- Config ---
const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || '';
const WA_TOKEN = process.env.WA_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || '';
const WA_APP_SECRET = process.env.WA_APP_SECRET || '';
const SYNC_SHARED_SECRET = process.env.SYNC_SHARED_SECRET || '';
const SALES_SHEET_ID = process.env.SALES_SHEET_ID || '';
// Media/GCS/WhatsApp media upload
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || '';
const MEDIA_BASE_PREFIX = (process.env.MEDIA_BASE_PREFIX || '').replace(/^\/+|\/+$|^\.$/g, ''); // e.g. 'media'
const MEDIA_HERO_SUFFIX = process.env.MEDIA_HERO_SUFFIX || '-1.jpg';
const MEDIA_BATCH_SIZE = parseInt(process.env.MEDIA_BATCH_SIZE || '3', 10);
const WA_WABA_ID = process.env.WA_WABA_ID || '';

// --- Firestore init ---
initDb();
const adminDb = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT });

function nowIso() { return new Date().toISOString(); }

// --- WhatsApp helpers ---
function waApiUrl() { return `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`; }
async function waSend(payload) {
  const res = await fetch(waApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WA_TOKEN}`
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) console.error('WA send error', res.status, text);
  return { status: res.status, text };
}
async function sendText(to, body) {
  return waSend({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
}
async function sendButtons(to, text, buttons) {
  return waSend({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text }, action: { buttons } } });
}
async function sendImage(to, imageUrl, caption = '') {
  return waSend({ messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption } });
}
async function sendImageByMediaId(to, mediaId, caption = '') {
  return waSend({ messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption } });
}

// --- GCS + WhatsApp media upload helpers ---
const storage = new Storage();
function normalizeGcsPath(p) {
  if (!p) return { bucket: '', name: '' };
  if (p.startsWith('gs://')) {
    const rest = p.slice('gs://'.length);
    const firstSlash = rest.indexOf('/');
    const b = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
    const name = firstSlash === -1 ? '' : rest.slice(firstSlash + 1);
    return { bucket: b, name };
  }
  // treat as object name under configured bucket/prefix
  const base = MEDIA_BASE_PREFIX ? `${MEDIA_BASE_PREFIX}/` : '';
  return { bucket: MEDIA_BUCKET, name: `${base}${p}` };
}

async function getGcsBytes(gcsPathOrObjectName) {
  const { bucket, name } = normalizeGcsPath(gcsPathOrObjectName);
  if (!bucket || !name) throw new Error('Invalid GCS path/object name');
  const file = storage.bucket(bucket).file(name);
  const [buf] = await file.download();
  // try infer mime from extension
  const lower = name.toLowerCase();
  const mime = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  const filename = name.split('/').pop() || 'image.jpg';
  return { buf, mime, filename };
}

function waMediaUploadUrl() {
  if (!PHONE_NUMBER_ID) throw new Error('WA_PHONE_NUMBER_ID not set');
  // Cloud API: upload media to the sender phone number's media edge
  return `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`;
}

async function uploadMediaToWA({ buf, mime, filename }) {
  // Node 18+: global FormData and Blob are available
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buf], { type: mime }), filename);
  const res = await fetch(waMediaUploadUrl(), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
    body: form
  });
  let bodyText = '';
  let json = null;
  try {
    bodyText = await res.text();
    json = JSON.parse(bodyText);
  } catch (_) {
    // leave json as null and keep raw text
  }
  if (!res.ok) {
    const errPayload = json || { error_text: bodyText };
    console.error('WA media upload error', res.status, errPayload);
    throw new Error(`WA media upload failed: ${res.status} ${JSON.stringify(errPayload)}`);
  }
  const mediaId = json && json.id ? json.id : null;
  if (!mediaId) throw new Error(`WA media upload returned no id: ${bodyText}`);
  return mediaId; // media_id
}

// Cache utilities in Firestore
import { getMediaCache, setMediaCache } from './firestore.js';

async function getOrCreateMediaIdForGcsPath(gcsPathOrObjectName) {
  const key = gcsPathOrObjectName.startsWith('gs://') ? gcsPathOrObjectName : `${MEDIA_BUCKET}/${MEDIA_BASE_PREFIX ? MEDIA_BASE_PREFIX + '/' : ''}${gcsPathOrObjectName}`;
  const cached = await getMediaCache(key);
  if (cached && cached.media_id) return cached.media_id;
  const payload = await getGcsBytes(gcsPathOrObjectName);
  const media_id = await uploadMediaToWA(payload);
  await setMediaCache(key, { media_id, mime: payload.mime, filename: payload.filename, uploaded_at: nowIso() });
  return media_id;
}

// --- Admin: public test to send one image by GCS path via media_id cache ---
app.post('/admin/test-media', async (req, res) => {
  try {
    if (SYNC_SHARED_SECRET) {
      const token = req.get('X-Shared-Secret') || '';
      if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
    }
    const to = (req.body?.to || '').toString().trim();
    const gcsPath = (req.body?.gcsPath || '').toString().trim(); // e.g., 'indian/ns-shorts/ns-s-1.jpg' or 'gs://bucket/media/indian/...'
    if (!to || !gcsPath) return res.status(400).json({ ok: false, error: 'to and gcsPath required' });
    const mediaId = await getOrCreateMediaIdForGcsPath(gcsPath);
    const r = await sendImageByMediaId(to, mediaId, 'Test image');
    return res.status(200).json({ ok: true, mediaId, result: r });
  } catch (e) {
    console.error('test-media error', e);
    return res.status(200).json({ ok: false, error: String(e) });
  }
});

// --- Admin: GCS indexer to Firestore ---
app.post('/admin/reindex-gcs', async (req, res) => {
  try {
    if (SYNC_SHARED_SECRET) {
      const token = req.get('X-Shared-Secret') || '';
      if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
    }
    const bucket = storage.bucket(MEDIA_BUCKET);
    const base = MEDIA_BASE_PREFIX ? `${MEDIA_BASE_PREFIX}/` : '';

    async function listPrefixes(prefix) {
      const [files, , apiResponse] = await bucket.getFiles({ prefix, delimiter: '/' });
      return (apiResponse?.prefixes || []).map(p => p);
    }
    async function listFiles(prefix) {
      const [files] = await bucket.getFiles({ prefix });
      return files.map(f => f.name);
    }
    function lastSegment(path) {
      const s = path.endsWith('/') ? path.slice(0, -1) : path;
      const i = s.lastIndexOf('/');
      return i >= 0 ? s.slice(i + 1) : s;
    }
    function toGsPath(objectName) {
      return `gs://${MEDIA_BUCKET}/${objectName}`;
    }
    function isImage(name) {
      const l = name.toLowerCase();
      return (l.endsWith('.jpg') || l.endsWith('.jpeg') || l.endsWith('.png') || l.endsWith('.webp')) && !l.endsWith('/.ds_store');
    }

    // Discover types
    const typePrefixes = await listPrefixes(base);
    const types = typePrefixes.map(p => lastSegment(p));

    const batchWrites = [];
    const productsByType = {};

    for (const type of types) {
      const skuPrefixes = await listPrefixes(`${base}${type}/`);
      const itemsForType = [];
      for (const skuPrefix of skuPrefixes) {
        const sku = lastSegment(skuPrefix);
        const objectNames = (await listFiles(`${skuPrefix}`)).filter(isImage);
        // filter only direct children (no deeper levels)
        const direct = objectNames.filter(n => n.split('/').length === skuPrefix.split('/').length);
        const images = (direct.length ? direct : objectNames)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map(toGsPath);
        if (images.length === 0) continue;
        // hero index: prefer *-1.*
        let heroIdx = 0;
        const suffix = MEDIA_HERO_SUFFIX || '-1.jpg';
        const idx = images.findIndex(u => u.toLowerCase().includes(suffix.replace(/^\./, '').toLowerCase().split('.jpg')[0]));
        if (idx >= 0) heroIdx = idx;

        // Write product doc
        const prodDoc = {
          sku,
          type,
          title: sku, // placeholder; can be updated later via CSV/Sheet
          category: '',
          images,
          hero_image_index: heroIdx,
          active: true,
          created_at: nowIso(),
          updated_at: nowIso()
        };
        batchWrites.push({ kind: 'product', data: prodDoc });
        itemsForType.push({ sku, title: prodDoc.title, hero_url: images[heroIdx], image_count: images.length });
      }
      productsByType[type] = itemsForType;
    }

    // Commit writes
    const batch = adminDb.batch();
    // products
    for (const w of batchWrites) {
      if (w.kind === 'product') {
        const ref = adminDb.collection('products').doc(w.data.sku);
        batch.set(ref, w.data, { merge: true });
      }
    }
    // products_by_type
    for (const [type, items] of Object.entries(productsByType)) {
      const ref = adminDb.collection('products_by_type').doc(type);
      batch.set(ref, { type, items, updated_at: nowIso() }, { merge: true });
    }
    // config/types
    const cfgRef = adminDb.collection('config').doc('types');
    batch.set(cfgRef, { types, updated_at: nowIso() }, { merge: true });

    await batch.commit();

    return res.status(200).json({ ok: true, types, counts: Object.fromEntries(Object.entries(productsByType).map(([k,v]) => [k, v.length])) });
  } catch (e) {
    console.error('reindex-gcs error', e);
    return res.status(200).json({ ok: false, error: String(e) });
  }
});

// --- Signature verification ---
function verifySignature(req) {
  if (!WA_APP_SECRET) return true; // skip if not set
  const signature = req.get('X-Hub-Signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', WA_APP_SECRET).update(req.rawBody || Buffer.from('')).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// --- Health ---
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/', (req, res) => res.status(200).send('ok'));

// --- WhatsApp webhook verification ---
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- WhatsApp webhook receiver ---
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    if (!verifySignature(req)) return res.sendStatus(401);
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(200);

    for (const entry of body.entry || []) {
      for (const chg of entry.changes || []) {
        const value = chg.value || {};
        const msgs = value.messages || [];
        for (const m of msgs) {
          const from = m.from; // phone number
          const waUserId = from;
          const text = extractMessageText(m);
          await handleMessage(waUserId, text, m);
        }
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error('webhook error', e);
    return res.sendStatus(200);
  }
});

// Normalize incoming WhatsApp message text across types
function extractMessageText(m) {
  try {
    // Plain text
    if (m.text && typeof m.text.body === 'string') return m.text.body;
    // Legacy interactive button (older payloads)
    if (m.button && typeof m.button.text === 'string') return m.button.text;
    // New interactive types
    if (m.type === 'interactive' && m.interactive) {
      const it = m.interactive;
      if (it.type === 'button_reply' && it.button_reply) {
        // Prefer title, fallback to id
        return it.button_reply.title || it.button_reply.id || '';
      }
      if (it.type === 'list_reply' && it.list_reply) {
        return it.list_reply.title || it.list_reply.id || '';
      }
    }
  } catch (_) {}
  return '';
}

// --- Simple state machine ---
async function handleMessage(waUserId, text, rawMsg) {
  const to = waUserId;
  const sess = await dbGetSession(waUserId);

  const lower = (text || '').trim().toLowerCase();
  if (sess.state === 'start') {
    sess.state = 'ask_mode';
    await dbSaveSession(waUserId, sess);
    return sendButtons(to, 'Welcome! Are you buying Wholesale or Retail?', [
      { type: 'reply', reply: { id: 'mode_wholesale', title: 'Wholesale' } },
      { type: 'reply', reply: { id: 'mode_retail', title: 'Retail' } }
    ]);
  }

  if (sess.state === 'ask_mode') {
    if (lower.includes('wholesale') || lower.includes('mode_wholesale')) {
      sess.mode = 'wholesale';
      sess.state = 'browse';
      await dbSaveSession(waUserId, sess);
      return showCatalog(to);
    }
    if (lower.includes('retail') || lower.includes('mode_retail')) {
      sess.mode = 'retail';
      sess.state = 'browse';
      await dbSaveSession(waUserId, sess);
      return sendText(to, 'Retail flow is limited. Please browse items and ask for assistance.');
    }
    return sendText(to, 'Please choose Wholesale or Retail.');
  }

  if (sess.state === 'browse') {
    // Allow re-showing catalog on demand
    if (lower === 'catalog' || lower === 'browse' || lower.includes('wholesale')) {
      return showCatalog(to);
    }
    if (lower.startsWith('add ')) {
      // format: add SKU QTY
      const parts = lower.split(/\s+/);
      const sku = (parts[1] || '').toUpperCase();
      const qty = parseInt(parts[2] || '0', 10);
      const p = await getCatalogItem(sku);
      if (!p) return sendText(to, 'Unknown SKU. Reply with SKU shown in the caption.');
      if (!Number.isInteger(qty) || qty <= 0) return sendText(to, 'Please provide a valid quantity.');
      const moq = p.moq || 1;
      if (qty % moq !== 0) {
        const up = Math.ceil(qty / moq) * moq;
        const down = Math.floor(qty / moq) * moq;
        return sendText(to, `Quantity must be a multiple of ${moq}. Try ${down > 0 ? down : moq} or ${up}.`);
      }
      const cart = await dbGetCart(waUserId);
      cart.items = cart.items || [];
      cart.items.push({ sku, qty, unit_price: p.price, currency: p.currency || 'INR' });
      cart.currency = p.currency || cart.currency || 'INR';
      await dbSaveCart(waUserId, cart);
      return sendText(to, `Added ${qty} of ${sku} to cart.`);
    }
    if (lower === 'cart' || lower === 'view') {
      const cart = await dbGetCart(waUserId);
      const items = cart.items || [];
      const total = items.reduce((s, i) => s + i.qty * i.unit_price, 0);
      const lines = items.map(i => `• ${i.sku} x ${i.qty} = ${i.qty * i.unit_price}`);
      return sendText(to, ['Your cart:', ...lines, `Total: ${total}`].join('\n'));
    }
    if (lower === 'checkout') {
      sess.state = 'business';
      await dbSaveSession(waUserId, sess);
      return sendText(to, 'Please share your Business Name (reply: biz <name>).');
    }
    return sendText(to, "Type 'add <SKU> <QTY>' to add items, 'cart' to view, or 'checkout' to place order.");
  }

  if (sess.state === 'business') {
    let name = '';
    if (lower.startsWith('biz ')) {
      name = text.slice(4).trim();
    } else if ((text || '').trim().length > 0) {
      // Accept any free-text as business name
      name = (text || '').trim();
    }
    if (name) {
      sess.business = { name };
      sess.state = 'confirm';
      await dbSaveSession(waUserId, sess);
      const cart = await dbGetCart(waUserId);
      const total = (cart.items || []).reduce((s, i) => s + i.qty * i.unit_price, 0);
      return sendButtons(to, `Confirm order for ${name}? Total ${total}`, [
        { type: 'reply', reply: { id: 'confirm_yes', title: 'Confirm' } },
        { type: 'reply', reply: { id: 'confirm_no', title: 'Cancel' } }
      ]);
    }
    return sendText(to, 'Reply your Business Name (e.g., biz Mindsfire).');
  }

  if (sess.state === 'confirm') {
    if (lower.includes('confirm') || lower.includes('confirm_yes')) {
      const order = await createOrder(waUserId, sess);
      await dbSaveSession(waUserId, { state: 'start', mode: null, locale: 'en' });
      await dbClearCart(waUserId);
      await sendText(to, `Order placed! ID: ${order.id}`);
      return;
    }
    if (lower.includes('cancel') || lower.includes('confirm_no')) {
      await dbSaveSession(waUserId, { state: 'start', mode: null, locale: 'en' });
      return sendText(to, 'Order cancelled.');
    }
    return sendText(to, 'Please Confirm or Cancel.');
  }

  // fallback
  return sendText(to, 'Type any message to start.');
}

async function showCatalog(to) {
  let items = await listCatalog(3);
  if (!items || items.length === 0) {
    // seed demo items into Firestore once
    const seed = [
      { sku: 'TSHIRT-1001', title: 'Classic Cotton Tee', price: 249, currency: 'INR', moq: 10, image_url: 'https://picsum.photos/seed/t1/512/512', active: true, updated_at: nowIso() },
      { sku: 'KURTI-2001', title: 'Elegant Kurti', price: 699, currency: 'INR', moq: 5, image_url: 'https://picsum.photos/seed/k1/512/512', active: true, updated_at: nowIso() },
      { sku: 'JACKET-3001', title: 'Imported Jacket', price: 2499, currency: 'INR', moq: 2, image_url: 'https://picsum.photos/seed/j1/512/512', active: true, updated_at: nowIso() }
    ];
    await upsertCatalogItems(seed);
    items = await listCatalog(3);
  }
  for (const p of items) {
    await sendImage(to, p.image_url, `${p.sku} | ${p.title}\nPrice: ${p.price} ${p.currency}\nMOQ: ${p.moq}\nType 'add ${p.sku} <QTY>'`);
  }
  await sendText(to, "Reply 'add <SKU> <QTY>' to add items, 'cart' to view, or 'checkout' to place order.");
}

// --- Order creation & Sheet logging ---
async function createOrder(waUserId, sess) {
  const id = 'ORD-' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const order = {
    id,
    wa_user_id: waUserId,
    business: sess.business || {},
    // Pull items from persisted cart to ensure consistency
    items: (await dbGetCart(waUserId)).items || [],
    currency: ((await dbGetCart(waUserId)).items?.[0] && (await dbGetCart(waUserId)).items[0].currency) || 'INR',
    subtotal: ((await dbGetCart(waUserId)).items || []).reduce((s, i) => s + i.qty * i.unit_price, 0),
    created_at: nowIso()
  };
  // Persist to Firestore
  try { await createOrderDoc(order); } catch (e) { console.error('createOrderDoc error', e); }
  // Attempt to append to Google Sheet if configured
  try { await appendOrderToSheet(order); } catch (e) { console.error('appendOrderToSheet error', e); }
  return order;
}

async function appendOrderToSheet(order) {
  if (!SALES_SHEET_ID) return;
  const auth = await google.auth.getClient({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const row = [ order.created_at, order.id, order.wa_user_id, order.business.name || '', JSON.stringify(order.items), order.subtotal, order.currency, 'placed' ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SALES_SHEET_ID,
    range: 'Orders!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

// --- Catalog sync endpoint ---
app.post('/sync-catalog', async (req, res) => {
  try {
    if (SYNC_SHARED_SECRET) {
      const token = req.get('X-Shared-Secret') || '';
      if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
    }
    const mode = (req.query.mode || 'dry-run').toString();
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const { errors, upserts } = validateRows(rows);
    if (mode === 'commit' && errors.length === 0) {
      await upsertCatalogItems(upserts);
    }
    return res.status(200).json({ ok: true, mode, upsertCount: upserts.length, errorCount: errors.length, errors });
  } catch (e) {
    console.error('sync-catalog error', e);
    return res.status(200).json({ ok: false, error: String(e) });
  }
});

function validateRows(rows) {
  const errors = [];
  const upserts = [];
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const ctx = `row ${i+1}`;
    const sku = (r.sku || '').toString().trim().toUpperCase();
    if (!sku) { errors.push({ row: i+1, field: 'sku', error: 'required' }); continue; }
    if (seen.has(sku)) { errors.push({ row: i+1, field: 'sku', error: 'duplicate in request' }); continue; }
    seen.add(sku);
    const price = Number(r.price);
    if (!Number.isFinite(price) || price <= 0) { errors.push({ row: i+1, field: 'price', error: 'invalid' }); continue; }
    const currency = (r.currency || 'INR').toString().trim().toUpperCase();
    const moq = parseInt(r.moq || '1', 10);
    if (!Number.isInteger(moq) || moq <= 0) { errors.push({ row: i+1, field: 'moq', error: 'invalid' }); continue; }
    const image_url = (r.image_url || r.imageUrl || '').toString().trim();
    if (!image_url) { errors.push({ row: i+1, field: 'image_url', error: 'required' }); continue; }
    const title = (r.title || '').toString().trim();
    const active = !!(r.active === true || r.active === 'TRUE' || r.active === 'true' || r.active === 1);
    upserts.push({ sku, title, category: r.category || '', price, currency, moq, sizes: r.sizes || [], colors: r.colors || [], image_url, active, updated_at: nowIso() });
  }
  return { errors, upserts };
}

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
