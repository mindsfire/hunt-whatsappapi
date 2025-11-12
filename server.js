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

// --- Admin: Sync catalog from Google Sheets ---
// Usage: GET /admin/sync-catalog-from-sheets?sheetId=...&range=Catalog!A1:Z&mode=dry-run|commit
app.get('/admin/sync-catalog-from-sheets', async (req, res) => {
  try {
    if (SYNC_SHARED_SECRET) {
      const token = req.get('X-Shared-Secret') || '';
      if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
    }
    const sheetId = (req.query.sheetId || '').toString().trim();
    const range = (req.query.range || 'Catalog!A1:Z').toString().trim();
    const mode = (req.query.mode || 'dry-run').toString();
    if (!sheetId) return res.status(400).json({ ok: false, error: 'sheetId required' });

    const auth = await google.auth.getClient({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const g = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    const values = g.data.values || [];
    if (values.length < 2) return res.status(200).json({ ok: false, error: 'No data rows found (need header + at least one row).' });
    const header = values[0].map(h => (h || '').toString().trim());

    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      const obj = {};
      for (let c = 0; c < header.length; c++) {
        const key = header[c];
        if (!key) continue;
        obj[key.replace(/\s+/g, '_').toLowerCase()] = r[c];
      }
      if (Object.keys(obj).length) rows.push(obj);
    }

    const { errors, upserts } = validateRows(rows);
    if (mode === 'commit' && errors.length === 0) {
      await upsertCatalogItems(upserts);
    }
    return res.status(200).json({ ok: true, mode, upsertCount: upserts.length, errorCount: errors.length, errors });
  } catch (e) {
    console.error('sync-catalog-from-sheets error', e);
    return res.status(200).json({ ok: false, error: String(e) });
  }
});

// --- Admin: Export products as CSV for pricing seeding ---
app.get('/admin/export-products-csv', async (req, res) => {
  try {
    if (SYNC_SHARED_SECRET) {
      const token = req.get('X-Shared-Secret') || '';
      if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
    }
    // Read all products
    const snap = await adminDb.collection('products').get();
    const rows = [];
    function esc(v) {
      const s = (v === undefined || v === null) ? '' : String(v);
      if (s.includes('"') || s.includes(',') || s.includes('\n')) return '"' + s.replaceAll('"', '""') + '"';
      return s;
    }
    rows.push(['SKU','Title','Type','Price','Currency','MOQ','Hero_URL','Image_Count','All_Images'].join(','));
    for (const d of snap.docs) {
      const p = d.data() || {};
      const sku = p.sku || d.id;
      const title = p.title || '';
      const type = p.type || '';
      const price = p.price || '';
      const currency = p.currency || 'INR';
      const moq = Number.isInteger(p.moq) ? p.moq : '';
      const images = Array.isArray(p.images) ? p.images : [];
      const heroIdx = Number.isInteger(p.hero_image_index) ? p.hero_image_index : 0;
      const hero = images[heroIdx] || '';
      const all = images.join(' ');
      rows.push([esc(sku), esc(title), esc(type), esc(price), esc(currency), esc(moq), esc(hero), esc(images.length), esc(all)].join(','));
    }
    const csv = rows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="products_export.csv"');
    return res.status(200).send(csv);
  } catch (e) {
    console.error('export-products-csv error', e);
    return res.status(200).json({ ok: false, error: String(e) });
  }
});

function nowIso() { return new Date().toISOString(); }

// --- Firestore-backed browse/detail (GCS indexed) ---
async function getTypes() {
  const doc = await adminDb.collection('config').doc('types').get();
  const data = doc.exists ? doc.data() : { types: ['indian','imported'] };
  return Array.isArray(data.types) && data.types.length ? data.types : ['indian','imported'];
}

async function showTypes(to) {
  const types = await getTypes();
  // If only two, send buttons; else send text list
  if (types.length <= 3) {
    const buttons = types.map(t => ({ type: 'reply', reply: { id: `type_${t}`, title: t.charAt(0).toUpperCase() + t.slice(1) } }));
    buttons.push({ type: 'reply', reply: { id: 'type_help', title: 'Help' } });
    return sendButtons(to, 'Choose a type to browse', buttons);
  }
  return sendText(to, `Available types:\n- ${types.join('\n- ')}\nReply with a type name (e.g., Indian).`);
}

async function getProductsByType(type) {
  const doc = await adminDb.collection('products_by_type').doc(type).get();
  return doc.exists ? (doc.data().items || []) : [];
}

async function showProductsPage(to, type, page = 0, pageSize = 3) {
  const items = await getProductsByType(type);
  if (!items.length) return sendText(to, `No products for type '${type}'. Reply 'types' to choose again.`);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = items.slice(p * pageSize, p * pageSize + pageSize);
  const header = `Products (${type}) page ${p + 1}/${totalPages}:`;
  // Check if user has items in cart to show 'View cart' button
  let hasCart = false;
  try {
    const cart = await dbGetCart(to);
    hasCart = Array.isArray(cart?.items) && cart.items.length > 0;
  } catch (_) {}
  for (const it of slice) {
    try {
      const sku = (it.sku || '').toLowerCase();
      const pd = await getProductDoc(sku);
      const imgs = Array.isArray(pd?.images) ? pd.images : [];
      const heroIdx = Number.isInteger(pd?.hero_image_index) ? pd.hero_image_index : 0;
      const heroPath = imgs[heroIdx];
      if (heroPath) {
        const mediaId = await getOrCreateMediaIdForGcsPath(heroPath);
        const cap = `${(it.sku || '').toUpperCase()}${it.title ? ' — ' + it.title : ''}`;
        await sendImageByMediaId(to, mediaId, cap);
        // Remember last shown SKU to interpret plain 'View'/'Add to cart'
        try {
          const s2 = await dbGetSession(to);
          s2.last_browse_sku = sku;
          await dbSaveSession(to, s2);
        } catch (_) {}
        // Add per-product quick actions
        const actions = [
          { type: 'reply', reply: { id: `view_${sku}`, title: 'View' } },
          { type: 'reply', reply: { id: `add_${sku}`, title: 'Add to cart' } }
        ];
        if (hasCart && actions.length < 3) {
          actions.push({ type: 'reply', reply: { id: 'cart_view', title: 'View cart' } });
        }
        await sendButtons(to, (it.title || 'Choose action'), actions);
      }
    } catch (_) {}
  }
  // Build interactive list rows to make selection easier
  const rows = slice.map(it => ({
    id: `view_${(it.sku || '').toLowerCase()}`,
    title: (it.sku || '').toUpperCase(),
    description: `${it.title || ''}`.trim() || `${it.image_count || 0} images`
  }));
  // WhatsApp list supports up to 10 rows. Our page size is <= 4, safe.
  await sendList(to, header, 'Choose SKU', `Page ${p + 1}`, rows);
  // Add paging buttons for easier navigation
  {
    const pageBtns = [
      { type: 'reply', reply: { id: 'page_prev', title: 'Prev' } },
      { type: 'reply', reply: { id: 'page_next', title: 'Next' } },
      { type: 'reply', reply: { id: 'page_types', title: 'Types' } }
    ];
    if (hasCart && pageBtns.length < 3) {
      // Note: buttons max 3; if we already have 3, skip adding cart here
    } else if (hasCart) {
      // Replace 'Types' with 'View cart' to stay within 3 buttons
      pageBtns[2] = { type: 'reply', reply: { id: 'cart_view', title: 'View cart' } };
    }
    await sendButtons(to, `Page ${p + 1}/${totalPages}`, pageBtns);
  }
  // Follow-up instructions (text fallback)
  return sendText(to, "Tip: Use buttons for paging. You can also type 'next'/'prev' or 'view <SKU>'.");
}

async function getProductDoc(sku) {
  const doc = await adminDb.collection('products').doc((sku || '').toLowerCase()).get();
  return doc.exists ? doc.data() : null;
}

async function showProductDetail(to, sku, sess) {
  const p = await getProductDoc(sku);
  if (!p) return sendText(to, `Unknown SKU ${sku}. Reply 'browse' to list again.`);
  const images = Array.isArray(p.images) ? p.images : [];
  if (!images.length) return sendText(to, `${sku}: No images.`);
  const heroIdx = Number.isInteger(p.hero_image_index) ? p.hero_image_index : 0;
  const heroPath = images[heroIdx];
  const caption = `${sku}${p.title ? ' | ' + p.title : ''}\nImages: ${images.length}\nReply 'more images' to see more, or 'add ${sku} <QTY>' to add to cart.`;
  try {
    const mediaId = await getOrCreateMediaIdForGcsPath(heroPath);
    await sendImageByMediaId(to, mediaId, caption);
  } catch (e) {
    console.error('detail send hero error', e);
    await sendText(to, `${caption}\n(Preview unavailable)`);
  }
  // prepare for more images
  sess.selected_product = sku;
  sess.images_offset = 0; // next batch starts from first non-hero index
  await dbSaveSession(to, sess);
}

async function sendMoreImages(to, sess) {
  const sku = sess.selected_product;
  if (!sku) return sendText(to, 'No product selected. Use view <SKU>.');
  const p = await getProductDoc(sku);
  if (!p || !Array.isArray(p.images) || !p.images.length) return sendText(to, 'No more images.');
  const heroIdx = Number.isInteger(p.hero_image_index) ? p.hero_image_index : 0;
  // Build list excluding hero
  const rest = p.images.filter((_, idx) => idx !== heroIdx);
  const start = sess.images_offset || 0;
  const end = Math.min(rest.length, start + MEDIA_BATCH_SIZE);
  if (start >= rest.length) return sendText(to, 'No more images.');
  const batch = rest.slice(start, end);
  for (const gcsPath of batch) {
    try {
      const mediaId = await getOrCreateMediaIdForGcsPath(gcsPath);
      await sendImageByMediaId(to, mediaId);
    } catch (e) {
      console.error('more images send error', e);
    }
  }
  sess.images_offset = end;
  await dbSaveSession(to, sess);
  if (end < rest.length) {
    return sendText(to, `Sent ${batch.length}. Reply 'more images' for more.`);
  } else {
    return sendText(to, 'All images sent.');
  }
}

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
async function sendList(to, bodyText, buttonText, sectionTitle, rows) {
  return waSend({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonText || 'Select',
        sections: [
          {
            title: sectionTitle || 'Options',
            rows
          }
        ]
      }
    }
  });
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

  let lower = (text || '').trim().toLowerCase();
  // Map interactive list/button reply IDs to commands (e.g., view_<sku>)
  try {
    if (rawMsg && rawMsg.type === 'interactive' && rawMsg.interactive) {
      const it = rawMsg.interactive;
      const id = (it.button_reply && it.button_reply.id) || (it.list_reply && it.list_reply.id) || '';
      if (id && typeof id === 'string') {
        const idLower = id.toLowerCase();
        if (idLower.startsWith('view_')) {
          const sku = idLower.slice(5);
          lower = `view ${sku}`;
        } else if (idLower.startsWith('add_')) {
          const sku = idLower.slice(4);
          lower = `add ${sku} 1`;
        } else if (idLower.startsWith('type_')) {
          // Normalize type selection
          const t = idLower.slice(5);
          lower = t; // 'indian' or 'imported' or 'help'
        } else if (idLower.startsWith('mode_')) {
          lower = idLower; // handled in ask_mode
        } else if (idLower === 'page_prev') {
          lower = 'prev';
        } else if (idLower === 'page_next') {
          lower = 'next';
        } else if (idLower === 'page_types') {
          lower = 'types';
        } else if (idLower === 'cart_view') {
          lower = 'cart';
        }
      }
    }
  } catch (_) {}

  if ((lower === 'view' || lower === 'add to cart' || lower === 'add') && sess.last_browse_sku) {
    if (lower === 'view') lower = `view ${sess.last_browse_sku}`;
    else lower = `add ${sess.last_browse_sku} 1`;
  }

  // Global escape routes to avoid getting stuck
  if (lower === 'types' || lower === 'type') {
    sess.state = 'types';
    await dbSaveSession(waUserId, sess);
    return showTypes(to);
  }
  if (lower === 'browse' || lower === 'catalog') {
    // If we know the type, reopen browse
    if (sess.type) {
      sess.state = 'browse';
      sess.page = sess.page || 0;
      await dbSaveSession(waUserId, sess);
      return showProductsPage(to, sess.type, sess.page);
    }
  }
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
      sess.state = 'types';
      await dbSaveSession(waUserId, sess);
      return showTypes(to);
    }
    if (lower.includes('retail') || lower.includes('mode_retail')) {
      // B2B gate: we serve wholesale only. Confirm buyer is B2B.
      sess.mode = 'retail';
      sess.state = 'b2b_gate';
      await dbSaveSession(waUserId, sess);
      return sendButtons(to, 'We currently serve Wholesale buyers. Are you buying for a business/resale?', [
        { type: 'reply', reply: { id: 'b2b_no', title: 'No' } },
        { type: 'reply', reply: { id: 'b2b_yes', title: 'I am Wholeseller' } }
      ]);
    }
    return sendText(to, 'Please choose Wholesale or Retail.');
  }

  // B2B gate confirmation
  if (sess.state === 'b2b_gate') {
    if (lower.includes('b2b_yes') || lower === 'yes' || lower.includes('yes')) {
      sess.mode = 'wholesale';
      sess.state = 'types';
      await dbSaveSession(waUserId, sess);
      return showTypes(to);
    }
    if (lower.includes('b2b_no') || lower === 'no') {
      sess.state = 'start';
      await dbSaveSession(waUserId, sess);
      return sendText(to, "Thanks for your interest! We currently sell to businesses only. If you represent a business, reply 'Wholesale' to continue.");
    }
    return sendButtons(to, 'Are you a Wholesale (business) buyer?', [
      { type: 'reply', reply: { id: 'b2b_no', title: 'No' } },
      { type: 'reply', reply: { id: 'b2b_yes', title: 'I am Wholeseller' } }
    ]);
  }

  // Choose type (indian/imported)
  if (sess.state === 'types') {
    if (lower.includes('indian') || lower === 'indian') {
      sess.type = 'indian';
      sess.page = 0;
      sess.state = 'browse';
      await dbSaveSession(waUserId, sess);
      return showProductsPage(to, sess.type, sess.page);
    }
    if (lower.includes('imported') || lower === 'imported') {
      sess.type = 'imported';
      sess.page = 0;
      sess.state = 'browse';
      await dbSaveSession(waUserId, sess);
      return showProductsPage(to, sess.type, sess.page);
    }
    // re-show types on any other input
    return showTypes(to);
  }

  if (sess.state === 'browse') {
    // Allow re-showing catalog on demand
    if (lower === 'types' || lower === 'type') {
      sess.state = 'types';
      await dbSaveSession(waUserId, sess);
      return showTypes(to);
    }
    if (lower === 'catalog' || lower === 'browse') {
      sess.page = 0;
      await dbSaveSession(waUserId, sess);
      return showProductsPage(to, sess.type || 'indian', sess.page);
    }
    if (lower === 'next') {
      sess.page = (sess.page || 0) + 1;
      await dbSaveSession(waUserId, sess);
      return showProductsPage(to, sess.type || 'indian', sess.page);
    }
    if (lower === 'prev' || lower === 'previous') {
      sess.page = Math.max(0, (sess.page || 0) - 1);
      await dbSaveSession(waUserId, sess);
      return showProductsPage(to, sess.type || 'indian', sess.page);
    }
    if (lower.startsWith('view ')) {
      const rawSku = (text || '').trim().slice(5).trim();
      const sku = rawSku ? rawSku.toLowerCase() : '';
      if (!sku) return sendText(to, "Usage: view <SKU>");
      sess.selected_product = sku;
      sess.images_offset = 0;
      sess.state = 'detail';
      await dbSaveSession(waUserId, sess);
      return showProductDetail(to, sku, sess);
    }
    if (lower.startsWith('add ')) {
      // format: add SKU QTY (SKU may be lowercase from products collection)
      const parts = lower.split(/\s+/);
      const skuRaw = (parts[1] || '').trim();
      const skuLower = skuRaw.toLowerCase();
      const skuUpper = skuRaw.toUpperCase();
      const qty = parseInt(parts[2] || '0', 10);
      if (!Number.isInteger(qty) || qty <= 0) return sendText(to, 'Please provide a valid quantity.');

      // Prefer products doc (new flow), fallback to legacy catalog
      let price = 0;
      let currency = 'INR';
      let moq = 1;
      let skuForCart = skuUpper; // store uppercase for readability
      const prod = await getProductDoc(skuLower);
      if (prod) {
        price = Number(prod.price || 0);
        currency = (prod.currency || 'INR').toUpperCase();
        moq = Number.isInteger(prod.moq) && prod.moq > 0 ? prod.moq : 1;
        // Fallback to catalog if product doc lacks valid price
        if (!Number.isFinite(price) || price <= 0) {
          const legacy = await getCatalogItem(skuUpper);
          if (legacy) {
            price = Number(legacy.price || 0);
            currency = (legacy.currency || currency || 'INR').toUpperCase();
            moq = Number.isInteger(legacy.moq) && legacy.moq > 0 ? legacy.moq : moq;
          }
        }
      } else {
        const legacy = await getCatalogItem(skuUpper);
        if (legacy) {
          price = Number(legacy.price || 0);
          currency = (legacy.currency || 'INR').toUpperCase();
          moq = Number.isInteger(legacy.moq) && legacy.moq > 0 ? legacy.moq : 1;
        } else {
          return sendText(to, 'Unknown SKU. Reply with SKU shown in the caption.');
        }
      }

      if (!Number.isFinite(price) || price <= 0) {
        return sendText(to, `Price not set for ${skuUpper}. Please update the catalog price and try again.`);
      }

      if (qty % moq !== 0) {
        const up = Math.ceil(qty / moq) * moq;
        const down = Math.floor(qty / moq) * moq;
        return sendText(to, `Quantity must be a multiple of ${moq}. Try ${down > 0 ? down : moq} or ${up}.`);
      }

      const cart = await dbGetCart(waUserId);
      cart.items = cart.items || [];
      const existing = cart.items.find(i => i.sku === skuForCart);
      if (existing) {
        existing.qty += qty;
        existing.unit_price = price || existing.unit_price;
        existing.currency = currency || existing.currency || 'INR';
      } else {
        cart.items.push({ sku: skuForCart, qty, unit_price: price, currency });
      }
      cart.currency = currency || cart.currency || 'INR';
      await dbSaveCart(waUserId, cart);
      await sendText(to, `Added ${qty} of ${skuForCart} to cart.`);
      return sendButtons(to, 'Next steps', [
        { type: 'reply', reply: { id: 'cart_view', title: 'View cart' } },
        { type: 'reply', reply: { id: 'checkout', title: 'Checkout' } }
      ]);
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
    return sendText(to, "Type 'view <SKU>' to see details, 'next'/'prev' to page, 'add <SKU> <QTY>' to add items, 'cart' to view, or 'checkout' to place order.");
  }

  // Detail state: show hero already sent; support more images and navigation
  if (sess.state === 'detail') {
    if (lower === 'more images' || lower === 'more' || lower === 'images') {
      return sendMoreImages(to, sess);
    }
    if (lower === 'browse' || lower === 'catalog') {
      sess.state = 'browse';
      await dbSaveSession(waUserId, sess);
      return showProductsPage(to, sess.type || 'indian', sess.page || 0);
    }
    if (lower === 'next') {
      sess.page = (sess.page || 0) + 1;
      sess.state = 'browse';
      await dbSaveSession(waUserId, sess);
      return showProductsPage(to, sess.type || 'indian', sess.page || 0);
    }
    if (lower === 'prev' || lower === 'previous') {
      sess.page = Math.max(0, (sess.page || 0) - 1);
      sess.state = 'browse';
      await dbSaveSession(waUserId, sess);
      return showProductsPage(to, sess.type || 'indian', sess.page || 0);
    }
    if (lower.startsWith('view ')) {
      const rawSku2 = (text || '').trim().slice(5).trim();
      const sku2 = rawSku2 ? rawSku2.toLowerCase() : '';
      if (!sku2) return sendText(to, "Usage: view <SKU>");
      sess.selected_product = sku2;
      sess.images_offset = 0;
      await dbSaveSession(waUserId, sess);
      return showProductDetail(to, sku2, sess);
    }
    // Default help in detail
    return sendText(to, "Reply 'more images' for more, 'browse' to go back, or 'types' to change category.");
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
    // image_url is optional in the new flow; products images come from GCS indexer
    const title = (r.title || '').toString().trim();
    const active = !!(r.active === true || r.active === 'TRUE' || r.active === 'true' || r.active === 1);
    const base = { sku, title, category: r.category || '', price, currency, moq, sizes: r.sizes || [], colors: r.colors || [], active, updated_at: nowIso() };
    const up = image_url ? { ...base, image_url } : base;
    upserts.push(up);
  }
  return { errors, upserts };
}

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
