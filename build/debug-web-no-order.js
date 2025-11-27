import { Firestore } from '@google-cloud/firestore';

const db = new Firestore();

async function main() {
  // How many hours to look back; default 3, or pass as first CLI arg
  const hours = Math.max(1, parseInt(process.argv[2] || '3', 10) || 3);

  const now = new Date();
  const cutoffIso = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();

  console.log(`Checking web_checkout sessions updated in last ${hours}h`);
  console.log(`Cutoff (UTC): ${cutoffIso}`);

  const snap = await db
    .collection('sessions')
    .where('state', '==', 'web_checkout')
    .get();

  console.log('Total web_checkout sessions:', snap.size);

  let recentCount = 0;
  let candidateCount = 0; // matches Web_No_Order condition: no orders at all

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const updatedAtRaw = (data.updated_at || '').toString();
    if (!updatedAtRaw || updatedAtRaw < cutoffIso) {
      // Older than N hours or missing updated_at
      continue;
    }
    recentCount++;

    const waUserId = doc.id;

    // Fetch all orders for this WA user
    const ordSnap = await db
      .collection('orders')
      .where('wa_user_id', '==', waUserId)
      .get();

    const hasAnyOrder = !ordSnap.empty;

    // Check if there is any order whose created_at is within [updated_at, updated_at + hours]
    const updatedDate = new Date(updatedAtRaw);
    const windowEnd = new Date(updatedDate.getTime() + hours * 60 * 60 * 1000);

    let hasOrderWithinHours = false;
    const orders = [];

    for (const oDoc of ordSnap.docs) {
      const o = oDoc.data() || {};
      const createdRaw = (o.created_at || '').toString();
      orders.push({ id: o.id || oDoc.id, created_at: createdRaw });
      if (!createdRaw) continue;
      const createdDate = new Date(createdRaw);
      if (isNaN(createdDate.getTime())) continue;
      if (createdDate >= updatedDate && createdDate <= windowEnd) {
        hasOrderWithinHours = true;
      }
    }

    // This matches the Web_No_Order export condition: no orders at all for this WA user
    const isWebNoOrderCandidate = !hasAnyOrder;
    if (isWebNoOrderCandidate) candidateCount++;

    console.log(
      JSON.stringify(
        {
          wa_user_id: waUserId,
          state: data.state || '',
          updated_at: updatedAtRaw,
          web_no_order_exported: data.web_no_order_exported === true,
          web_no_order_exported_at: data.web_no_order_exported_at || null,
          hasAnyOrder,
          hasOrderWithinHours,
          isWebNoOrderCandidate,
          language: data.language || '',
          locale: data.locale || '',
          orders,
        },
        null,
        2,
      ),
    );
  }

  console.log('Recent web_checkout sessions within window:', recentCount);
  console.log('Web_No_Order candidates (no orders at all):', candidateCount);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
