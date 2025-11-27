"use client";

import React, { useState } from "react";

export type Product = {
  content_id: string;
  title: string;
  price: number;
  currency: string;
  image_url?: string;
  description?: string;
  sizes?: string[];
};

export type ProductCardProps = {
  product: Product;
  formatCurrency: (code: string) => string;
  onAddToCart: (product: Product, size: string, qty: number) => void;
  onViewImages: (content_id: string) => void;
  onGoToCart: () => void;
};

export default function ProductCard({ product, formatCurrency, onAddToCart, onViewImages, onGoToCart }: ProductCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedSize, setSelectedSize] = useState("");
  const [qty, setQty] = useState(1);
  const [addedOnce, setAddedOnce] = useState(false);

  const sizes = Array.isArray(product.sizes) && product.sizes.length
    ? product.sizes
    : ["S", "M", "L", "XL", "2XL"];

  const handleAddClick = () => {
    if (!expanded) {
      setExpanded(true);
      return;
    }
    if (!selectedSize) return;
    if (addedOnce) {
      onGoToCart();
      return;
    }
    const safeQty = qty > 0 ? qty : 1;
    onAddToCart(product, selectedSize, safeQty);
    setAddedOnce(true);
  };

  const canAddToCart = !!selectedSize && qty > 0;

  return (
    <div
      style={{
        borderRadius: 12,
        padding: 12,
        background: "#0b0b0b",
        border: "1px solid #1f2933",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {product.image_url && (
        <div
          style={{
            width: "100%",
            paddingBottom: "65%",
            position: "relative",
            borderRadius: 10,
            overflow: "hidden",
            background: "#111",
          }}
        >
          <img
            src={product.image_url}
            alt={product.title}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        </div>
      )}
      <div style={{ fontWeight: 600, fontSize: 14 }}>{product.title}</div>
      {product.description && (
        <div
          style={{
            fontSize: 12,
            opacity: 0.75,
            marginBottom: 4,
            maxHeight: 48,
            overflow: "hidden",
          }}
        >
          {product.description}
        </div>
      )}
      <div style={{ fontSize: 14, opacity: 0.9 }}>
        {formatCurrency(product.currency)} {product.price} / Pc
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
        <button
          type="button"
          onClick={() => onViewImages(product.content_id)}
          style={{
            width: "100%",
            padding: "8px 10px",
            borderRadius: 999,
            border: "1px solid #374151",
            background: "#111827",
            color: "#e5e7eb",
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          View Images
        </button>

        {expanded && (
          <div
            style={{
              marginTop: 4,
              paddingTop: 8,
              borderTop: "1px solid #1f2933",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 12, opacity: 0.85 }}>Select size</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {sizes.map((s) => {
                const active = selectedSize === s;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => { setSelectedSize(s); setAddedOnce(false); }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: active ? "1px solid #22c55e" : "1px solid #374151",
                      background: active ? "#022c22" : "#111827",
                      color: "#e5e7eb",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>Quantity (sets)</div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
              }}
            >
              <button
                type="button"
                onClick={() => setQty((q) => (q > 1 ? q - 1 : 1))}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  border: "1px solid #4b5563",
                  background: "#111827",
                  color: "#e5e7eb",
                  fontSize: 16,
                  cursor: "pointer",
                }}
              >
                -
              </button>
              <div style={{ minWidth: 24, textAlign: "center", fontSize: 14 }}>{qty}</div>
              <button
                type="button"
                onClick={() => setQty((q) => q + 1)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  border: "1px solid #4b5563",
                  background: "#111827",
                  color: "#e5e7eb",
                  fontSize: 16,
                  cursor: "pointer",
                }}
              >
                +
              </button>
            </div>

          </div>
        )}

        <button
          onClick={handleAddClick}
          style={{
            width: "100%",
            padding: "8px 10px",
            borderRadius: 999,
            border: "none",
            background: "#22c55e",
            color: "#051b10",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            opacity: !expanded || canAddToCart ? 1 : 0.6,
          }}
          disabled={expanded && !canAddToCart}
        >
          {!expanded ? "Add" : addedOnce ? "Go to cart" : "Add to cart"}
        </button>
      </div>
    </div>
  );
}
