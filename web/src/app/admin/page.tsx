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

  return (
    <div>
      {/* Header (same look as checkout page) */}
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
          <div
            style={{
              fontSize: 24,
              fontWeight: 700,
              fontFamily: "Poppins, system-ui, -apple-system, sans-serif",
            }}
          >
            Wholesale
          </div>
          <div
            style={{
              fontSize: 13,
              fontStyle: "italic",
              opacity: 0.75,
              fontFamily: "Poppins, system-ui, -apple-system, sans-serif",
            }}
          >
            Fabric Dealers
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
        <div style={{ fontWeight: 600, color: "#e5e5e5", marginBottom: 4 }}>
          Mans Impex - Wholesale Dealers
        </div>
        <div style={{ marginBottom: 6 }}>GST - 29HCSPS6716N1ZA</div>
        <div>Reg Address: Ward No 17, Assessment No 10323, Kalenahalli Hosa Badavane</div>
        <div>Hassan Mysore Highway, Krishnarajanagara, Mysuru - 571602</div>
        <div>Karnataka, India</div>
      </div>
    </div>
  );
}
