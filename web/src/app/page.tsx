"use client";
import React, { useEffect, useMemo, useState } from "react";

function useQuery() {
  const [query, setQuery] = useState<Record<string, string>>({});
  useEffect(() => {
    const u = new URL(window.location.href);
    const q: Record<string, string> = {};
    u.searchParams.forEach((v, k) => (q[k] = v));
    setQuery(q);
  }, []);
  return query;
}

type CartItem = {
  content_id: string;
  title: string;
  price: number;
  currency: string;
  image_url?: string;
  size?: string;
  qty?: number;
};

type Product = {
  content_id: string;
  title: string;
  price: number;
  currency: string;
  image_url?: string;
};

export default function Page() {
  const query = useQuery();
  const waId = query["u"] || "";
  const token = query["t"] || "";
  const lang = (query["lang"] || "en").toLowerCase();

  const [items, setItems] = useState<CartItem[]>([]);
  const [bizName, setBizName] = useState("");
  const [bizAddr, setBizAddr] = useState("");
  const [loading, setLoading] = useState(true);
  const [placing, setPlacing] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Browse state
  const [browseType, setBrowseType] = useState<"indian" | "imported">("indian");
  const [prods, setProds] = useState<Product[]>([]);
  const [prodLoading, setProdLoading] = useState(false);
  const [prodPage, setProdPage] = useState(1);
  const [prodPageCount, setProdPageCount] = useState(1);

  // Gallery modal state
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryItem, setGalleryItem] = useState<{ content_id: string; title: string; images: string[]; hero_index: number } | null>(null);
  const [galleryIndex, setGalleryIndex] = useState(0);

  useEffect(() => {
    if (!waId || !token) return;
    setLoading(true);
    fetch(`/api/cart?u=${encodeURIComponent(waId)}&t=${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Cart error ${r.status}`);
        return r.json();
      })
      .then((j) => {
        const its: CartItem[] = Array.isArray(j.items) ? j.items : [];
        // Ensure defaults
        const norm = its.map((it) => ({ ...it, qty: it.qty || 1 }));
        setItems(norm);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [waId, token]);

  // Fetch products for browse
  useEffect(() => {
    if (!waId || !token) return;
    setProdLoading(true);
    fetch(`/api/products?u=${encodeURIComponent(waId)}&t=${encodeURIComponent(token)}&type=${browseType}&page=${prodPage}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Products error ${r.status}`);
        return r.json();
      })
      .then((j) => {
        const its: Product[] = Array.isArray(j.items) ? j.items : [];
        setProds(its);
        setProdPageCount(Number(j.pageCount || 1));
        setProdLoading(false);
      })
      .catch(() => setProdLoading(false));
  }, [waId, token, browseType, prodPage]);

  const openGallery = async (content_id: string) => {
    try {
      const r = await fetch(`/api/product?id=${encodeURIComponent(content_id)}&u=${encodeURIComponent(waId)}&t=${encodeURIComponent(token)}`);
      if (!r.ok) throw new Error(`Product error ${r.status}`);
      const j = await r.json();
      const images: string[] = Array.isArray(j.images) ? j.images : [];
      const hero = Number.isInteger(j.hero_image_index) ? j.hero_image_index : 0;
      setGalleryItem({ content_id, title: j.title || content_id.toUpperCase(), images, hero_index: hero });
      setGalleryIndex(Math.max(0, Math.min(hero, images.length - 1)));
      setGalleryOpen(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const total = useMemo(() => {
    return items.reduce((s, it) => s + (it.qty || 0) * (it.price || 0), 0);
  }, [items]);

  const onQtyChange = (idx: number, v: number) => {
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, qty: Math.max(1, Math.floor(v || 1)) } : it)));
  };
  const onSizeChange = (idx: number, v: string) => {
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, size: v } : it)));
  };

  const onAddProduct = (p: Product) => {
    setItems((arr) => {
      const idx = arr.findIndex((x) => x.content_id === p.content_id);
      if (idx >= 0) {
        const copy = [...arr];
        const cur = copy[idx];
        copy[idx] = { ...cur, qty: (cur.qty || 1) + 1 };
        return copy;
      }
      return [...arr, { ...p, qty: 1 } as CartItem];
    });
  };

  const placeOrder = async () => {
    if (!items.length || placing) return;
    const name = bizName.trim();
    const address = bizAddr.trim();
    if (!name || !address) {
      alert("Please enter Business name and Full address before placing the order.");
      return;
    }
    try {
      setPlacing(true);
      const body = {
        u: waId,
        t: token,
        items: items.map((it) => ({ content_id: it.content_id, qty: it.qty, size: it.size })),
        business: { name, address }
      };
      const resp = await fetch(`/api/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await resp.json();
      if (!j.ok) {
        alert(j.error || "Failed to place order");
        return;
      }
      setOrderId(j.id || "");
      setItems([]);
    } catch (e) {
      console.error(e);
      alert("Unexpected error placing order");
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "8px 0 16px", gap: 12 }}>
        <img
          src="/checkout/hunt-logo.jpg"
          alt="Hunt Wholesale"
          style={{ height: 56, maxWidth: 240, objectFit: "contain" }}
        />
        <h1 style={{ margin: 0 }}>Checkout</h1>
      </div>
      {!waId || !token ? (
        <div>Missing link parameters.</div>
      ) : loading ? (
        <div>Loading…</div>
      ) : orderId ? (
        <div style={{ padding: 16, background: "#0f1b12", border: "1px solid #1f8b4c", borderRadius: 8 }}>
          <div style={{ fontSize: 18, marginBottom: 8 }}>Order placed successfully</div>
          <div>Order ID: <b>{orderId}</b></div>
        </div>
      ) : (
        <>
          {error && (
            <div style={{ padding: 12, background: "#2a0f0f", border: "1px solid #b34141", borderRadius: 8, marginBottom: 12 }}>
              {error}
            </div>
          )}

          {/* Browse */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button
                onClick={() => { setBrowseType("indian"); setProdPage(1); }}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #333", background: browseType === "indian" ? "#222" : "#111", color: "#eaeaea" }}
              >
                Indian
              </button>
              <button
                onClick={() => { setBrowseType("imported"); setProdPage(1); }}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #333", background: browseType === "imported" ? "#222" : "#111", color: "#eaeaea" }}
              >
                Imported
              </button>
            </div>
            {prodLoading ? (
              <div>Loading products…</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                {prods.map((p) => (
                  <div key={p.content_id} style={{ border: "1px solid #333", borderRadius: 8, padding: 12 }}>
                    {p.image_url ? (
                      <img src={p.image_url} alt={p.title} style={{ width: "100%", height: 140, objectFit: "cover", borderRadius: 6, marginBottom: 8 }} />
                    ) : (
                      <div style={{ width: "100%", height: 140, background: "#222", borderRadius: 6, marginBottom: 8 }} />
                    )}
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{p.title}</div>
                    <div style={{ opacity: 0.8, fontSize: 14, marginBottom: 8 }}>{p.currency} {p.price}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => onAddProduct(p)} style={{ padding: "6px 10px", background: "#2563eb", color: "white", border: 0, borderRadius: 6, cursor: "pointer" }}>
                        Add
                      </button>
                      <button onClick={() => openGallery(p.content_id)} style={{ padding: "6px 10px", background: "#374151", color: "white", border: 0, borderRadius: 6, cursor: "pointer" }}>
                        View Images
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {prodPageCount > 1 && (
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
                <button disabled={prodPage <= 1} onClick={() => setProdPage((p) => Math.max(1, p - 1))} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #333", background: "#111", color: "#eaeaea" }}>Prev</button>
                <div style={{ alignSelf: "center", opacity: 0.8 }}>Page {prodPage} / {prodPageCount}</div>
                <button disabled={prodPage >= prodPageCount} onClick={() => setProdPage((p) => Math.min(prodPageCount, p + 1))} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #333", background: "#111", color: "#eaeaea" }}>Next</button>
              </div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingLeft: 8, paddingRight: 8 }}>
            {items.map((it, i) => (
              <div key={it.content_id} style={{ display: "flex", gap: 12, border: "1px solid #333", borderRadius: 8, padding: 12 }}>
                {it.image_url ? (
                  <img src={it.image_url} alt={it.title} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8 }} />
                ) : (
                  <div style={{ width: 72, height: 72, background: "#222", borderRadius: 8 }} />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{it.title}</div>
                  <div style={{ opacity: 0.8, fontSize: 14 }}>
                    {it.currency} {it.price}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <select value={it.size || ""} onChange={(e) => onSizeChange(i, e.target.value)} style={{ padding: 6, background: "#111", color: "#eaeaea", border: "1px solid #333", borderRadius: 6 }}>
                      <option value="">Select size</option>
                      <option>S</option>
                      <option>M</option>
                      <option>L</option>
                      <option>XL</option>
                      <option>2XL</option>
                    </select>
                    <input type="number" min={1} value={it.qty || 1} onChange={(e) => onQtyChange(i, Number(e.target.value))} style={{ width: 90, padding: 6, background: "#111", color: "#eaeaea", border: "1px solid #333", borderRadius: 6 }} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16, borderTop: "1px solid #333", paddingTop: 12, paddingLeft: 8, paddingRight: 8 }}>
            <div style={{ marginBottom: 8, fontWeight: 600, textAlign: "left" }}>Business</div>
            <input
              placeholder="Business name"
              value={bizName}
              onChange={(e) => setBizName(e.target.value)}
              maxLength={40}
              style={{ width: "100%", boxSizing: "border-box", padding: 11, background: "#111", color: "#eaeaea", border: "1px solid #333", borderRadius: 6, marginBottom: 8, fontSize: 14, lineHeight: "1.4" }}
            />
            <textarea
              placeholder="Full address"
              value={bizAddr}
              onChange={(e) => setBizAddr(e.target.value)}
              rows={4}
              maxLength={200}
              style={{ width: "100%", boxSizing: "border-box", padding: 11, background: "#111", color: "#eaeaea", border: "1px solid #333", borderRadius: 6, fontSize: 14, lineHeight: "1.4" }}
            />
          </div>

          <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center", paddingLeft: 8, paddingRight: 8 }}>
            <div style={{ fontWeight: 600 }}>Total: {total.toFixed(2)}</div>
            <button onClick={placeOrder} disabled={placing || items.length === 0 || !bizName.trim() || !bizAddr.trim()} style={{ padding: "13px 28px", background: "#16a34a", color: "white", border: 0, borderRadius: 6, cursor: "pointer", fontSize: 15 }}>
              {placing ? "Placing…" : "Place Order"}
            </button>
          </div>
        </>
      )}

      {/* Company footer */}
      <div style={{ marginTop: 32, padding: "16px 12px 24px", borderTop: "1px solid #222", fontSize: 12, lineHeight: 1.5, color: "#9ca3af", textAlign: "center" }}>
        <div style={{ fontWeight: 600, color: "#e5e5e5", marginBottom: 4 }}>Mans Impex - Wholesale Dealers</div>
        <div style={{ marginBottom: 6 }}>GST - 29HCSPS6716N1ZA</div>
        <div>Reg Address: Ward No 17, Assessment No 10323, Kalenahalli Hosa Badavane</div>
        <div>Hassan Mysore Highway, Krishnarajanagara, Mysuru - 571602</div>
        <div>Karnataka, India</div>
      </div>

      {/* Gallery modal */}
      {galleryOpen && galleryItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 1000 }}>
          <div style={{ background: '#0b0b0b', border: '1px solid #333', borderRadius: 10, width: 'min(960px, 95vw)', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #222' }}>
              <div style={{ fontWeight: 600, flex: 1 }}>{galleryItem.title}</div>
              <button onClick={() => setGalleryOpen(false)} style={{ background: 'transparent', color: '#eaeaea', border: 0, fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 12, padding: 12 }}>
              {/* Thumbnails */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', maxHeight: '70vh' }}>
                {galleryItem.images.map((img, idx) => (
                  <img key={idx} src={img} onClick={() => setGalleryIndex(idx)} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: idx === galleryIndex ? '2px solid #16a34a' : '1px solid #333', cursor: 'pointer' }} />
                ))}
              </div>
              {/* Main image */}
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 360 }}>
                {galleryItem.images[galleryIndex] ? (
                  <img src={galleryItem.images[galleryIndex]} style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 8, border: '1px solid #333' }} />
                ) : (
                  <div style={{ width: '100%', height: 360, background: '#111', borderRadius: 8 }} />
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
