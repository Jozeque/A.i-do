// ── NB Frames reference board ─────────────────────────────────────────────────────
// The empty column beside the NB Frames chat holds the brief's references, sorted by role: the
// composition, the location, a block per character, a block per prop — all optional. Images come
// in by drag (from the computer, the chat, or anywhere in the app), upload, paste, or straight
// from the project (Assets, Library, kept references).
// On send, the board's images go first, in role order, each labelled with its number and role
// ("Image 3 — CHARACTER 1 "Maya" — …"); images attached in the composer follow. The labels stay
// with the turn, so "Send to Nano Banana 2" hands every image over with the same number and role.
// The board stays put between messages, like the Seedance brief. Pure helpers up top (tested);
// createRefBoard() wires the column, borrowing app.js's helpers.

export const RB_SECTIONS = [
  { kind: 'composition', icon: '🧭', title: 'Composition', one: 'Composition', multi: false,
    hint: 'framing, angle & layout to follow',
    role: 'COMPOSITION reference', purpose: 'follow its framing, camera angle and layout only, not its people, place, objects or look' },
  { kind: 'location', icon: '🏙', title: 'Location', one: 'Location', multi: false,
    hint: 'the place and its light',
    role: 'LOCATION reference', purpose: 'the place and its light, not its people' },
  { kind: 'character', icon: '👤', title: 'Characters', one: 'Character', multi: true, add: 'Add character',
    hint: 'a block per person', namePh: 'Name — e.g. Maya',
    role: 'CHARACTER', purpose: "this person's identity and wardrobe" },
  { kind: 'prop', icon: '🎬', title: 'Objects & props', one: 'Prop', multi: true, add: 'Add prop',
    hint: 'objects that must read exactly', namePh: 'Name — e.g. Trophy',
    role: 'PROP', purpose: 'its exact design, materials and colour' },
];
export const rbSection = (kind) => RB_SECTIONS.find(s => s.kind === kind) || null;

// Which section an Assets-tab asset belongs in (looks and finished frames have none).
export const ASSET_ROLE = { character: 'character', mascot: 'character', location: 'location', prop: 'prop', product: 'prop', vehicle: 'prop' };

let _seq = 0;
export const rbId = () => `rb${Date.now().toString(36)}${(_seq++).toString(36)}`;
export const newRbBlock = (kind) => ({ id: rbId(), kind, name: '', note: '', images: [] });
export const newBoard = () => ({ blocks: RB_SECTIONS.map(s => newRbBlock(s.kind)), sent: null });

// A block's name in labels: a character or prop by its name (else its place in the section).
export function rbBlockLabel(block, idx) {
  const sec = rbSection(block.kind);
  if (!sec) return '';
  return sec.multi ? (String(block.name || '').trim() || `${sec.one} ${idx}`) : sec.title;
}

// The role an image carries to the gem and on to Nano Banana.
export function refLabel(block, idx, k = 1, of = 1) {
  const sec = rbSection(block.kind);
  const name = String(block.name || '').trim();
  const head = sec.multi ? `${sec.role} ${idx}${name ? ` "${name}"` : ''}` : sec.role;
  return `${head}${of > 1 ? ` (view ${k} of ${of})` : ''} — ${sec.purpose}`;
}

// Every image on the board in send order — sections in order, blocks in order, images in order.
export function orderedBoard(board) {
  const out = [];
  for (const sec of RB_SECTIONS) {
    const blocks = (board?.blocks || []).filter(b => b.kind === sec.kind);
    blocks.forEach((block, bi) => block.images.forEach((img, ii) => out.push({
      n: out.length + 1, img, block, sec, idx: bi + 1, k: ii + 1, of: block.images.length,
      label: refLabel(block, bi + 1, ii + 1, block.images.length),
    })));
  }
  return out;
}

// Changes when an image is added, removed or moved — not when a name or note is edited — so
// the conversation about a board goes on until the references themselves change.
export const boardSignature = (items) => items.map(it => `${it.img.id}@${it.block.id}`).join('|');

// The list that opens the gem's message: every image's number and role, the images attached in
// the composer after them, and any character or prop that has a name but no image.
export function boardManifest(board, extraCount = 0) {
  const items = orderedBoard(board);
  const lines = items.map(it => {
    const note = String(it.block.note || '').trim();
    return `Image ${it.n} = ${it.label}.${note && it.k === 1 ? ` Note: ${note}` : ''}`;
  });
  for (let j = 0; j < extraCount; j++) lines.push(`Image ${items.length + j + 1} = additional reference attached in the chat — its role is in my message.`);
  const loose = [];
  for (const sec of RB_SECTIONS.filter(s => s.multi)) {
    (board?.blocks || []).filter(b => b.kind === sec.kind).forEach((b, i) => {
      const name = String(b.name || '').trim(), note = String(b.note || '').trim();
      if (!b.images.length && (name || note)) loose.push(`${sec.one} ${i + 1}${name ? ` "${name}"` : ''}${note ? ` — ${note}` : ''}`);
    });
  }
  if (!lines.length && !loose.length) return '';
  return [
    lines.length ? `REFERENCE IMAGES (sorted on the app's reference board — Nano Banana 2 gets the same images, in this order, with these roles):\n${lines.join('\n')}\n`
      + 'In every prompt, point to each of these images by its number and role (e.g. "the framing of image 1", "Maya from image 3"), and take from each image only what its role says.' : '',
    loose.length ? `ALSO IN THE FRAME (no image — write them in words):\n${loose.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

const DRAG = { move: 'text/avs-rb-move', image: 'text/avs-image' };

export function createRefBoard({ escapeHtml: esc, toast, state, mediaFetch, imgFileToB64, filesFromPaste, openLightbox, boardKey }) {
  let root = null;          // the board column while NB Frames is open — re-created on every visit
  let mountedKey = null;
  let activeBid = null;     // the block a paste lands in (the last one touched)
  let pasteWired = false;
  const picker = { open: false, target: null, tab: 'assets' };

  const board = () => {
    state.nbBoards = state.nbBoards || {};
    const k = boardKey();
    return state.nbBoards[k] || (state.nbBoards[k] = newBoard());
  };
  const absUrl = (u) => { try { return new URL(u, location.href).href; } catch { return String(u || ''); } };
  const findBlock = (bid) => board().blocks.find(b => b.id === bid) || null;
  const kindIndex = (block) => board().blocks.filter(b => b.kind === block.kind).indexOf(block) + 1;
  const labelOf = (block) => rbBlockLabel(block, kindIndex(block));
  function locate(iid) {
    for (const blk of board().blocks) {
      const i = blk.images.findIndex(x => x.id === iid);
      if (i >= 0) return { blk, i };
    }
    return null;
  }
  function insertBlock(kind) {
    const b = board(), blk = newRbBlock(kind);
    let at = -1;
    b.blocks.forEach((x, i) => { if (x.kind === kind) at = i; });
    b.blocks.splice(at + 1, 0, blk);   // a section's blocks stay together, newest last
    return blk;
  }

  // Folded to a slim rail, the board leaves the chat its full width (remembered). A narrow window
  // starts folded, since the open board sits over the chat there.
  const isCollapsed = () => {
    try { const v = localStorage.getItem('avs:refBoard'); if (v) return v === 'collapsed'; } catch {}
    return matchMedia('(max-width: 1100px)').matches;
  };
  function setCollapsed(c) {
    try { localStorage.setItem('avs:refBoard', c ? 'collapsed' : 'open'); } catch {}
    picker.open = false;
    render();
  }

  // ── render ────────────────────────────────────────────────────────────────────
  function render() {
    if (!root || !root.isConnected) return;
    const b = board();
    const items = orderedBoard(b);
    const nums = new Map(items.map(it => [it.img.id, it.n]));
    const collapsed = isCollapsed();
    root.classList.toggle('rb-collapsed', collapsed);
    if (collapsed) {
      root.innerHTML = `<button class="rb-rail" data-act="expand" type="button" title="Show the references — composition, location, characters, props">
        <span class="rb-rail-ico">🧩</span><span class="rb-rail-label">References</span>${items.length ? `<span class="rb-rail-n">${items.length}</span>` : ''}</button>`;
      return;
    }
    const filled = items.length || b.blocks.some(x => x.name.trim() || x.note.trim());
    root.innerHTML = `
      <div class="rb-head">
        <div class="rb-title"><b>References</b><span class="rb-count">${items.length ? `${items.length} image${items.length === 1 ? '' : 's'} · numbered` : 'optional'}</span></div>
        ${filled ? '<button class="rb-btn" data-act="clear" type="button" title="Empty the board">Clear</button>' : ''}
        <button class="rb-btn rb-fold" data-act="collapse" type="button" title="Fold the board away">»</button>
      </div>
      <p class="rb-hint">Each image goes to the gem — and on to Nano Banana — numbered, with its role. Drop, paste, ⬆ upload or 📁 pick from the project.</p>
      <div class="rb-secs">${RB_SECTIONS.map(sec => secHtml(sec, b, nums)).join('')}</div>
      ${picker.open ? pickerHtml() : ''}`;
  }

  function secHtml(sec, b, nums) {
    const blocks = b.blocks.filter(x => x.kind === sec.kind);
    return `<section class="rb-sec" data-kind="${sec.kind}">
      <div class="rb-sec-head"><h4>${sec.icon} ${sec.title}</h4><span>${sec.hint}</span></div>
      ${blocks.map((blk, i) => blockHtml(blk, sec, i + 1, blocks.length, nums)).join('')}
      ${sec.multi ? `<button class="rb-more" data-act="add-block" data-kind="${sec.kind}" type="button">＋ ${sec.add}</button>` : ''}
    </section>`;
  }

  function blockHtml(blk, sec, idx, count, nums) {
    const cls = ['rb-block', blk.id === activeBid ? 'rb-active' : '', picker.open && picker.target === blk.id ? 'rb-target' : ''].filter(Boolean).join(' ');
    const showNote = blk.images.length || blk.note || (sec.multi && blk.name.trim());
    return `<div class="${cls}" data-bid="${blk.id}" tabindex="-1">
      ${sec.multi ? `<div class="rb-block-head">
        <input class="rb-name" dir="auto" data-field="name" data-bid="${blk.id}" placeholder="${esc(sec.namePh)}" value="${esc(blk.name)}" aria-label="${sec.one} ${idx} name" />
        ${count > 1 ? `<button class="rb-x" data-act="rm-block" data-bid="${blk.id}" type="button" title="Remove this ${sec.one.toLowerCase()}">✕</button>` : ''}
      </div>` : ''}
      <div class="rb-drop" data-drop="${blk.id}">
        ${blk.images.map(img => thumbHtml(img, nums.get(img.id))).join('')}
        <button class="rb-add" data-act="upload" data-bid="${blk.id}" type="button" title="Upload from your computer">⬆</button>
        <button class="rb-add" data-act="pick" data-bid="${blk.id}" type="button" title="Pick from the project — Assets, Library, References">📁</button>
        ${blk.images.length ? '' : '<span class="rb-drop-hint">drop · paste</span>'}
        <input type="file" accept="image/*" multiple hidden data-file="${blk.id}" />
      </div>
      ${showNote ? `<input class="rb-note" dir="auto" data-field="note" data-bid="${blk.id}" placeholder="Note — optional, e.g. low angle, at night" value="${esc(blk.note)}" aria-label="${esc(rbBlockLabel(blk, idx))} note" />` : ''}
    </div>`;
  }

  function thumbHtml(img, n) {
    return `<div class="rb-thumb" draggable="true" data-iid="${img.id}" title="Image ${n} · ${esc(img.name || 'image')} — drag to move, click to enlarge">
      <img src="${esc(img.url)}" alt="" draggable="false" /><span class="rb-n">${n}</span>
      <button class="rb-x" data-act="rm-img" data-iid="${img.id}" type="button" title="Remove">✕</button>
    </div>`;
  }

  function pickerItems(tab, kind) {
    const pid = state.current?.id;
    if (tab === 'assets') {
      const list = (state.current?.characters || []).filter(c => c.reference?.file);
      const fits = (c) => ASSET_ROLE[c.type || 'character'] === kind;
      return [...list.filter(fits), ...list.filter(c => !fits(c))].map(c => ({
        url: `/media/${pid}/images/${c.reference.file}`, name: c.name, title: c.name, asset: { name: c.name, type: c.type || 'character' } }));
    }
    if (tab === 'library') return (state.current?.images || []).map(im => ({ url: `/media/${pid}/images/${im.file}`, name: im.title || im.file, title: im.title || im.prompt || '' }));
    return (state.current?.references || []).map(r => ({ url: r.url, name: r.file, title: 'Kept reference' }));
  }

  function pickerHtml() {
    const tgt = findBlock(picker.target);
    const items = pickerItems(picker.tab, tgt?.kind);
    const tabs = [['assets', 'Assets'], ['library', 'Library'], ['refs', 'Refs']];
    const empty = { assets: 'No assets yet — build or save them in 📁 Assets.', library: 'No images in this project yet.', refs: 'No kept references yet.' }[picker.tab];
    return `<div class="rb-picker" role="dialog" aria-label="Pick from the project">
      <div class="rb-picker-head"><b>Add to ${esc(tgt ? labelOf(tgt) : '—')}</b><button class="rb-x" data-act="pick-close" type="button" title="Close">✕</button></div>
      <div class="mode-toggle rb-picker-tabs">${tabs.map(([k, l]) => `<button class="seg${picker.tab === k ? ' active' : ''}" data-act="pick-tab" data-tab="${k}" type="button">${l} · ${pickerItems(k, tgt?.kind).length}</button>`).join('')}</div>
      ${items.length ? `<div class="rb-picker-grid">${items.map(it => `<button class="rb-pick" data-act="pick-item" data-src="${encodeURIComponent(JSON.stringify(it))}" title="${esc(it.title)}" type="button">
          <img src="${esc(it.url)}" alt="" loading="lazy" draggable="false" />${it.asset ? `<span dir="auto">${esc(it.name)}</span>` : ''}</button>`).join('')}</div>`
        : `<div class="fav-empty">${empty}</div>`}
    </div>`;
  }

  // ── adding and moving images ─────────────────────────────────────────────────
  // Re-encoded to a JPEG under 1568px, like every chat attachment.
  async function addFiles(bid, files) {
    const blk = findBlock(bid);
    if (!blk) return 0;
    const imgs = files.filter(f => (f.type || '').startsWith('image/'));
    if (!imgs.length) { toast('Only image files can be added.', true); return 0; }
    let n = 0;
    for (const f of imgs) {
      try { blk.images.push({ id: rbId(), name: f.name || 'pasted image', mimeType: 'image/jpeg', data: await imgFileToB64(f), url: URL.createObjectURL(f) }); n++; }
      catch (e) { toast(e.message || 'Could not read that image.', true); }
    }
    activeBid = bid;
    render();
    return n;
  }

  async function addUrl(bid, item) {
    const blk = findBlock(bid);
    if (!blk || !item?.url) return false;
    const url = absUrl(item.url);
    if (blk.images.some(x => absUrl(x.url) === url)) { toast(`Already in ${labelOf(blk)}.`); return false; }
    try {
      const blob = await (await mediaFetch(url)).blob();
      if (!(blob.type || '').startsWith('image/')) throw new Error('not an image');
      blk.images.push({ id: rbId(), name: item.name || url.split('/').pop(), mimeType: 'image/jpeg', data: await imgFileToB64(blob), url });
    } catch { toast('Could not add that image.', true); return false; }
    // an asset (or a restored turn) dropped on an unnamed character/prop names it
    if (rbSection(blk.kind).multi && !blk.name.trim() && item.asset?.name) blk.name = item.asset.name;
    activeBid = blk.id;
    render();
    return true;
  }

  function moveImage(iid, bid, beforeIid) {
    if (!iid || iid === beforeIid) return;
    const from = locate(iid), to = findBlock(bid);
    if (!from || !to) return;
    const [img] = from.blk.images.splice(from.i, 1);
    let at = beforeIid ? to.images.findIndex(x => x.id === beforeIid) : -1;
    if (at < 0) at = to.images.length;
    to.images.splice(at, 0, img);
    activeBid = bid;
    render();
  }

  function viewImage(iid) {
    const all = orderedBoard(board());
    const i = all.findIndex(it => it.img.id === iid);
    if (i < 0) return;
    openLightbox(all.map(it => ({ src: it.img.url, caption: `Image ${it.n} — ${it.label}` })), i);
  }

  // ── events (delegated from the column, so they survive every re-render) ──────
  async function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || !root.contains(btn)) {
      const th = e.target.closest('.rb-thumb');
      if (th) viewImage(th.dataset.iid);
      return;
    }
    const b = board();
    switch (btn.dataset.act) {
      case 'expand': return setCollapsed(false);
      case 'collapse': return setCollapsed(true);
      case 'clear':
        if (!confirm('Clear every reference on the board?')) return;
        state.nbBoards[boardKey()] = newBoard();
        picker.open = false; activeBid = null;
        return render();
      case 'add-block': {
        const blk = insertBlock(btn.dataset.kind);
        activeBid = blk.id;
        render();
        root.querySelector(`.rb-name[data-bid="${blk.id}"]`)?.focus();
        return;
      }
      case 'rm-block': {
        const blk = findBlock(btn.dataset.bid);
        if (!blk || (blk.images.length && !confirm(`Remove ${labelOf(blk)} and its ${blk.images.length} image${blk.images.length === 1 ? '' : 's'}?`))) return;
        b.blocks = b.blocks.filter(x => x !== blk);
        if (picker.target === blk.id) picker.open = false;
        return render();
      }
      case 'upload': activeBid = btn.dataset.bid; root.querySelector(`input[data-file="${btn.dataset.bid}"]`)?.click(); return;
      case 'pick': activeBid = btn.dataset.bid; picker.open = true; picker.target = btn.dataset.bid; return render();
      case 'pick-close': picker.open = false; return render();
      case 'pick-tab': picker.tab = btn.dataset.tab; return render();
      case 'pick-item': {
        if (!findBlock(picker.target)) { picker.open = false; return render(); }
        btn.disabled = true;
        const tgt = findBlock(picker.target);
        if (await addUrl(picker.target, JSON.parse(decodeURIComponent(btn.dataset.src)))) { picker.open = false; render(); toast(`Added to ${labelOf(tgt)}.`); }
        else btn.disabled = false;
        return;
      }
      case 'rm-img': { const loc = locate(btn.dataset.iid); if (loc) { loc.blk.images.splice(loc.i, 1); render(); } return; }
    }
  }

  function onInput(e) {
    const t = e.target, f = t.dataset.field;
    if ((f === 'name' || f === 'note') && t.dataset.bid) {
      const blk = findBlock(t.dataset.bid);
      if (blk) blk[f] = t.value;
    }
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.file) { const files = [...t.files]; t.value = ''; addFiles(t.dataset.file, files); }
  }
  function setActive(bid) {
    if (activeBid === bid) return;
    activeBid = bid;
    root.querySelectorAll('.rb-block').forEach(el => el.classList.toggle('rb-active', el.dataset.bid === bid));
  }
  // Clicking a block makes it the paste target — and focusable, so Ctrl/⌘V reaches it.
  function onPointer(e) {
    const blk = e.target.closest('.rb-block');
    if (!blk) return;
    setActive(blk.dataset.bid);
    if (!e.target.closest('input, button')) blk.focus({ preventScroll: true });
  }
  function onKey(e) { if (e.key === 'Escape' && picker.open) { picker.open = false; render(); } }

  const dragTypes = (e) => [...(e.dataTransfer?.types || [])];
  const isOurDrag = (e) => dragTypes(e).some(t => t === 'Files' || t === DRAG.move || t === DRAG.image);
  // A drop lands in the block under the pointer — or, on a section's head, its first block.
  const zoneOf = (t) => t?.closest?.('[data-drop]') || t?.closest?.('.rb-block')?.querySelector('[data-drop]') || t?.closest?.('.rb-sec')?.querySelector('[data-drop]') || null;
  function clearDragMarks() { root?.querySelectorAll('.drag, .rb-dragging').forEach(el => el.classList.remove('drag', 'rb-dragging')); }
  function onDragStart(e) {
    const th = e.target.closest?.('.rb-thumb');
    if (!th) return;
    e.dataTransfer.setData(DRAG.move, th.dataset.iid);
    e.dataTransfer.effectAllowed = 'move';
    th.classList.add('rb-dragging');
  }
  function onDragOver(e) {
    if (!isOurDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();   // the chat panel under the board would take it as a chat attachment
    root.closest('.chat-panel')?.classList.remove('drag-over');
    const zone = zoneOf(e.target);
    root.querySelectorAll('.rb-drop.drag').forEach(z => { if (z !== zone) z.classList.remove('drag'); });
    if (zone) zone.classList.add('drag');
    e.dataTransfer.dropEffect = dragTypes(e).includes(DRAG.move) ? 'move' : 'copy';
  }
  function onDragLeave(e) {
    const zone = e.target.closest?.('[data-drop]');
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drag');
  }
  async function onDrop(e) {
    if (!isOurDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clearDragMarks();
    if (isCollapsed()) setCollapsed(false);
    const zone = zoneOf(e.target);
    if (!zone) { toast('Drop it on Composition, Location, a character or a prop.', true); return; }
    const bid = zone.dataset.drop, types = dragTypes(e);
    if (types.includes(DRAG.move)) { moveImage(e.dataTransfer.getData(DRAG.move), bid, e.target.closest?.('.rb-thumb')?.dataset.iid || null); return; }
    const url = e.dataTransfer.getData(DRAG.image);   // one of the app's own images — keep its original
    if (url) { await addUrl(bid, { url }); return; }
    if (types.includes('Files')) await addFiles(bid, [...(e.dataTransfer.files || [])]);
  }

  // A pasted image lands in the block that has the focus (click a block, then Ctrl/⌘V). A paste
  // in the chat box still attaches to the message, as before.
  function wirePaste() {
    if (pasteWired) return;
    pasteWired = true;
    document.addEventListener('paste', async (e) => {
      if (state.activeTab !== 'nb-frames' || !root?.isConnected || !root.contains(document.activeElement)) return;
      const files = filesFromPaste(e);
      if (!files.length) return;
      e.preventDefault();
      const bid = document.activeElement.closest?.('.rb-block')?.dataset.bid || activeBid;
      if (!findBlock(bid)) { toast('Click a section first, then paste.', true); return; }
      const n = await addFiles(bid, files);
      if (n) toast(`Pasted into ${labelOf(findBlock(bid))}.`);
    });
  }

  // ── public ───────────────────────────────────────────────────────────────────
  function mount(el) {
    root = el;
    const k = boardKey();
    if (mountedKey !== k) { mountedKey = k; picker.open = false; activeBid = null; }
    wirePaste();
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('pointerdown', onPointer);
    el.addEventListener('keydown', onKey);
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    el.addEventListener('dragend', clearDragMarks);
    render();
  }

  // What a message sends: the board's images with their roles, the manifest that opens the text
  // (extraCount = images attached in the composer, numbered after the board's), and the board's
  // signature for keeping the conversation going.
  function payload(extraCount = 0) {
    const b = board();
    const items = orderedBoard(b);
    return {
      count: items.length,
      key: boardSignature(items),
      images: items.map(it => ({ mimeType: it.img.mimeType, data: it.img.data, label: it.label, role: it.sec.kind, refName: String(it.block.name || '').trim() })),
      manifest: boardManifest(b, extraCount),
    };
  }
  // Where the current set of references was first sent in this chat: while it doesn't change,
  // later messages carry the conversation from there.
  const session = () => board().sent;
  // slot: the board the message was sent from (the user may have changed scene since).
  function markSent(key, from, chat, slot = boardKey()) {
    const b = state.nbBoards?.[slot];
    if (b) b.sent = { key, from, chat };
  }

  // From the Assets tab: the sheet goes to its role's section (a character into its own block).
  // null when the asset has no role here (a look, a finished frame).
  async function addAsset(c) {
    const kind = ASSET_ROLE[c?.type || 'character'];
    if (!kind || !c.reference?.file) return null;
    const b = board(), sec = rbSection(kind);
    const url = absUrl(`/media/${state.current.id}/images/${c.reference.file}`);
    const holder = b.blocks.find(x => x.images.some(i => absUrl(i.url) === url));
    if (holder) return { status: 'exists', section: labelOf(holder) };
    const blk = sec.multi
      ? (b.blocks.find(x => x.kind === kind && !x.images.length && (!x.name.trim() || x.name.trim() === c.name)) || insertBlock(kind))
      : b.blocks.find(x => x.kind === kind);
    if (isCollapsed()) { try { localStorage.setItem('avs:refBoard', 'open'); } catch {} }   // show where it went
    const ok = await addUrl(blk.id, { url, name: c.name, asset: { name: c.name } });
    return { status: ok ? 'added' : 'failed', section: labelOf(blk) };
  }

  // "Reuse prompt" on a turn sent from the board: its images go back to their sections (only onto
  // an empty board — a board in use is never overwritten). Returns how many came back.
  async function restore(imgs, pid) {
    const withRole = (imgs || []).filter(im => rbSection(im.role));
    if (!withRole.length || orderedBoard(board()).length) return 0;
    let n = 0, prev = null;
    for (const im of withRole) {
      const sec = rbSection(im.role), b = board();
      const view = Number((String(im.label || '').match(/\(view (\d+) of \d+\)/) || [])[1] || 1);
      let blk;
      if (!sec.multi) blk = b.blocks.find(x => x.kind === im.role);
      else if (view > 1 && prev?.kind === im.role) blk = prev;   // another view of the same one
      else {
        const name = String(im.refName || '').trim();
        blk = (name && b.blocks.find(x => x.kind === im.role && x.name.trim() === name))
          || b.blocks.find(x => x.kind === im.role && !x.images.length && !x.name.trim())
          || insertBlock(im.role);
        if (name && !blk.name.trim()) blk.name = name;
      }
      prev = blk;
      if (await addUrl(blk.id, { url: `/media/${pid}/uploads/${im.file}`, name: im.refName || im.file })) n++;
    }
    return n;
  }

  const hasImages = () => orderedBoard(board()).length > 0;

  return { mount, payload, session, markSent, addAsset, restore, hasImages, render };
}
