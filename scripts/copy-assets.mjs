// ─────────────────────────────────────────────────────────────────────────────
// Copy assets (the `characters` collection) from one project into another.
//
// Assets are per-project, so starting a fresh project leaves the ones you already built
// behind. This duplicates them — reference sheet, source photos, notes and @tag — into the
// target. Purely additive: the source project keeps its copies and nothing is deleted.
//
// The image bytes are re-uploaded under new ids in the target so the two projects never
// share a file: deleting an asset in one can then never break the other.
//
//   node scripts/copy-assets.mjs <fromProjectId> <toProjectId> [--dry-run]
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import crypto from 'crypto';
import { createStorage } from '../server/storage.js';
import { createDataStore } from '../server/data.js';

const DATA_DIR = process.env.DATA_DIR || 'projects-data';
const data = createDataStore(DATA_DIR);
const storage = createStorage(DATA_DIR);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [from, to] = args.filter((a) => !a.startsWith('--'));
if (!from || !to) {
  console.error('Usage: node scripts/copy-assets.mjs <fromProjectId> <toProjectId> [--dry-run]');
  process.exit(1);
}

const id = () => crypto.randomBytes(8).toString('hex');
const streamToBuffer = async (s) => { const c = []; for await (const x of s) c.push(x); return Buffer.concat(c); };

// Read a stored image back out, whichever storage backend is configured.
async function readStored(pid, bucket, file) {
  if (storage.backend === 'drive') return streamToBuffer((await storage.readFile(file)).stream);
  const fsp = await import('fs/promises');
  const path = await import('path');
  return fsp.readFile(path.join(DATA_DIR, pid, bucket, file));
}

const src = await data.getProject(from);
const dst = await data.getProject(to);
const assets = src.characters || [];
if (!assets.length) { console.log(`"${src.name}" has no assets to copy.`); process.exit(0); }

// Guard against re-running this script, NOT against the source's own duplicates: two assets
// can legitimately share a name (successive versions of the same trophy), and both must come
// across. So this set is seeded from the target only and never added to while copying.
const existing = new Set((dst.characters || []).map((c) => `${c.name}|${c.type || 'character'}`));
console.log(`${src.name} → ${dst.name}: ${assets.length} assets${dryRun ? '  [dry run]' : ''}\n`);

let copied = 0, skipped = 0, failed = 0;
for (const a of [...assets].reverse()) {           // oldest first, so newest ends up on top
  const key = `${a.name}|${a.type || 'character'}`;
  if (existing.has(key)) { console.log(`  = ${a.name} — already copied to ${dst.name} previously, skipped`); skipped++; continue; }
  try {
    const copy = { ...a, id: id(), createdAt: Date.now() };
    if (a.reference?.file) {
      const buf = await readStored(from, 'images', a.reference.file);
      const refId = id();
      const { file } = dryRun ? { file: 'dry-run' } : await storage.saveImage(to, refId, buf, a.reference.mimeType || 'image/png');
      copy.reference = { ...a.reference, id: refId, file };
    }
    // Source/wardrobe photos are provenance only — carry them so the card still shows them.
    for (const bucket of ['sourceImages', 'wardrobeImages']) {
      const list = a[bucket] || [];
      const out = [];
      for (const s of list) {
        try {
          const buf = await readStored(from, 'uploads', s.file);
          const saved = dryRun ? { file: 'dry-run', mimeType: s.mimeType } : await storage.saveUpload(to, buf.toString('base64'), s.mimeType);
          out.push({ ...s, file: saved.file });
        } catch { /* a missing source photo must not block the asset itself */ }
      }
      copy[bucket] = out;
    }
    if (!dryRun) await data.update(to, (p) => { p.characters = p.characters || []; p.characters.unshift(copy); p.updatedAt = Date.now(); });
    copied++;
    console.log(`  + ${a.name}  (${a.type || 'character'})`);
  } catch (e) {
    failed++;
    console.warn(`  ! ${a.name}: ${e?.message || e}`);
  }
}
console.log(`\n${dryRun ? 'Would copy' : 'Copied'} ${copied}, skipped ${skipped} already present${failed ? `, ${failed} failed` : ''}.`);
