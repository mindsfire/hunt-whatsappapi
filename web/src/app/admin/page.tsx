"use client";

import React, { useEffect, useMemo, useState } from "react";

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Not synced yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} min${diffMin === 1 ? "" : "s"} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  return d.toLocaleString();
}

export default function AdminPage() {
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<any[] | null>(null);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [imageFiles, setImageFiles] = useState<any | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const relativeLastSynced = useMemo(() => formatRelativeTime(lastSyncedAt), [lastSyncedAt]);

  useEffect(() => {
    let cancelled = false;
    const loadStatus = async () => {
      try {
        const res = await fetch("/admin/sync-status");
        let j: any = {};
        try {
          j = await res.json();
        } catch (_) {}
        if (!res.ok || !j || j.ok === false || cancelled) return;
        if (j.lastSyncAt) {
          setLastSyncedAt(j.lastSyncAt);
          const counts = j.counts || {};
          const imported = counts.imported ?? 0;
          const indian = counts.indian ?? 0;
          setLastResult(
            `Last sync: ${imported} imported and ${indian} indian products from Commerce Manager into Firestore.`
          );
        }
      } catch (_) {}
    };
    loadStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSync = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLastResult(null);
    setLoading(true);
    try {
      const res = await fetch("/admin/sync-from-cm", {
        method: "GET",
        headers: secret ? { "X-Shared-Secret": secret } : {},
      });
      let j: any = {};
      try {
        j = await res.json();
      } catch (_) {}
      if (!res.ok || !j || j.ok === false) {
        const msg = (j && j.error) || `Sync failed with status ${res.status}`;
        setError(msg);
        return;
      }
      const counts = (j && j.counts) || {};
      const imported = counts.imported ?? 0;
      const indian = counts.indian ?? 0;
      const syncedAt = new Date().toISOString();
      setLastSyncedAt(syncedAt);
      setLastResult(
        `Synced ${imported} imported and ${indian} indian products from Commerce Manager into Firestore.`
      );
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadProducts = async () => {
    if (!secret || productsLoading) return;
    setProductsError(null);
    setProductsLoading(true);
    try {
      const res = await fetch("/admin/products-list", {
        method: "GET",
        headers: { "X-Shared-Secret": secret },
      });
      let j: any = {};
      try {
        j = await res.json();
      } catch (_) {}
      if (!res.ok || !j || j.ok === false) {
        const msg = (j && j.error) || `Fetch failed with status ${res.status}`;
        setProductsError(msg);
        return;
      }
      setProducts(Array.isArray(j.items) ? j.items : []);
    } catch (err: any) {
      setProductsError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setProductsLoading(false);
    }
  };

  const startEdit = (p: any) => {
    setEditing({
      sku: p.sku,
      title: p.title || "",
      type: (p.type || "").toString(),
      price: p.price || "",
      sizes: Array.isArray(p.sizes) ? p.sizes.join(", ") : "",
      description: (p.description || "").toString(),
      pcs_per_set: p.pcs_per_set || "",
      active: p.active === false ? false : true,
      isNew: false,
    });
    setSaveError(null);
    setSaveSuccess(null);
    setImageFiles(null);
    setUploadError(null);
    setUploadSuccess(null);
    setDeleteError(null);
  };

  const startCreateNew = () => {
    if (!secret) return;
    setEditing({
      sku: "",
      title: "",
      type: "",
      price: "",
      sizes: "",
      description: "",
      pcs_per_set: "",
      active: true,
      isNew: true,
    });
    setSaveError(null);
    setSaveSuccess(null);
    setImageFiles(null);
    setUploadError(null);
    setUploadSuccess(null);
    setDeleteError(null);
  };

  const handleEditChange = (field: string, value: any) => {
    setEditing((prev: any) => (prev ? { ...prev, [field]: value } : prev));
  };

  const handleSave = async () => {
    if (!editing || !secret || saving) return;
    if ((editing as any).isNew && !String(editing.sku || "").trim()) {
      setSaveError("SKU is required for new product.");
      return;
    }
    const payload = {
      sku: editing.sku,
      title: (editing.title || "").toString(),
      type: (editing.type || "").toString().toLowerCase(),
      price: Number(editing.price || 0) || 0,
      sizes: (editing.sizes || "").toString(),
      description: (editing.description || "").toString(),
      pcs_per_set: Number(editing.pcs_per_set || 0) || 0,
      active: !!editing.active,
    };
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const res = await fetch("/admin/product-upsert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shared-Secret": secret,
        },
        body: JSON.stringify(payload),
      });
      let j: any = {};
      try {
        j = await res.json();
      } catch (_) {}
      if (!res.ok || !j || j.ok === false) {
        const msg = (j && j.error) || `Save failed with status ${res.status}`;
        setSaveError(msg);
        return;
      }
      setSaveSuccess("Saved changes.");
      // Refresh catalog list so new products and type changes appear correctly
      if (products) {
        loadProducts();
      }
    } catch (err: any) {
      setSaveError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editing || !secret || deleting) return;
    const confirmed = window.confirm(
      `Delete product ${editing.sku} from catalog? This will remove it from web checkout and delete its images from storage.`
    );
    if (!confirmed) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/admin/product-delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shared-Secret": secret,
        },
        body: JSON.stringify({ sku: editing.sku }),
      });
      let j: any = {};
      try {
        j = await res.json();
      } catch (_) {}
      if (!res.ok || !j || j.ok === false) {
        const msg = (j && j.error) || `Delete failed with status ${res.status}`;
        setDeleteError(msg);
        return;
      }
      if (products) {
        setProducts((prev) => (prev || []).filter((p: any) => p.sku !== editing.sku));
      }
      setEditing(null);
    } catch (err: any) {
      setDeleteError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setDeleting(false);
    }
  };

  const handleImageFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setImageFiles(e.target.files || null);
    setUploadError(null);
    setUploadSuccess(null);
  };

  const handleUploadImages = async () => {
    if (!editing || !secret || uploading || !imageFiles || imageFiles.length === 0) return;
    const form = new FormData();
    form.append("sku", editing.sku);
    for (let i = 0; i < imageFiles.length; i++) {
      form.append("images", imageFiles[i]);
    }
    setUploading(true);
    setUploadError(null);
    setUploadSuccess(null);
    try {
      const res = await fetch("/admin/product-images-upload", {
        method: "POST",
        headers: {
          "X-Shared-Secret": secret,
        },
        body: form,
      });
      let j: any = {};
      try {
        j = await res.json();
      } catch (_) {}
      if (!res.ok || !j || j.ok === false) {
        const msg = (j && j.error) || `Upload failed with status ${res.status}`;
        setUploadError(msg);
        return;
      }
      const count = typeof j.image_count === "number" ? j.image_count : null;
      if (count !== null && products) {
        setProducts((prev) =>
          (prev || []).map((p: any) =>
            p.sku === editing.sku
              ? {
                  ...p,
                  image_count: count,
                }
              : p
          )
        );
      }
      setUploadSuccess("Uploaded images and replaced gallery.");
    } catch (err: any) {
      setUploadError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      {/* Header (same look as checkout page) */}
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

      {/* Admin content */}
      <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
        <div
          style={{
            maxWidth: 560,
            width: "100%",
            background: "#0b0b0b",
            border: "1px solid #374151",
            borderRadius: 10,
            padding: 16,
          }}
        >
          <div style={{ marginBottom: 12, textAlign: "left" }}>
            <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>
              Admin: Sync Commerce Manager
            </div>
            <div style={{ fontSize: 13, opacity: 0.9 }}>
              This tool pulls products from WhatsApp Commerce Manager and updates the
              Hunt Wholesale catalog in Firestore.
            </div>
          </div>

          <div
            style={{
              fontSize: 13,
              opacity: 0.9,
              background: "#020617",
              borderRadius: 8,
              border: "1px solid #1f2937",
              padding: 12,
              marginBottom: 12,
              textAlign: "left",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>What this sync does</div>
            <ul style={{ paddingLeft: 18, margin: 0, lineHeight: 1.5 }}>
              <li>Fetches products from your configured Imported and Indian sets.</li>
              <li>Updates the Firestore <code>products</code> collection (price, title, sizes, pcs per set, images).</li>
              <li>Refreshes the <code>products_by_type</code> index used by the web checkout.</li>
              <li>Does not delete existing products; it only upserts based on SKU.</li>
            </ul>
          </div>

          <form onSubmit={handleSync} style={{ textAlign: "left" }}>
            <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
              Sync password (shared secret)
            </label>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Enter SYNC_SHARED_SECRET"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: 10,
                borderRadius: 6,
                border: "1px solid #374151",
                background: "#020617",
                color: "#e5e7eb",
                fontSize: 14,
                marginBottom: 10,
              }}
            />

            {error && (
              <div
                style={{
                  marginBottom: 8,
                  padding: 8,
                  borderRadius: 6,
                  background: "#451a1a",
                  border: "1px solid #b91c1c",
                  color: "#fecaca",
                  fontSize: 12,
                }}
              >
                {error}
              </div>
            )}

            {lastResult && (
              <div
                style={{
                  marginBottom: 8,
                  padding: 8,
                  borderRadius: 6,
                  background: "#022c22",
                  border: "1px solid #16a34a",
                  color: "#bbf7d0",
                  fontSize: 12,
                }}
              >
                {lastResult}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !secret}
              style={{
                marginTop: 4,
                padding: "10px 22px",
                background: loading ? "#15803d" : "#16a34a",
                color: "white",
                border: 0,
                borderRadius: 6,
                cursor: loading || !secret ? "default" : "pointer",
                fontSize: 14,
                fontWeight: 600,
                opacity: loading || !secret ? 0.8 : 1,
              }}
            >
              {loading ? "Syncing…" : "Sync catalogs"}
            </button>
          </form>

          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              opacity: 0.9,
              textAlign: "left",
            }}
          >
            <div>
              <b>Last synced:</b> {relativeLastSynced}
            </div>
            {lastSyncedAt && (
              <div style={{ opacity: 0.8 }}>Exact time: {new Date(lastSyncedAt).toLocaleString()}</div>
            )}
          </div>

          {/* Catalog (read-only) */}
          <div
            style={{
              marginTop: 16,
              fontSize: 12,
              textAlign: "left",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Catalog</div>
            <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 8 }}>
              View products currently in Firestore. Use the shared secret above to load the list.
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <button
                type="button"
                onClick={loadProducts}
                disabled={productsLoading || !secret}
                style={{
                  padding: "6px 14px",
                  borderRadius: 999,
                  border: "1px solid #374151",
                  background: productsLoading ? "#111827" : "#020617",
                  color: "#e5e7eb",
                  fontSize: 12,
                  cursor: productsLoading || !secret ? "default" : "pointer",
                  opacity: productsLoading || !secret ? 0.7 : 1,
                }}
              >
                {productsLoading ? "Loading catalog…" : "Load catalog"}
              </button>
              <button
                type="button"
                onClick={startCreateNew}
                disabled={!secret || productsLoading}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  border: "1px solid #4b5563",
                  background: "#020617",
                  color: "#e5e7eb",
                  fontSize: 12,
                  cursor: !secret || productsLoading ? "default" : "pointer",
                  opacity: !secret || productsLoading ? 0.7 : 1,
                }}
              >
                New product
              </button>
            </div>
            {productsError && (
              <div
                style={{
                  marginTop: 8,
                  padding: 8,
                  borderRadius: 6,
                  background: "#451a1a",
                  border: "1px solid #b91c1c",
                  color: "#fecaca",
                }}
              >
                {productsError}
              </div>
            )}
            {products && (
              <div
                style={{
                  marginTop: 10,
                  borderRadius: 8,
                  border: "1px solid #1f2937",
                  background: "#020617",
                  maxHeight: 260,
                  overflowY: "auto",
                }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#111827" }}>
                      <th style={{ padding: 6, textAlign: "left", borderBottom: "1px solid #1f2937" }}>SKU</th>
                      <th style={{ padding: 6, textAlign: "left", borderBottom: "1px solid #1f2937" }}>Title</th>
                      <th style={{ padding: 6, textAlign: "left", borderBottom: "1px solid #1f2937" }}>Type</th>
                      <th style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #1f2937" }}>Price</th>
                      <th style={{ padding: 6, textAlign: "right", borderBottom: "1px solid #1f2937" }}>Images</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ padding: 8, textAlign: "center", opacity: 0.8 }}>
                          No products found.
                        </td>
                      </tr>
                    ) : (
                      products.map((p) => (
                        <tr key={p.sku}>
                          <td style={{ padding: 6, borderBottom: "1px solid #111827", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                            {p.sku}
                          </td>
                          <td style={{ padding: 6, borderBottom: "1px solid #111827" }}>{p.title || "-"}</td>
                          <td style={{ padding: 6, borderBottom: "1px solid #111827", textTransform: "capitalize" }}>{p.type || "-"}</td>
                          <td style={{ padding: 6, borderBottom: "1px solid #111827", textAlign: "right" }}>
                            {p.price ? `${p.currency} ${p.price}` : "-"}
                          </td>
                          <td style={{ padding: 6, borderBottom: "1px solid #111827", textAlign: "right" }}>
                            {typeof p.image_count === "number" ? p.image_count : "-"}
                          </td>
                          <td style={{ padding: 6, borderBottom: "1px solid #111827", textAlign: "right" }}>
                            <button
                              type="button"
                              onClick={() => startEdit(p)}
                              style={{
                                padding: "3px 8px",
                                borderRadius: 999,
                                border: "1px solid #4b5563",
                                background: "#020617",
                                color: "#e5e7eb",
                                fontSize: 11,
                                cursor: "pointer",
                              }}
                            >
                              Edit
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {editing && (
              <div
                style={{
                  marginTop: 12,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid #1f2937",
                  background: "#020617",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  {(editing as any).isNew ? (
                    "New product"
                  ) : (
                    <>
                      Edit product:{" "}
                      <span
                        style={{
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                        }}
                      >
                        {editing.sku}
                      </span>
                    </>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(editing as any).isNew && (
                    <label style={{ fontSize: 12 }}>
                      SKU
                      <input
                        type="text"
                        value={editing.sku}
                        onChange={(e) => handleEditChange("sku", e.target.value)}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          marginTop: 2,
                          padding: 8,
                          borderRadius: 6,
                          border: "1px solid #374151",
                          background: "#020617",
                          color: "#e5e7eb",
                          fontSize: 12,
                        }}
                      />
                    </label>
                  )}
                  <label style={{ fontSize: 12 }}>
                    Title
                    <input
                      type="text"
                      value={editing.title}
                      onChange={(e) => handleEditChange("title", e.target.value)}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        marginTop: 2,
                        padding: 8,
                        borderRadius: 6,
                        border: "1px solid #374151",
                        background: "#020617",
                        color: "#e5e7eb",
                        fontSize: 12,
                      }}
                    />
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <label style={{ fontSize: 12, flex: 1 }}>
                      Type
                      <select
                        value={editing.type}
                        onChange={(e) => handleEditChange("type", e.target.value)}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          marginTop: 2,
                          padding: 8,
                          borderRadius: 6,
                          border: "1px solid #374151",
                          background: "#020617",
                          color: "#e5e7eb",
                          fontSize: 12,
                        }}
                      >
                        <option value="">Select type</option>
                        <option value="indian">Indian</option>
                        <option value="imported">Imported</option>
                      </select>
                    </label>
                    <label style={{ fontSize: 12, width: 120 }}>
                      Pcs per set
                      <input
                        type="number"
                        value={editing.pcs_per_set}
                        onChange={(e) => handleEditChange("pcs_per_set", e.target.value)}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          marginTop: 2,
                          padding: 8,
                          borderRadius: 6,
                          border: "1px solid #374151",
                          background: "#020617",
                          color: "#e5e7eb",
                          fontSize: 12,
                        }}
                      />
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <label style={{ fontSize: 12, flex: 1 }}>
                      Price (INR)
                      <input
                        type="number"
                        value={editing.price}
                        onChange={(e) => handleEditChange("price", e.target.value)}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          marginTop: 2,
                          padding: 8,
                          borderRadius: 6,
                          border: "1px solid #374151",
                          background: "#020617",
                          color: "#e5e7eb",
                          fontSize: 12,
                        }}
                      />
                    </label>
                  </div>
                  <label style={{ fontSize: 12 }}>
                    Description (for web)
                    <textarea
                      value={editing.description || ""}
                      onChange={(e) => handleEditChange("description", e.target.value)}
                      rows={3}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        marginTop: 2,
                        padding: 8,
                        borderRadius: 6,
                        border: "1px solid #374151",
                        background: "#020617",
                        color: "#e5e7eb",
                        fontSize: 12,
                        resize: "vertical",
                      }}
                    />
                  </label>
                  <label style={{ fontSize: 12 }}>
                    Sizes (comma separated)
                    <input
                      type="text"
                      value={editing.sizes}
                      onChange={(e) => handleEditChange("sizes", e.target.value)}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        marginTop: 2,
                        padding: 8,
                        borderRadius: 6,
                        border: "1px solid #374151",
                        background: "#020617",
                        color: "#e5e7eb",
                        fontSize: 12,
                      }}
                    />
                  </label>
                  <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={!!editing.active}
                      onChange={(e) => handleEditChange("active", e.target.checked)}
                    />
                    Active (visible in web catalog)
                  </label>
                  {saveError && (
                    <div
                      style={{
                        marginTop: 4,
                        padding: 6,
                        borderRadius: 6,
                        background: "#451a1a",
                        border: "1px solid #b91c1c",
                        color: "#fecaca",
                        fontSize: 12,
                      }}
                    >
                      {saveError}
                    </div>
                  )}
                  {saveSuccess && (
                    <div
                      style={{
                        marginTop: 4,
                        padding: 6,
                        borderRadius: 6,
                        background: "#022c22",
                        border: "1px solid #16a34a",
                        color: "#bbf7d0",
                        fontSize: 12,
                      }}
                    >
                      {saveSuccess}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saving}
                      style={{
                        padding: "8px 16px",
                        borderRadius: 999,
                        border: "none",
                        background: saving ? "#15803d" : "#16a34a",
                        color: "white",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: saving ? "default" : "pointer",
                      }}
                    >
                      {saving ? "Saving…" : "Save changes"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      disabled={saving}
                      style={{
                        padding: "8px 12px",
                        borderRadius: 999,
                        border: "1px solid #4b5563",
                        background: "transparent",
                        color: "#e5e7eb",
                        fontSize: 12,
                        cursor: saving ? "default" : "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                  {deleteError && (
                    <div
                      style={{
                        marginTop: 4,
                        padding: 6,
                        borderRadius: 6,
                        background: "#451a1a",
                        border: "1px solid #b91c1c",
                        color: "#fecaca",
                        fontSize: 12,
                      }}
                    >
                      {deleteError}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleting || saving}
                    style={{
                      marginTop: 4,
                      padding: "6px 12px",
                      borderRadius: 999,
                      border: "1px solid #7f1d1d",
                      background: deleting ? "#7f1d1d" : "#991b1b",
                      color: "#fee2e2",
                      fontSize: 12,
                      cursor: deleting || saving ? "default" : "pointer",
                    }}
                  >
                    {deleting ? "Deleting…" : "Delete product"}
                  </button>
                  <div
                    style={{
                      marginTop: 10,
                      paddingTop: 8,
                      borderTop: "1px solid #1f2937",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600 }}>Images</div>
                    <div style={{ fontSize: 12, opacity: 0.9 }}>
                      Current images: {(() => {
                        const row = (products || []).find((p: any) => p.sku === editing.sku);
                        return typeof row?.image_count === "number" ? row.image_count : 0;
                      })()}
                    </div>
                    <input type="file" multiple accept="image/*" onChange={handleImageFilesChange} />
                    {uploadError && (
                      <div
                        style={{
                          marginTop: 4,
                          padding: 6,
                          borderRadius: 6,
                          background: "#451a1a",
                          border: "1px solid #b91c1c",
                          color: "#fecaca",
                          fontSize: 12,
                        }}
                      >
                        {uploadError}
                      </div>
                    )}
                    {uploadSuccess && (
                      <div
                        style={{
                          marginTop: 4,
                          padding: 6,
                          borderRadius: 6,
                          background: "#022c22",
                          border: "1px solid #16a34a",
                          color: "#bbf7d0",
                          fontSize: 12,
                        }}
                      >
                        {uploadSuccess}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={handleUploadImages}
                      disabled={uploading || !imageFiles || imageFiles.length === 0}
                      style={{
                        marginTop: 2,
                        padding: "6px 12px",
                        borderRadius: 999,
                        border: "1px solid #4b5563",
                        background: uploading ? "#111827" : "#020617",
                        color: "#e5e7eb",
                        fontSize: 12,
                        cursor: uploading || !imageFiles || imageFiles.length === 0 ? "default" : "pointer",
                        opacity: uploading || !imageFiles || imageFiles.length === 0 ? 0.7 : 1,
                      }}
                    >
                      {uploading ? "Uploading…" : "Upload & replace images"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Company footer (same as checkout page) */}
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
      </div>
    </div>
  );
}
