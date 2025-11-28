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
  source_type?: string;
};

export default function Page() {
  const WA_CHAT_URL = "https://wa.me/message/UJZ3AUOEXVPUN1";
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
  const [gstError, setGstError] = useState<string | null>(null);
  const [sizeErrors, setSizeErrors] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [placing, setPlacing] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Browse state
  const [browseType, setBrowseType] = useState<"all" | "indian" | "imported">("all");
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
  const [toastError, setToastError] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => {
      setToast(null);
      setToastError(false);
    }, 2000);
    return () => clearTimeout(id);
  }, [toast]);

  // Persist cart to backend for abandoned-cart tracking and refresh persistence
  useEffect(() => {
    if (!waId || !token) return;
    // Don't send before initial cart load has completed
    if (loading) return;
    const handler = setTimeout(() => {
      const payload = {
        u: waId,
        t: token,
        items: items.map((it) => ({ content_id: it.content_id, qty: it.qty, size: it.size })),
      };
      fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(handler);
  }, [waId, token, items, loading]);

  useEffect(() => {
    if (!waId || !token) return;
    setLoading(true);
    fetch(`/api/cart?u=${encodeURIComponent(waId)}&t=${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (!r.ok) {
          let msg = `Cart error ${r.status}`;
          try {
            const j = await r.json();
            if (j && typeof j.error === 'string') msg = j.error;
          } catch (_) {}
          throw new Error(msg);
        }
        return r.json();
      })
      .then((j) => {
        const its: CartItem[] = Array.isArray(j.items) ? j.items : [];
        // Ensure defaults
        const norm = its.map((it) => ({ ...it, qty: it.qty || 1 }));
        setItems(norm);

        const biz = j.business || {};
        setBizName((prev) => prev || (biz.name || ""));
        setBizAddr((prev) => prev || (biz.address || ""));
        setGstin((prev) => prev || (biz.gstin ? String(biz.gstin).toUpperCase() : ""));

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
    const base = `/api/products?u=${encodeURIComponent(waId)}&t=${encodeURIComponent(token)}&type=${browseType}&page=${prodPage}`;
    const url = browseType === "all" ? `${base}&pageSize=15` : base;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) {
          let msg = `Products error ${r.status}`;
          try {
            const j = await r.json();
            if (j && typeof j.error === 'string') msg = j.error;
          } catch (_) {}
          throw new Error(msg);
        }
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
      const pricePerPiece = it.price || 0; // Catalog price is treated as per piece
      return s + qtySets * pcsPerSet * pricePerPiece;
    }, 0);
  }, [items]);

  const placedTotal = useMemo(() => {
    return placedItems.reduce((s, it) => {
      const qtySets = it.qty || 0;
      const pcsPerSet = it.pcs_per_set && it.pcs_per_set > 0 ? it.pcs_per_set : 1;
      const pricePerPiece = it.price || 0; // Catalog price is treated as per piece
      return s + qtySets * pcsPerSet * pricePerPiece;
    }, 0);
  }, [placedItems]);

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
    setToastError(false);
    setToast("Added to cart");
  };

  const onRemoveItem = (idx: number) => {
    setItems((arr) => arr.filter((_, i) => i !== idx));
    setSizeErrors((errs) => errs.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i)));
  };

  const placeOrder = async () => {
    if (placing) return;
    if (!items.length) {
      setToastError(true);
      setToast("Add at least one item to your cart before placing order.");
      return;
    }
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
    setGstError(null);

    // Business name: allow only letters and spaces
    const nameValid = !!name && /^[A-Za-z\s]+$/.test(name);
    if (!nameValid || !address) {
      setBizError(true);
      return;
    }

    // GSTIN: optional, but if provided must be a valid 15-character uppercase GST number
    if (gst) {
      const gstPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[A-Z0-9]{1}$/;
      if (!gstPattern.test(gst)) {
        setGstError("Enter a valid 15-character GSTIN in UPPERCASE without spaces or special characters.");
        return;
      }
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
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          margin: "8px 0 32px",
        }}
      >
        <img
          src="/checkout/hunt-logo-rectangular.jpg"
          alt="Mans Impex logo"
          style={{ height: 52, maxWidth: 260, objectFit: "contain", display: "block", marginBottom: 16 }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            lineHeight: 1.2,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 26,
              fontWeight: 700,
              fontFamily: "Poppins, system-ui, -apple-system, sans-serif",
            }}
          >
            Mans Impex
          </div>
          <div
            style={{
              fontSize: 13,
              marginTop: 4,
              fontFamily: "Poppins, system-ui, -apple-system, sans-serif",
            }}
          >
            Manufacturer | Exporters
          </div>
          <div
            style={{
              fontSize: 12,
              marginTop: 2,
              opacity: 0.85,
              fontFamily: "Poppins, system-ui, -apple-system, sans-serif",
            }}
          >
            Shirts, T-Shirts, Trousers & Sportswear
          </div>
        </div>
      </div>
      {!waId || !token ? (
        <div>Missing link parameters.</div>
      ) : loading ? (
        <div>Loading…</div>
      ) : error && error.startsWith('Error: checkout_session_') ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
          <div style={{ maxWidth: 520, width: "100%", background: "#0f1b12", border: "1px solid #1f8b4c", borderRadius: 8, padding: 16, textAlign: "center" }}>
            <div style={{ fontSize: 18, marginBottom: 8, fontWeight: 600 }}>Your session has expired</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 10 }}>
              For security, your checkout link can only be used once and for a limited time.
            </div>
            <div style={{ fontSize: 13, opacity: 0.9 }}>
              Please go back to your WhatsApp chat with us and request a new checkout link to continue browsing and placing orders.
            </div>
            <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
              <a
                href={WA_CHAT_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open WhatsApp chat to request a new checkout link"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "9px 18px",
                  borderRadius: 9999,
                  background: "#16a34a",
                  color: "#f9fafb",
                  textDecoration: "none",
                  fontSize: 14,
                  fontWeight: 600,
                  marginTop: 4,
                }}
              >
                <img
                  src="/checkout/Digital_Inline_White.svg"
                  alt="WhatsApp"
                  style={{ height: 18, width: "auto", display: "block" }}
                />
              </a>
            </div>
          </div>
        </div>
      ) : orderId ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
          <div style={{ maxWidth: 520, width: "100%", background: "#0f1b12", border: "1px solid #1f8b4c", borderRadius: 8, padding: 16, textAlign: "center" }}>
            <div style={{ fontSize: 20, marginBottom: 6, fontWeight: 600 }}>Order placed successfully</div>
            <div style={{ marginBottom: 12 }}>Order ID: <b>{orderId}</b></div>
            <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 16 }}>
              One of our sales person will contact you for the payment and delivery of the products.
            </div>

            {!!placedItems.length && (
              <>
                <div style={{ textAlign: "left", marginTop: 4 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>Bill summary</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {placedItems.map((it, i) => {
                      const qtySets = it.qty || 0;
                      const pcsPerSet = it.pcs_per_set && it.pcs_per_set > 0 ? it.pcs_per_set : 1;
                      const pricePerPiece = it.price || 0; // Catalog price is per piece
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
                <div style={{ marginTop: 14, fontWeight: 600, fontSize: 16 }}>
                  Grand total: {formatCurrency(placedItems[0]?.currency || 'INR')} {placedTotal.toFixed(2)}
                </div>
              </>
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
                onClick={() => { setBrowseType("all"); setProdPage(1); }}
                style={{ padding: "12px 24px", borderRadius: 6, border: "1px solid #333", background: browseType === "all" ? "#222" : "#111", color: "#eaeaea", fontWeight: 600, fontSize: 17 }}
              >
                All
              </button>
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
                    showTypePill={browseType === "all"}
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
                  <div style={{ fontSize: 13, marginTop: 2 }}>
                    {(() => {
                      const qtySets = it.qty || 0;
                      const pcsPerSet = it.pcs_per_set && it.pcs_per_set > 0 ? it.pcs_per_set : 1;
                      const pricePerPiece = it.price || 0;
                      const lineTotal = qtySets * pcsPerSet * pricePerPiece;
                      return <b>{formatCurrency(it.currency)} {lineTotal.toFixed(2)}</b>;
                    })()}
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
              style={{ width: "100%", boxSizing: "border-box", padding: 11, background: "#1f2937", color: "#ffffff", border: bizError && (!bizName.trim() || !/^[A-Za-z\s]+$/.test(bizName.trim())) ? "1px solid #b91c1c" : "1px solid #9ca3af", borderRadius: 6, marginBottom: 4, fontSize: 14, lineHeight: "1.4" }}
            />
            {bizError && !bizName.trim() && (
              <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 4 }}>Business Name is required</div>
            )}
            {bizError && bizName.trim() && !/^[A-Za-z\s]+$/.test(bizName.trim()) && (
              <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 4 }}>Business Name can contain letters and spaces only</div>
            )}
            <input
              placeholder="GSTIN (optional)"
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              maxLength={20}
              style={{ width: "100%", boxSizing: "border-box", padding: 11, background: "#1f2937", color: "#ffffff", border: gstError ? "1px solid #b91c1c" : "1px solid #9ca3af", borderRadius: 6, marginBottom: 4, fontSize: 14, lineHeight: "1.4" }}
            />
            {gstError && (
              <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 4 }}>{gstError}</div>
            )}
            <textarea
              placeholder="Provide your Delivery Address"
              value={bizAddr}
              onChange={(e) => setBizAddr(e.target.value)}
              rows={4}
              maxLength={200}
              style={{ width: "100%", boxSizing: "border-box", padding: 11, background: "#1f2937", color: "#ffffff", border: bizError && !bizAddr.trim() ? "1px solid #b91c1c" : "1px solid #9ca3af", borderRadius: 6, fontSize: 14, lineHeight: "1.4" }}
            />
            {bizError && !bizAddr.trim() && (
              <div style={{ color: "#fca5a5", fontSize: 12, marginTop: 4 }}>Delivery Address is required</div>
            )}
          </div>

          {items.length > 0 && (
            <div style={{ marginTop: 16, paddingLeft: 8, paddingRight: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, marginBottom: 6 }}>
                <span aria-hidden="true">🧾</span>
                <span>Bill Summary</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                {items.map((it, i) => {
                  const qtySets = it.qty || 0;
                  const pcsPerSet = it.pcs_per_set && it.pcs_per_set > 0 ? it.pcs_per_set : 1;
                  const pricePerPiece = it.price || 0; // Catalog price is per piece
                  const lineTotal = qtySets * pcsPerSet * pricePerPiece;
                  const left = `${it.title} | ${it.size || "-"} | ${qtySets} x ${pcsPerSet} Pcs Set`;
                  return (
                    <div key={it.content_id + ':' + i} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{left}</span>
                      <span style={{ whiteSpace: "nowrap" }}>{formatCurrency(it.currency)} {lineTotal.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600, fontSize: 14, marginTop: 10 }}>
                <span>Items total</span>
                <span>{formatCurrency(items[0]?.currency || 'INR')} {total.toFixed(2)}</span>
              </div>
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 6 }}>
                Payment is collected after you place the order. Our sales team will contact you to confirm payment and delivery details.
              </div>
            </div>
          )}

          <div style={{ marginTop: 16, display: "flex", justifyContent: "center", paddingLeft: 8, paddingRight: 8 }}>
            <button
              onClick={placeOrder}
              disabled={placing}
              style={{
                padding: "13px 32px",
                background: "#16a34a",
                color: "white",
                border: 0,
                borderRadius: 9999,
                cursor: placing ? "default" : "pointer",
                fontSize: 15,
                minWidth: 180,
                fontWeight: 600,
              }}
            >
              {placing ? "Placing…" : "Place Order"}
            </button>
          </div>
        </>
      )}

      {/* Company footer */}
      <div
        style={{
          marginTop: 32,
          padding: "16px 12px 24px",
          borderTop: "1px solid #222",
          fontSize: 12,
          lineHeight: 1.5,
          color: "#9ca3af",
          textAlign: "center",
        }}
      >
        <div style={{ fontWeight: 600, color: "#e5e5e5", marginBottom: 2 }}>Mans Impex</div>
        <div style={{ marginBottom: 6 }}>Manufacturer | Exporters – Shirts, T-Shirts, Trousers & Sportswear</div>
        <div style={{ marginBottom: 6 }}>GST - 29HCSPS6716N1ZA</div>
        <div>Reg Address: Ward No 17, Assessment No 10323, Kalenahalli Hosa Badavane</div>
        <div>Hassan Mysore Highway, Krishnarajanagara, Mysuru - 571602</div>
        <div>Karnataka, India</div>
        <div style={{ marginTop: 8 }}>
          <div>Copyright © 2025 Mans Impex.</div>
          <div>
            Powered by{" "}
            <a
              href="https://www.mindsfire.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#bfdbfe", textDecoration: "none" }}
            >
              Mindsfire Private Limited
            </a>
          </div>
        </div>
      </div>

      {/* Toast notification */}
      {toast && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            background: toastError ? "#450a0a" : "#022c22",
            color: toastError ? "#fecaca" : "#bbf7d0",
            padding: "10px 16px",
            borderRadius: 9999,
            border: toastError ? "1px solid #b91c1c" : "1px solid #16a34a",
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
