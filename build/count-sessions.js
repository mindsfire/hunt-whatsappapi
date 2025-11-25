import { Firestore } from '@google-cloud/firestore';

const db = new Firestore();

async function main() {
  // Total sessions
  const snap = await db.collection('sessions').get();
  console.log('Total sessions:', snap.size);

  // If you have created_at as ISO string, example for today:
  const from = '2025-11-25T00:00:00.000Z';
  const snapToday = await db
    .collection('sessions')
    .where('created_at', '>=', from)
    .get();
  console.log('Sessions since', from, ':', snapToday.size);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});