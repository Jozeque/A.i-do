// ── R2 media backend — public showcase assets on Cloudflare's CDN ──────────────
// Portfolio videos + their poster thumbnails live in a Cloudflare R2 bucket so the
// public landing page streams them straight from Cloudflare's edge: free egress and
// HTTP Range (progressive playback + scrubbing) come built in. This replaces the old
// path where every video byte was proxied out of Google Drive through the Node server
// (no CDN, no range → slow to start, impossible to seek).
//
// R2 is S3-compatible; we sign requests with aws4fetch (tiny, uses the Node 18+ global
// fetch + WebCrypto — no AWS SDK). Enabled ONLY when all five R2_* vars are set; if any
// is missing r2Enabled() is false and callers fall back to the Drive/local storage seam,
// so the app runs unchanged until credentials exist.
//
//   R2_ACCOUNT_ID          – Cloudflare account id (the S3 endpoint host)
//   R2_ACCESS_KEY_ID       – R2 API token access key
//   R2_SECRET_ACCESS_KEY   – R2 API token secret
//   R2_BUCKET              – bucket name (e.g. "sheyo-showcase")
//   R2_PUBLIC_BASE_URL     – the bucket's public base (e.g. https://pub-xxxx.r2.dev
//                            or a custom domain like https://cdn.sheyo.studio)
import { AwsClient } from 'aws4fetch';

const env = (k) => (process.env[k] || '').trim();

export function r2Enabled() {
  return !!(env('R2_ACCOUNT_ID') && env('R2_ACCESS_KEY_ID') && env('R2_SECRET_ACCESS_KEY')
    && env('R2_BUCKET') && env('R2_PUBLIC_BASE_URL'));
}

let _client = null;
function client() {
  if (_client) return _client;
  // region "auto" is R2's convention; service "s3" selects SigV4 S3 signing.
  _client = new AwsClient({
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    region: 'auto',
    service: 's3',
  });
  return _client;
}

// The S3 API endpoint for object operations (signed). Keys are simple slugs
// (showcase/videos/<id>.mp4) so no extra URL-encoding is needed.
const objectUrl = (key) => `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/${env('R2_BUCKET')}/${key}`;

// The public, CDN-served URL a browser loads media from (never signed).
export function publicUrl(key) {
  return `${env('R2_PUBLIC_BASE_URL').replace(/\/+$/, '')}/${key}`;
}

// Upload a buffer under `key`; returns its public CDN URL. Content-Type is required for
// correct <video>/<img> handling; the immutable cache header lets Cloudflare + the browser
// hold the file forever (every upload gets a unique key, so it never goes stale).
export async function putObject(key, buffer, contentType) {
  const res = await client().fetch(objectUrl(key), {
    method: 'PUT',
    body: buffer,
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`R2 upload failed (${res.status}) for ${key}: ${body.slice(0, 200)}`);
  }
  return publicUrl(key);
}

// Best-effort delete; a missing object (404) is treated as already gone.
export async function deleteObject(key) {
  const res = await client().fetch(objectUrl(key), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 delete failed (${res.status}) for ${key}`);
  }
}
