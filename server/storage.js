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
import { createReadStream } from 'fs';
import path from 'path';
import crypto from 'crypto';

const rid = () => crypto.randomBytes(8).toString('hex');

// Upload ext rule mirrors the original saveUpload (png/webp/gif else jpg).
function uploadExt(mt) {
  mt = mt || '';
  return mt.includes('png') ? 'png' : mt.includes('webp') ? 'webp' : mt.includes('gif') ? 'gif' : 'jpg';
}
// Showcase videos live under a single virtual project id "showcase" / bucket "videos".
function videoExt(mt) {
  mt = mt || '';
  return mt.includes('webm') ? 'webm' : (mt.includes('quicktime') || mt.includes('mov')) ? 'mov' : 'mp4';
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
    async saveShowcase(id, filePath, mimeType) {
      const dir = path.join(dataDir, 'showcase', 'videos');
      await fsp.mkdir(dir, { recursive: true });
      const file = `${id}.${videoExt(mimeType)}`;
      await fsp.copyFile(filePath, path.join(dir, file));
      return { file, url: `/media/showcase/videos/${file}` };
    },
    async deleteShowcase(file) {
      await fsp.rm(path.join(dataDir, 'showcase', 'videos', file), { force: true });
    },
  };
}

// ── Google Drive backend ─────────────────────────────────────────────────────
// Writes media into the OWNER's personal Drive (so it counts against their 2 TB) by
// acting as that Google account via OAuth + a stored refresh token — a service account
// can't use a consumer Drive's quota. Scope: drive.file (the app only ever touches
// files it creates). Layout: <DRIVE_ROOT>/<pid>/<bucket>/<file>. The returned `file`
// is the Drive file id; the /media route streams it back (proxy in server/index.js).
function createDriveStorage() {
  let _drive = null, _Readable = null;
  async function drive() {
    if (_drive) return _drive;
    const { google } = await import('googleapis');
    ({ Readable: _Readable } = await import('stream'));
    const oauth = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    );
    oauth.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    _drive = google.drive({ version: 'v3', auth: oauth });
    return _drive;
  }

  const ROOT = process.env.DRIVE_ROOT_FOLDER || 'AI Video Studio';
  const folderCache = new Map(); // "parent/name" -> folderId

  // Cache the in-flight PROMISE (not just the id) so concurrent uploads to the same
  // project/bucket reuse one folder-creation instead of racing to create duplicates.
  function folder(name, parentId) {
    const key = `${parentId || 'root'}/${name}`;
    let pending = folderCache.get(key);
    if (pending) return pending;
    pending = (async () => {
      const d = await drive();
      const q = [
        `name='${name.replace(/'/g, "\\'")}'`,
        "mimeType='application/vnd.google-apps.folder'",
        'trashed=false',
        parentId ? `'${parentId}' in parents` : null,
      ].filter(Boolean).join(' and ');
      const res = await d.files.list({ q, fields: 'files(id)', spaces: 'drive' });
      let id = res.data.files?.[0]?.id;
      if (!id) {
        const created = await d.files.create({
          requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined },
          fields: 'id',
        });
        id = created.data.id;
      }
      return id;
    })();
    folderCache.set(key, pending);
    return pending;
  }

  async function upload(pid, bucket, name, source, mimeType) {
    const d = await drive();
    const root = await folder(ROOT, null);
    const proj = await folder(pid, root);
    const parent = await folder(bucket, proj);
    // source is a Buffer (small images) or a readable stream (large showcase videos streamed from
    // a temp file, so a big upload never sits fully in memory).
    const body = Buffer.isBuffer(source) ? _Readable.from(source) : source;
    const res = await d.files.create({
      requestBody: { name, parents: [parent] },
      media: { mimeType: mimeType || 'application/octet-stream', body },
      fields: 'id',
    });
    return res.data.id;
  }

  return {
    backend: 'drive',
    async saveUpload(pid, b64, mimeType) {
      const mt = mimeType || 'image/jpeg';
      const file = await upload(pid, 'uploads', `${rid()}.${uploadExt(mt)}`, Buffer.from(b64, 'base64'), mt);
      return { file, mimeType: mt, url: `/media/${pid}/uploads/${file}` };
    },
    async saveImage(pid, imgId, buffer, mimeType) {
      const ext = (mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
      const file = await upload(pid, 'images', `${imgId}.${ext}`, buffer, mimeType);
      return { file, url: `/media/${pid}/images/${file}` };
    },
    async deleteImage(pid, file) {
      try { await (await drive()).files.delete({ fileId: file }); } catch { /* already gone */ }
    },
    async saveShowcase(id, filePath, mimeType) {
      const file = await upload('showcase', 'videos', `${id}.${videoExt(mimeType)}`, createReadStream(filePath), mimeType);
      return { file, url: `/media/showcase/videos/${file}` };
    },
    async deleteShowcase(file) {
      try { await (await drive()).files.delete({ fileId: file }); } catch { /* already gone */ }
    },
    // Stream a Drive file's bytes back (used by the /media proxy). Returns {stream, mimeType}.
    async readFile(fileId) {
      const d = await drive();
      const res = await d.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
      return { stream: res.data, mimeType: res.headers?.['content-type'] || 'application/octet-stream' };
    },
    // Pre-load the Drive client (googleapis import + first OAuth token exchange) at boot,
    // so the first real media request isn't hit with the cold-start latency (~seconds).
    async warmUp() {
      try { const d = await drive(); await d.files.list({ pageSize: 1, fields: 'files(id)' }); } catch { /* best-effort */ }
    },
  };
}

export function createStorage(dataDir, { backend = process.env.STORAGE_BACKEND || 'local' } = {}) {
  if (backend === 'local') return createLocalStorage(dataDir);
  if (backend === 'drive') return createDriveStorage();
  throw new Error(`Unknown STORAGE_BACKEND "${backend}" (expected "local" or "drive")`);
}
