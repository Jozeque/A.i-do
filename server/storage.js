// ── Media storage seam ────────────────────────────────────────────────────────
// All media (chat/reference uploads + generated images) flows through this module
// so the storage backend is swappable. Today: local disk under DATA_DIR, served at
// /media/<pid>/<bucket>/<file>. Phase 1 adds a Google Drive backend behind the SAME
// interface (createStorage picks it via STORAGE_BACKEND) — no route code changes.
//
// Interface:
//   saveUpload(pid, base64, mimeType) -> { file, mimeType, url }
//   saveImage(pid, imgId, buffer, mimeType) -> { file, url }
//   deleteImage(pid, file) -> void
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const rid = () => crypto.randomBytes(8).toString('hex');

// Upload ext rule mirrors the original saveUpload (png/webp/gif else jpg).
function uploadExt(mt) {
  mt = mt || '';
  return mt.includes('png') ? 'png' : mt.includes('webp') ? 'webp' : mt.includes('gif') ? 'gif' : 'jpg';
}

function createLocalStorage(dataDir) {
  const uploadsDir = (pid) => path.join(dataDir, pid, 'uploads');
  const imagesDir = (pid) => path.join(dataDir, pid, 'images');
  return {
    backend: 'local',
    async saveUpload(pid, b64, mimeType) {
      await fsp.mkdir(uploadsDir(pid), { recursive: true });
      const mt = mimeType || 'image/jpeg';
      const file = `${rid()}.${uploadExt(mt)}`;
      await fsp.writeFile(path.join(uploadsDir(pid), file), Buffer.from(b64, 'base64'));
      return { file, mimeType: mt, url: `/media/${pid}/uploads/${file}` };
    },
    async saveImage(pid, imgId, buffer, mimeType) {
      await fsp.mkdir(imagesDir(pid), { recursive: true });
      // Image ext rule mirrors the original generate handler (jpeg else png).
      const ext = (mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
      const file = `${imgId}.${ext}`;
      await fsp.writeFile(path.join(imagesDir(pid), file), buffer);
      return { file, url: `/media/${pid}/images/${file}` };
    },
    async deleteImage(pid, file) {
      await fsp.rm(path.join(imagesDir(pid), file), { force: true });
    },
  };
}

export function createStorage(dataDir, { backend = process.env.STORAGE_BACKEND || 'local' } = {}) {
  if (backend === 'local') return createLocalStorage(dataDir);
  // Phase 1: if (backend === 'drive') return createDriveStorage(dataDir, ...);
  throw new Error(`Unknown STORAGE_BACKEND "${backend}" (expected "local")`);
}
