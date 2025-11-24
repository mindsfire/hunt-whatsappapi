import { google } from 'googleapis';
import { fetchSets, fetchSetProductsDetailed } from '../lib/graph.js';
import { getOrCreateMediaIdForGcsPath } from '../lib/media.js';
import { sendImageByMediaId } from '../lib/wa.js';
import { Storage } from '@google-cloud/storage';
import multer from 'multer';
import { upsertCatalogItems } from '../firestore.js';

const SYNC_SHARED_SECRET = process.env.SYNC_SHARED_SECRET || '';
const WA_GRAPH_TOKEN = process.env.WA_GRAPH_TOKEN || process.env.WA_CATALOG_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || '';
const WA_CATALOG_ID = process.env.WA_CATALOG_ID || '';
const WA_SET_IMPORTED_ID = process.env.WA_SET_IMPORTED_ID || '';
const WA_SET_INDIAN_ID = process.env.WA_SET_INDIAN_ID || '';
const WA_SET_IMPORTED_NAME = process.env.WA_SET_IMPORTED_NAME || 'Imported brands';
const WA_SET_INDIAN_NAME = process.env.WA_SET_INDIAN_NAME || 'Indian brands';

const MEDIA_BUCKET = process.env.MEDIA_BUCKET || '';
const MEDIA_BASE_PREFIX = (process.env.MEDIA_BASE_PREFIX || '').replace(/^\/+|\/+$/g, '');

const storage = new Storage();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 }
});

function nowIso() { return new Date().toISOString(); }

function buildCatalogObjectName(typeKey, sku, index) {
  const base = MEDIA_BASE_PREFIX ? `${MEDIA_BASE_PREFIX}/cm` : 'cm';
  return `${base}/${typeKey}/${sku}/${index}.jpg`;
}

async function mirrorImageToGcs(srcUrl, typeKey, sku, index) {
  if (!MEDIA_BUCKET || !srcUrl) return null;
  try {
    const res = await fetch(srcUrl);
    if (!res.ok) {
      console.error('mirrorImageToGcs: fetch failed', { srcUrl, status: res.status });
      return null;
    }
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const objectName = buildCatalogObjectName(typeKey, sku, index);
    const bucket = storage.bucket(MEDIA_BUCKET);
    const file = bucket.file(objectName);
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    await file.save(buf, { contentType, resumable: false, public: true });
    return `gs://${MEDIA_BUCKET}/${objectName}`;
  } catch (e) {
    console.error('mirrorImageToGcs: error', { srcUrl, error: e });
    return null;
  }
}

function parseDescriptionAndSizes(descRaw) {
  const desc = (descRaw || '').toString();

  // Try to find patterns like:
  //  "Available in sizes: M, L, XL, 2XL" or "Sizes: M,L,XL,2XL"
  const m = desc.match(/available in sizes\s*:?\s*([A-Za-z0-9,\s]+)/i) ||
            desc.match(/sizes\s*:?\s*([A-Za-z0-9,\s]+)/i);

  // Parse sizes list if present
  let sizes = [];
  let cleanDesc = desc;
  if (m) {
    const sizesPart = m[1] || '';
    sizes = sizesPart
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Remove the matched "sizes" segment from the description for cleaner display
    cleanDesc = desc.replace(m[0], '').replace(/\s*\|\s*$/, '').trim();
  }

  // Parse pcs per set from patterns like "8 Pcs set" / "8 pcs set"
  let pcsPerSet = 0;
  // Support variants like:
  //  "8 Pcs set", "8 pcs", "8pc set", "8pcs", "8 pieces set"
  //  with or without space before/after the unit and optional "set" word.
  const pcsMatch = desc.match(/(\d+)\s*(pc|pcs?|pieces?)\b(?:\s*set)?/i);
  if (pcsMatch) {
    const n = parseInt(pcsMatch[1], 10);
    if (Number.isFinite(n) && n > 0) pcsPerSet = n;
  }

  return { description: cleanDesc, sizes, pcs_per_set: pcsPerSet };
}

export function registerAdminRoutes(app, adminDb) {
  // --- Admin: Sync products from Commerce Manager (Catalog) into Firestore ---
  // Usage: GET /admin/sync-from-cm
  // Auth: header X-Shared-Secret must equal SYNC_SHARED_SECRET if set
  app.get('/admin/sync-from-cm', async (req, res) => {
    try {
      if (SYNC_SHARED_SECRET) {
        const token = req.get('X-Shared-Secret') || '';
        if (token !== SYNC_SHARED_SECRET) return res.sendStatus(401);
      }
      if (!WA_GRAPH_TOKEN || !WA_CATALOG_ID) {
        return res.status(400).json({ ok: false, error: 'WA_GRAPH_TOKEN and WA_CATALOG_ID required' });
      }

      async function resolveSetIdByName(name) {
        const sets = await fetchSets();
        const found = sets.find(s => (s.name || '').toLowerCase() === String(name || '').toLowerCase());
        return (found && found.id) || '';
      }

      let importedSetId = WA_SET_IMPORTED_ID;
      if (!importedSetId && WA_SET_IMPORTED_NAME) importedSetId = await resolveSetIdByName(WA_SET_IMPORTED_NAME);
      let indianSetId = WA_SET_INDIAN_ID;
      if (!indianSetId && WA_SET_INDIAN_NAME) indianSetId = await resolveSetIdByName(WA_SET_INDIAN_NAME);

      const [imported, indian] = await Promise.all([
        importedSetId ? fetchSetProductsDetailed(importedSetId) : Promise.resolve([]),
        indianSetId ? fetchSetProductsDetailed(indianSetId) : Promise.resolve([])
      ]);

      const types = [];
      const productsByType = {};
      const batch = adminDb.batch();

      async function upsertType(typeKey, arr) {
        if (!arr || !arr.length) return;
        types.push(typeKey);
        const itemsMini = [];
        for (const p of arr) {
          const sku = String(p.retailer_id || '').toLowerCase();
          if (!sku) continue;
          const srcImages = [p.image_url, ...(Array.isArray(p.additional_image_urls) ? p.additional_image_urls : [])].filter(Boolean);
          let images = [];
          if (srcImages.length && MEDIA_BUCKET) {
            const mirrored = [];
            for (let i = 0; i < srcImages.length; i++) {
              const m = await mirrorImageToGcs(srcImages[i], typeKey, sku, i + 1);
              if (m) mirrored.push(m);
            }
            images = mirrored.length ? mirrored : srcImages;
          } else {
            images = srcImages;
          }
          const heroIdx = 0;
          const parsed = parseDescriptionAndSizes(p.description);
          const prodDoc = {
            sku,
            type: typeKey,
            title: p.name || sku.toUpperCase(),
            description: parsed.description,
            sizes: parsed.sizes,
            pcs_per_set: parsed.pcs_per_set || 0,
            price: Number(p.price || 0) || 0,
            currency: (p.currency || 'INR').toUpperCase(),
            images,
            hero_image_index: heroIdx,
            active: true,
            updated_at: nowIso()
          };
          const ref = adminDb.collection('products').doc(sku);
          batch.set(ref, prodDoc, { merge: true });
          itemsMini.push({ sku, title: prodDoc.title, hero_url: images[heroIdx] || '', image_count: images.length });
        }
        productsByType[typeKey] = itemsMini;
        const refType = adminDb.collection('products_by_type').doc(typeKey);
        batch.set(refType, { type: typeKey, items: itemsMini, updated_at: nowIso() }, { merge: true });
      }

      await upsertType('imported', imported);
      await upsertType('indian', indian);

      const cfgRef = adminDb.collection('config').doc('types');
      if (types.length) batch.set(cfgRef, { types, updated_at: nowIso() }, { merge: true });

      await batch.commit();

      const importedCount = (imported || []).length;
      const indianCount = (indian || []).length;
      const syncAt = nowIso();
      try {
        const syncRef = adminDb.collection('config').doc('sync_from_cm');
        await syncRef.set({
          last_sync_at: syncAt,
          last_counts: { imported: importedCount, indian: indianCount }
        }, { merge: true });
      } catch (e) {
        console.error('sync-from-cm: failed to persist sync metadata', e);
      }

      return res.status(200).json({ ok: true, counts: { imported: importedCount, indian: indianCount }, lastSyncAt: syncAt });
    } catch (e) {
      console.error('sync-from-cm error', e);
      return res.status(200).json({ ok: false, error: String(e) });
    }
  });

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

  // --- Admin: Get last Commerce Manager sync status ---
  // Usage: GET /admin/sync-status
  // No shared-secret required; this only returns metadata (timestamp + counts).
  app.get('/admin/sync-status', async (req, res) => {
    try {
      const doc = await adminDb.collection('config').doc('sync_from_cm').get();
      if (!doc.exists) {
        return res.status(200).json({ ok: true, lastSyncAt: null, counts: { imported: 0, indian: 0 } });
      }
      const data = doc.data() || {};
      const lastSyncAt = data.last_sync_at || null;
      const lastCounts = data.last_counts || {};
      const imported = typeof lastCounts.imported === 'number' ? lastCounts.imported : 0;
      const indian = typeof lastCounts.indian === 'number' ? lastCounts.indian : 0;
      return res.status(200).json({ ok: true, lastSyncAt, counts: { imported, indian } });
    } catch (e) {
      console.error('sync-status error', e);
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
