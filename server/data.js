// ── Project metadata seam ───────────────────────────────────────────────────
// Project records (name, chats, gem settings, image list) flow through this module
// so the metadata backend is swappable. Today: local JSON at
// projects-data/<pid>/project.json. Phase 1 can drop in a database (e.g. Postgres)
// behind the SAME interface — no route code changes.
//
// Interface:
//   getProject(pid)    -> project object
//   saveProject(p)     -> project object (persisted)
//   listProjects()     -> [{ id, name, createdAt, updatedAt, imageCount, chatCount }]
//   deleteProject(pid) -> void
import fsp from 'fs/promises';
import path from 'path';
import { getAdminApp } from './firebase.js';

function createLocalDataStore(dataDir) {
  const projDir = (pid) => path.join(dataDir, pid);
  const metaPath = (pid) => path.join(projDir(pid), 'project.json');

  async function getProject(pid) {
    return JSON.parse(await fsp.readFile(metaPath(pid), 'utf8'));
  }
  // Local reads the whole file anyway; these keep the seam interface consistent with Firestore.
  async function getProjectLight(pid) { const p = await getProject(pid); return { ...p, images: [] }; }
  async function getImages(pid) { const p = await getProject(pid); return p.images || []; }
  async function addImage(pid, rec) { return update(pid, (p) => { p.images = p.images || []; p.images.unshift(rec); p.updatedAt = Date.now(); }); }
  async function appendChat(pid, gemId, newMsgs) { return update(pid, (p) => { p.chats = p.chats || {}; p.chats[gemId] = p.chats[gemId] || []; p.chats[gemId].push(...newMsgs); p.updatedAt = Date.now(); }); }

  async function saveProject(p) {
    await fsp.mkdir(projDir(p.id), { recursive: true });
    // Atomic write: write a temp file then rename over the target, so a crash/kill mid-write
    // can never truncate project.json (which would lose the whole project's metadata).
    const dest = metaPath(p.id);
    const tmp = `${dest}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(p, null, 2));
    await fsp.rename(tmp, dest);
    return p;
  }

  // ── Per-project write serialization ────────────────────────────────────────
  // Each project's read-modify-write runs in a queue keyed by pid, so two concurrent
  // requests can't both read the same project.json and then clobber each other's changes
  // (the race that was silently dropping generated images from the library). The mutator
  // gets a FRESH read inside the lock and the result is written before the lock frees.
  const queues = new Map(); // pid -> tail promise
  async function update(pid, mutator) {
    const prev = queues.get(pid) || Promise.resolve();
    const run = prev.then(async () => {
      const p = await getProject(pid);
      const out = await mutator(p);
      const toSave = out || p;
      await saveProject(toSave);
      return toSave;
    });
    const tail = run.catch(() => {});           // keep the chain alive past a failed mutator
    queues.set(pid, tail);
    tail.then(() => { if (queues.get(pid) === tail) queues.delete(pid); });
    return run;
  }

  async function listProjects() {
    const entries = await fsp.readdir(dataDir, { withFileTypes: true });
    const projects = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const p = JSON.parse(await fsp.readFile(metaPath(e.name), 'utf8'));
        const imageCount = (p.images || []).length;
        const chatCount = Object.values(p.chats || {}).reduce((n, arr) => n + (arr?.length || 0), 0);
        projects.push({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, imageCount, chatCount });
      } catch { /* skip dirs that aren't projects */ }
    }
    projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return projects;
  }

  async function deleteProject(pid) {
    await fsp.rm(projDir(pid), { recursive: true, force: true });
  }

  return { backend: 'local', getProject, getProjectLight, getImages, addImage, appendChat, saveProject, update, listProjects, deleteProject };
}

// ── Firestore backend (subcollections) ──────────────────────────────────────
// A project is split across documents so no single doc can hit Firestore's 1 MiB
// limit and concurrent writes can't clobber a shared array:
//   projects/{pid}                — light meta (name, gem settings, timestamps, cached counts)
//   projects/{pid}/chats/{gemId}  — one doc per tab, holding that tab's message array
//   projects/{pid}/images/{imgId} — one doc per generated image
// getProject reassembles the full blob the routes already expect, so route code is
// unchanged. Writes go through a per-pid queue (single-instance lock, like the local
// backend); saveProject diffs the image docs so only new/changed ones are written.
const GEM_TABS = ['nb-frames', 'kling', 'kling-advisor', 'nb-advisor'];

function createFirestoreDataStore() {
  let _db = null, _col = null;
  async function init() {
    if (_col) return;
    const { getFirestore } = await import('firebase-admin/firestore');
    _db = getFirestore(await getAdminApp());
    // Mirror JSON semantics: silently drop undefined fields instead of throwing.
    try { _db.settings({ ignoreUndefinedProperties: true }); } catch { /* already configured */ }
    _col = _db.collection('projects');
  }

  // Reassemble the full project blob from the meta doc + chats + images subcollections.
  async function getProject(pid) {
    await init();
    const ref = _col.doc(pid);
    // Fetch meta + all three subcollections IN PARALLEL — they're independent, and doing them
    // sequentially cost ~4 network round trips per project open (the "switching is slow" lag).
    const [metaSnap, chatsSnap, imagesSnap, charactersSnap] = await Promise.all([
      ref.get(),
      ref.collection('chats').get(),
      ref.collection('images').get(),
      ref.collection('characters').get(),
    ]);
    if (!metaSnap.exists) throw new Error(`Project not found: ${pid}`);
    const { imageCount, chatCount, ...meta } = metaSnap.data(); // counts are internal cache
    const chats = {};
    for (const g of GEM_TABS) chats[g] = [];
    chatsSnap.forEach((d) => { chats[d.id] = d.data().messages || []; });
    const images = imagesSnap.docs
      .map((d) => d.data())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const characters = charactersSnap.docs
      .map((d) => d.data())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { ...meta, chats, images, characters };
  }

  // Fast open: everything EXCEPT the (potentially huge) images subcollection. The frontend
  // opens a project on this, then lazy-loads images via getImages when a tab needs them.
  async function getProjectLight(pid) {
    await init();
    const ref = _col.doc(pid);
    const [metaSnap, chatsSnap, charactersSnap] = await Promise.all([
      ref.get(), ref.collection('chats').get(), ref.collection('characters').get(),
    ]);
    if (!metaSnap.exists) throw new Error(`Project not found: ${pid}`);
    const { imageCount, chatCount, ...meta } = metaSnap.data();
    const chats = {};
    for (const g of GEM_TABS) chats[g] = [];
    chatsSnap.forEach((d) => { chats[d.id] = d.data().messages || []; });
    const characters = charactersSnap.docs.map((d) => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { ...meta, chats, images: [], characters };
  }

  // Just the images subcollection (for the lazy Library / Generate load).
  async function getImages(pid) {
    await init();
    const snap = await _col.doc(pid).collection('images').get();
    return snap.docs.map((d) => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  // Append ONE generated image WITHOUT reading the whole project — writes just the image doc
  // and bumps the cached count. (A full saveProject re-reads every image doc to diff them, so
  // appending via getProject+saveProject cost hundreds of Firestore reads per generation — the
  // burst that tripped the quota when "Send all 3" fired several generations at once.)
  async function addImage(pid, rec) {
    await init();
    const { FieldValue } = await import('firebase-admin/firestore');
    const ref = _col.doc(pid);
    await ref.collection('images').doc(String(rec.id)).set(rec);
    await ref.set({ imageCount: FieldValue.increment(1), updatedAt: rec.createdAt || Date.now() }, { merge: true });
  }

  // Append chat message(s) to ONE gem's chat doc via a transaction — reads only that chat doc
  // (not the whole project's images), so a chat message costs ~1 read instead of hundreds. The
  // transaction keeps two concurrent messages on the same tab from clobbering each other.
  async function appendChat(pid, gemId, newMsgs) {
    await init();
    const { FieldValue } = await import('firebase-admin/firestore');
    const ref = _col.doc(pid);
    const chatRef = ref.collection('chats').doc(gemId);
    await _db.runTransaction(async (tx) => {
      const snap = await tx.get(chatRef);
      const msgs = snap.exists ? (snap.data().messages || []) : [];
      msgs.push(...newMsgs);
      tx.set(chatRef, { messages: msgs });
      tx.set(ref, { updatedAt: Date.now(), chatCount: FieldValue.increment(newMsgs.length) }, { merge: true });
    });
  }

  // Persist the blob: meta + per-tab chat docs in one batch, then image docs DIFFED
  // (only new/changed written, removed deleted), chunked under the 500-op batch limit.
  async function saveProject(p) {
    await init();
    const ref = _col.doc(p.id);
    const { chats = {}, images = [], characters = [], ...meta } = p;
    meta.imageCount = images.length;
    meta.characterCount = characters.length;
    meta.chatCount = Object.values(chats).reduce((n, a) => n + (a?.length || 0), 0);

    const head = _db.batch();
    head.set(ref, meta);
    for (const [gemId, msgs] of Object.entries(chats)) head.set(ref.collection('chats').doc(gemId), { messages: msgs || [] });
    await head.commit();

    // Diff a per-doc subcollection (images, characters): write only new/changed, delete removed.
    async function diffSub(sub, items) {
      const prevById = new Map((await ref.collection(sub).get()).docs.map((d) => [d.id, d.data()]));
      const ops = [];
      const keep = new Set();
      for (const it of items) {
        const docId = String(it.id);
        keep.add(docId);
        const prev = prevById.get(docId);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(it)) ops.push(['set', ref.collection(sub).doc(docId), it]);
      }
      for (const docId of prevById.keys()) if (!keep.has(docId)) ops.push(['del', ref.collection(sub).doc(docId)]);
      return ops;
    }
    const ops = [...(await diffSub('images', images)), ...(await diffSub('characters', characters))];
    for (let i = 0; i < ops.length; i += 450) {
      const batch = _db.batch();
      for (const [kind, docRef, data] of ops.slice(i, i + 450)) kind === 'set' ? batch.set(docRef, data) : batch.delete(docRef);
      await batch.commit();
    }
    return p;
  }

  // Serialized per-pid read-modify-write — single-instance lock, like the local backend.
  const queues = new Map();
  async function update(pid, mutator) {
    const prev = queues.get(pid) || Promise.resolve();
    const run = prev.then(async () => {
      const p = await getProject(pid);
      const out = await mutator(p);
      const toSave = out || p;
      await saveProject(toSave);
      return toSave;
    });
    const tail = run.catch(() => {});
    queues.set(pid, tail);
    tail.then(() => { if (queues.get(pid) === tail) queues.delete(pid); });
    return run;
  }

  // Fast: reads only the light meta docs (counts are cached on them).
  async function listProjects() {
    await init();
    const snap = await _col.get();
    const projects = [];
    snap.forEach((doc) => {
      const p = doc.data();
      projects.push({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, imageCount: p.imageCount || 0, chatCount: p.chatCount || 0 });
    });
    projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return projects;
  }

  // Delete the meta doc + every chats/images subdoc (chunked).
  async function deleteProject(pid) {
    await init();
    const ref = _col.doc(pid);
    for (const sub of ['chats', 'images', 'characters']) {
      const docs = (await ref.collection(sub).get()).docs;
      for (let i = 0; i < docs.length; i += 450) {
        const batch = _db.batch();
        docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    }
    await ref.delete();
  }

  return { backend: 'firestore', getProject, getProjectLight, getImages, addImage, appendChat, saveProject, update, listProjects, deleteProject };
}

export function createDataStore(dataDir, { backend = process.env.DATA_BACKEND || 'local' } = {}) {
  if (backend === 'local') return createLocalDataStore(dataDir);
  if (backend === 'firestore') return createFirestoreDataStore();
  throw new Error(`Unknown DATA_BACKEND "${backend}" (expected "local" or "firestore")`);
}
