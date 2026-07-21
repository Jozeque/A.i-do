// ── Showcase seam — public portfolio videos for the A.I-Duo landing page ──────
// Records live in the Firestore 'showcase' collection; the video files go through the
// storage seam (Drive). The landing page reads the PUBLIC list; add/remove/update are
// gated (in-app admin, behind the login).
import { getAdminApp } from './firebase.js';

export function createShowcase(storage) {
  let _col = null;
  async function col() {
    if (_col) return _col;
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(await getAdminApp());
    try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* already configured */ }
    _col = db.collection('showcase');
    return _col;
  }

  async function list({ publishedOnly = false } = {}) {
    const snap = await (await col()).get();
    let items = snap.docs.map((d) => d.data());
    if (publishedOnly) items = items.filter((i) => i.published !== false);
    // explicit order first, then newest
    items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (b.createdAt || 0) - (a.createdAt || 0));
    return items;
  }

  async function add({ id, title, caption, buffer, mimeType, createdAt }) {
    const saved = await storage.saveShowcase(id, buffer, mimeType);
    const item = {
      id, title: title || '', caption: caption || '',
      file: saved.file, url: saved.url, mimeType: mimeType || 'video/mp4',
      published: true, order: createdAt, createdAt,
    };
    await (await col()).doc(id).set(item);
    return item;
  }

  async function remove(id) {
    const ref = (await col()).doc(id);
    const snap = await ref.get();
    if (snap.exists) { try { await storage.deleteShowcase(snap.data().file); } catch { /* file already gone */ } }
    await ref.delete();
  }

  async function update(id, patch) {
    const ref = (await col()).doc(id);
    await ref.set(patch, { merge: true });
    return (await ref.get()).data();
  }

  return { list, add, remove, update };
}
