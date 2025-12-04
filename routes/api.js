import { getSession as dbGetSession, saveSession as dbSaveSession, getCart as dbGetCart, saveCart as dbSaveCart, createOrderDoc, markCheckoutTokenUsed } from '../firestore.js';
import { getCheckoutTokenStatus } from '../lib/checkout.js';
import { google } from 'googleapis';
import { sendButtons, sendText, sendInternalOrderAlertTemplate } from '../lib/wa.js';
import { t } from '../locales.js';

function nowIso() { return new Date().toISOString(); }

function toIstString(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

function normalizeImageUrl(u) {
  if (!u || typeof u !== 'string') return u;
  if (u.startsWith('gs://')) {
    const without = u.slice('gs://'.length);
    const idx = without.indexOf('/');
    if (idx > 0) {
      const bucket = without.slice(0, idx);
      const object = without.slice(idx + 1);
      return `https://storage.googleapis.com/${bucket}/${object}`;
    }
  }
  return u;
}

function formatOrderItemsForSheet(items) {
  if (!Array.isArray(items) || !items.length) return '';
  const parts = [];
  for (const it of items) {
    if (!it) continue;
    const name = (it.title || it.sku || '').toString();
    if (!name) continue;
    const size = (it.size || '').toString();
    const qty = Number(it.qty || 0) || 0;

    let segment = name;
    if (size) segment += ' - ' + size;
    if (qty) segment += ' * ' + qty;
    parts.push(segment);
  }
  return parts.join(', ');
}

const DISABLE_CHECKOUT_TOKEN = ((process.env.DISABLE_CHECKOUT_TOKEN || 'false').toString().toLowerCase() === 'true');

async function getProductDoc(adminDb, sku) {
  const doc = await adminDb.collection('products').doc((sku || '').toLowerCase()).get();
  return doc.exists ? doc.data() : null;
}

async function appendOrderToSheet(order) {
  const SALES_SHEET_ID = process.env.SALES_SHEET_ID || '';
  if (!SALES_SHEET_ID) {
    console.warn('appendOrderToSheet: SALES_SHEET_ID not set, skipping Sheets append');
    return;
  }
  try {
    const auth = await google.auth.getClient({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    const itemsSummary = formatOrderItemsForSheet(order.items);
    const business = order.business || {};
    const gstin = (business.gstin || '').toString();
    const address = (business.address || '').toString();
    const createdAtIst = toIstString(order.created_at || '');
    const row = [createdAtIst, order.id, order.wa_user_id, business.name || '', gstin, address, itemsSummary, order.subtotal, order.currency, 'placed'];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SALES_SHEET_ID,
      range: 'Orders!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
    console.log('appendOrderToSheet: appended order to sheet', { id: order.id, wa_user_id: order.wa_user_id });
  } catch (e) {
    console.error('appendOrderToSheet: Sheets append error', e);
  }
}

export function registerApiRoutes(app, adminDb) {
  // GET /api/cart
  app.get('/api/cart', async (req, res) => {
    try {
      const u = (req.query.u || '').toString().trim();
      const tkn = (req.query.t || '').toString().trim();
      if (!u) return res.status(400).json({ ok: false, error: 'u required' });
      if (!DISABLE_CHECKOUT_TOKEN) {
        const status = await getCheckoutTokenStatus(u, tkn);
        console.log('CHECKOUT_STATUS', { u, tkn, status });
        if (status !== 'ok') return res.status(401).json({ ok: false, error: 'checkout_session_' + status });
      }

      let business = { name: '', address: '', gstin: '' };
      try {
        const sess = await dbGetSession(u);
        business = {
          name: sess?.business_name || sess?.business?.name || '',
          address: sess?.business_address || sess?.business?.address || '',
          gstin: sess?.business_gstin || sess?.business?.gstin || sess?.gstin || ''
        };
      } catch (_) {}

      const items = [];
      try {
        const cart = await dbGetCart(u);
        const cartItems = Array.isArray(cart?.items) ? cart.items : [];
        for (const ci of cartItems) {
          const sku = (ci.sku || ci.content_id || '').toString().toLowerCase();
          if (!sku) continue;
          const pd = await getProductDoc(adminDb, sku);
          if (!pd) continue;
          const rawImages = Array.isArray(pd.images) ? pd.images : [];
          const images = rawImages.map(normalizeImageUrl);
          const heroIdx = Number.isInteger(pd.hero_image_index) ? pd.hero_image_index : 0;
          const image_url = images[heroIdx] || '';
          const price = Number(pd.price || ci.unit_price || 0) || 0;
          const currency = (pd.currency || 'INR').toString();
          const title = pd.title || sku.toUpperCase();
          const sizes = Array.isArray(pd.sizes) ? pd.sizes : [];
          const pcs_per_set = Number(pd.pcs_per_set || 0) || 0;
          items.push({ content_id: sku, title, price, currency, image_url, sizes, pcs_per_set, qty: Number(ci.qty || 1) });
        }
      } catch (_) {}

      return res.status(200).json({ ok: true, items, business });
    } catch (e) {
      console.error('GET /api/cart error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

  // POST /api/cart - persist web cart to Firestore for abandoned cart tracking
  app.post('/api/cart', async (req, res) => {
    try {
      const u = (req.body?.u || '').toString().trim();
      const tkn = (req.body?.t || '').toString().trim();
      if (!u) return res.status(400).json({ ok: false, error: 'u required' });
      if (!DISABLE_CHECKOUT_TOKEN) {
        const status = await getCheckoutTokenStatus(u, tkn);
        if (status !== 'ok') return res.status(401).json({ ok: false, error: 'checkout_session_' + status });
      }

      const itemsIn = Array.isArray(req.body?.items) ? req.body.items : [];
      // We allow empty items to clear the cart; just normalize shape
      const norm = itemsIn.map((it) => ({
        sku: (it.sku || it.content_id || '').toString().toLowerCase(),
        content_id: (it.content_id || it.sku || '').toString().toLowerCase(),
        qty: Number(it.qty || 1) || 1,
        size: (it.size || '').toString()
      })).filter((it) => it.content_id);

      await dbSaveCart(u, { items: norm, currency: 'INR' });
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('POST /api/cart error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

  // POST /api/order
  app.post('/api/order', async (req, res) => {
    try {
      const u = (req.body?.u || '').toString().trim();
      const tkn = (req.body?.t || '').toString().trim();
      if (!u) return res.status(400).json({ ok: false, error: 'u required' });
      if (!DISABLE_CHECKOUT_TOKEN) {
        const status = await getCheckoutTokenStatus(u, tkn);
        if (status !== 'ok') return res.status(401).json({ ok: false, error: 'checkout_session_' + status });
      }

      const itemsIn = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!itemsIn.length) return res.status(400).json({ ok: false, error: 'items required' });

      const outItems = [];
      let subtotal = 0;
      let currency = 'INR';
      for (const it of itemsIn) {
        const cid = (it.content_id || it.sku || '').toString().toLowerCase();
        const qty = Math.max(1, parseInt(it.qty || '1', 10));
        if (!cid || !qty) continue;
        const pd = await getProductDoc(adminDb, cid);
        if (!pd) continue;
        const pricePerPiece = Number(pd.price || 0) || 0;
        currency = (pd.currency || 'INR').toString();
        const title = pd.title || cid.toUpperCase();
        const rawPcsPerSet = Number(pd.pcs_per_set || 0) || 0;
        const pcs_per_set = rawPcsPerSet > 0 ? rawPcsPerSet : 1;
        const lineTotal = qty * pcs_per_set * pricePerPiece;
        outItems.push({ sku: cid.toUpperCase(), title, qty, unit_price: pricePerPiece, currency, size: it.size || '', pcs_per_set });
        subtotal += lineTotal;
      }

      if (!outItems.length) return res.status(400).json({ ok: false, error: 'no valid items' });

      const business = {
        name: (req.body?.business?.name || '').toString(),
        address: (req.body?.business?.address || '').toString(),
        gstin: (req.body?.business?.gstin || '').toString()
      };

      try {
        await dbSaveSession(u, {
          business_name: business.name,
          business_address: business.address,
          business_gstin: business.gstin,
          business: {
            name: business.name,
            address: business.address,
            gstin: business.gstin
          }
        });
      } catch (e) {
        console.error('saveSession business update error', e);
      }

      const id = 'ORD-' + Math.random().toString(36).slice(2, 10).toUpperCase();
      const order = { id, wa_user_id: u, business, items: outItems, currency, subtotal, created_at: nowIso(), source: 'web_checkout' };

      try { await createOrderDoc(order); } catch (e) { console.error('createOrderDoc error', e); }
      try { await appendOrderToSheet(order); } catch (e) { console.error('appendOrderToSheet error', e); }

      // Best-effort internal WhatsApp alert for new orders (owner/ops notifications)
      try {
        const internalWa = (process.env.INTERNAL_ALERT_WA || '').toString().trim();
        if (internalWa) {
          const totalStr = `₹${subtotal}`;
          const buyerName = (business && business.name) ? business.name.toString() : '';
          const buyerWaNumber = u;
          await sendInternalOrderAlertTemplate(internalWa, id, buyerName, buyerWaNumber, totalStr);
        }
      } catch (e) {
        console.error('internal WA order alert error', e);
      }

      // Best-effort WhatsApp confirmation back to the user
      try {
        let lang = 'en';
        try {
          const sess = await dbGetSession(u);
          if (sess && (sess.language || sess.locale)) lang = sess.language || sess.locale;
        } catch (_) { }

        const header = t(lang, 'ORDER_CONFIRM_HEADER');
        const bodyText = t(lang, 'ORDER_CONFIRM_BODY', { id });
        const footer = t(lang, 'ORDER_CONFIRM_FOOTER');
        const fullMsg = `${header}\n\n${bodyText}\n\n${footer}`;
        await sendText(u, fullMsg);

        const orderAgainTitle = t(lang, 'BUTTON_ORDER_AGAIN') || 'Order again';
        const contactSupportTitle = t(lang, 'BUTTON_CONTACT_SUPPORT');
        const helpTitle = t(lang, 'BUTTON_HELP');
        const nextStepsBody = t(lang, 'NEXT_STEPS_TITLE') || 'Next steps';

        await sendButtons(u, nextStepsBody, [
          { type: 'reply', reply: { id: 'web_restart', title: orderAgainTitle } },
          { type: 'reply', reply: { id: 'contact_support', title: contactSupportTitle } },
          { type: 'reply', reply: { id: 'web_help', title: helpTitle } }
        ]);
      } catch (e) {
        console.error('send WA order confirmation error', e);
      }

      // Mark this checkout token as used so the link cannot be reused for another order
      try {
        if (!DISABLE_CHECKOUT_TOKEN && tkn) {
          await markCheckoutTokenUsed(tkn);
        }
      } catch (_) { }

      return res.status(200).json({ ok: true, id });
    } catch (e) {
      console.error('POST /api/order error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

  // GET /api/products
  app.get('/api/products', async (req, res) => {
    try {
      const u = (req.query.u || '').toString().trim();
      const tkn = (req.query.t || '').toString().trim();
      const rawType = (req.query.type || 'indian').toString().toLowerCase();
      const page = Math.max(1, parseInt((req.query.page || '1').toString(), 10) || 1);
      const pageSize = Math.max(1, Math.min(50, parseInt((req.query.pageSize || '20').toString(), 10) || 20));
      if (!u) return res.status(400).json({ ok: false, error: 'u required' });
      if (!DISABLE_CHECKOUT_TOKEN) {
        const status = await getCheckoutTokenStatus(u, tkn);
        if (status !== 'ok') return res.status(401).json({ ok: false, error: 'checkout_session_' + status });
      }

      let type = rawType;
      let list = [];

      if (rawType === 'all') {
        // Combine Indian and Imported product lists into a single "all" view.
        // Tag each entry with its source type so the UI can show a pill.
        const [indDoc, impDoc] = await Promise.all([
          adminDb.collection('products_by_type').doc('indian').get(),
          adminDb.collection('products_by_type').doc('imported').get(),
        ]);
        const indList = indDoc.exists ? (indDoc.data().items || []) : [];
        const impList = impDoc.exists ? (impDoc.data().items || []) : [];
        const taggedInd = indList.map((it) => ({ ...it, _srcType: 'indian' }));
        const taggedImp = impList.map((it) => ({ ...it, _srcType: 'imported' }));
        list = [...taggedInd, ...taggedImp];
        type = 'all';
      } else {
        const doc = await adminDb.collection('products_by_type').doc(type).get();
        list = doc.exists ? (doc.data().items || []) : [];
      }

      const total = Array.isArray(list) ? list.length : 0;
      const pageCount = Math.max(1, Math.ceil(total / pageSize));
      const p = Math.min(Math.max(1, page), pageCount);
      const start = (p - 1) * pageSize;
      const end = Math.min(total, start + pageSize);
      const slice = list.slice(start, end);

      const items = [];
      for (const it of slice) {
        const sku = (it.sku || '').toString().toLowerCase();
        if (!sku) continue;
        const pd = await getProductDoc(adminDb, sku).catch(() => null);
        if (!pd) continue;
        if (pd.active === false) continue;
        const rawImages = Array.isArray(pd.images) ? pd.images : [];
        const images = rawImages.map(normalizeImageUrl);
        const heroIdx = Number.isInteger(pd.hero_image_index) ? pd.hero_image_index : 0;
        const image_url = images[heroIdx] || '';
        const price = Number(pd.price || 0) || 0;
        const currency = (pd.currency || 'INR').toString();
        const title = pd.title || (it.title || sku.toUpperCase());
        const description = (pd.description || '').toString();
        const sizes = Array.isArray(pd.sizes) ? pd.sizes : [];
        const pcs_per_set = Number(pd.pcs_per_set || 0) || 0;
        const source_type = (it._srcType || type || '').toString();
        items.push({ content_id: sku, title, price, currency, image_url, description, sizes, pcs_per_set, source_type });
      }

      return res.status(200).json({ ok: true, type, page: p, pageSize, total, pageCount, items });
    } catch (e) {
      console.error('GET /api/products error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

  // GET /api/product?id=<content_id>&u=&t=
  app.get('/api/product', async (req, res) => {
    try {
      const u = (req.query.u || '').toString().trim();
      const tkn = (req.query.t || '').toString().trim();
      const id = (req.query.id || req.query.content_id || '').toString().toLowerCase();
      if (!u) return res.status(400).json({ ok: false, error: 'u required' });
      if (!DISABLE_CHECKOUT_TOKEN) {
        const status = await getCheckoutTokenStatus(u, tkn);
        if (status !== 'ok') return res.status(401).json({ ok: false, error: 'checkout_session_' + status });
      }
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });

      const pd = await getProductDoc(adminDb, id);
      if (!pd) return res.status(404).json({ ok: false, error: 'not found' });
      const rawImages = Array.isArray(pd.images) ? pd.images : [];
      const images = rawImages.map(normalizeImageUrl);
      const hero_image_index = Number.isInteger(pd.hero_image_index) ? pd.hero_image_index : 0;
      const pcs_per_set = Number(pd.pcs_per_set || 0) || 0;
      const sizes = Array.isArray(pd.sizes) ? pd.sizes : [];
      return res.status(200).json({
        ok: true,
        content_id: id,
        title: pd.title || id.toUpperCase(),
        price: Number(pd.price || 0) || 0,
        currency: (pd.currency || 'INR').toString(),
        description: (pd.description || '').toString(),
        images,
        hero_image_index,
        sizes,
        pcs_per_set
      });
    } catch (e) {
      console.error('GET /api/product error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });
}
