// ── One-time migration: showcase videos Google Drive → Cloudflare R2 ───────────
// Moves each existing portfolio video from the Drive-backed /media proxy onto R2 and
// repoints its Firestore record at the public CDN URL, so the landing page streams from
// Cloudflare (fast start + scrubbing) instead of through the Node server.
//
// Idempotent: items already on R2 are skipped, so it's safe to re-run.
//
// Run LOCALLY with the production creds present in .env:
//   • FIREBASE_SERVICE_ACCOUNT      (same Firebase project the app uses)
//   • GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN  (+ DRIVE_ROOT_FOLDER)  — to read the originals
//   • R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_BASE_URL
//
//   node scripts/migrate-showcase-to-r2.js
import 'dotenv/config';
import { getFirestore } from 'firebase-admin/firestore';
import { getAdminApp } from '../server/firebase.js';
import { createStorage } from '../server/storage.js';
import { r2Enabled, putObject } from '../server/r2.js';

function videoExt(mt) {
  mt = mt || '';
  return mt.includes('webm') ? 'webm' : (mt.includes('quicktime') || mt.includes('mov')) ? 'mov' : 'mp4';
}
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

async function main() {
  if (!r2Enabled()) {
    console.error('✗ R2 is not configured — set the five R2_* vars in .env first.');
    process.exit(1);
  }
  const storage = createStorage(process.cwd() + '/projects-data', { backend: 'drive' });
  if (typeof storage.readFile !== 'function') {
    console.error('✗ Drive storage unavailable — this migration needs GOOGLE_OAUTH_* in .env to read the originals.');
    process.exit(1);
  }

  const db = getFirestore(await getAdminApp());
  const col = db.collection('showcase');
  const snap = await col.get();
  console.log(`Found ${snap.size} showcase item(s).\n`);

  let moved = 0, skipped = 0, failed = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.storage === 'r2') { skipped++; console.log(`  • skip ${d.id} — already on R2`); continue; }
    if (!d.file) { skipped++; console.log(`  • skip ${d.id} — no Drive file id on record`); continue; }
    try {
      process.stdout.write(`  • ${d.id} … reading from Drive`);
      const { stream, mimeType } = await storage.readFile(d.file);
      const buf = await streamToBuffer(stream);
      const mt = d.mimeType || mimeType || 'video/mp4';
      const videoKey = `showcase/videos/${d.id}.${videoExt(mt)}`;
      process.stdout.write(` → uploading ${(buf.length / 1e6).toFixed(1)} MB to R2`);
      const url = await putObject(videoKey, buf, mt);
      // Repoint the record; keep the original `file`/Drive copy in place as a safety net
      // (remove() now branches on storage==='r2', so the Drive original is simply orphaned).
      await doc.ref.set({ storage: 'r2', videoKey, url, poster: d.poster || '' }, { merge: true });
      console.log(' ✓');
      moved++;
    } catch (e) {
      console.log(' ✗');
      console.error(`     ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone. moved=${moved} skipped=${skipped} failed=${failed}`);
  if (moved) console.log('Posters backfill automatically the next time you open the Showcase tab in the app (or re-upload a clip to attach one).');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
