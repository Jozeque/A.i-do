// ── Showcase seam — public portfolio videos for the A.I-Duo landing page ──────
// Records live in the Firestore 'showcase' collection; the video files go through the
// storage seam (Drive). The landing page reads the PUBLIC list; add/remove/update are
// gated (in-app admin, behind the login).
import { getAdminApp } from './firebase.js';
import { r2Enabled, putObject, deleteObject } from './r2.js';

// Extension from a video mime type (mirrors storage.js videoExt) — used to build R2 keys.
function videoExt(mt) {
  mt = mt || '';
  return mt.includes('webm') ? 'webm' : (mt.includes('quicktime') || mt.includes('mov')) ? 'mov' : 'mp4';
}

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

  async function add({ id, title, caption, buffer, mimeType, posterBuffer, posterMime, createdAt }) {
    const base = {
      id, title: title || '', caption: caption || '',
      mimeType: mimeType || 'video/mp4', published: true, order: createdAt, createdAt,
    };
    let item;
    if (r2Enabled()) {
      // Public CDN path: the video + poster live in R2 and the record holds their public
      // URLs, so the landing page streams straight from Cloudflare (no /media proxy).
      const videoKey = `showcase/videos/${id}.${videoExt(mimeType)}`;
      const url = await putObject(videoKey, buffer, mimeType || 'video/mp4');
      let poster = '', posterKey = '';
      if (posterBuffer && posterBuffer.length) {
        posterKey = `showcase/posters/${id}.jpg`;
        poster = await putObject(posterKey, posterBuffer, posterMime || 'image/jpeg');
      }
      item = { ...base, storage: 'r2', videoKey, posterKey, url, poster };
    } else {
      // Fallback (no R2 configured): Drive/local storage seam via the /media proxy, no poster.
      const saved = await storage.saveShowcase(id, buffer, mimeType);
      item = { ...base, storage: storage.backend, file: saved.file, url: saved.url, poster: '' };
    }
    await (await col()).doc(id).set(item);
    return item;
  }

  // Backfill a poster for an EXISTING R2 video. Posters are captured in the browser (the
  // server has no ffmpeg), so this takes the finished JPEG and stores it beside the video.
  async function setPoster(id, posterBuffer, posterMime) {
    const ref = (await col()).doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Showcase item not found.');
    const d = snap.data();
    if (d.storage !== 'r2') return d;   // only R2 items carry CDN posters
    const posterKey = d.posterKey || `showcase/posters/${id}.jpg`;
    const poster = await putObject(posterKey, posterBuffer, posterMime || 'image/jpeg');
    await ref.set({ posterKey, poster }, { merge: true });
    return { ...d, posterKey, poster };
  }

  async function remove(id) {
    const ref = (await col()).doc(id);
    const snap = await ref.get();
    if (snap.exists) {
      const d = snap.data();
      if (d.storage === 'r2') {
        if (d.videoKey) { try { await deleteObject(d.videoKey); } catch { /* already gone */ } }
        if (d.posterKey) { try { await deleteObject(d.posterKey); } catch { /* already gone */ } }
      } else if (d.file) {
        try { await storage.deleteShowcase(d.file); } catch { /* file already gone */ }
      }
    }
    await ref.delete();
  }

  async function update(id, patch) {
    const ref = (await col()).doc(id);
    await ref.set(patch, { merge: true });
    return (await ref.get()).data();
  }

  return { list, add, setPoster, remove, update };
}
