import { google } from 'googleapis';
import { getOrCreateMediaIdForGcsPath } from '../lib/media.js';
import { sendImageByMediaId } from '../lib/wa.js';
import { Storage } from '@google-cloud/storage';
import multer from 'multer';
import { upsertCatalogItems } from '../firestore.js';

const SYNC_SHARED_SECRET = process.env.SYNC_SHARED_SECRET || '';
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || '';
const MEDIA_BASE_PREFIX = (process.env.MEDIA_BASE_PREFIX || '').replace(/^\/+|\/+$/g, '');

const storage = new Storage();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 }
});
function nowIso() { return new Date().toISOString(); }

function toIstString(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

export function registerAdminRoutes(app, adminDb) {
  // --- Admin: Upload product images (replace images array) ---
  app.post('/admin/product-images-upload', upload.array('images', 10), async (req, res) => {
    try {
      if (SYNC_SHARED_SECRET) {
        const token = req.get('X-Shared-Secret') || '';
        if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
      }
      if (!MEDIA_BUCKET) return res.status(500).json({ ok: false, error: 'MEDIA_BUCKET not configured' });

      const body = req.body || {};
      const rawSku = (body.sku || '').toString().trim();
      if (!rawSku) return res.status(400).json({ ok: false, error: 'sku required' });
      const sku = rawSku.toLowerCase();

      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) return res.status(400).json({ ok: false, error: 'no images provided' });

      const doc = await adminDb.collection('products').doc(sku).get();
      const existing = doc.exists ? doc.data() || {} : {};
      const typeKey = (existing.type || 'misc').toString().toLowerCase() || 'misc';

      const bucket = storage.bucket(MEDIA_BUCKET);
      const basePrefix = MEDIA_BASE_PREFIX ? `${MEDIA_BASE_PREFIX}/admin` : 'admin';
      const images = [];

      let index = 1;
      for (const f of files) {
        const fileObj = f || {};
        const originalName = (fileObj.originalname || 'image').toString();
        const mime = (fileObj.mimetype || 'image/jpeg').toString();
        let ext = 'jpg';
        if (mime.includes('png')) ext = 'png';
        else if (mime.includes('webp')) ext = 'webp';
        else if (mime.includes('jpeg')) ext = 'jpg';
        else if (originalName.toLowerCase().endsWith('.png')) ext = 'png';
        else if (originalName.toLowerCase().endsWith('.webp')) ext = 'webp';

        const objectName = `${basePrefix}/${typeKey}/${sku}/${index}.${ext}`;
        const fileRef = bucket.file(objectName);
        const buf = fileObj.buffer;
        await fileRef.save(buf, { contentType: mime, resumable: false, public: true });
        images.push(`gs://${MEDIA_BUCKET}/${objectName}`);
        index++;
      }

      await adminDb.collection('products').doc(sku).set(
        {
          images,
          hero_image_index: 0,
          updated_at: nowIso(),
        },
        { merge: true }
      );

      // Best-effort update of products_by_type hero_url and image_count
      if (existing.type) {
        const typeRef = adminDb.collection('products_by_type').doc(existing.type);
        const typeDoc = await typeRef.get();
        if (typeDoc.exists) {
          const data = typeDoc.data() || {};
          const items = Array.isArray(data.items)
            ? data.items.map((it) =>
                (it && it.sku === sku.toUpperCase()) || (it && (it.sku || '').toString().toLowerCase() === sku)
                  ? { ...it, hero_url: images[0] || '', image_count: images.length }
                  : it
              )
            : [];
          await typeRef.set({ ...data, items, updated_at: nowIso() }, { merge: true });
        }
      }

      return res.status(200).json({ ok: true, image_count: images.length });
    } catch (e) {
      console.error('product-images-upload error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

  // --- Admin: public test to send one image by GCS path via media_id cache ---
  app.post('/admin/test-media', async (req, res) => {
    try {
      if (SYNC_SHARED_SECRET) {
        const token = req.get('X-Shared-Secret') || '';
        if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
      }
      const to = (req.body?.to || '').toString().trim();
      const gcsPath = (req.body?.gcsPath || '').toString().trim();
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
      const MEDIA_BUCKET = process.env.MEDIA_BUCKET || '';
      const MEDIA_BASE_PREFIX = (process.env.MEDIA_BASE_PREFIX || '').replace(/^\/+|\/+$/g, '');
      const MEDIA_HERO_SUFFIX = process.env.MEDIA_HERO_SUFFIX || '-1.jpg';
      const storage = new Storage();

      async function listPrefixes(prefix) {
        const [files, , apiResponse] = await storage.bucket(MEDIA_BUCKET).getFiles({ prefix, delimiter: '/' });
        return (apiResponse?.prefixes || []).map(p => p);
      }
      async function listFiles(prefix) {
        const [files] = await storage.bucket(MEDIA_BUCKET).getFiles({ prefix });
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

      const base = MEDIA_BASE_PREFIX ? `${MEDIA_BASE_PREFIX}/` : '';
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
          const direct = objectNames.filter(n => n.split('/').length === skuPrefix.split('/').length);
          const images = (direct.length ? direct : objectNames)
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map(toGsPath);
          if (images.length === 0) continue;
          let heroIdx = 0;
          const idx = images.findIndex(u => u.toLowerCase().includes(MEDIA_HERO_SUFFIX.replace(/^\./, '').toLowerCase().split('.jpg')[0]));
          if (idx >= 0) heroIdx = idx;

          const prodDoc = {
            sku,
            type,
            title: sku,
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

      const batch = adminDb.batch();
      for (const w of batchWrites) {
        if (w.kind === 'product') {
          const ref = adminDb.collection('products').doc(w.data.sku);
          batch.set(ref, w.data, { merge: true });
        }
      }
      for (const [type, items] of Object.entries(productsByType)) {
        const ref = adminDb.collection('products_by_type').doc(type);
        batch.set(ref, { type, items, updated_at: nowIso() }, { merge: true });
      }
      const cfgRef = adminDb.collection('config').doc('types');
      batch.set(cfgRef, { types, updated_at: nowIso() }, { merge: true });

      await batch.commit();
      return res.status(200).json({ ok: true, types, counts: Object.fromEntries(Object.entries(productsByType).map(([k, v]) => [k, v.length])) });
    } catch (e) {
      console.error('reindex-gcs error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

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

  // --- Admin helpers ---
  async function getProductTitleCached(adminDb, sku, cache) {
    const key = (sku || '').toString().trim().toLowerCase();
    if (!key) return '';
    if (cache[key] !== undefined) return cache[key];
    try {
      const doc = await adminDb.collection('products').doc(key).get();
      if (!doc.exists) {
        cache[key] = key.toUpperCase();
        return cache[key];
      }
      const data = doc.data() || {};
      const title = (data.title || key.toUpperCase()).toString();
      cache[key] = title;
      return title;
    } catch (e) {
      console.error('getProductTitleCached error', { sku: key, error: e });
      cache[key] = key.toUpperCase();
      return cache[key];
    }
  }

  // --- Admin: Export products as CSV for pricing seeding ---
  app.get('/admin/export-products-csv', async (req, res) => {
    try {
      if (SYNC_SHARED_SECRET) {
        const token = req.get('X-Shared-Secret') || '';
        if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
      }
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

  // --- Admin: Upsert product (basic catalog editing) ---
  app.post('/admin/product-upsert', async (req, res) => {
    try {
      if (SYNC_SHARED_SECRET) {
        const token = req.get('X-Shared-Secret') || '';
        if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
      }

      const body = req.body || {};
      const rawSku = (body.sku || '').toString().trim();
      if (!rawSku) return res.status(400).json({ ok: false, error: 'sku required' });
      const sku = rawSku.toLowerCase();

      const title = (body.title || '').toString().trim() || sku.toUpperCase();
      const type = (body.type || '').toString().trim().toLowerCase();
      const priceNum = Number(body.price || 0) || 0;
      const active = body.active === false ? false : true;
      const pcsPerSetNum = Number(body.pcs_per_set || 0) || 0;
      const description = (body.description || '').toString();

      let sizesArr = [];
      if (Array.isArray(body.sizes)) {
        sizesArr = body.sizes.map((s) => (s || '').toString().trim()).filter(Boolean);
      } else if (typeof body.sizes === 'string') {
        sizesArr = body.sizes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const ref = adminDb.collection('products').doc(sku);
      await ref.set(
        {
          sku,
          title,
          type,
          price: priceNum,
          currency: 'INR',
          sizes: sizesArr,
          pcs_per_set: pcsPerSetNum,
          description,
          active,
          updated_at: nowIso(),
        },
        { merge: true }
      );

      // Best-effort update of products_by_type index so new/edited products show in browse list
      try {
        if (type) {
          const typeKey = type;
          const snap = await ref.get();
          const pd = snap.exists ? snap.data() || {} : {};
          const typeRef = adminDb.collection('products_by_type').doc(typeKey);
          const typeSnap = await typeRef.get();
          const tData = typeSnap.exists ? typeSnap.data() || {} : {};
          const oldItems = Array.isArray(tData.items) ? tData.items : [];
          const images = Array.isArray(pd.images) ? pd.images : [];
          const heroIdx = Number.isInteger(pd.hero_image_index) ? pd.hero_image_index : 0;
          const hero = images[heroIdx] || '';
          const skuUpper = (pd.sku || sku).toString().toUpperCase();
          const filtered = oldItems.filter((it) => {
            const itSku = (it && it.sku) ? it.sku.toString() : '';
            return itSku.toLowerCase() !== sku;
          });
          const newItem = {
            sku: skuUpper,
            title: pd.title || skuUpper,
            hero_url: hero,
            image_count: images.length,
          };
          const items = [...filtered, newItem];
          await typeRef.set({ ...tData, type: typeKey, items, updated_at: nowIso() }, { merge: true });
        }
      } catch (e) {
        console.error('product-upsert: failed to update products_by_type', { sku, type, error: e });
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('product-upsert error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

  // --- Admin: Delete product (catalog + images) ---
  app.post('/admin/product-delete', async (req, res) => {
    try {
      if (SYNC_SHARED_SECRET) {
        const token = req.get('X-Shared-Secret') || '';
        if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
      }

      const body = req.body || {};
      const rawSku = (body.sku || '').toString().trim();
      if (!rawSku) return res.status(400).json({ ok: false, error: 'sku required' });
      const sku = rawSku.toLowerCase();

      const docRef = adminDb.collection('products').doc(sku);
      const docSnap = await docRef.get();
      if (!docSnap.exists) {
        return res.status(200).json({ ok: true, deleted: false });
      }

      const data = docSnap.data() || {};
      const typeKey = (data.type || '').toString().toLowerCase();
      const images = Array.isArray(data.images) ? data.images : [];

      // Best-effort delete any GCS images that belong to this product
      if (MEDIA_BUCKET && images.length) {
        const bucket = storage.bucket(MEDIA_BUCKET);
        for (const u of images) {
          if (!u || typeof u !== 'string') continue;
          let objectName = '';
          if (u.startsWith('gs://')) {
            const without = u.slice('gs://'.length);
            const idx = without.indexOf('/');
            if (idx > 0) {
              const bucketName = without.slice(0, idx);
              const obj = without.slice(idx + 1);
              if (bucketName === MEDIA_BUCKET) objectName = obj;
            }
          } else if (!u.startsWith('http://') && !u.startsWith('https://')) {
            objectName = u.replace(/^\/+/, '');
          }
          if (!objectName) continue;
          try {
            await bucket.file(objectName).delete();
          } catch (e) {
            console.error('product-delete: failed to delete image', { sku, objectName, error: e });
          }
        }
      }

      await docRef.delete();

      // Remove from products_by_type items list
      if (typeKey) {
        try {
          const typeRef = adminDb.collection('products_by_type').doc(typeKey);
          const typeSnap = await typeRef.get();
          if (typeSnap.exists) {
            const tData = typeSnap.data() || {};
            const oldItems = Array.isArray(tData.items) ? tData.items : [];
            const skuLower = sku.toLowerCase();
            const skuUpper = sku.toUpperCase();
            const items = oldItems.filter((it) => {
              const itSku = (it && it.sku) ? it.sku.toString() : '';
              const l = itSku.toLowerCase();
              return l !== skuLower && itSku !== skuUpper;
            });
            await typeRef.set({ ...tData, items, updated_at: nowIso() }, { merge: true });
          }
        } catch (e) {
          console.error('product-delete: failed to update products_by_type', { sku, typeKey, error: e });
        }
      }

      return res.status(200).json({ ok: true, deleted: true });
    } catch (e) {
      console.error('product-delete error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

  // --- Admin: List products for catalog UI (read-only) ---
  app.get('/admin/products-list', async (req, res) => {
    try {
      if (SYNC_SHARED_SECRET) {
        const token = req.get('X-Shared-Secret') || '';
        if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
      }
      const snap = await adminDb.collection('products').get();
      const items = [];
      for (const d of snap.docs) {
        const p = d.data() || {};
        const images = Array.isArray(p.images) ? p.images : [];
        items.push({
          sku: p.sku || d.id,
          title: p.title || '',
          type: p.type || '',
          price: p.price || '',
          currency: (p.currency || 'INR').toString(),
          image_count: images.length,
          sizes: Array.isArray(p.sizes) ? p.sizes : [],
          pcs_per_set: Number(p.pcs_per_set || 0) || 0,
          description: (p.description || '').toString(),
          active: p.active === false ? false : true,
          updated_at: p.updated_at || null,
        });
      }
      return res.status(200).json({ ok: true, items });
    } catch (e) {
      console.error('products-list error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

  app.get('/admin/export-leads', async (req, res) => {
    try {
      if (SYNC_SHARED_SECRET) {
        const token = req.get('X-Shared-Secret') || '';
        if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
      }

      const LEADS_SHEET_ID = process.env.LEADS_SHEET_ID || '';
      if (!LEADS_SHEET_ID) {
        console.warn('export-leads: LEADS_SHEET_ID not set, skipping');
        return res.status(200).json({ ok: false, error: 'LEADS_SHEET_ID not configured' });
      }

      const now = nowIso();
      const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
      const cutoffIso = cutoff.toISOString();

      const auth = await google.auth.getClient({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      const sheets = google.sheets({ version: 'v4', auth });

      let retailCount = 0;
      let webNoOrderCount = 0;
      let cartNoOrderCount = 0;

      // --- Retail_Opted ---
      try {
        const snap = await adminDb.collection('sessions')
          .where('mode', '==', 'retail')
          .where('state', '==', 'start')
          .get();

        const retailRows = [];
        const retailToMark = [];

        for (const doc of snap.docs) {
          const data = doc.data() || {};
          if (data.retail_exported === true) continue;
          const updatedAtRaw = (data.updated_at || '').toString();
          if (updatedAtRaw && updatedAtRaw < cutoffIso) continue; // older than 3h
          const createdAt = toIstString(data.created_at || '');
          const waUserId = doc.id;
          const mode = data.mode || '';
          const state = data.state || '';
          const language = data.language || '';
          const locale = data.locale || '';
          const updatedAt = toIstString(updatedAtRaw);
          retailRows.push([createdAt, waUserId, mode, state, language, locale, updatedAt]);
          retailToMark.push(doc.ref);
        }

        if (retailRows.length) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: LEADS_SHEET_ID,
            range: 'Retail_Opted!A1',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: retailRows },
          });

          const batch = adminDb.batch();
          for (const ref of retailToMark) {
            batch.set(ref, { retail_exported: true, retail_exported_at: now }, { merge: true });
          }
          await batch.commit();
          retailCount = retailRows.length;
        }
      } catch (e) {
        console.error('export-leads: Retail_Opted export error', e);
      }

      // --- Web_No_Order ---
      try {
        const snap = await adminDb.collection('sessions')
          .where('state', '==', 'web_checkout')
          .get();

        const webRows = [];
        const webToMark = [];

        for (const doc of snap.docs) {
          const data = doc.data() || {};
          if (data.web_no_order_exported === true) continue;
          const updatedAtRaw = (data.updated_at || '').toString();
          if (!updatedAtRaw || updatedAtRaw < cutoffIso) continue; // older than 3h or missing

          const waUserId = doc.id;
          // Skip if any order exists for this wa_user_id
          const ordSnap = await adminDb.collection('orders')
            .where('wa_user_id', '==', waUserId)
            .limit(1)
            .get();
          if (!ordSnap.empty) continue;

          const createdAt = toIstString((data.created_at || '').toString());
          const mode = data.mode || '';
          const state = data.state || '';
          const language = data.language || '';
          const locale = data.locale || '';
          const notes = [language, locale].filter(Boolean).join('/');
          // Columns: Created at, WA User ID, Last State, Last Updated At, Has Order within 1hr?, Notes
          const updatedAt = toIstString(updatedAtRaw);
          webRows.push([createdAt, waUserId, state, updatedAt, 'No', notes]);
          webToMark.push(doc.ref);
        }

        if (webRows.length) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: LEADS_SHEET_ID,
            range: 'Web_No_Order!A1',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: webRows },
          });

          const batch = adminDb.batch();
          for (const ref of webToMark) {
            batch.set(ref, { web_no_order_exported: true, web_no_order_exported_at: now }, { merge: true });
          }
          await batch.commit();
          webNoOrderCount = webRows.length;
        }
      } catch (e) {
        console.error('export-leads: Web_No_Order export error', e);
      }

      // --- Cart_No_Order ---
      try {
        const snap = await adminDb.collection('carts')
          .where('updated_at', '>=', cutoffIso)
          .get();

        const cartRows = [];
        const cartToMark = [];
        const titleCache = {};

        for (const doc of snap.docs) {
          const data = doc.data() || {};
          if (data.cart_exported === true) continue;
          const items = Array.isArray(data.items) ? data.items : [];
          if (!items.length) continue;

          const waUserId = doc.id;
          // Skip if any order exists for this wa_user_id
          const ordSnap = await adminDb.collection('orders')
            .where('wa_user_id', '==', waUserId)
            .limit(1)
            .get();
          if (!ordSnap.empty) continue;

          const updatedAt = toIstString((data.updated_at || '').toString());
          const summaryParts = [];
          for (const it of items) {
            if (!it) continue;
            const rawSku = (it.sku || it.content_id || '').toString();
            const sku = rawSku.trim();
            const qtyNum = Number(it.qty || 0) || 0;
            const size = (it.size || '').toString().trim();
            if (!sku && !qtyNum && !size) continue;
            const title = await getProductTitleCached(adminDb, sku, titleCache);
            let seg = title || sku || '';
            if (size) seg = seg ? `${seg} (${size})` : size;
            if (qtyNum) seg = seg ? `${seg} * ${qtyNum}` : String(qtyNum);
            if (seg) summaryParts.push(seg);
          }
          const itemSummary = summaryParts.join(', ');
          const cartItemCount = items.length;
          const hasOrderedWithin3h = 'No';
          const notes = '';
          // Columns: Cart Updated At, WA User ID, Item Summary, Cart Item Count, Has ordered within 3hr?, Notes
          cartRows.push([updatedAt, waUserId, itemSummary, cartItemCount, hasOrderedWithin3h, notes]);
          cartToMark.push(doc.ref);
        }

        if (cartRows.length) {
          await sheets.spreadsheets.values.append({
            spreadsheetId: LEADS_SHEET_ID,
            range: 'Cart_No_Order!A1',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: cartRows },
          });

          const batch = adminDb.batch();
          for (const ref of cartToMark) {
            batch.set(ref, { cart_exported: true, cart_exported_at: now }, { merge: true });
          }
          await batch.commit();
          cartNoOrderCount = cartRows.length;
        }
      } catch (e) {
        console.error('export-leads: Cart_No_Order export error', e);
      }

      return res.status(200).json({ ok: true, retailCount, webNoOrderCount, cartNoOrderCount });
    } catch (e) {
      console.error('export-leads error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });
}

function validateRows(rows) {
  const errors = [];
  const upserts = [];
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
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
    const title = (r.title || '').toString().trim();
    const active = !!(r.active === true || r.active === 'TRUE' || r.active === 'true' || r.active === 1);
    const base = { sku, title, category: r.category || '', price, currency, moq, sizes: r.sizes || [], colors: r.colors || [], active, updated_at: nowIso() };
    const up = image_url ? { ...base, image_url } : base;
    upserts.push(up);
  }
  return { errors, upserts };
}
