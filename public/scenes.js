// ── Scenes ───────────────────────────────────────────────────────────────────────
// A project splits into scenes: General — fixed and first, home to everything made before
// scenes existed — and the user's own, in their order. The strip under the tabs picks the active
// one: in a gem tab it picks the chat, in Nano Banana and Swap it tags what gets made, in the
// Library it filters. Tools and settings — gems and their Tune, Assets, kept References — stay
// with the whole project. See SCENES.md.
// The pure helpers up top are what the tests import; createScenes() wires the strip and its
// modal, borrowing app.js's helpers.

export const GENERAL = 'general';
export const sortScenes = (scenes) => [...(scenes || [])]
  .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || (a.createdAt || 0) - (b.createdAt || 0));
// A scene's chat with a gem. General keeps the plain gem id, so every older chat is its chat.
export const chatKey = (gemId, sceneId) => (!sceneId || sceneId === GENERAL ? gemId : `${sceneId}~${gemId}`);
// An image's scene: its sceneId while that scene exists, else General — older images carry none,
// and one finished while its scene was being deleted keeps a dangling id.
export const imageScene = (im, scenes) => (im?.sceneId && (scenes || []).some(s => s.id === im.sceneId) ? im.sceneId : GENERAL);
// "General", or "2 · Night chase" — the number is the scene's place in the strip.
export function sceneLabel(sceneId, scenes) {
  if (!sceneId || sceneId === GENERAL) return 'General';
  const list = sortScenes(scenes);
  const i = list.findIndex(s => s.id === sceneId);
  return i < 0 ? 'General' : `${i + 1} · ${list[i].title}`;
}
// The order for a scene dropped at index `to` among the other scenes: halfway between its new
// neighbours, so a reorder writes only the scene that moved. Once a gap has been halved too
// thin, every scene is renumbered instead.
export function orderFor(scenes, movingId, to) {
  const others = sortScenes(scenes).filter(s => s.id !== movingId);
  const at = Math.max(0, Math.min(Number(to) || 0, others.length));
  const ord = (s) => Number(s.order) || 0;
  const prev = others[at - 1], next = others[at];
  if (!prev && !next) return { order: 1 };
  if (!prev) return { order: ord(next) - 1 };
  if (!next) return { order: ord(prev) + 1 };
  if (ord(next) - ord(prev) > 1e-6) return { order: (ord(prev) + ord(next)) / 2 };
  const list = [...others];
  list.splice(at, 0, (scenes || []).find(s => s.id === movingId));
  return { renumber: list.filter(Boolean).map((s, i) => ({ id: s.id, order: i + 1 })) };
}

const DRAG_SCENE = 'text/avs-scene';

export function createScenes({ state, api, toast, escapeHtml: esc, onSwitch, onImageDrop, onDeleted, onChanged }) {
  const strip = () => document.getElementById('sceneStrip');
  const list = () => sortScenes(state.current?.scenes);
  const byId = (id) => (state.current?.scenes || []).find(s => s.id === id) || null;
  // The scene in use: the one picked, while it still exists — else General.
  const activeId = () => (state.sceneId && state.sceneId !== GENERAL && byId(state.sceneId) ? state.sceneId : GENERAL);
  const label = (id) => sceneLabel(id, state.current?.scenes);
  function upsert(scene) {
    const all = state.current.scenes = [...(state.current.scenes || [])];
    const i = all.findIndex(s => s.id === scene.id);
    if (i >= 0) all[i] = scene; else all.push(scene);
    state.current.scenes = sortScenes(all);
  }

  // ── the strip ──────────────────────────────────────────────────────────────────
  // Hidden in Assets (they're the whole project's) and outside a project.
  function render() {
    const el = strip();
    if (!el) return;
    const hidden = !state.current || state.activeTab === 'characters';
    el.classList.toggle('hidden', hidden);
    if (hidden) return;
    const active = activeId();
    const chip = (id, inner, title, movable) => `<button class="ss-chip${id === active ? ' active' : ''}" data-scene="${id}" type="button" role="tab" aria-selected="${id === active}"${movable ? ' draggable="true"' : ''} title="${esc(title)}">${inner}</button>`;
    el.innerHTML = `
      <span class="ss-label">Scene</span>
      <div class="ss-chips" role="tablist" aria-label="Scenes">
        ${chip(GENERAL, 'General', 'General — the project\'s work that isn\'t in a scene', false)}
        ${list().map((s, i) => chip(s.id,
          `<span class="ss-n">${i + 1}</span><span class="ss-t" dir="auto">${esc(s.title)}</span><span class="ss-edit" data-edit="${s.id}" title="Edit, or delete, this scene">✎</span>`,
          `${s.title}${s.brief ? ` — ${s.brief.slice(0, 160)}${s.brief.length > 160 ? '…' : ''}` : ''}\nClick to open · drag to reorder · drop an image here to move it`, true)).join('')}
      </div>
      <button class="ss-add" type="button" data-add title="New scene">＋ Scene</button>`;
    el.querySelector('.ss-chip.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ── reorder (drag a chip) · move an image (drop it on a chip) ─────────────────
  const types = (e) => [...(e.dataTransfer?.types || [])];
  function clearMarks() { strip()?.querySelectorAll('.ss-before, .ss-after, .ss-drop, .ss-dragging').forEach(c => c.classList.remove('ss-before', 'ss-after', 'ss-drop', 'ss-dragging')); }
  // Where a dragged scene would land: before or after the chip under the pointer.
  function dropSpot(e) {
    const c = e.target.closest?.('.ss-chip');
    if (!c) return null;
    if (c.dataset.scene === GENERAL) return { chip: c, side: 'after' };   // General stays first
    const r = c.getBoundingClientRect();
    return { chip: c, side: e.clientX < r.left + r.width / 2 ? 'before' : 'after' };
  }
  async function reorder(movingId, spot) {
    const others = list().filter(s => s.id !== movingId);
    let to = 0;
    if (spot.chip.dataset.scene !== GENERAL) {
      const i = others.findIndex(s => s.id === spot.chip.dataset.scene);
      if (i < 0) return;
      to = spot.side === 'before' ? i : i + 1;
    }
    if (list().findIndex(s => s.id === movingId) === to) return;   // dropped where it already is
    const plan = orderFor(state.current.scenes, movingId, to);
    try {
      const updates = plan.renumber || [{ id: movingId, order: plan.order }];
      for (const u of updates) {
        const { scene } = await api(`/api/projects/${state.current.id}/scenes/${u.id}`, { method: 'PATCH', body: JSON.stringify({ order: u.order }) });
        upsert(scene);
      }
    } catch (err) { toast(err.message, true); }
    render();
    onChanged();
  }

  function wire() {
    const el = strip();
    if (!el || el.dataset.wired) return;
    el.dataset.wired = '1';
    el.addEventListener('click', (e) => {
      const edit = e.target.closest('[data-edit]');
      if (edit) { e.stopPropagation(); openEditor(byId(edit.dataset.edit)); return; }
      if (e.target.closest('[data-add]')) { openEditor(null); return; }
      const c = e.target.closest('.ss-chip');
      if (c) onSwitch(c.dataset.scene);
    });
    el.addEventListener('dragstart', (e) => {
      const c = e.target.closest?.('.ss-chip[draggable="true"]');
      if (!c) return;
      e.dataTransfer.setData(DRAG_SCENE, c.dataset.scene);
      e.dataTransfer.effectAllowed = 'move';
      c.classList.add('ss-dragging');
    });
    el.addEventListener('dragover', (e) => {
      const t = types(e);
      if (t.includes(DRAG_SCENE)) {
        const spot = dropSpot(e);
        el.querySelectorAll('.ss-before, .ss-after').forEach(x => x.classList.remove('ss-before', 'ss-after'));
        if (!spot) return;
        e.preventDefault();
        spot.chip.classList.add(spot.side === 'before' ? 'ss-before' : 'ss-after');
      } else if (t.includes('text/avs-image')) {
        const c = e.target.closest?.('.ss-chip');
        el.querySelectorAll('.ss-drop').forEach(x => { if (x !== c) x.classList.remove('ss-drop'); });
        if (!c) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        c.classList.add('ss-drop');
      }
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) clearMarks(); });
    el.addEventListener('dragend', clearMarks);
    el.addEventListener('drop', (e) => {
      const t = types(e);
      const spot = dropSpot(e);
      clearMarks();
      if (!spot) return;
      e.preventDefault();
      if (t.includes(DRAG_SCENE)) reorder(e.dataTransfer.getData(DRAG_SCENE), spot);
      else if (t.includes('text/avs-image')) onImageDrop(e.dataTransfer.getData('text/avs-image'), spot.chip.dataset.scene);
    });
  }

  // ── new / edit / delete ────────────────────────────────────────────────────────
  function openEditor(scene) {
    if (!state.current) return;
    let modal = document.getElementById('sceneModal');
    if (!modal) { modal = document.createElement('div'); modal.id = 'sceneModal'; modal.className = 'modal-overlay'; document.body.appendChild(modal); }
    const editing = !!scene;
    modal.innerHTML = `
      <form class="modal-card scene-card" id="scForm">
        <div class="modal-head"><h3>${editing ? `Scene ${esc(label(scene.id))}` : 'New scene'}</h3><button class="modal-x" type="button" data-close>✕</button></div>
        <p class="modal-sub">${editing ? 'The brief is background for every gem in this scene\'s chats.' : 'A scene keeps its own chats and images. Gems, their Tune and the Assets stay shared by the whole project.'}</p>
        <label class="np-field"><span class="field-label">Name</span>
          <input id="scTitle" dir="auto" maxlength="60" autocomplete="off" placeholder="e.g. Opening, Night chase" value="${esc(scene?.title || '')}" /></label>
        <label class="np-field"><span class="field-label">Brief — optional</span>
          <textarea id="scBrief" dir="auto" rows="5" maxlength="4000" placeholder="What happens in it, who's in it, the mood — every gem reads it as background in this scene.">${esc(scene?.brief || '')}</textarea></label>
        <div class="modal-actions">
          ${editing ? '<button class="modal-btn danger" type="button" id="scDelete">Delete scene</button>' : ''}
          <button class="modal-btn ghost" type="button" data-close>Cancel</button>
          <button class="modal-btn accent" type="submit" id="scGo">${editing ? 'Save' : 'Create scene'}</button>
        </div>
      </form>`;
    modal.classList.remove('hidden');
    const close = () => modal.classList.add('hidden');
    modal.querySelectorAll('[data-close]').forEach(b => { b.onclick = close; });
    modal.onclick = (e) => { if (e.target === modal) close(); };
    modal.onkeydown = (e) => { if (e.key === 'Escape') close(); };
    const title = modal.querySelector('#scTitle'), brief = modal.querySelector('#scBrief'), go = modal.querySelector('#scGo');
    modal.querySelector('#scForm').onsubmit = async (e) => {
      e.preventDefault();
      if (!title.value.trim()) { title.focus(); toast('Give the scene a name.', true); return; }
      go.disabled = true;
      try {
        const body = JSON.stringify({ title: title.value, brief: brief.value });
        const { scene: saved } = editing
          ? await api(`/api/projects/${state.current.id}/scenes/${scene.id}`, { method: 'PATCH', body })
          : await api(`/api/projects/${state.current.id}/scenes`, { method: 'POST', body });
        upsert(saved);
        close();
        if (editing) { render(); onChanged(); toast(`Saved ${label(saved.id)}.`); }
        else { onSwitch(saved.id); toast(`Scene ${label(saved.id)} created — its chats and images start empty.`); }
      } catch (err) { toast(err.message, true); go.disabled = false; }
    };
    const del = modal.querySelector('#scDelete');
    if (del) del.onclick = async () => {
      const n = (state.current.images || []).filter(im => im.sceneId === scene.id).length;
      if (!confirm(`Delete scene "${scene.title}"?\n\nIts chats are deleted. Its ${n} image${n === 1 ? '' : 's'} move to General — no image is deleted.`)) return;
      del.disabled = true;
      deleting = scene.id;
      try {
        const res = await api(`/api/projects/${state.current.id}/scenes/${scene.id}`, { method: 'DELETE' });
        state.current.scenes = (state.current.scenes || []).filter(s => s.id !== scene.id);
        close();
        onDeleted(scene.id);
        toast(`Scene deleted${res.movedImages ? ` — ${res.movedImages} image${res.movedImages === 1 ? '' : 's'} moved to General` : ''}.`);
      } catch (err) { toast(err.message, true); del.disabled = false; }
      deleting = null;
    };
    (editing ? brief : title).focus();
  }

  // The scenes changed in the database (live sync — this browser or the other one): take the new
  // list, and leave a scene that's gone.
  let deleting = null;   // the scene this browser is deleting, so its own delete isn't announced twice
  function sync(scenes) {
    if (!state.current) return;
    const was = state.sceneId;
    state.current.scenes = sortScenes(scenes);
    if (was && was !== GENERAL && !byId(was)) {
      onDeleted(was);
      if (was !== deleting) toast('The scene you were in was deleted — back to General.');
      return;
    }
    render();
    onChanged();
  }

  return { render, wire, openEditor, sync, activeId, label, list };
}
