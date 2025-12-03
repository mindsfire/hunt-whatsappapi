## Mans Impex WhatsApp Wholesale Checkout – Handover

This document summarizes how the app is set up in production, how to access the main user and admin flows, and what is needed to operate it day‑to‑day.

---

## 1. High‑level Overview

- **Channel**: WhatsApp Business + web checkout.
- **Goal**: Let wholesale buyers browse Indian and Imported products, build a cart, and submit an order via a guided web checkout flow.
- **Backend**: Node.js/Express on Cloud Run, Firestore as database, Google Sheets for reporting.
- **Frontend**: Static Next.js site exported under the `/checkout` path and served from the same Cloud Run service.

---

## 2. Customer Entry Points

- **WhatsApp message link (primary entry)**  
  - Link: `https://wa.me/message/UJZ3AUOEXVPUN1`  
  - This opens a WhatsApp conversation with a pre‑filled wholesale greeting.  
  - The bot responds, confirms business mode, and sends a **deep link** to the web checkout.

- **Web checkout URL (used by the system)**  
  - Base path: `https://hunt-whatsappapi-876367554060.asia-south1.run.app/checkout/`  
  - Each link is **personalized and time‑limited**; users should always use the latest link they receive in WhatsApp.
  - If the link is reused or expired, the web page shows a **“session expired”** message and a button to jump back to WhatsApp.

---

## 3. Web UI Summary

- **Product browsing**
  - Tabs: `All` (default), `Indian Fabric`, `Imported Fabric`.
  - `All` tab shows **Indian + Imported** together, 15 products per page with Next/Prev where needed.
  - Each product card shows a **tiny pill** on the top‑right (`Indian` / `Imported`) to indicate source type.

- **Cart and checkout**
  - Users select **size** and **quantity** for each item; line totals and a bill summary are shown.
  - A **Business Details** section collects:
    - Business name (letters + spaces)
    - GSTIN (optional, validated if present)
    - Delivery address
  - After submission, an order ID is created and shown, and sales team can follow up offline for payment/delivery.

- **Session expired page**
  - Explains that the link is one‑time / time‑limited.
  - Shows a **WhatsApp CTA button** with the official white WhatsApp logo, linking back to:  
    `https://wa.me/message/UJZ3AUOEXVPUN1`.

- **Footer (on checkout and admin pages)**
  - Company and registration details.
  - Copyright:
    - `Copyright © 2025 Mans Impex.`
    - `Powered by Mindsfire Private Limited` with a link to `https://www.mindsfire.com`.

---

## 4. Admin & Internal Tools

These are for internal staff only and are protected using a shared secret.

- **Web catalog admin UI**
  - URL: `https://hunt-whatsappapi-876367554060.asia-south1.run.app/checkout/admin`
  - Authentication: enter the **shared secret** value (see `SYNC_SHARED_SECRET` below) in the “Admin password (shared secret)” field.
  - Capabilities:
    - View products currently in Firestore (`products` + `products_by_type`).
    - Create / edit products (title, type, price, sizes, description, pieces per set, active flag).
    - Upload and replace product images for a given SKU.

- **Export leads to Google Sheets**
  - HTTPS endpoint: `/admin/export-leads`
  - Triggered by the `export-leads` Cloud Scheduler job (see next section).
  - Writes data into the configured Google Sheet (`LEADS_SHEET_ID`).

- **Re‑engage abandoned users**
  - HTTPS endpoint: `/admin/reengage-users`
  - Triggered by the `reengage-users` Cloud Scheduler job.
  - Uses shared logic to:
    - Re‑engage **web no order** users (visited checkout but did not place an order).
    - Re‑engage **cart no order** users (have items in cart but no order).
  - Each run logs a summary row into the `Reengagement_Runs` tab of the same Google Sheet.

> **Security note**: All `/admin/*` endpoints that are not part of the public web UI are protected using the `X-Shared-Secret` header. Cloud Scheduler and any internal tooling must send this header for access.

---

## 5. Scheduled Jobs (Cloud Scheduler)

There are two key jobs running in production in `asia-south1`:

- **Job: `export-leads`**
  - Schedule: `0 * * * *` (every hour, Asia/Kolkata timezone).
  - Request:
    - URL: `https://hunt-whatsappapi-876367554060.asia-south1.run.app/admin/export-leads`
    - Method: `GET`
    - Headers: `X-Shared-Secret: mansfire` (must match `SYNC_SHARED_SECRET` in the service env).
  - Purpose: export leads data to Google Sheets.

- **Job: `reengage-users`**
  - Schedule: `0 */6 * * *` (every 6 hours, Asia/Kolkata timezone).
  - Request:
    - URL: `https://hunt-whatsappapi-876367554060.asia-south1.run.app/admin/reengage-users`
    - Method: `GET`
    - Headers: `X-Shared-Secret: mansfire`
  - Purpose:
    - Re‑engage eligible “web no order” sessions.
    - Re‑engage eligible “cart no order” carts.
    - Append run stats to the `Reengagement_Runs` tab in Google Sheets.

If you ever rotate the shared secret, remember to update **both** jobs with the new value using:

```bash
gcloud scheduler jobs update http <job-name> \
  --project="prod-hunt-whatsappapi" \
  --location="asia-south1" \
  --update-headers="X-Shared-Secret=<NEW_SECRET_VALUE>"
```

---

## 6. Re‑Engagement Logic (Abandoned Users)

### 6.1 Web No Order (sessions without order)

- Looks at Firestore `sessions` with:
  - `state == 'web_checkout'`
  - `updated_at >= (now - 24 hours)`
  - Ordered by `updated_at` ascending, with a small limit per run.
- Skips users who:
  - Already have an order **created after** the session’s last `updated_at`.
  - Were already re‑engaged, or were processed in the same run.
- For each eligible user:
  - Builds a fresh web checkout URL.
  - Sends a localized re‑engagement text (e.g. “We noticed you were checking out…”), then appends the URL as a separate line.
  - Waits **3 seconds**.
  - Sends navigation buttons (`Restart`, `Change language`, `Help`) with localized labels.

### 6.2 Cart No Order (carts without order)

- Looks at Firestore `carts` where:
  - There are items present and no completed order.
- Skips users who have an order **created after** the cart was last updated.
- For each eligible user:
  - Builds a fresh web checkout URL.
  - Sends a localized re‑engagement body for “cart no order”, then appends the URL.
  - Waits **3 seconds**.
  - Sends the same navigation buttons as above.

### 6.3 Logging & limits

- Both functions:
  - Track `processed`, `skipped`, and `failed` counts.
  - Use Firestore batch writes with **chunking** under the 500‑operations per‑batch limit.
  - Share a `processedUsers` set so a user is not re‑engaged twice in one run.
- The `/admin/reengage-users` handler:
  - Computes total processed and duration.
  - Logs results to the `Reengagement_Runs` tab in Google Sheets (both success and error runs).

---

## 7. Data & Configuration

### 7.1 Firestore (high level)

- **Collections (relevant)**:
  - `products`: master catalog items (price, currency, sizes, images, etc.).
  - `products_by_type`: per‑type product lists (`indian`, `imported`) used by the web UI tabs.
  - `sessions`: WhatsApp conversational sessions and web checkout state.
  - `carts`: Abandoned cart tracking.
  - `orders`: Orders placed from the web checkout.

- **Indexes**
  - A composite index for `sessions` is required and has been created:
    - Fields: `state` (Ascending), `updated_at` (Ascending).

### 7.2 Environment variables (key ones)

- `SYNC_SHARED_SECRET`  
  - Shared secret used to protect admin and scheduler endpoints.  
  - Must match the value used in `X-Shared-Secret` headers in Cloud Scheduler jobs.

- `LEADS_SHEET_ID` / `SALES_SHEET_ID`  
  - Google Sheets IDs used by the export and logging features.

- `BASE_URL`, `PORT`, Firestore / GCP project variables  
  - Standard runtime configuration for Cloud Run and Firestore access.

> Any rotation of secrets (e.g., new `SYNC_SHARED_SECRET`) should be coordinated between **Cloud Run environment** and **Cloud Scheduler job headers**.

---

## 8. Monitoring & Troubleshooting

- **Cloud Run logs**
  - Check the Cloud Run service logs for:
    - WhatsApp webhook processing.
    - Checkout link generation.
    - Re‑engagement job runs.

- **Cloud Scheduler**
  - For `export-leads` and `reengage-users`:
    - Look at job run history for success/failure.
    - Common failure reasons:
      - Wrong `X-Shared-Secret` header.
      - Invalid or missing Firestore index.
      - Transient network or Google Sheets/API issues.

- **Google Sheets**
  - Confirm that:
    - Lead exports appear as new rows in the expected sheet.
    - Re‑engagement runs append to `Reengagement_Runs` with timestamp, counts, and status.

---

## 9. Handover Checklist

- [ ] Cloud Run service deployed and healthy (`/health` and `/healthz` return `ok`).  
- [ ] WhatsApp Business number configured and linked to the correct webhook URL.  
- [ ] Web checkout accessible via deep links sent from WhatsApp.  
- [ ] `/checkout/admin` reachable internally and protected by the shared secret.  
- [ ] `export-leads` job succeeding hourly with correct `X-Shared-Secret`.  
- [ ] `reengage-users` job succeeding every 6 hours and logging to `Reengagement_Runs`.  
- [ ] Firestore index on `sessions(state, updated_at)` is present and serving traffic.  
- [ ] All environment variables (secrets, sheet IDs, base URL) documented and stored securely.  

This document can be extended over time with more operational runbooks (e.g. how to onboard new operators, how to rotate secrets, how to modify re‑engagement thresholds) as needed.






