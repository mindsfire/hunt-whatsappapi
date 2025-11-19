export async function graphGet(url, token = process.env.WA_GRAPH_TOKEN) {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { }
  if (!res.ok) {
    console.error('Graph GET error', res.status, json || text);
    throw new Error(`Graph GET ${res.status}`);
  }
  return json || {};
}

export async function fetchSets(catalogId = process.env.WA_CATALOG_ID) {
  if (!catalogId) return [];
  const u = `https://graph.facebook.com/v20.0/${catalogId}/product_sets?fields=id,name&limit=200`;
  const j = await graphGet(u).catch(() => ({ data: [] }));
  return Array.isArray(j.data) ? j.data : [];
}

export async function fetchSetItems(setId) {
  if (!setId) return [];
  const u = `https://graph.facebook.com/v20.0/${setId}/products?fields=retailer_id&limit=30`;
  const j = await graphGet(u).catch(() => ({ data: [] }));
  const arr = Array.isArray(j.data) ? j.data : [];
  return arr.map(x => x && x.retailer_id).filter(Boolean);
}

export function parsePriceToNumber(priceStr) {
  if (priceStr === undefined || priceStr === null) return 0;
  if (typeof priceStr === 'number') return priceStr;
  const s = String(priceStr).replace(/[^0-9.]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchSetProductsDetailed(setId) {
  if (!setId) return [];
  let url = `https://graph.facebook.com/v20.0/${setId}/products?fields=id,retailer_id,name,price,currency,image_url,additional_image_urls&limit=100`;
  const out = [];
  for (let i = 0; i < 30 && url; i++) {
    const j = await graphGet(url).catch(() => ({}));
    const data = Array.isArray(j.data) ? j.data : [];
    for (const p of data) {
      out.push({
        id: p.id,
        retailer_id: p.retailer_id,
        name: p.name,
        price: parsePriceToNumber(p.price),
        currency: p.currency || 'INR',
        image_url: p.image_url || '',
        additional_image_urls: Array.isArray(p.additional_image_urls) ? p.additional_image_urls : []
      });
    }
    url = (j.paging && j.paging.next) ? j.paging.next : '';
  }
  return out;
}
