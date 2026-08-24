// ─────────────────────────────────────────────────────────────────────────────
// Backfill the reference collection from chat history.
//
// Every image ever attached in a chat already lives in storage — it was just never
// recorded as a reusable reference. This walks a project's chats, fetches each attached
// image, hashes the bytes, drops exact duplicates, and writes one reference record per
// unique image. Purely additive: nothing is deleted or rewritten.
//
//   node scripts/backfill-references.mjs <projectId>     apply
//   node scripts/backfill-references.mjs <projectId> --dry-run
//   node scripts/backfill-references.mjs --all
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
const all = args.includes('--all');
const pids = args.filter((a) => !a.startsWith('--'));
if (!all && !pids.length) {
  console.error('Usage: node scripts/backfill-references.mjs <projectId> [--dry-run]  |  --all [--dry-run]');
  process.exit(1);
}

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
};

// Read an attached image's bytes back out of storage, whichever backend is in use.
async function readUpload(pid, rec) {
  if (storage.backend === 'drive') {
    const { stream } = await storage.readFile(rec.file);
    return streamToBuffer(stream);
  }
  const fsp = await import('fs/promises');
  const path = await import('path');
  return fsp.readFile(path.join(DATA_DIR, pid, 'uploads', rec.file));
}

async function backfill(pid) {
  const p = await data.getProject(pid);
  // Newest first so that when duplicates exist, the record we keep is the most recent one.
  const attached = [];
  for (const [gemId, msgs] of Object.entries(p.chats || {})) {
    for (const m of msgs || []) for (const im of m.images || []) attached.push({ ...im, gemId, at: m.at || 0 });
  }
  attached.sort((a, b) => (b.at || 0) - (a.at || 0));

  const seen = new Set((p.references || []).map((r) => r.sha256).filter(Boolean));
  const already = seen.size;
  let added = 0, dupes = 0, failed = 0;

  for (const rec of attached) {
    if (!rec.file) continue;
    try {
      const buf = await readUpload(pid, rec);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (seen.has(sha)) { dupes++; continue; }
      seen.add(sha);
      added++;
      if (!dryRun) {
        await data.addReference(pid, {
          id: crypto.randomBytes(8).toString('hex'), sha256: sha,
          file: rec.file, mimeType: rec.mimeType || 'image/jpeg', url: rec.url,
          gemId: rec.gemId || '', createdAt: rec.at || Date.now(),
        });
      }
    } catch (e) {
      failed++;
      console.warn(`   ! ${rec.file}: ${e?.message || e}`);
    }
  }
  console.log(`${p.name || pid}: ${attached.length} attached → ${added} unique added, ${dupes} duplicates skipped` +
    (already ? `, ${already} already kept` : '') + (failed ? `, ${failed} unreadable` : '') + (dryRun ? '  [dry run]' : ''));
  return { added, dupes, failed };
}

const targets = all ? (await data.listProjects()).map((p) => p.id) : pids;
console.log(`${dryRun ? 'Dry run' : 'Backfill'} over ${targets.length} project(s) · storage=${storage.backend} · data=${data.backend}\n`);
let t = { added: 0, dupes: 0, failed: 0 };
for (const pid of targets) {
  try {
    const r = await backfill(pid);
    t = { added: t.added + r.added, dupes: t.dupes + r.dupes, failed: t.failed + r.failed };
  } catch (e) { console.error(`${pid}: ${e?.message || e}`); }
}
console.log(`\nTotal: ${t.added} references ${dryRun ? 'would be added' : 'added'}, ${t.dupes} duplicates skipped, ${t.failed} unreadable.`);
