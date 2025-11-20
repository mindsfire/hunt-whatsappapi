"use client";
import React, { useEffect, useMemo, useState } from "react";
import ProductCard, { Product as CardProduct } from "./components/ProductCard";

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
  sizes?: string[];
  pcs_per_set?: number;
};

type Product = {
  content_id: string;
  title: string;
  price: number;
  currency: string;
  image_url?: string;
  description?: string;
  sizes?: string[];
};

export default function Page() {
  const query = useQuery();
  const waId = query["u"] || "";
  const token = query["t"] || "";
  const lang = (query["lang"] || "en").toLowerCase();

  const [items, setItems] = useState<CartItem[]>([]);
  const [placedItems, setPlacedItems] = useState<CartItem[]>([]);
  const [bizName, setBizName] = useState("");
  const [bizAddr, setBizAddr] = useState("");
  const [gstin, setGstin] = useState("");
  const [bizError, setBizError] = useState(false);
  const [sizeErrors, setSizeErrors] = useState<number[]>([]);
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

  // Toast notification state
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(id);
  }, [toast]);

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
        const sorted = [...its].sort((a, b) => (a.price || 0) - (b.price || 0));
        setProds(sorted);
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
    return items.reduce((s, it) => {
      const qtySets = it.qty || 0;
      const pcsPerSet = it.pcs_per_set && it.pcs_per_set > 0 ? it.pcs_per_set : 1;
      const pricePerPiece = it.price || 0;
      return s + qtySets * pcsPerSet * pricePerPiece;
    }, 0);
  }, [items]);

  const formatCurrency = (code: string) => {
    if ((code || '').toUpperCase() === 'INR') return '₹';
    return code;
  };

  const onQtyChange = (idx: number, v: number) => {
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, qty: Math.max(1, Math.floor(v || 1)) } : it)));
  };
  const onSizeChange = (idx: number, v: string) => {
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, size: v } : it)));
    // Clear size error for this item once user selects a size
    setSizeErrors((errs) => errs.filter((i) => i !== idx));
  };

  const onAddProductSized = (p: Product, size: string, qty: number) => {
    if (!size) return;
    const addQty = qty > 0 ? qty : 1;
    setItems((arr) => {
      const idx = arr.findIndex((x) => x.content_id === p.content_id && x.size === size);
      if (idx >= 0) {
        const copy = [...arr];
        const cur = copy[idx];
        copy[idx] = { ...cur, qty: (cur.qty || 1) + addQty };
        return copy;
      }
      return [...arr, { ...p, size, qty: addQty } as CartItem];
    });
    setToast("Added to cart");
  };

  const onRemoveItem = (idx: number) => {
    setItems((arr) => arr.filter((_, i) => i !== idx));
    setSizeErrors((errs) => errs.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i)));
  };

  const placeOrder = async () => {
    if (!items.length || placing) return;
    // Validate that all items have a size selected
    const missingSizeIdxs = items.map((it, idx) => (!it.size ? idx : -1)).filter((i) => i >= 0);
    if (missingSizeIdxs.length) {
      setSizeErrors(missingSizeIdxs);
      return;
    }
    const name = bizName.trim();
    const address = bizAddr.trim();
    const gst = gstin.trim();
    setBizError(false);
    if (!name || !address) {
      setBizError(true);
      return;
    }
    try {
      setPlacing(true);
      const body = {
        u: waId,
        t: token,
        items: items.map((it) => ({ content_id: it.content_id, qty: it.qty, size: it.size })),
        business: { name, address, gstin: gst }
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
      setPlacedItems(items);
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "32px 0 32px",
          gap: 16,
        }}
      >
        <img
          src="/checkout/hunt-logo.jpg"
          alt="Hunt Wholesale"
          style={{ height: 160, maxWidth: 280, objectFit: "contain" }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            lineHeight: 1.1,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "Poppins, system-ui, -apple-system, sans-serif" }}>Wholesale</div>
          <div style={{ fontSize: 13, fontStyle: "italic", opacity: 0.75, fontFamily: "Poppins, system-ui, -apple-system, sans-serif" }}>Fabric Dealers</div>
        </div>
      </div>
      {!waId || !token ? (
        <div>Missing link parameters.</div>
      ) : loading ? (
        <div>Loading…</div>
      ) : orderId ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
          <div style={{ maxWidth: 520, width: "100%", background: "#0f1b12", border: "1px solid #1f8b4c", borderRadius: 8, padding: 16, textAlign: "center" }}>
            <div style={{ fontSize: 20, marginBottom: 6, fontWeight: 600 }}>Order placed successfully</div>
            <div style={{ marginBottom: 12 }}>Order ID: <b>{orderId}</b></div>
            <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 16 }}>
              One of our sales person will contact you for the payment and delivery of the products.
            </div>

            {!!placedItems.length && (
              <div style={{ textAlign: "left", marginTop: 4 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Bill summary</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {placedItems.map((it, i) => {
                    const qtySets = it.qty || 0;
                    const pcsPerSet = it.pcs_per_set && it.pcs_per_set > 0 ? it.pcs_per_set : 1;
                    const pricePerPiece = it.price || 0;
                    const lineTotal = qtySets * pcsPerSet * pricePerPiece;
                    return (
                      <div key={it.content_id + ':' + i} style={{ border: "1px solid #1f8b4c", borderRadius: 6, padding: 8, background: "#05140b" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <div style={{ fontWeight: 600 }}>{it.title}</div>
                          <div style={{ fontSize: 13 }}>
                            {formatCurrency(it.currency)} {pricePerPiece}
                            {it.pcs_per_set && it.pcs_per_set > 0 ? ` x ${it.pcs_per_set} Pcs Set` : ""}
                          </div>
                        </div>
                        <div style={{ fontSize: 13, opacity: 0.9 }}>
                          Size: {it.size || '-'} &nbsp;·&nbsp; Sets: {qtySets}
                        </div>
                        <div style={{ fontSize: 13, marginTop: 2 }}>
                          Line total: <b>{formatCurrency(it.currency)} {lineTotal.toFixed(2)}</b>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
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
            <div style={{ display: "flex", gap: 12, marginBottom: 12, justifyContent: "center" }}>
              <button
                onClick={() => { setBrowseType("indian"); setProdPage(1); }}
                style={{ padding: "12px 24px", borderRadius: 6, border: "1px solid #333", background: browseType === "indian" ? "#222" : "#111", color: "#eaeaea", fontWeight: 600, fontSize: 17 }}
              >
                Indian Fabric
              </button>
              <button
                onClick={() => { setBrowseType("imported"); setProdPage(1); }}
                style={{ padding: "12px 24px", borderRadius: 6, border: "1px solid #333", background: browseType === "imported" ? "#222" : "#111", color: "#eaeaea", fontWeight: 600, fontSize: 17 }}
              >
                Imported Fabric
              </button>
            </div>
            {prodLoading ? (
              <div>Loading products…</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                {prods.map((p) => (
                  <ProductCard
                    key={p.content_id}
                    product={p as CardProduct}
                    formatCurrency={formatCurrency}
                    onAddToCart={onAddProductSized}
                    onViewImages={openGallery}
                    onGoToCart={() => {
                      try {
                        const el = document.getElementById("cart");
                        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                      } catch (_) {}
                    }}
                  />
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

          <div id="cart" style={{ display: "flex", flexDirection: "column", gap: 12, paddingLeft: 8, paddingRight: 8 }}>
            {items.map((it, i) => (
              <div key={it.content_id + ':' + i} style={{ display: "flex", gap: 12, border: "1px solid #333", borderRadius: 8, padding: 12 }}>
                {it.image_url ? (
                  <img src={it.image_url} alt={it.title} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8 }} />
                ) : (
                  <div style={{ width: 72, height: 72, background: "#222", borderRadius: 8 }} />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontWeight: 600 }}>{it.title}</div>
                    <button
                      type="button"
                      onClick={() => onRemoveItem(i)}
                      style={{
                        background: "transparent",
                        border: 0,
                        color: "#f97373",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  <div style={{ opacity: 0.8, fontSize: 14 }}>
                    {formatCurrency(it.currency)} {it.price}
                    {it.pcs_per_set && it.pcs_per_set > 0 ? ` x ${it.pcs_per_set} Pcs Set` : ""}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                    <div style={{ display: "flex", gap: 8 }}>
                      <select
                        value={it.size || ""}
                        onChange={(e) => onSizeChange(i, e.target.value)}
                        style={{
                          padding: 6,
                          background: "#111",
                          color: "#eaeaea",
                          border: sizeErrors.includes(i) && !it.size ? "1px solid #b91c1c" : "1px solid #333",
                          borderRadius: 6,
                        }}
                      >
                        <option value="">Select size</option>
                        {((it.sizes && it.sizes.length) ? it.sizes : ["S", "M", "L", "XL", "2XL"]).map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          borderRadius: 6,
                          overflow: "hidden",
                          border: "1px solid #333",
                          background: "#111",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => onQtyChange(i, (it.qty || 1) - 1)}
                          disabled={(it.qty || 1) <= 1}
                          style={{
                            padding: "4px 8px",
                            border: 0,
                            background: "transparent",
                            color: (it.qty || 1) <= 1 ? "#555" : "#eaeaea",
                            cursor: (it.qty || 1) <= 1 ? "default" : "pointer",
                          }}
                        >
                          -
                        </button>
                        <div style={{ padding: "4px 10px", minWidth: 28, textAlign: "center", fontSize: 14 }}>
                          {it.qty || 1}
                        </div>
                        <button
                          type="button"
                          onClick={() => onQtyChange(i, (it.qty || 1) + 1)}
                          style={{
                            padding: "4px 8px",
                            border: 0,
                            background: "transparent",
                            color: "#eaeaea",
                            cursor: "pointer",
                          }}
                        >
                          +
                        </button>
                      </div>
                    </div>
                    {sizeErrors.includes(i) && !it.size && (
                      <div style={{ color: "#fca5a5", fontSize: 12 }}>Select size</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16, borderTop: "1px solid #333", paddingTop: 12, paddingLeft: 8, paddingRight: 8 }}>
            <div style={{ marginBottom: 8, fontWeight: 600, textAlign: "left" }}>Business Details</div>
            <input
              placeholder="Business name"
              value={bizName}
              onChange={(e) => setBizName(e.target.value)}
              maxLength={40}
              style={{ width: "100%", boxSizing: "border-box", padding: 11, background: "#111", color: "#eaeaea", border: bizError && !bizName.trim() ? "1px solid #b91c1c" : "1px solid #333", borderRadius: 6, marginBottom: 4, fontSize: 14, lineHeight: "1.4" }}
            />
            {bizError && !bizName.trim() && (
              <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 4 }}>Business Name is required</div>
            )}
            <input
              placeholder="GSTIN (optional)"
              value={gstin}
              onChange={(e) => setGstin(e.target.value)}
              maxLength={20}
              style={{ width: "100%", boxSizing: "border-box", padding: 11, background: "#111", color: "#eaeaea", border: "1px solid #333", borderRadius: 6, marginBottom: 8, fontSize: 14, lineHeight: "1.4" }}
            />
            <textarea
              placeholder="Provide your Delivery Address"
              value={bizAddr}
              onChange={(e) => setBizAddr(e.target.value)}
              rows={4}
              maxLength={200}
              style={{ width: "100%", boxSizing: "border-box", padding: 11, background: "#111", color: "#eaeaea", border: bizError && !bizAddr.trim() ? "1px solid #b91c1c" : "1px solid #333", borderRadius: 6, fontSize: 14, lineHeight: "1.4" }}
            />
            {bizError && !bizAddr.trim() && (
              <div style={{ color: "#fca5a5", fontSize: 12, marginTop: 4 }}>Delivery Address is required</div>
            )}
          </div>

          <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center", paddingLeft: 8, paddingRight: 8 }}>
            <div style={{ fontWeight: 600 }}>Total: {formatCurrency(items[0]?.currency || 'INR')} {total.toFixed(2)}</div>
            <button onClick={placeOrder} disabled={placing || items.length === 0} style={{ padding: "13px 28px", background: "#16a34a", color: "white", border: 0, borderRadius: 6, cursor: "pointer", fontSize: 15 }}>
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

      {/* Toast notification */}
      {toast && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            background: "#022c22",
            color: "#bbf7d0",
            padding: "10px 16px",
            borderRadius: 9999,
            border: "1px solid #16a34a",
            fontSize: 13,
            boxShadow: "0 10px 25px rgba(0,0,0,0.5)",
            zIndex: 1100,
          }}
        >
          {toast}
        </div>
      )}

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
