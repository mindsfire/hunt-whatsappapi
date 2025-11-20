import { getSession as dbGetSession, getCart as dbGetCart } from '../firestore.js';
import { createOrderDoc } from '../firestore.js';
import { verifyCheckoutToken } from '../lib/checkout.js';
import { google } from 'googleapis';
import { sendText } from '../lib/wa.js';

function nowIso() { return new Date().toISOString(); }

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
    const row = [order.created_at, order.id, order.wa_user_id, order.business.name || '', JSON.stringify(order.items), order.subtotal, order.currency, 'placed'];
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
      if (!DISABLE_CHECKOUT_TOKEN && !verifyCheckoutToken(u, tkn)) return res.sendStatus(401);

      let business = { name: '', address: '' };
      try {
        const sess = await dbGetSession(u);
        business = {
          name: sess?.business_name || sess?.business?.name || '',
          address: sess?.business_address || sess?.business?.address || ''
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
          const images = Array.isArray(pd.images) ? pd.images : [];
          const heroIdx = Number.isInteger(pd.hero_image_index) ? pd.hero_image_index : 0;
          const image_url = images[heroIdx] || '';
          const price = Number(pd.price || ci.unit_price || 0) || 0;
          const currency = (pd.currency || 'INR').toString();
          const title = pd.title || sku.toUpperCase();
          items.push({ content_id: sku, title, price, currency, image_url, qty: Number(ci.qty || 1) });
        }
      } catch (_) {}

      return res.status(200).json({ ok: true, items, business });
    } catch (e) {
      console.error('GET /api/cart error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

  // POST /api/order
  app.post('/api/order', async (req, res) => {
    try {
      const u = (req.body?.u || '').toString().trim();
      const tkn = (req.body?.t || '').toString().trim();
      if (!u) return res.status(400).json({ ok: false, error: 'u required' });
      if (!DISABLE_CHECKOUT_TOKEN && !verifyCheckoutToken(u, tkn)) return res.sendStatus(401);

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
        const unit_price = Number(pd.price || 0) || 0;
        currency = (pd.currency || 'INR').toString();
        outItems.push({ sku: cid.toUpperCase(), qty, unit_price, currency, size: it.size || '' });
        subtotal += unit_price * qty;
      }

      if (!outItems.length) return res.status(400).json({ ok: false, error: 'no valid items' });

      const business = {
        name: (req.body?.business?.name || '').toString(),
        address: (req.body?.business?.address || '').toString()
      };

      const id = 'ORD-' + Math.random().toString(36).slice(2, 10).toUpperCase();
      const order = { id, wa_user_id: u, business, items: outItems, currency, subtotal, created_at: nowIso(), source: 'web_checkout' };

      try { await createOrderDoc(order); } catch (e) { console.error('createOrderDoc error', e); }
      try { await appendOrderToSheet(order); } catch (e) { console.error('appendOrderToSheet error', e); }

      // Best-effort WhatsApp confirmation back to the user
      try {
        const msg = `Your order has been placed successfully. Order ID: ${id}`;
        await sendText(u, msg);
      } catch (e) {
        console.error('send WA order confirmation error', e);
      }

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
      const type = (req.query.type || 'indian').toString().toLowerCase();
      const page = Math.max(1, parseInt((req.query.page || '1').toString(), 10) || 1);
      const pageSize = Math.max(1, Math.min(50, parseInt((req.query.pageSize || '20').toString(), 10) || 20));
      if (!u) return res.status(400).json({ ok: false, error: 'u required' });
      if (!DISABLE_CHECKOUT_TOKEN && !verifyCheckoutToken(u, tkn)) return res.sendStatus(401);

      const doc = await adminDb.collection('products_by_type').doc(type).get();
      const list = doc.exists ? (doc.data().items || []) : [];
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
        const images = Array.isArray(pd.images) ? pd.images : [];
        const heroIdx = Number.isInteger(pd.hero_image_index) ? pd.hero_image_index : 0;
        const image_url = images[heroIdx] || '';
        const price = Number(pd.price || 0) || 0;
        const currency = (pd.currency || 'INR').toString();
        const title = pd.title || (it.title || sku.toUpperCase());
        const description = (pd.description || '').toString();
        items.push({ content_id: sku, title, price, currency, image_url, description });
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
      if (!DISABLE_CHECKOUT_TOKEN && !verifyCheckoutToken(u, tkn)) return res.sendStatus(401);
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });

      const pd = await getProductDoc(adminDb, id);
      if (!pd) return res.status(404).json({ ok: false, error: 'not found' });
      const images = Array.isArray(pd.images) ? pd.images : [];
      const hero_image_index = Number.isInteger(pd.hero_image_index) ? pd.hero_image_index : 0;
      return res.status(200).json({
        ok: true,
        content_id: id,
        title: pd.title || id.toUpperCase(),
        price: Number(pd.price || 0) || 0,
        currency: (pd.currency || 'INR').toString(),
        description: (pd.description || '').toString(),
        images,
        hero_image_index
      });
    } catch (e) {
      console.error('GET /api/product error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });
}
