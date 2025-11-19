import { Storage } from '@google-cloud/storage';
import { getMediaCache, setMediaCache } from '../firestore.js';

const MEDIA_BUCKET = process.env.MEDIA_BUCKET || '';
const MEDIA_BASE_PREFIX = (process.env.MEDIA_BASE_PREFIX || '').replace(/^\/+|\/+$/g, '');
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || '';
const WA_TOKEN = process.env.WA_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN || '';

const storage = new Storage();

export function normalizeGcsPath(p) {
  if (!p) return { bucket: '', name: '' };
  if (p.startsWith('gs://')) {
    const rest = p.slice('gs://'.length);
    const firstSlash = rest.indexOf('/');
    const b = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
    const name = firstSlash === -1 ? '' : rest.slice(firstSlash + 1);
    return { bucket: b, name };
  }
  const base = MEDIA_BASE_PREFIX ? `${MEDIA_BASE_PREFIX}/` : '';
  return { bucket: MEDIA_BUCKET, name: `${base}${p}` };
}

export async function getGcsBytes(gcsPathOrObjectName) {
  const { bucket, name } = normalizeGcsPath(gcsPathOrObjectName);
  if (!bucket || !name) throw new Error('Invalid GCS path/object name');
  const file = storage.bucket(bucket).file(name);
  const [buf] = await file.download();
  const lower = name.toLowerCase();
  const mime = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  const filename = name.split('/').pop() || 'image.jpg';
  return { buf, mime, filename };
}

function waMediaUploadUrl() {
  if (!PHONE_NUMBER_ID) throw new Error('WA_PHONE_NUMBER_ID not set');
  return `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`;
}

export async function uploadMediaToWA({ buf, mime, filename }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buf], { type: mime }), filename);
  const res = await fetch(waMediaUploadUrl(), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
    body: form
  });
  let bodyText = '';
  let json = null;
  try {
    bodyText = await res.text();
    json = JSON.parse(bodyText);
  } catch (_) {}
  if (!res.ok) {
    const errPayload = json || { error_text: bodyText };
    console.error('WA media upload error', res.status, errPayload);
    throw new Error(`WA media upload failed: ${res.status} ${JSON.stringify(errPayload)}`);
  }
  const mediaId = json && json.id ? json.id : null;
  if (!mediaId) throw new Error(`WA media upload returned no id: ${bodyText}`);
  return mediaId;
}

export async function getOrCreateMediaIdForGcsPath(gcsPathOrObjectName) {
  const key = gcsPathOrObjectName.startsWith('gs://')
    ? gcsPathOrObjectName
    : `${MEDIA_BUCKET}/${MEDIA_BASE_PREFIX ? MEDIA_BASE_PREFIX + '/' : ''}${gcsPathOrObjectName}`;
  const cached = await getMediaCache(key);
  if (cached && cached.media_id) return cached.media_id;
  const payload = await getGcsBytes(gcsPathOrObjectName);
  const media_id = await uploadMediaToWA(payload);
  await setMediaCache(key, { media_id, mime: payload.mime, filename: payload.filename, uploaded_at: new Date().toISOString() });
  return media_id;
}
