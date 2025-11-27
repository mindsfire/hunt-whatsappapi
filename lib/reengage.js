import { Firestore } from '@google-cloud/firestore';
import { t } from '../locales.js';
import { sendText, sendButtons } from './wa.js';
import { buildCheckoutUrl } from './checkout.js';

const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
const adminDb = new Firestore({ projectId });

export async function reengageWebNoOrderUsers({ limit = 4, processedUsers = null } = {}) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  const snap = await adminDb.collection('sessions')
    .where('state', '==', 'web_checkout')
    .where('updated_at', '>=', cutoffIso)
    .orderBy('updated_at', 'asc')
    .limit(limit)
    .get();

  console.log(`reengageWebNoOrderUsers: Found ${snap.docs.length} sessions in web_checkout state`);

  let batch = adminDb.batch();
  let batchOps = 0;
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const localProcessed = processedUsers || new Set();

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (data.web_reengaged === true) {
      skipped++;
      continue;
    }
    const updatedAtRaw = (data.updated_at || '').toString();
    if (!updatedAtRaw || updatedAtRaw < cutoffIso) {
      skipped++;
      continue;
    }

    const waUserId = doc.id;

    // Skip if already processed by another re-engagement function in this run
    if (localProcessed.has(waUserId)) {
      skipped++;
      continue;
    }

    // Skip if an order was placed AFTER this web checkout session was last updated.
    // User may have past orders, but we only care about orders placed after this session,
    // similar to the cart re-engagement logic.
    const ordSnap = await adminDb.collection('orders')
      .where('wa_user_id', '==', waUserId)
      .get();
    let hasRecentOrder = false;
    for (const ordDoc of ordSnap.docs) {
      const ordData = ordDoc.data() || {};
      const orderCreatedAt = (ordData.created_at || '').toString();
      if (orderCreatedAt && orderCreatedAt > updatedAtRaw) {
        hasRecentOrder = true;
        break;
      }
    }
    if (hasRecentOrder) {
      skipped++;
      continue;
    }

    // Build and send explicit web-no-order re-engagement message
    let sendSuccess = false;
    try {
      const lang = (data.language || data.locale || 'en').toString();
      const url = await buildCheckoutUrl(waUserId);

      // Main re-engagement body (localized)
      const body = t(lang, 'WEB_NO_ORDER_REENGAGE_BODY');
      await sendText(waUserId, `${body}\n\n${url}`);

      // Small delay before sending navigation so the message is read first
      try {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (_) {}

      // Navigation buttons (same pattern as standard checkout link)
      const resendTitle = t(lang, 'BUTTON_RESEND_LINK');
      const changeLangTitle = t(lang, 'BUTTON_CHANGE_LANGUAGE');
      const helpTitle = t(lang, 'BUTTON_HELP');
      const nextStepsBody = t(lang, 'NEXT_STEPS_TITLE') || 'Next steps';
      await sendButtons(waUserId, nextStepsBody, [
        { type: 'reply', reply: { id: 'web_restart', title: resendTitle } },
        { type: 'reply', reply: { id: 'web_change_lang', title: changeLangTitle } },
        { type: 'reply', reply: { id: 'web_help', title: helpTitle } }
      ]);

      sendSuccess = true;
    } catch (e) {
      console.error('reengageWebNoOrderUsers: failed to send re-engagement message', { waUserId, error: e });
      failed++;
      // Don't mark as re-engaged if send failed
      continue;
    }

    // Only mark as re-engaged if message was successfully sent
    if (sendSuccess) {
      batch.set(doc.ref, { web_reengaged: true, web_reengaged_at: now.toISOString() }, { merge: true });
      batchOps++;
      localProcessed.add(waUserId);
      processed++;

      // Firestore batch limit safety (commit in chunks)
      if (batchOps >= 450) {
        await batch.commit();
        batch = adminDb.batch();
        batchOps = 0;
      }
    }
  }

  if (batchOps > 0) {
    await batch.commit();
  }
  if (processed > 0) {
    console.log(`reengageWebNoOrderUsers: Marked ${processed} users as re-engaged`);
  }

  console.log(`reengageWebNoOrderUsers: Summary - processed: ${processed}, skipped: ${skipped}, failed: ${failed}`);

  return { processed, skipped, failed, processedUsers: localProcessed };
}

export async function reengageCartNoOrderUsers({ processedUsers = null } = {}) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  const snap = await adminDb.collection('carts')
    .where('updated_at', '>=', cutoffIso)
    .get();

  console.log(`reengageCartNoOrderUsers: Found ${snap.docs.length} carts updated in last 24h`);

  let batch = adminDb.batch();
  let batchOps = 0;
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const localProcessed = processedUsers || new Set();

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (data.cart_reengaged === true) {
      skipped++;
      continue;
    }
    
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      skipped++;
      continue;
    }

    const waUserId = doc.id;
    const cartUpdatedAt = (data.updated_at || '').toString();
    if (!cartUpdatedAt || cartUpdatedAt < cutoffIso) {
      skipped++;
      continue;
    }

    // Skip if already processed by another re-engagement function in this run
    if (localProcessed.has(waUserId)) {
      skipped++;
      continue;
    }

    // Check if an order was placed AFTER the cart was last updated
    // This ensures we only skip if the current cart items might have been ordered
    // (User may have past orders, but we only care about orders placed after cart was updated)
    const ordSnap = await adminDb.collection('orders')
      .where('wa_user_id', '==', waUserId)
      .get();
    
    // Filter in code to find orders created after cart was updated
    let hasRecentOrder = false;
    for (const ordDoc of ordSnap.docs) {
      const ordData = ordDoc.data() || {};
      const orderCreatedAt = (ordData.created_at || '').toString();
      if (orderCreatedAt && orderCreatedAt > cartUpdatedAt) {
        hasRecentOrder = true;
        break;
      }
    }
    if (hasRecentOrder) {
      skipped++;
      continue;
    }

    // Send explicit cart re-engagement message (no CHECKOUT_LINK_INTRO)
    // Only mark as re-engaged if this succeeds
    let sendSuccess = false;
    try {
      const lang = (data.language || data.locale || 'en').toString();
      const url = await buildCheckoutUrl(waUserId);

      const body = t(lang, 'WEB_CART_NO_ORDER_REENGAGE_BODY');
      await sendText(waUserId, `${body}\n\n${url}`);

      // Small delay before sending navigation so the message is read first
      try {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } catch (_) {}

      const resendTitle = t(lang, 'BUTTON_RESEND_LINK');
      const changeLangTitle = t(lang, 'BUTTON_CHANGE_LANGUAGE');
      const helpTitle = t(lang, 'BUTTON_HELP');
      const nextStepsBody = t(lang, 'NEXT_STEPS_TITLE') || 'Next steps';
      await sendButtons(waUserId, nextStepsBody, [
        { type: 'reply', reply: { id: 'web_restart', title: resendTitle } },
        { type: 'reply', reply: { id: 'web_change_lang', title: changeLangTitle } },
        { type: 'reply', reply: { id: 'web_help', title: helpTitle } }
      ]);

      sendSuccess = true;
    } catch (e) {
      console.error('reengageCartNoOrderUsers: failed to send re-engagement message', { waUserId, error: e });
      failed++;
      // Don't mark as re-engaged if send failed
      continue;
    }

    // Only mark as re-engaged if message was successfully sent
    if (sendSuccess) {
      batch.set(doc.ref, { cart_reengaged: true, cart_reengaged_at: now.toISOString() }, { merge: true });
      batchOps++;
      localProcessed.add(waUserId);
      processed++;

      // Firestore batch limit safety (commit in chunks)
      if (batchOps >= 450) {
        await batch.commit();
        batch = adminDb.batch();
        batchOps = 0;
      }
    }
  }

  if (batchOps > 0) {
    await batch.commit();
  }
  if (processed > 0) {
    console.log(`reengageCartNoOrderUsers: Marked ${processed} users as re-engaged`);
  }

  console.log(`reengageCartNoOrderUsers: Summary - processed: ${processed}, skipped: ${skipped}, failed: ${failed}`);

  return { processed, skipped, failed, processedUsers: localProcessed };
}


