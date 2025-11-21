import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import process from 'process';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { Storage } from '@google-cloud/storage';
import { Firestore } from '@google-cloud/firestore';
import { t } from './locales.js';
import { waSend, sendText, sendButtons, sendList, sendImage, sendImageByMediaId } from './lib/wa.js';
import { makeCheckoutToken, verifyCheckoutToken, buildCheckoutUrl } from './lib/checkout.js';
import { graphGet, fetchSets, fetchSetItems, fetchSetProductsDetailed, parsePriceToNumber } from './lib/graph.js';
import { getOrCreateMediaIdForGcsPath } from './lib/media.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerApiRoutes } from './routes/api.js';
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
const MEDIA_BASE_PREFIX = (process.env.MEDIA_BASE_PREFIX || '').replace(/^\/+|\/+$/g, ''); // e.g. 'media'
const MEDIA_HERO_SUFFIX = process.env.MEDIA_HERO_SUFFIX || '-1.jpg';
const MEDIA_BATCH_SIZE = parseInt(process.env.MEDIA_BATCH_SIZE || '3', 10);
const WA_WABA_ID = process.env.WA_WABA_ID || '';
const USE_WA_CATALOG = ((process.env.USE_WA_CATALOG || 'false').toString().toLowerCase() === 'true');
const WA_CATALOG_ID = process.env.WA_CATALOG_ID || '';
const WA_GRAPH_TOKEN = process.env.WA_GRAPH_TOKEN || process.env.WA_CATALOG_ACCESS_TOKEN || WA_TOKEN;
const SHOW_CATALOG_IMMEDIATELY = ((process.env.SHOW_CATALOG_IMMEDIATELY || 'false').toString().toLowerCase() === 'true');
const WA_SET_IMPORTED_ID = process.env.WA_SET_IMPORTED_ID || '';
const WA_SET_INDIAN_ID = process.env.WA_SET_INDIAN_ID || '';
const WA_SET_IMPORTED_NAME = process.env.WA_SET_IMPORTED_NAME || 'Imported brands';
const WA_SET_INDIAN_NAME = process.env.WA_SET_INDIAN_NAME || 'Indian brands';
const WA_IMPORTED_RETAILER_IDS = (process.env.WA_IMPORTED_RETAILER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const WA_INDIAN_RETAILER_IDS = (process.env.WA_INDIAN_RETAILER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const CHECKOUT_TOKEN_SECRET = process.env.CHECKOUT_TOKEN_SECRET || '';
const BASE_URL = process.env.BASE_URL || '';

// __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// helpers imported from ./lib/checkout.js

// Locale-specific yes/no keywords for intent recognition
// This keeps business logic independent of specific UI text and makes it easy to add locales.
const YES_NO_KEYWORDS = {
  en: {
    yes: ['yes', 'y', 'confirm'],
    no: ['no', 'n', 'cancel']
  },
  kn: {
    yes: ['ಹೌದು', 'ಸಮ್ಮತಿಸಿ'],
    no: ['ಇಲ್ಲ', 'ರದ್ದು']
  },
  ta: {
    yes: ['ஆம்', 'ஆமாம்'],
    no: ['இல்லை']
  },
  te: {
    yes: ['అవును'],
    no: ['కాదు']
  },
  hi: {
    yes: ['हाँ', 'हां'],
    no: ['नहीं']
  },
  ml: {
    yes: ['അതെ'],
    no: ['ഇല്ല']
  }
};

async function chooseCatalogEntryRetailerId() {
  // Prefer explicit env-configured IDs
  if (WA_IMPORTED_RETAILER_IDS.length) return WA_IMPORTED_RETAILER_IDS[0];
  if (WA_INDIAN_RETAILER_IDS.length) return WA_INDIAN_RETAILER_IDS[0];
  // Try sets (imported first)
  try {
    let setId = WA_SET_IMPORTED_ID;
    if (!setId) {
      const sets = await fetchSets();
      const found = sets.find(s => (s.name || '').toLowerCase() === (WA_SET_IMPORTED_NAME || '').toLowerCase());
      setId = (found && found.id) || '';
    }
    const ids = await fetchSetItems(setId).catch(() => []);
    if (ids && ids.length) return ids[0];
  } catch (_) { }
  try {
    let setId = WA_SET_INDIAN_ID;
    if (!setId) {
      const sets = await fetchSets();
      const found = sets.find(s => (s.name || '').toLowerCase() === (WA_SET_INDIAN_NAME || '').toLowerCase());
      setId = (found && found.id) || '';
    }
    const ids = await fetchSetItems(setId).catch(() => []);
    if (ids && ids.length) return ids[0];
  } catch (_) { }
  return '';
}

async function sendProductList(to, title, retailerIds) {
  try {
    const items = (retailerIds || []).slice(0, 30).map(id => ({ product_retailer_id: id }));
    if (!WA_CATALOG_ID || items.length === 0) {
      return sendText(to, `No products for ${title}.`);
    }
    const interactive = {
      type: 'product_list',
      header: { type: 'text', text: title },
      body: { text: 'Choose a product' },
      action: {
        catalog_id: WA_CATALOG_ID,
        sections: [{ title, product_items: items }]
      }
    };
    await waSend({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
    try {
      await new Promise(r => setTimeout(r, 1200));
      const ctaText = 'When you are ready, tap Checkout here to confirm and get an Order ID. If you already placed order in WhatsApp, tap the other button.';
      await sendButtons(to, ctaText, [
        { type: 'reply', reply: { id: 'checkout', title: 'Checkout' } },
        { type: 'reply', reply: { id: 'native_order', title: 'I placed order in WhatsApp' } }
      ]);
      await sendText(to, 'Tip: you can also reply "checkout" here to confirm, or "native order" if you already placed it in WhatsApp.');
      return;
    } catch (e2) {
      console.error('CTA after product_list failed', e2);
      return sendText(to, 'When ready, reply "checkout" here to confirm and get an Order ID. If you already placed an order in WhatsApp, reply "native order".');
    }
  } catch (e) {
    console.error('sendProductList error', e);
    return sendText(to, `No products for ${title}.`);
  }
}

async function sendProductListSections(to, sectionsMap) {
  try {
    if (!WA_CATALOG_ID) return sendText(to, 'No products available.');
    const sections = Object.entries(sectionsMap)
      .map(([title, ids]) => ({ title, product_items: (ids || []).slice(0, 30).map(id => ({ product_retailer_id: id })) }))
      .filter(s => s.product_items.length > 0)
      .slice(0, 10); // WA supports up to 10 sections
    if (!sections.length) return sendText(to, 'No products available.');
    const interactive = {
      type: 'product_list',
      header: { type: 'text', text: 'Our Catalog' },
      body: { text: 'Choose products' },
      action: { catalog_id: WA_CATALOG_ID, sections }
    };
    await waSend({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
    try {
      await new Promise(r => setTimeout(r, 400));
      const ctaText = 'When you are ready, tap Checkout here to confirm and get an Order ID. If you already placed order in WhatsApp, tap the other button.';
      return sendButtons(to, ctaText, [
        { type: 'reply', reply: { id: 'checkout', title: 'Checkout' } },
        { type: 'reply', reply: { id: 'native_order', title: 'I placed order in WhatsApp' } }
      ]);
    } catch (e2) {
      console.error('CTA after product_list sections failed', e2);
      return sendText(to, 'When ready, reply "checkout" here to confirm and get an Order ID. If you already placed an order in WhatsApp, reply "native order".');
    }
  } catch (e) {
    console.error('sendProductListSections error', e);
    return sendText(to, 'No products available.');
  }
}

async function sendSingleProduct(to, bodyText, retailerId) {
  try {
    if (!WA_CATALOG_ID || !retailerId) {
      return sendText(to, bodyText || 'Browse our catalog');
    }
    const interactive = {
      type: 'product',
      body: { text: bodyText || 'Browse our catalog' },
      action: {
        catalog_id: WA_CATALOG_ID,
        product_retailer_id: retailerId
      }
    };
    return waSend({ messaging_product: 'whatsapp', to, type: 'interactive', interactive });
  } catch (e) {
    console.error('sendSingleProduct error', e);
    return sendText(to, bodyText || 'Browse our catalog');
  }
}

// graph helpers imported from ./lib/graph.js

async function showWAProductListForType(to, typeKey) {
  let retailerIds = [];
  if (typeKey === 'imported') {
    if (WA_IMPORTED_RETAILER_IDS.length) retailerIds = WA_IMPORTED_RETAILER_IDS;
    if (!retailerIds.length) {
      let setId = WA_SET_IMPORTED_ID;
      if (!setId) {
        const sets = await fetchSets();
        const found = sets.find(s => (s.name || '').toLowerCase() === (WA_SET_IMPORTED_NAME || '').toLowerCase());
        setId = (found && found.id) || '';
      }
      if (setId) retailerIds = await fetchSetItems(setId).catch(() => []);
    }
    return sendProductList(to, 'Imported', retailerIds);
  }
  if (typeKey === 'indian') {
    if (WA_INDIAN_RETAILER_IDS.length) retailerIds = WA_INDIAN_RETAILER_IDS;
    if (!retailerIds.length) {
      let setId = WA_SET_INDIAN_ID;
      if (!setId) {
        const sets = await fetchSets();
        const found = sets.find(s => (s.name || '').toLowerCase() === (WA_SET_INDIAN_NAME || '').toLowerCase());
        setId = (found && found.id) || '';
      }
      if (setId) retailerIds = await fetchSetItems(setId).catch(() => []);
    }
    return sendProductList(to, 'Indian', retailerIds);
  }
  return sendText(to, 'No products.');
}

// --- Firestore init ---
initDb();
const adminDb = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT });
// mount admin module routes
registerAdminRoutes(app, adminDb);
// mount api module routes
registerApiRoutes(app, adminDb);

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
    rows.push(['SKU', 'Title', 'Type', 'Price', 'Currency', 'MOQ', 'Hero_URL', 'Image_Count', 'All_Images'].join(','));
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
  const data = doc.exists ? doc.data() : { types: ['indian', 'imported'] };
  return Array.isArray(data.types) && data.types.length ? data.types : ['indian', 'imported'];
}

const TYPE_DISPLAY_NAMES = {
  en: {
    indian: 'Indian',
    imported: 'Imported'
  },
  kn: {
    indian: 'Indian (ಇಂಡಿಯನ್)',
    imported: 'Imported (ಇಂಪೋರ್ಟೆಡ್)'
  }
};

async function showTypes(to, sess) {
  const types = await getTypes();
  const lang = (sess && (sess.language || sess.locale)) || 'en';
  // If only two, send buttons; else send text list
  if (types.length <= 3) {
    const displayMap = TYPE_DISPLAY_NAMES[lang] || TYPE_DISPLAY_NAMES.en || {};
    const buttons = types.map(t => ({
      type: 'reply',
      reply: {
        id: `type_${t}`,
        title: displayMap[t] || t
      }
    }));
    buttons.push({ type: 'reply', reply: { id: 'type_help', title: t(lang, 'BUTTON_HELP') } });
    const body = t(lang, 'TYPES_CHOOSE');
    return sendButtons(to, body, buttons);
  }
  const displayMap = TYPE_DISPLAY_NAMES[lang] || TYPE_DISPLAY_NAMES.en || {};
  const typeList = types.map(t => displayMap[t] || t).join('\n- ');
  const body = t(lang, 'TYPES_LIST', { types: typeList });
  return sendText(to, body);
}

async function getProductsByType(type) {
  const doc = await adminDb.collection('products_by_type').doc(type).get();
  return doc.exists ? (doc.data().items || []) : [];
}

async function showProductsPage(to, type, page = 0, pageSize = 3) {
  const sessForLang = await dbGetSession(to).catch(() => null);
  const lang = (sessForLang && (sessForLang.language || sessForLang.locale)) || 'en';
  const items = await getProductsByType(type);
  if (!items.length) {
    const msg = t(lang, 'NO_PRODUCTS_FOR_TYPE', { type });
    return sendText(to, msg);
  }
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = items.slice(p * pageSize, p * pageSize + pageSize);
  const header = t(lang, 'PRODUCTS_PAGE_HEADER', { type, page: p + 1, totalPages });
  // Check if user has items in cart to show 'View cart' button
  let hasCart = false;
  try {
    const cart = await dbGetCart(to);
    hasCart = Array.isArray(cart?.items) && cart.items.length > 0;
  } catch (_) { }
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
        } catch (_) { }
        // Add per-product quick actions
        const actions = [
          { type: 'reply', reply: { id: `view_${sku}`, title: t(lang, 'BUTTON_VIEW') } },
          { type: 'reply', reply: { id: `add_${sku}`, title: t(lang, 'BUTTON_ADD_TO_CART') } }
        ];
        if (hasCart && actions.length < 3) {
          actions.push({ type: 'reply', reply: { id: 'cart_view', title: t(lang, 'BUTTON_VIEW_CART') } });
        }
        const body = (it.title || '');
        await sendButtons(to, body, actions);
      }
    } catch (_) { }
  }
  // Build interactive list rows to make selection easier
  const rows = slice.map(it => ({
    id: `view_${(it.sku || '').toLowerCase()}`,
    title: (it.sku || '').toUpperCase(),
    description: `${it.title || ''}`.trim() || `${it.image_count || 0} images`
  }));
  // WhatsApp list supports up to 10 rows. Our page size is <= 4, safe.
  await sendList(to, header, t(lang, 'BUTTON_CHOOSE_SKU'), t(lang, 'PRODUCTS_PAGE_TITLE', { page: p + 1, totalPages }), rows);
  // Add paging buttons for easier navigation
  {
    const pageBtns = [
      { type: 'reply', reply: { id: 'page_prev', title: t(lang, 'BUTTON_PREV') } },
      { type: 'reply', reply: { id: 'page_next', title: t(lang, 'BUTTON_NEXT') } },
      { type: 'reply', reply: { id: 'page_types', title: t(lang, 'BUTTON_TYPES') } }
    ];
    if (hasCart && pageBtns.length < 3) {
      // Note: buttons max 3; if we already have 3, skip adding cart here
    } else if (hasCart) {
      // Replace 'Types' with 'View cart' to stay within 3 buttons
      pageBtns[2] = { type: 'reply', reply: { id: 'cart_view', title: t(lang, 'BUTTON_VIEW_CART') } };
    }
    const pgBody = t(lang, 'PRODUCTS_PAGE_TITLE', { page: p + 1, totalPages });
    await sendButtons(to, pgBody, pageBtns);
  }
  // Follow-up instructions (text fallback)
  const tip = t(lang, 'PAGE_TIP');
  return sendText(to, tip);
}

async function getProductDoc(sku) {
  const doc = await adminDb.collection('products').doc((sku || '').toLowerCase()).get();
  return doc.exists ? doc.data() : null;
}

async function showProductDetail(to, sku, sess) {
  const p = await getProductDoc(sku);
  const lang = (sess && (sess.language || sess.locale)) || 'en';
  if (!p) {
    const msg = t(lang, 'DETAIL_UNKNOWN_SKU', { sku });
    return sendText(to, msg);
  }
  const images = Array.isArray(p.images) ? p.images : [];
  if (!images.length) {
    const msg = t(lang, 'DETAIL_NO_IMAGES', { sku });
    return sendText(to, msg);
  }
  const heroIdx = Number.isInteger(p.hero_image_index) ? p.hero_image_index : 0;
  const heroPath = images[heroIdx];
  const titlePart = p.title ? ' | ' + p.title : '';
  const caption = t(lang, 'DETAIL_CAPTION', {
    sku,
    titlePart,
    imageCount: images.length
  });
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
  const lang = (sess && (sess.language || sess.locale)) || 'en';
  if (!sku) {
    const msg = t(lang, 'DETAIL_NO_SELECTED_PRODUCT');
    return sendText(to, msg);
  }
  const p = await getProductDoc(sku);
  if (!p || !Array.isArray(p.images) || !p.images.length) {
    const msg = t(lang, 'DETAIL_NO_MORE_IMAGES');
    return sendText(to, msg);
  }
  const heroIdx = Number.isInteger(p.hero_image_index) ? p.hero_image_index : 0;
  // Build list excluding hero
  const rest = p.images.filter((_, idx) => idx !== heroIdx);
  const start = sess.images_offset || 0;
  const end = Math.min(rest.length, start + MEDIA_BATCH_SIZE);
  if (start >= rest.length) {
    const msg = t(lang, 'DETAIL_NO_MORE_IMAGES');
    return sendText(to, msg);
  }
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
    const msg = t(lang, 'DETAIL_SENT_MORE_IMAGES', { count: batch.length });
    return sendText(to, msg);
  } else {
    const msg = t(lang, 'DETAIL_ALL_IMAGES_SENT');
    return sendText(to, msg);
  }
}

// WhatsApp helpers imported from ./lib/wa.js

// Share web checkout deep link in chat
async function sendCheckoutLink(toWaId) {
  try {
    const url = await buildCheckoutUrl(toWaId);
    // Look up session to determine the preferred language for this user.
    let lang = 'en';
    try {
      const sess = await dbGetSession(toWaId);
      if (sess && (sess.language || sess.locale)) lang = sess.language || sess.locale;
    } catch (_) { /* ignore, fallback to en */ }
    const intro = t(lang, 'CHECKOUT_LINK_INTRO');
    await sendText(toWaId, `${intro}\n${url}`);
  } catch (_) { /* non-fatal */ }
}

// --- GCS + WhatsApp media upload helpers ---
const storage = new Storage();

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

    return res.status(200).json({ ok: true, types, counts: Object.fromEntries(Object.entries(productsByType).map(([k, v]) => [k, v.length])) });
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
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// --- Health ---
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/health', (req, res) => res.status(200).send('ok'));
app.get('/', (req, res) => res.status(200).send('ok'));

// --- Static web checkout (Next.js export) ---
try {
  const staticDir = path.join(__dirname, 'web', 'out');
  app.use('/checkout', express.static(staticDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        // HTML: avoid aggressive caching so clients always get latest build
        res.setHeader('Cache-Control', 'no-store');
      } else if (filePath.includes(`${path.sep}_next${path.sep}static${path.sep}`)) {
        // Next.js hashed assets: safe to cache long-term
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        // Other assets (images, etc.): short/medium cache
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    }
  }));
} catch (e) {
  console.error('Static /checkout mount failed (non-fatal):', e);
}

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

// --- Webhook receiver ---
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
  } catch (_) { }

  return '';
}

async function sendHelp(to, sess) {
  const state = sess && sess.state ? sess.state : 'start';
  const lang = (sess && (sess.language || sess.locale)) || 'en';
  if (state === 'start' || state === 'ask_mode') {
    return sendText(to, t(lang, 'ASK_MODE_HELP'));
  }
  if (state === 'types') {
    return sendText(to, t(lang, 'TYPES_HELP'));
  }
  if (state === 'browse') {
    return sendText(to, t(lang, 'BROWSE_HELP'));
  }
  if (state === 'detail') {
    return sendText(to, t(lang, 'DETAIL_HELP'));
  }
  if (state === 'business') {
    return sendText(to, t(lang, 'BUSINESS_PROMPT'));
  }
  if (state === 'confirm') {
    return sendText(to, t(lang, 'CONFIRM_HELP'));
  }
  return sendText(to, t(lang, 'HELP_FALLBACK'));
}

async function sendLanguageSelector(to) {
  const headerText = t('en', 'LANG_GATE_HEADER');
  const bodyText = t('en', 'LANG_GATE_BODY');
  const footerText = t('en', 'LANG_GATE_FOOTER');
  const buttonText = t('en', 'BUTTON_LANG_SELECT');
  const rows = [
    { id: 'lang_hi', title: 'हिन्दी', description: '' },
    { id: 'lang_en', title: 'English', description: '' },
    { id: 'lang_kn', title: 'ಕನ್ನಡ', description: '' },
    { id: 'lang_ta', title: 'தமிழ்', description: '' },
    { id: 'lang_te', title: 'తెలుగు', description: '' },
    { id: 'lang_ml', title: 'മലയാളം', description: '' }
  ];
  return sendList(to, bodyText, buttonText, 'Languages', rows, headerText, footerText);
}

async function handleMessage(waUserId, text, rawMsg) {
  const to = waUserId;
  const sess = await dbGetSession(waUserId);

  let lower = (text || '').trim().toLowerCase();
  const lang = (sess && (sess.language || sess.locale)) || 'en';
  // Map interactive list/button reply IDs to commands (e.g., view_<sku>)
  try {
    if (rawMsg && rawMsg.type === 'interactive' && rawMsg.interactive) {
      const it = rawMsg.interactive;
      const btn = it.button_reply;
      const lst = it.list_reply;
      const id = (btn && btn.id) || (lst && lst.id) || '';
      const title = (btn && btn.title) || (lst && lst.title) || '';
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
        } else if (idLower.startsWith('qtyplus_')) {
          const sku = idLower.slice(8);
          lower = `add ${sku} 1`;
        } else if (idLower === 'checkout') {
          lower = 'checkout';
        } else if (idLower === 'b2b_no' || idLower === 'b2b_yes') {
          // B2B gate buttons
          lower = idLower;
        } else if (idLower === 'confirm_yes' || idLower === 'confirm_no') {
          // Order confirmation buttons
          lower = idLower;
        } else if (idLower === 'lang_en') {
          lower = 'lang en';
        } else if (idLower === 'lang_kn') {
          lower = 'lang kn';
        } else if (idLower === 'lang_more') {
          lower = 'lang more';
        } else if (idLower === 'lang_ta') {
          lower = 'lang ta';
        } else if (idLower === 'lang_te') {
          lower = 'lang te';
        } else if (idLower === 'lang_hi') {
          lower = 'lang hi';
        } else if (idLower === 'lang_ml') {
          lower = 'lang ml';
        } else if (idLower === 'start') {
          lower = 'start';
        } else if (idLower === 'native_order') {
          lower = 'native_order';
        }
      } else if (title) {
        const tLower = title.toLowerCase().trim();
        // If the list title is the SKU (we render SKU in list title), map it to view <sku>
        if (/^[a-z0-9\-_.]+$/i.test(tLower) && tLower.includes('-')) {
          lower = `view ${tLower}`;
        } else if (tLower === 'view' && sess.last_browse_sku) {
          lower = `view ${sess.last_browse_sku}`;
        } else if (tLower === 'add to cart' && sess.last_browse_sku) {
          lower = `add ${sess.last_browse_sku} 1`;
        }
      }
    }
  } catch (_) { }

  if (lower === 'help' || lower === 'type_help') {
    return sendHelp(to, sess);
  }

  if (lower === 'native order' || lower === 'native_order') {
    // Fallback capture for native WhatsApp orders
    // Ensure business info first
    if (!sess.business_name) {
      sess.state = 'business_name';
      await dbSaveSession(waUserId, sess);
      return sendText(to, 'Please share your business name before placing the order.');
    }
    if (!sess.business_address) {
      sess.state = 'business_address';
      await dbSaveSession(waUserId, sess);
      return sendText(to, 'Please share your full business address before placing the order.');
    }
    sess.state = 'native_capture';
    await dbSaveSession(waUserId, sess);
    return sendText(to, 'Please paste the items and quantities you placed (or attach a screenshot). We will create an order and share the Order ID.');
  }

  if (lower === 'start' || lower === 'hi' || lower === 'hello') {
    // Reset conversational state. If language is not chosen yet, show language gate.
    delete sess.mode;
    delete sess.type;
    delete sess.page;
    delete sess.selected_product;
    delete sess.images_offset;

    if (!sess.language) {
      sess.state = 'lang_select';
      await dbSaveSession(waUserId, sess);
      return sendLanguageSelector(to);
    }

    // If user is already in web checkout, resend a fresh deep link using restart copy.
    if (sess.state === 'web_checkout') {
      try {
        const l = sess.language || lang || 'en';
        const url = await buildCheckoutUrl(waUserId);
        const header = t(l, 'WEB_CHECKOUT_RESTART_HEADER');
        const body = t(l, 'WEB_CHECKOUT_RESTART_BODY', { checkout_url: url });
        const footer = t(l, 'WEB_CHECKOUT_RESTART_FOOTER');
        const msg = `${header}\n${body}\n${footer}`;
        await sendText(to, msg);
        // Stay in web_checkout state so future messages are treated as part of checkout.
        return;
      } catch (_) {
        // Fallback to generic checkout link behavior if something fails.
        try { await sendCheckoutLink(waUserId); } catch (_) {}
        sess.state = 'web_checkout';
        await dbSaveSession(waUserId, sess);
        return;
      }
    }

    // If language is already set and not in web_checkout, restart flow in the same language
    // using the wholesale greeting (header/body/footer) plus Wholesale/Retail buttons.
    sess.state = 'ask_mode';
    await dbSaveSession(waUserId, sess);
    const l = sess.language;
    const headerRestart = t(l, 'WHOLESALE_GREETING_HEADER');
    const bodyRestart = t(l, 'WHOLESALE_GREETING_BODY');
    const footerRestart = t(l, 'WHOLESALE_GREETING_FOOTER');
    const fullBodyRestart = `*${headerRestart}*\n\n${bodyRestart}\n\n_${footerRestart}_`;
    const wholesaleTitle = t(l, 'BUTTON_MODE_WHOLESALE');
    const retailTitle = t(l, 'BUTTON_MODE_RETAIL');
    return sendButtons(to, fullBodyRestart, [
      { type: 'reply', reply: { id: 'mode_wholesale', title: wholesaleTitle } },
      { type: 'reply', reply: { id: 'mode_retail', title: retailTitle } }
    ]);
  }

  // Global cart view / checkout shortcuts (work from any state)
  if (lower === 'cart' || lower === 'view cart') {
    const cart = await dbGetCart(waUserId);
    const items = cart.items || [];
    const total = items.reduce((s, i) => s + i.qty * i.unit_price, 0);
    const lines = items.map(i => `• ${i.sku} x ${i.qty} = ${i.qty * i.unit_price}`);
    if (!items.length) {
      const msgEmpty = t(lang, 'CART_EMPTY');
      return sendText(to, msgEmpty);
    }
    const header = t(lang, 'CART_HEADER');
    const totalLine = t(lang, 'CART_TOTAL_LINE', { total });
    return sendText(to, [header, ...lines, totalLine].join('\n'));
  }
  if (lower === 'checkout') {
    const cartForCheckout = await dbGetCart(waUserId);
    const cartItems = cartForCheckout.items || [];
    if (!cartItems.length) {
      const msgEmpty = t(lang, 'CART_EMPTY');
      return sendText(to, msgEmpty);
    }
    if (!sess.business_name) {
      sess.state = 'business_name';
      await dbSaveSession(waUserId, sess);
      return sendText(to, 'Please share your business name before placing the order.');
    }
    if (!sess.business_address) {
      sess.state = 'business_address';
      await dbSaveSession(waUserId, sess);
      return sendText(to, 'Please share your full business address before placing the order.');
    }
    // Build confirm prompt
    sess.business = { name: sess.business_name, address: sess.business_address };
    sess.state = 'confirm';
    await dbSaveSession(waUserId, sess);
    const totalC = cartItems.reduce((s, i) => s + i.qty * i.unit_price, 0);
    const bodyC = t(lang, 'CONFIRM_BODY', { name: sess.business_name, total: totalC });
    const yesTitleC = t(lang, 'BUTTON_CONFIRM');
    const noTitleC = t(lang, 'BUTTON_CANCEL');
    return sendButtons(to, bodyC, [
      { type: 'reply', reply: { id: 'confirm_yes', title: yesTitleC } },
      { type: 'reply', reply: { id: 'confirm_no', title: noTitleC } }
    ]);
  }

  // When user is already in web checkout mode and sends any message (other than 'start',
  // which is handled above), respond with a friendly, session-aware explanation
  // formatted as Header (bold), Body, Footer (italic) instead of restarting flow.
  if (sess.state === 'web_checkout') {
    const headerW = t(lang, 'WEB_CHECKOUT_SESSION_HEADER');
    const bodyW = t(lang, 'WEB_CHECKOUT_SESSION_INFO');
    const footerW = t(lang, 'WEB_CHECKOUT_SESSION_FOOTER');
    const msgW = `*${headerW}*\n\n${bodyW}\n\n_${footerW}_`;
    return sendText(to, msgW);
  }

  if (lower === 'view' || lower === 'add to cart' || lower === 'add') {
    const prefSku = (sess.selected_product && sess.selected_product.trim()) || (sess.last_browse_sku && sess.last_browse_sku.trim()) || '';
    if (prefSku) {
      if (lower === 'view') lower = `view ${prefSku}`;
      else lower = `add ${prefSku} 1`;
    }
  }

  // Global escape routes to avoid getting stuck
  if (lower === 'types' || lower === 'type') {
    sess.state = 'types';
    await dbSaveSession(waUserId, sess);
    return showTypes(to, sess);
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
    // If language not chosen yet, go to language selection gate.
    // Ignore legacy sess.locale here so that existing sessions also see the gate once.
    if (!sess.language) {
      sess.state = 'lang_select';
      await dbSaveSession(waUserId, sess);
      return sendLanguageSelector(to);
    }
    sess.state = 'ask_mode';
    await dbSaveSession(waUserId, sess);
    const headerStart = t(lang, 'WHOLESALE_GREETING_HEADER');
    const bodyStart = t(lang, 'WHOLESALE_GREETING_BODY');
    const footerStart = t(lang, 'WHOLESALE_GREETING_FOOTER');
    const fullBodyStart = `*${headerStart}*\n\n${bodyStart}\n\n_${footerStart}_`;
    const wholesaleTitle = t(lang, 'BUTTON_MODE_WHOLESALE');
    const retailTitle = t(lang, 'BUTTON_MODE_RETAIL');
    return sendButtons(to, fullBodyStart, [
      { type: 'reply', reply: { id: 'mode_wholesale', title: wholesaleTitle } },
      { type: 'reply', reply: { id: 'mode_retail', title: retailTitle } }
    ]);
  }

  // Language selection state
  if (sess.state === 'lang_select') {
    if (lower === 'lang en' || lower === 'english') {
      // Proceed in English directly
      sess.language = 'en';
      sess.state = 'ask_mode';
      await dbSaveSession(waUserId, sess);
      const headerEn = t('en', 'WHOLESALE_GREETING_HEADER');
      const bodyEn = t('en', 'WHOLESALE_GREETING_BODY');
      const footerEn = t('en', 'WHOLESALE_GREETING_FOOTER');
      const fullBodyEn = `*${headerEn}*\n\n${bodyEn}\n\n_${footerEn}_`;
      return sendButtons(to, fullBodyEn, [
        { type: 'reply', reply: { id: 'mode_wholesale', title: t('en', 'BUTTON_MODE_WHOLESALE') } },
        { type: 'reply', reply: { id: 'mode_retail', title: t('en', 'BUTTON_MODE_RETAIL') } }
      ]);
    }
    if (lower === 'lang kn' || lower === 'kannada' || lower === 'ಕನ್ನಡ') {
      sess.language = 'kn';
    } else if (lower === 'lang ta') {
      sess.language = 'ta';
    } else if (lower === 'lang te') {
      sess.language = 'te';
    } else if (lower === 'lang hi') {
      sess.language = 'hi';
    } else if (lower === 'lang ml') {
      sess.language = 'ml';
    }

    if (sess.language) {
      sess.state = 'ask_mode';
      await dbSaveSession(waUserId, sess);
      const l = sess.language;
      const header = t(l, 'WHOLESALE_GREETING_HEADER');
      const body = t(l, 'WHOLESALE_GREETING_BODY');
      const footer = t(l, 'WHOLESALE_GREETING_FOOTER');
      const fullBody = `*${header}*\n\n${body}\n\n_${footer}_`;
      return sendButtons(to, fullBody, [
        { type: 'reply', reply: { id: 'mode_wholesale', title: t(l, 'BUTTON_MODE_WHOLESALE') } },
        { type: 'reply', reply: { id: 'mode_retail', title: t(l, 'BUTTON_MODE_RETAIL') } }
      ]);
    }

    // Re-show language selector on any other input
    return sendLanguageSelector(to);
  }

  if (sess.state === 'ask_mode') {
    if (lower.includes('wholesale') || lower.includes('mode_wholesale')) {
      sess.mode = 'wholesale';
      // Share deep link to web checkout and stop legacy browse flow
      try { await sendCheckoutLink(waUserId); } catch (_) {}
      sess.state = 'web_checkout';
      await dbSaveSession(waUserId, sess);
      return;
    }
    if (lower.includes('retail') || lower.includes('mode_retail')) {
      // B2B gate: we serve wholesale only. Confirm buyer is B2B.
      sess.mode = 'retail';
      sess.state = 'b2b_gate';
      await dbSaveSession(waUserId, sess);
      const body = t(lang, 'B2B_GATE_PROMPT');
      const noTitle = t(lang, 'BUTTON_B2B_NO');
      const yesTitle = t(lang, 'BUTTON_B2B_YES');
      return sendButtons(to, body, [
        { type: 'reply', reply: { id: 'b2b_yes', title: yesTitle } },
        { type: 'reply', reply: { id: 'b2b_no', title: noTitle } }
      ]);
    }
    // Any other input here: gently force the user back to choosing Wholesale or Retail
    // by resending the choice with buttons instead of plain text, with formatted header/options.
    const headerChoose = t(lang, 'ASK_MODE_CHOOSE');
    const optionsChoose = t(lang, 'ASK_MODE_OPTIONS');
    const body = `*${headerChoose}*\n\n_${optionsChoose}_`;
    const wholesaleTitle = t(lang, 'BUTTON_MODE_WHOLESALE');
    const retailTitle = t(lang, 'BUTTON_MODE_RETAIL');
    return sendButtons(to, body, [
      { type: 'reply', reply: { id: 'mode_wholesale', title: wholesaleTitle } },
      { type: 'reply', reply: { id: 'mode_retail', title: retailTitle } }
    ]);
  }

  // B2B gate confirmation
  if (sess.state === 'b2b_gate') {
    const kw = YES_NO_KEYWORDS[lang] || YES_NO_KEYWORDS.en;
    const yesWords = kw.yes || YES_NO_KEYWORDS.en.yes;
    const noWords = kw.no || YES_NO_KEYWORDS.en.no;

    const isYes =
      lower.includes('b2b_yes') ||
      // If the user types or taps Wholesale again here, treat it as a YES.
      lower.includes('mode_wholesale') ||
      lower.includes('wholesale') ||
      yesWords.some(w => lower === w || lower.includes(w));
    const isNo =
      lower.includes('b2b_no') ||
      noWords.some(w => lower === w || lower.includes(w));

    if (isYes) {
      sess.mode = 'wholesale';
      // Share deep link to web checkout when B2B is confirmed and stop legacy browse flow
      try { await sendCheckoutLink(waUserId); } catch (_) {}
      sess.state = 'web_checkout';
      await dbSaveSession(waUserId, sess);
      return;
    }
    if (isNo) {
      sess.state = 'start';
      await dbSaveSession(waUserId, sess);
      const body = t(lang, 'B2B_GATE_THANKS_NO');
      const startTitle = t(lang, 'BUTTON_START');
      return sendButtons(to, body, [
        { type: 'reply', reply: { id: 'start', title: startTitle } }
      ]);
    }
    const body = t(lang, 'B2B_GATE_QUESTION');
    const noTitle = t(lang, 'BUTTON_B2B_NO');
    const yesTitle = t(lang, 'BUTTON_B2B_YES');
    return sendButtons(to, body, [
      { type: 'reply', reply: { id: 'b2b_yes', title: yesTitle } },
      { type: 'reply', reply: { id: 'b2b_no', title: noTitle } }
    ]);
  }

  // Collect business name/address states
  if (sess.state === 'business_name') {
    const name = (text || '').trim();
    if (!name) {
      return sendText(to, 'Please enter your business name to continue.');
    }
    sess.business_name = name;
    sess.state = 'business_address';
    await dbSaveSession(waUserId, sess);
    return sendText(to, 'Please enter your full business address (including city and pincode).');
  }
  if (sess.state === 'business_address') {
    const addr = (text || '').trim();
    if (!addr) {
      return sendText(to, 'Please enter your full business address to continue.');
    }
    sess.business_address = addr;
    // proceed to types
    sess.state = 'types';
    await dbSaveSession(waUserId, sess);
    return showTypes(to, sess);
  }

  // Choose type (indian/imported)
  if (sess.state === 'types') {
    if (lower.includes('indian') || lower === 'indian') {
      sess.type = 'indian';
      sess.page = 0;
      sess.state = 'browse';
      await dbSaveSession(waUserId, sess);
      if (USE_WA_CATALOG && WA_CATALOG_ID) {
        return showWAProductListForType(to, 'indian');
      }
      return showProductsPage(to, sess.type, sess.page);
    }
    if (lower.includes('imported') || lower === 'imported') {
      sess.type = 'imported';
      sess.page = 0;
      sess.state = 'browse';
      await dbSaveSession(waUserId, sess);
      if (USE_WA_CATALOG && WA_CATALOG_ID) {
        return showWAProductListForType(to, 'imported');
      }
      return showProductsPage(to, sess.type, sess.page);
    }
    // re-show types on any other input
    return showTypes(to, sess);
  }

  if (sess.state === 'browse') {
    // Allow re-showing catalog on demand
    if (lower === 'types' || lower === 'type') {
      sess.state = 'types';
      await dbSaveSession(waUserId, sess);
      return showTypes(to, sess);
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
      const rawSku = lower.slice(5).trim();
      const sku = rawSku ? rawSku.toLowerCase() : '';
      if (!sku) {
        const msg = t(lang, 'USAGE_VIEW_SKU');
        return sendText(to, msg);
      }
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
      if (!Number.isInteger(qty) || qty <= 0) {
        const msg = t(lang, 'INVALID_QTY');
        return sendText(to, msg);
      }

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
          const msg = t(lang, 'UNKNOWN_SKU_CAPTION');
          return sendText(to, msg);
        }
      }

      if (!Number.isFinite(price) || price <= 0) {
        const msg = t(lang, 'PRICE_NOT_SET', { sku: skuUpper });
        return sendText(to, msg);
      }

      // No MOQ enforcement: allow any integer qty >= 1

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
      const addedMsg = t(lang, 'CART_ADDED_LINE', { sku: skuForCart, qty });
      await sendText(to, addedMsg);
      const nextBody = t(lang, 'NEXT_STEPS_TITLE');
      return sendButtons(to, nextBody, [
        { type: 'reply', reply: { id: `qtyplus_${skuLower}`, title: t(lang, 'BUTTON_QTYPLUS') } },
        { type: 'reply', reply: { id: 'cart_view', title: t(lang, 'BUTTON_VIEW_CART') } },
        { type: 'reply', reply: { id: 'checkout', title: t(lang, 'BUTTON_CHECKOUT') } }
      ]);
    }
    if (lower === 'cart' || lower === 'view') {
      const cart = await dbGetCart(waUserId);
      const items = cart.items || [];
      const total = items.reduce((s, i) => s + i.qty * i.unit_price, 0);
      const lines = items.map(i => `• ${i.sku} x ${i.qty} = ${i.qty * i.unit_price}`);
      if (!items.length) {
        const msgEmpty = t(lang, 'CART_EMPTY');
        return sendText(to, msgEmpty);
      }
      const header = t(lang, 'CART_HEADER');
      const totalLine = t(lang, 'CART_TOTAL_LINE', { total });
      return sendText(to, [header, ...lines, totalLine].join('\n'));
    }
    if (lower === 'checkout') {
      const cartForCheckout2 = await dbGetCart(waUserId);
      const cartItems2 = cartForCheckout2.items || [];
      if (!cartItems2.length) {
        const msgEmpty2 = t(lang, 'CART_EMPTY');
        return sendText(to, msgEmpty2);
      }
      if (!sess.business_name) {
        sess.state = 'business_name';
        await dbSaveSession(waUserId, sess);
        return sendText(to, 'Please share your business name before placing the order.');
      }
      if (!sess.business_address) {
        sess.state = 'business_address';
        await dbSaveSession(waUserId, sess);
        return sendText(to, 'Please share your full business address before placing the order.');
      }
      sess.business = { name: sess.business_name, address: sess.business_address };
      sess.state = 'confirm';
      await dbSaveSession(waUserId, sess);
      const totalC2 = cartItems2.reduce((s, i) => s + i.qty * i.unit_price, 0);
      const bodyC2 = t(lang, 'CONFIRM_BODY', { name: sess.business_name, total: totalC2 });
      const yesTitleC2 = t(lang, 'BUTTON_CONFIRM');
      const noTitleC2 = t(lang, 'BUTTON_CANCEL');
      return sendButtons(to, bodyC2, [
        { type: 'reply', reply: { id: 'confirm_yes', title: yesTitleC2 } },
        { type: 'reply', reply: { id: 'confirm_no', title: noTitleC2 } }
      ]);
    }
    if (USE_WA_CATALOG && WA_CATALOG_ID) {
      // Do not spam legacy text-help when using native WhatsApp catalog UI
      return;
    }
    const msgBrowse = t(lang, 'BROWSE_INLINE_HELP');
    return sendText(to, msgBrowse);
  }

  // Detail state: show hero already sent; support more images and navigation
  if (sess.state === 'detail') {
    if (lower === 'more images' || lower === 'more' || lower === 'images') {
      return sendMoreImages(to, sess);
    }
    if (lower.startsWith('add ')) {
      // Allow adding from detail view as well
      const parts = lower.split(/\s+/);
      const skuRaw = (parts[1] || '').trim();
      const skuLower = skuRaw.toLowerCase();
      const skuUpper = skuRaw.toUpperCase();
      const qty = parseInt(parts[2] || '0', 10);
      if (!Number.isInteger(qty) || qty <= 0) {
        const msg = t(lang, 'INVALID_QTY');
        return sendText(to, msg);
      }

      let price = 0;
      let currency = 'INR';
      let moq = 1;
      let skuForCart = skuUpper;
      const prod = await getProductDoc(skuLower);
      if (prod) {
        price = Number(prod.price || 0);
        currency = (prod.currency || 'INR').toUpperCase();
        moq = Number.isInteger(prod.moq) && prod.moq > 0 ? prod.moq : 1;
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
          const msg = t(lang, 'UNKNOWN_SKU_CAPTION');
          return sendText(to, msg);
        }
      }
      if (!Number.isFinite(price) || price <= 0) {
        const msg = t(lang, 'PRICE_NOT_SET', { sku: skuUpper });
        return sendText(to, msg);
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
      const addedMsgDetail = t(lang, 'CART_ADDED_LINE', { sku: skuForCart, qty });
      await sendText(to, addedMsgDetail);
      const nextBodyDetail = t(lang, 'NEXT_STEPS_TITLE');
      return sendButtons(to, nextBodyDetail, [
        { type: 'reply', reply: { id: `qtyplus_${skuLower}`, title: t(lang, 'BUTTON_QTYPLUS') } },
        { type: 'reply', reply: { id: 'cart_view', title: t(lang, 'BUTTON_VIEW_CART') } },
        { type: 'reply', reply: { id: 'checkout', title: t(lang, 'BUTTON_CHECKOUT') } }
      ]);
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
      const rawSku2 = lower.slice(5).trim();
      const sku2 = rawSku2 ? rawSku2.toLowerCase() : '';
      if (!sku2) {
        const msg = t(lang, 'USAGE_VIEW_SKU');
        return sendText(to, msg);
      }
      sess.selected_product = sku2;
      sess.images_offset = 0;
      await dbSaveSession(waUserId, sess);
      return showProductDetail(to, sku2, sess);
    }
    // Default help in detail
    const msgDetail = t(lang, 'DETAIL_INLINE_HELP');
    return sendText(to, msgDetail);
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
      const body = t(lang, 'CONFIRM_BODY', { name, total });
      const yesTitle = t(lang, 'BUTTON_CONFIRM');
      const noTitle = t(lang, 'BUTTON_CANCEL');
      return sendButtons(to, body, [
        { type: 'reply', reply: { id: 'confirm_yes', title: yesTitle } },
        { type: 'reply', reply: { id: 'confirm_no', title: noTitle } }
      ]);
    }
    const msg = t(lang, 'BUSINESS_PROMPT');
    return sendText(to, msg);
  }

  if (sess.state === 'confirm') {
    // Legacy chat-based confirmation is deprecated; orders are placed via web checkout only.
    const info = 'To place or confirm your order, please use the latest checkout link we sent above.';
    return sendText(to, info);
  }

  // Handle native WhatsApp order message
  if (rawMsg && rawMsg.type === 'order') {
    return handleNativeOrder(waUserId, rawMsg);
  }

  // fallback
  {
    const msg = t(lang, 'FALLBACK_START');
    return sendText(to, msg);
  }
}

async function handleNativeOrder(waUserId, rawMsg) {
  const orderDetails = rawMsg.order;
  const products = orderDetails.product_items || [];

  if (!products.length) {
    return sendText(waUserId, "We received an empty order. Please try again.");
  }

  // Reconstruct items with details from our DB to ensure valid prices/titles
  const items = [];
  let subtotal = 0;
  let currency = 'INR';

  for (const p of products) {
    const skuRaw = p.product_retailer_id || '';
    const sku = skuRaw.toUpperCase(); // normalize
    const qty = Number(p.quantity) || 1;

    // Try to fetch fresh details
    let unit_price = Number(p.item_price) || 0;
    let cur = (p.currency || 'INR').toUpperCase();

    const doc = await getProductDoc(skuRaw.toLowerCase());
    if (doc) {
      if (doc.price) unit_price = Number(doc.price);
      if (doc.currency) cur = doc.currency.toUpperCase();
    }

    items.push({
      sku,
      qty,
      unit_price,
      currency: cur
    });

    subtotal += (qty * unit_price);
    currency = cur; // assume all same currency
  }

  // Legacy chat-native order creation is deprecated; web checkout is now the only order mechanism.
  const info = 'Ordering directly by message is no longer supported. Please use the checkout link we sent to review items and place your order.';
  await sendText(waUserId, info);
}

async function showCatalog(to) {
  const items = await listCatalog(3);
  if (!items || items.length === 0) {
    await sendText(to, t('en', 'CATALOG_FOOTER'));
    return;
  }
  for (const p of items) {
    const caption = t('en', 'CATALOG_IMAGE_CAPTION', {
      sku: p.sku,
      title: p.title,
      price: p.price,
      currency: p.currency,
      moq: p.moq
    });
    await sendImage(to, p.image_url, caption);
  }
  await sendText(to, t('en', 'CATALOG_FOOTER'));
}

// (Order creation & Sheet logging now live in routes/api.js for web checkout.)

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
    const ctx = `row ${i + 1}`;
    const sku = (r.sku || '').toString().trim().toUpperCase();
    if (!sku) { errors.push({ row: i + 1, field: 'sku', error: 'required' }); continue; }
    if (seen.has(sku)) { errors.push({ row: i + 1, field: 'sku', error: 'duplicate in request' }); continue; }
    seen.add(sku);
    const price = Number(r.price);
    if (!Number.isFinite(price) || price <= 0) { errors.push({ row: i + 1, field: 'price', error: 'invalid' }); continue; }
    const currency = (r.currency || 'INR').toString().trim().toUpperCase();
    const moq = parseInt(r.moq || '1', 10);
    if (!Number.isInteger(moq) || moq <= 0) { errors.push({ row: i + 1, field: 'moq', error: 'invalid' }); continue; }
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
