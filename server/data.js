// ── Project metadata seam ───────────────────────────────────────────────────
// Project records (name, chats, gem settings, image list) flow through this module
// so the metadata backend is swappable. Today: local JSON at
// projects-data/<pid>/project.json. Phase 1 can drop in a database (e.g. Postgres)
// behind the SAME interface — no route code changes.
//
// Interface:
//   getProject(pid)    -> project object
//   saveProject(p)     -> project object (persisted)
//   listProjects()     -> [{ id, name, client, createdAt, updatedAt, imageCount, chatCount }]
//   deleteProject(pid) -> void
//   getScenes / addScene / patchScene / deleteScene -> a project's scenes (see SCENES.md)
import fsp from 'fs/promises';
import path from 'path';
import { getAdminApp } from './firebase.js';
import { sortScenes } from './scenes.js';

function createLocalDataStore(dataDir) {
  const projDir = (pid) => path.join(dataDir, pid);
  const metaPath = (pid) => path.join(projDir(pid), 'project.json');

  async function getProject(pid) {
    return JSON.parse(await fsp.readFile(metaPath(pid), 'utf8'));
  }
  // Local reads the whole file anyway; these keep the seam interface consistent with Firestore.
  async function getProjectLight(pid) { const p = await getProject(pid); return { ...p, images: [] }; }
  async function getImages(pid) { const p = await getProject(pid); return p.images || []; }
  async function getCharacters(pid) { const p = await getProject(pid); return p.characters || []; }
  async function addImage(pid, rec) { return update(pid, (p) => { p.images = p.images || []; p.images.unshift(rec); p.updatedAt = Date.now(); }); }
  // References = every image attached in a chat, kept so it never has to be re-uploaded.
  // Deduped on sha256 of the bytes, so the same file attached ten times is stored once.
  async function addReference(pid, rec) { return update(pid, (p) => { p.references = p.references || []; p.references.unshift(rec); p.updatedAt = Date.now(); }); }
  async function findReferenceBySha(pid, sha) { const p = await getProject(pid); return (p.references || []).find((r) => r.sha256 === sha) || null; }
  async function deleteReference(pid, refId) { return update(pid, (p) => { p.references = (p.references || []).filter((r) => r.id !== refId); p.updatedAt = Date.now(); }); }
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
        projects.push({ id: p.id, name: p.name, client: p.client || '', createdAt: p.createdAt, updatedAt: p.updatedAt, imageCount, chatCount });
      } catch { /* skip dirs that aren't projects */ }
    }
    projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return projects;
  }

  async function deleteProject(pid) {
    await fsp.rm(projDir(pid), { recursive: true, force: true });
  }

  // Scenes live in project.json's `scenes` list; their chats under `{sceneId}~{gemId}` keys.
  async function getScenes(pid) { return sortScenes((await getProject(pid)).scenes); }
  async function addScene(pid, scene) {
    await update(pid, (p) => { p.scenes = [...(p.scenes || []), scene]; p.updatedAt = Date.now(); });
    return scene;
  }
  async function patchScene(pid, sceneId, patch) {
    let out = null;
    await update(pid, (p) => {
      const s = (p.scenes || []).find(x => x.id === sceneId);
      if (!s) return;
      Object.assign(s, patch, { updatedAt: Date.now() });
      out = { ...s };
    });
    return out;
  }
  // The scene and its chats go; its images stay, back in General.
  async function deleteScene(pid, sceneId) {
    const res = { movedImages: 0, deletedChats: 0 };
    await update(pid, (p) => {
      p.scenes = (p.scenes || []).filter(s => s.id !== sceneId);
      for (const key of Object.keys(p.chats || {})) if (key.startsWith(`${sceneId}~`)) { delete p.chats[key]; res.deletedChats++; }
      for (const im of p.images || []) if (im.sceneId === sceneId) { delete im.sceneId; res.movedImages++; }
      p.updatedAt = Date.now();
    });
    return res;
  }

  // The project's own settings, without its content (local reads the whole file anyway).
  const getMeta = (pid) => getProject(pid);
  // Every version of a gem's Tune, kept so an image's recipe can show the one it was made with.
  async function addTune(pid, snap) { await update(pid, (p) => { p.tunes = [...(p.tunes || []), snap]; }); return snap; }
  async function getTune(pid, tuneId) { return ((await getProject(pid)).tunes || []).find(t => t.id === tuneId) || null; }
  // Change one message of one chat in place — find(messages) picks it, mutate(message) changes it
  // and returns the result (undefined when there's no such chat or message).
  async function updateChatMessage(pid, key, find, mutate) {
    let out;
    await update(pid, (p) => {
      const msgs = p.chats?.[key];
      const i = msgs ? find(msgs) : -1;
      if (i < 0) return;
      out = mutate(msgs[i]);
      p.updatedAt = Date.now();
    });
    return out;
  }

  return { backend: 'local', getProject, getProjectLight, getImages, getCharacters, addImage, appendChat, saveProject, update, listProjects, deleteProject,
    addReference, findReferenceBySha, deleteReference, getScenes, addScene, patchScene, deleteScene, getMeta, addTune, getTune, updateChatMessage };
}

// Runs each write to a project after the earlier ones on that project have finished; different
// projects don't wait on each other. A failed write doesn't hold up the ones behind it.
export function createWriteQueue() {
  const queues = new Map(); // pid -> tail promise
  return function serialize(pid, fn) {
    const prev = queues.get(pid) || Promise.resolve();
    const run = prev.then(fn);
    const tail = run.catch(() => {});   // keep the chain alive past a failed write
    queues.set(pid, tail);
    tail.then(() => { if (queues.get(pid) === tail) queues.delete(pid); });
    return run;
  };
}

// ── Firestore backend (subcollections) ──────────────────────────────────────
// A project is split across documents so no single doc can hit Firestore's 1 MiB
// limit and concurrent writes can't clobber a shared array:
//   projects/{pid}                — light meta (name, gem settings, timestamps, cached counts)
//   projects/{pid}/chats/{gemId}  — one doc per tab, holding that tab's message array
//                                   (a scene's chat: {sceneId}~{gemId})
//   projects/{pid}/images/{imgId} — one doc per generated image
//   projects/{pid}/scenes/{sceneId} — one doc per scene (title, brief, order)
// getProject reassembles the full blob the routes already expect, so route code is
// unchanged. Writes go through a per-pid queue (single-instance lock, like the local
// backend); saveProject diffs the image docs so only new/changed ones are written.
const GEM_TABS = ['nb-frames', 'kling', 'kling-advisor', 'nb-advisor', 'storyboard'];

function createFirestoreDataStore() {
  let _db = null, _col = null;

  // One write queue per project. update()'s read-modify-write rewrites every chat doc and deletes
  // any image or reference it didn't read, so the quick writes (addImage, appendChat,
  // addReference, deleteReference) wait in the same queue: a generation or a chat reply landing
  // in the middle of a ♥, an approve or a rename used to be erased by it. The quick writes still
  // read nothing extra — they only wait their turn.
  const serialize = createWriteQueue();
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
    const [metaSnap, chatsSnap, imagesSnap, charactersSnap, referencesSnap, scenesSnap] = await Promise.all([
      ref.get(),
      ref.collection('chats').get(),
      ref.collection('images').get(),
      ref.collection('characters').get(),
      ref.collection('references').get(),
      ref.collection('scenes').get(),
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
    const references = referencesSnap.docs
      .map((d) => d.data())
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const scenes = sortScenes(scenesSnap.docs.map((d) => d.data()));
    return { ...meta, chats, images, characters, references, scenes };
  }

  // Fast open: everything EXCEPT the (potentially huge) images subcollection. The frontend
  // opens a project on this, then lazy-loads images via getImages when a tab needs them.
  async function getProjectLight(pid) {
    await init();
    const ref = _col.doc(pid);
    const [metaSnap, chatsSnap, charactersSnap, referencesSnap, scenesSnap] = await Promise.all([
      ref.get(), ref.collection('chats').get(), ref.collection('characters').get(), ref.collection('references').get(),
      ref.collection('scenes').get(),
    ]);
    if (!metaSnap.exists) throw new Error(`Project not found: ${pid}`);
    const { imageCount, chatCount, ...meta } = metaSnap.data();
    const chats = {};
    for (const g of GEM_TABS) chats[g] = [];
    chatsSnap.forEach((d) => { chats[d.id] = d.data().messages || []; });
    const characters = charactersSnap.docs.map((d) => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const references = referencesSnap.docs.map((d) => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const scenes = sortScenes(scenesSnap.docs.map((d) => d.data()));
    return { ...meta, chats, images: [], characters, references, scenes };
  }

  // Just the images subcollection (for the lazy Library / Generate load).
  async function getImages(pid) {
    await init();
    const snap = await _col.doc(pid).collection('images').get();
    return snap.docs.map((d) => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  // Just the assets — lets the "import from another project" picker read every project's
  // assets without dragging each one's images and chat history along with it.
  async function getCharacters(pid) {
    await init();
    const snap = await _col.doc(pid).collection('characters').get();
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
    return serialize(pid, async () => {
      await ref.collection('images').doc(String(rec.id)).set(rec);
      await ref.set({ imageCount: FieldValue.increment(1), updatedAt: rec.createdAt || Date.now() }, { merge: true });
    });
  }

  // References = every image attached in a chat, kept so it never has to be re-uploaded.
  // One targeted doc write (never a full-project read-modify-write), deduped on sha256.
  async function addReference(pid, rec) {
    await init();
    return serialize(pid, () => _col.doc(pid).collection('references').doc(String(rec.id)).set(rec));
  }
  async function findReferenceBySha(pid, sha) {
    await init();
    const snap = await _col.doc(pid).collection('references').where('sha256', '==', sha).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  }
  async function deleteReference(pid, refId) {
    await init();
    return serialize(pid, () => _col.doc(pid).collection('references').doc(String(refId)).delete());
  }

  // Append chat message(s) to ONE gem's chat doc via a transaction — reads only that chat doc
  // (not the whole project's images), so a chat message costs ~1 read instead of hundreds. The
  // transaction keeps two concurrent messages on the same tab from clobbering each other.
  async function appendChat(pid, gemId, newMsgs) {
    await init();
    const { FieldValue } = await import('firebase-admin/firestore');
    const ref = _col.doc(pid);
    const chatRef = ref.collection('chats').doc(gemId);
    return serialize(pid, () => _db.runTransaction(async (tx) => {
      const snap = await tx.get(chatRef);
      const msgs = snap.exists ? (snap.data().messages || []) : [];
      msgs.push(...newMsgs);
      tx.set(chatRef, { messages: msgs });
      tx.set(ref, { updatedAt: Date.now(), chatCount: FieldValue.increment(newMsgs.length) }, { merge: true });
    }));
  }

  // Persist the blob: meta + per-tab chat docs in one batch, then image docs DIFFED
  // (only new/changed written, removed deleted), chunked under the 500-op batch limit.
  async function saveProject(p) {
    await init();
    const ref = _col.doc(p.id);
    // `references` is deliberately NOT defaulted to []: diffSub deletes whatever isn't in the
    // list it's handed, so defaulting would let any project object that simply doesn't carry
    // references wipe the whole collection. Absent field => leave the subcollection alone.
    // `scenes` is never written from here — the scene routes write their own docs — but it must
    // stay out of `meta`, or every full save would copy the list into the project doc.
    const { chats = {}, images = [], characters = [], references, scenes, tunes, ...meta } = p;
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
    const ops = [...(await diffSub('images', images)), ...(await diffSub('characters', characters)),
      ...(Array.isArray(references) ? await diffSub('references', references) : [])];
    for (let i = 0; i < ops.length; i += 450) {
      const batch = _db.batch();
      for (const [kind, docRef, data] of ops.slice(i, i + 450)) kind === 'set' ? batch.set(docRef, data) : batch.delete(docRef);
      await batch.commit();
    }
    return p;
  }

  // Serialized per-pid read-modify-write — single-instance lock, like the local backend.
  async function update(pid, mutator) {
    return serialize(pid, async () => {
      const p = await getProject(pid);
      const out = await mutator(p);
      const toSave = out || p;
      await saveProject(toSave);
      return toSave;
    });
  }

  // Fast: reads only the light meta docs (counts are cached on them).
  async function listProjects() {
    await init();
    const snap = await _col.get();
    const projects = [];
    snap.forEach((doc) => {
      const p = doc.data();
      projects.push({ id: p.id, name: p.name, client: p.client || '', createdAt: p.createdAt, updatedAt: p.updatedAt, imageCount: p.imageCount || 0, chatCount: p.chatCount || 0 });
    });
    projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return projects;
  }

  // ── Scenes: one doc each, written on their own (never through saveProject) ──
  async function getScenes(pid) {
    await init();
    const snap = await _col.doc(pid).collection('scenes').get();
    return sortScenes(snap.docs.map((d) => d.data()));
  }
  async function addScene(pid, scene) {
    await init();
    const ref = _col.doc(pid);
    return serialize(pid, async () => {
      // a scene for a project that's gone would bring its meta doc back as a nameless ghost
      if (!(await ref.get()).exists) throw new Error(`Project not found: ${pid}`);
      await ref.collection('scenes').doc(scene.id).set(scene);
      await ref.set({ updatedAt: scene.createdAt || Date.now() }, { merge: true });
      return scene;
    });
  }
  async function patchScene(pid, sceneId, patch) {
    await init();
    const doc = _col.doc(pid).collection('scenes').doc(sceneId);
    return serialize(pid, async () => {
      const snap = await doc.get();
      if (!snap.exists) return null;
      const next = { ...snap.data(), ...patch, updatedAt: Date.now() };
      await doc.set(next);
      return next;
    });
  }
  // The scene doc and its chat docs are deleted; its images stay and return to General (their
  // sceneId field is removed). One queued job, so no chat reply or save lands half-way through.
  async function deleteScene(pid, sceneId) {
    await init();
    const { FieldValue } = await import('firebase-admin/firestore');
    const ref = _col.doc(pid);
    return serialize(pid, async () => {
      const [chatsSnap, imagesSnap] = await Promise.all([
        ref.collection('chats').get(),
        ref.collection('images').where('sceneId', '==', sceneId).get(),
      ]);
      const chatDocs = chatsSnap.docs.filter((d) => d.id.startsWith(`${sceneId}~`));
      const removedMsgs = chatDocs.reduce((n, d) => n + (d.data().messages || []).length, 0);
      const ops = [
        ...chatDocs.map((d) => (b) => b.delete(d.ref)),
        ...imagesSnap.docs.map((d) => (b) => b.update(d.ref, { sceneId: FieldValue.delete() })),
        (b) => b.delete(ref.collection('scenes').doc(sceneId)),
        (b) => b.set(ref, { updatedAt: Date.now(), chatCount: FieldValue.increment(-removedMsgs) }, { merge: true }),
      ];
      for (let i = 0; i < ops.length; i += 450) {
        const batch = _db.batch();
        ops.slice(i, i + 450).forEach((op) => op(batch));
        await batch.commit();
      }
      return { movedImages: imagesSnap.size, deletedChats: chatDocs.length };
    });
  }

  // The meta doc alone — one read, for a route that needs a setting but none of the content.
  async function getMeta(pid) {
    await init();
    const snap = await _col.doc(pid).get();
    if (!snap.exists) throw new Error(`Project not found: ${pid}`);
    const { imageCount, chatCount, ...meta } = snap.data();
    return meta;
  }
  // Tune versions: projects/{pid}/tunes/{gemId}@{v}, written once each, read on demand.
  async function addTune(pid, snap) {
    await init();
    return serialize(pid, async () => { await _col.doc(pid).collection('tunes').doc(snap.id).set(snap); return snap; });
  }
  async function getTune(pid, tuneId) {
    await init();
    const snap = await _col.doc(pid).collection('tunes').doc(tuneId).get();
    return snap.exists ? snap.data() : null;
  }
  // Change one message of one chat in place — reads and writes that chat doc only, in the
  // project's write queue (so a reply landing at the same moment can't be lost).
  async function updateChatMessage(pid, key, find, mutate) {
    await init();
    const chatRef = _col.doc(pid).collection('chats').doc(key);
    return serialize(pid, () => _db.runTransaction(async (tx) => {
      const snap = await tx.get(chatRef);
      if (!snap.exists) return undefined;
      const msgs = snap.data().messages || [];
      const i = find(msgs);
      if (i < 0) return undefined;
      const out = mutate(msgs[i]);
      tx.set(chatRef, { messages: msgs });
      return out;
    }));
  }

  // Delete the meta doc + every chats/images subdoc (chunked).
  async function deleteProject(pid) {
    await init();
    const ref = _col.doc(pid);
    for (const sub of ['chats', 'images', 'characters', 'references', 'scenes', 'tunes']) {
      const docs = (await ref.collection(sub).get()).docs;
      for (let i = 0; i < docs.length; i += 450) {
        const batch = _db.batch();
        docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    }
    await ref.delete();
  }

  return { backend: 'firestore', getProject, getProjectLight, getImages, getCharacters, addImage, appendChat, saveProject, update, listProjects, deleteProject,
    addReference, findReferenceBySha, deleteReference, getScenes, addScene, patchScene, deleteScene, getMeta, addTune, getTune, updateChatMessage };
}

export function createDataStore(dataDir, { backend = process.env.DATA_BACKEND || 'local' } = {}) {
  if (backend === 'local') return createLocalDataStore(dataDir);
  if (backend === 'firestore') return createFirestoreDataStore();
  throw new Error(`Unknown DATA_BACKEND "${backend}" (expected "local" or "firestore")`);
}
