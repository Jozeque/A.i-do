// ── Seedance brief builder ───────────────────────────────────────────────────────
// The Seedance tab builds its brief in two steps instead of one chat box.
// ① Assets: the reference images go into ordered sections — the look, the location(s), one
//   block per character, the props — because OpenArt numbers @image tags by upload order
//   and every file needs a stated role.
// ② Prompt: the brief itself, either as director/DOP (a numbered shot list with a length per
//   shot) or as a creative (a description the gem breaks into shots), with the film length on
//   a slider. The images stay visible on the side in their upload order.
// The pure helpers up top are what the tests import; createSeedance() wires them to the page,
// borrowing app.js's helpers the way crm.js does.

export const SD_SECTIONS = [
  { kind: 'look', icon: '🎨', title: 'Look & cinematography', one: 'Look', noun: 'look', multi: false,
    hint: 'The overall look — lenses, lighting, grade. Style only: nothing in it appears on screen.',
    namePh: '', notePh: 'What to take from it — e.g. anamorphic flares, soft top light, warm grade',
    role: 'LOOK & CINEMATOGRAPHY',
    purpose: 'take its lens character, lighting and overall look/grade ONLY — no subject, object or location from it' },
  { kind: 'location', icon: '🏙', title: 'Location', one: 'Location', noun: 'place', multi: true, add: 'Add location',
    hint: 'Where it happens — add a block for every extra location.',
    namePh: 'Location name — e.g. Showroom', notePh: 'Optional — e.g. at night, rain on the glass',
    role: 'LOCATION', purpose: 'the place and its geography only — not its people' },
  { kind: 'character', icon: '👤', title: 'Characters', one: 'Character', noun: 'person', multi: true, add: 'Add character',
    hint: 'One block per character — every image in a block is the same person.',
    namePh: 'Character name — e.g. Maya', notePh: 'Optional — role, wardrobe, e.g. the host, red coat',
    role: 'CHARACTER', purpose: 'identity and wardrobe' },
  { kind: 'prop', icon: '🎬', title: 'Props & special items', one: 'Prop', noun: 'object', multi: true, add: 'Add prop',
    hint: 'Objects that must read exactly — products, vehicles, hero props.',
    namePh: 'Prop name — e.g. Trophy', notePh: 'Optional — e.g. engraved, catches the light',
    role: 'PROP', purpose: 'its exact design, materials and color' },
];
const secOf = (kind) => SD_SECTIONS.find(s => s.kind === kind) || SD_SECTIONS[SD_SECTIONS.length - 1];

// Which section an Assets-tab asset lands in when it's sent here.
export const ASSET_KIND = { character: 'character', mascot: 'character', location: 'location', look: 'look', vehicle: 'prop', product: 'prop', prop: 'prop' };

// Per-version platform budget (docs/seedance.md): clip length and reference images.
export const SD_LIMITS = { '2.5': { maxLen: 30, maxImages: 30 }, '2.0': { maxLen: 15, maxImages: 9 } };
export const limitsFor = (version) => SD_LIMITS[version] || SD_LIMITS['2.5'];
export const SD_MIN_LEN = 4;                       // shortest clip Seedance renders
export const SHOT_MIN = 1, SHOT_STEP = 0.5;        // per-shot slider, in seconds

export const tagSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
export const fmtSec = (s) => String(Math.round(Number(s || 0) * 10) / 10);

let _seq = 0;
export const sdId = () => `sd${Date.now().toString(36)}${(_seq++).toString(36)}`;
export const newBlock = (kind) => ({ id: sdId(), kind, name: '', tag: '', note: '', images: [] });
export const newShot = (len = 3) => ({ id: sdId(), len, size: '', lens: '', move: '', action: '' });
export function newBrief() {
  return {
    step: 'assets', mode: 'creative',
    blocks: SD_SECTIONS.map(s => newBlock(s.kind)),   // one empty block per section to start
    inbox: [],                                        // dropped on the tab button, not sorted yet — never sent
    creative: '', scene: '', shots: [], length: 10, aspect: '',
  };
}

// A block's @name in the brief: its asset tag, else its name, else its place in the section.
export const blockTag = (block, idx) => block.tag || tagSlug(block.name) || (block.kind === 'look' ? 'look' : `${block.kind}${idx}`);
export function blockLabel(block, idx) {
  const sec = secOf(block.kind);
  return sec.multi ? (String(block.name || '').trim() || `${sec.one} ${idx}`) : sec.title;
}

// Every image in upload order — sections in order, blocks in order, images in order.
export function orderedImages(brief) {
  const out = [];
  for (const sec of SD_SECTIONS) {
    const blocks = brief.blocks.filter(b => b.kind === sec.kind);
    blocks.forEach((block, bi) => block.images.forEach((img, ii) => out.push({
      n: out.length + 1, img, block, sec, blockIndex: bi + 1, k: ii + 1, of: block.images.length,
    })));
  }
  return out;
}

export const sumShots = (shots) => Math.round(shots.reduce((a, s) => a + Number(s.len || 0), 0) * 100) / 100;
export function shotTimes(shots) {
  let t = 0;
  return shots.map(s => { const start = t; t = Math.round((t + Number(s.len || 0)) * 100) / 100; return { start, end: t }; });
}

// Stretch or tighten every shot to a new total, keeping their proportions. Works in whole
// steps so the result sums to the total exactly; the rounding residue goes to the longest shots.
export function rescaleShots(lens, total, { min = SHOT_MIN, step = SHOT_STEP } = {}) {
  const n = lens.length;
  if (!n) return [];
  const minU = Math.round(min / step);
  const target = Math.max(Math.round(total / step), minU * n);
  const base = lens.map(l => Math.max(0, Number(l) || 0));
  const sum = base.reduce((a, b) => a + b, 0);
  const share = sum > 0 ? base.map(l => l / sum) : base.map(() => 1 / n);
  const out = share.map(s => Math.max(minU, Math.round(s * target)));
  let diff = target - out.reduce((a, b) => a + b, 0);
  while (diff !== 0) {
    let i = -1;
    for (let j = 0; j < n; j++) if ((diff > 0 || out[j] > minU) && (i < 0 || out[j] > out[i])) i = j;
    if (i < 0) break;
    out[i] += diff > 0 ? 1 : -1;
    diff += diff > 0 ? -1 : 1;
  }
  return out.map(u => u * step);
}

// One shot's slider, held so the whole clip stays between the platform minimum and maximum.
export function clampShotLen(lens, i, value, { maxTotal, minTotal = SD_MIN_LEN, min = SHOT_MIN, step = SHOT_STEP } = {}) {
  const others = lens.reduce((a, l, j) => (j === i ? a : a + Number(l || 0)), 0);
  const lo = Math.max(min, minTotal - others);
  const hi = Math.max(lo, maxTotal - others);
  const v = Math.round(Number(value) / step) * step;
  return Math.min(hi, Math.max(lo, v));
}

function manifestLine({ n, block, sec, blockIndex, k, of }) {
  const name = String(block.name || '').trim();
  const note = String(block.note || '').trim();
  const head = `${sec.role}${sec.multi ? ` ${blockIndex}` : ''}${name ? ` "${name}"` : ''} (@${blockTag(block, blockIndex)})`;
  const part = of > 1 ? (sec.kind === 'look' ? `, look reference ${k} of ${of}` : `, view ${k} of ${of} of this one ${sec.noun}`) : '';
  return `Image ${n} = ${head}${part} — ${sec.purpose}.${note && k === 1 ? ` Note: ${note}` : ''}`;
}

// Blocks with a name or note but no image still belong in the scene — the gem writes them in words.
function imagelessLines(brief) {
  const out = [];
  for (const sec of SD_SECTIONS) {
    brief.blocks.filter(b => b.kind === sec.kind).forEach((b, i) => {
      const name = String(b.name || '').trim(), note = String(b.note || '').trim();
      if (b.images.length || (!name && !note)) return;
      out.push(`${sec.role}${sec.multi ? ` ${i + 1}` : ''}${name ? ` "${name}"` : ''} (@${blockTag(b, i + 1)})${note ? ` — ${note}` : ''}`);
    });
  }
  return out;
}

function shotLine(s, i, t) {
  const specs = [s.size, s.lens, s.move].map(x => String(x || '').trim()).filter(Boolean);
  const action = String(s.action || '').trim().replace(/\s*\n+\s*/g, ' ');
  return `Shot ${i + 1} · ${fmtSec(t.start)}–${fmtSec(t.end)}s${specs.map(x => ` · ${x}`).join('')}${action ? ` — ${action}` : ''}`;
}

// The message the gem receives: a role-labeled upload manifest, then the brief in its mode.
export function composeBrief(brief, { version = '2.5' } = {}) {
  const items = orderedImages(brief);
  const director = brief.mode === 'director';
  const length = director ? sumShots(brief.shots) : Math.min(limitsFor(version).maxLen, Number(brief.length) || SD_MIN_LEN);
  const aspect = brief.aspect || '';
  const out = [];
  if (items.length) out.push(`ATTACHED REFERENCE FILES — upload to OpenArt in this exact order:\n${items.map(manifestLine).join('\n')}`);
  const loose = imagelessLines(brief);
  if (loose.length) out.push(`ALSO IN THE SCENE, WITHOUT A REFERENCE IMAGE:\n${loose.join('\n')}`);
  const settings = `LENGTH: ${fmtSec(length)}s${aspect ? ` · ASPECT RATIO: ${aspect}` : ''}`;
  if (director) {
    out.push(`BRIEF MODE: DIRECTOR / DOP — keep my shot list exactly.\n${settings}`);
    if (String(brief.scene || '').trim()) out.push(`SCENE: ${brief.scene.trim()}`);
    const times = shotTimes(brief.shots);
    out.push(`SHOT LIST — ${brief.shots.length} shot${brief.shots.length === 1 ? '' : 's'}, ${fmtSec(length)}s:\n${brief.shots.map((s, i) => shotLine(s, i, times[i])).join('\n')}`);
  } else {
    out.push(`BRIEF MODE: CREATIVE — break the scene into shots yourself.\n${settings}`);
    out.push(`SCENE:\n${String(brief.creative || '').trim()}`);
  }
  return { text: out.join('\n\n'), images: items.map(it => it.img), length, mode: director ? 'director' : 'creative', aspect };
}

// Why the brief can't be sent yet ('' when it can).
export function validateBrief(brief, version = '2.5') {
  const L = limitsFor(version);
  const count = orderedImages(brief).length;
  if (count > L.maxImages) return `Seedance ${version} takes up to ${L.maxImages} images — this brief has ${count}. Remove ${count - L.maxImages}${version === '2.0' ? ', or switch to 2.5' : ''}.`;
  if (brief.mode === 'director') {
    if (!brief.shots.length) return 'Add at least one shot.';
    if (!brief.shots.some(s => String(s.action || '').trim())) return 'Write what happens in at least one shot.';
    const total = sumShots(brief.shots);
    if (total > L.maxLen) return `The shots run ${fmtSec(total)}s — Seedance ${version} takes up to ${L.maxLen}s. Shorten some shots.`;
    if (total < SD_MIN_LEN) return `The shots run ${fmtSec(total)}s — Seedance needs at least ${SD_MIN_LEN}s.`;
  } else if (!String(brief.creative || '').trim()) return 'Describe the scene first.';
  return '';
}

const ASPECTS = [['', 'Project default'], ['16:9', '16:9 wide'], ['9:16', '9:16 vertical'], ['21:9', '21:9 cinema'], ['1:1', '1:1 square'], ['4:3', '4:3'], ['3:4', '3:4 portrait']];
const SIZES = ['Extreme wide', 'Wide', 'Full shot', 'Medium wide', 'Medium', 'Medium close-up', 'Close-up', 'Extreme close-up', 'Insert / detail', 'Over-the-shoulder', 'POV', 'Two-shot'];
const LENSES = ['14mm ultra-wide', '18mm', '24mm', '28mm', '35mm', '40mm anamorphic', '50mm', '65mm', '85mm', '100mm macro', '135mm', '200mm tele'];
const MOVES = ['Locked-off', 'Slow push-in', 'Pull-out', 'Pan', 'Tilt', 'Dolly / track', 'Tracking', 'Handheld', 'Gimbal follow', 'Crane up', 'Crane down', 'Orbit', 'Whip pan', 'Rack focus', 'Drone / aerial', 'Snap zoom'];

// Drag payloads: a block thumbnail being moved, a project-drawer image, or a Library card.
const DRAG = { move: 'text/avs-sd-move', item: 'text/avs-sd-item', image: 'text/avs-image' };

export function createSeedance({ escapeHtml: esc, toast, state, mediaFetch, imgFileToB64, filesFromPaste, insertAtCursor, openLightbox, runTurn }) {
  let root = null;           // #sdMain while the tab is open — re-created on every visit
  let mountedPid = null;
  let busyPid = null;        // the project whose prompt is being written
  let activeBid = null;      // the block a pasted image lands in (the last one touched)
  let lastField = null;      // the brief field an @name chip inserts into
  let pasteWired = false;
  const drawer = { open: false, target: null, tab: 'generated' };

  const brief = () => {
    state.sdBriefs = state.sdBriefs || {};
    const pid = state.current?.id || '_';
    return state.sdBriefs[pid] || (state.sdBriefs[pid] = newBrief());
  };
  const version = () => state.seedanceVersion || '2.5';
  const absUrl = (u) => { try { return new URL(u, location.href).href; } catch { return String(u || ''); } };
  const findBlock = (bid) => brief().blocks.find(b => b.id === bid) || null;
  const listFor = (target) => (target === 'inbox' ? brief().inbox : findBlock(target)?.images || null);
  const kindIndex = (block) => brief().blocks.filter(b => b.kind === block.kind).indexOf(block) + 1;
  const labelOf = (block) => blockLabel(block, kindIndex(block));
  function locate(iid) {
    const b = brief();
    for (const list of [b.inbox, ...b.blocks.map(x => x.images)]) {
      const i = list.findIndex(x => x.id === iid);
      if (i >= 0) return { list, i };
    }
    return null;
  }
  function insertBlock(kind) {
    const b = brief(), blk = newBlock(kind);
    let at = -1;
    b.blocks.forEach((x, i) => { if (x.kind === kind) at = i; });
    b.blocks.splice(at + 1, 0, blk);   // keep a section's blocks together, newest last
    return blk;
  }
  const setShotLens = (b, lens) => { b.shots.forEach((s, i) => { s.len = lens[i]; }); b.length = sumShots(b.shots); };

  // ── render ────────────────────────────────────────────────────────────────────
  function render() {
    if (!root || !root.isConnected) return;
    const b = brief();
    const body = root.closest('.sd-body');
    if (body) { body.classList.toggle('step-assets', b.step !== 'prompt'); body.classList.toggle('step-prompt', b.step === 'prompt'); }
    const nums = new Map(orderedImages(b).map(it => [it.img.id, it.n]));
    root.innerHTML = stepsHtml(b, nums.size) + (b.step === 'prompt' ? promptHtml(b) : assetsHtml(b, nums));
  }

  function stepsHtml(b, count) {
    const L = limitsFor(version());
    return `<div class="sd-steps">
      <button class="sd-step${b.step !== 'prompt' ? ' active' : ''}" data-act="step" data-step="assets" type="button"><span class="sd-step-n">1</span>Assets<em class="${count > L.maxImages ? 'sd-over' : ''}">${count} / ${L.maxImages} images</em></button>
      <span class="sd-step-line"></span>
      <button class="sd-step${b.step === 'prompt' ? ' active' : ''}" data-act="step" data-step="prompt" type="button"><span class="sd-step-n">2</span>Prompt<em>${b.mode === 'director' ? 'Director · DOP' : 'Creative'}</em></button>
      <button class="mini-btn ghost sd-reset" data-act="reset" type="button" title="Clear every image and the brief for this project">Reset</button>
    </div>`;
  }

  function thumbHtml(img, n) {
    return `<div class="sd-thumb" draggable="true" data-iid="${img.id}" title="${esc(img.name || 'image')} — drag to move · click to enlarge">
      <img src="${esc(img.url)}" alt="" draggable="false" />${n ? `<span class="sd-n">${n}</span>` : ''}
      <button class="sd-x" data-act="rm-img" data-iid="${img.id}" type="button" title="Remove">✕</button>
    </div>`;
  }

  function blockHtml(blk, sec, idx, count, nums) {
    const ns = blk.images.map(i => nums.get(i.id)).filter(Boolean);
    const range = ns.length > 1 ? `#${ns[0]}–${ns[ns.length - 1]}` : (ns.length ? `#${ns[0]}` : '');
    const tag = blockTag(blk, idx);
    const cls = ['sd-block', blk.id === activeBid ? 'sd-active' : '', drawer.open && drawer.target === blk.id ? 'sd-target' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-bid="${blk.id}">
      <div class="sd-block-head">
        ${sec.multi ? `<input class="sd-name" data-field="name" data-bid="${blk.id}" placeholder="${esc(sec.namePh)}" value="${esc(blk.name)}" aria-label="${sec.one} ${idx} name" />` : ''}
        <span class="sd-chip" data-chip="${blk.id}" title="Point at this reference in the brief with @${esc(tag)}">@${esc(tag)}</span>
        <span class="sd-range-n" title="Upload order on OpenArt">${range}</span>
        ${sec.multi && count > 1 ? `<button class="sd-x" data-act="rm-block" data-bid="${blk.id}" type="button" title="Remove this ${sec.one.toLowerCase()}">✕</button>` : ''}
      </div>
      <div class="sd-drop" data-drop="${blk.id}">
        ${blk.images.map(img => thumbHtml(img, nums.get(img.id))).join('')}
        <div class="sd-add">
          <button class="sd-add-btn" data-act="upload" data-bid="${blk.id}" type="button">⬆ Upload</button>
          <button class="sd-add-btn" data-act="from-project" data-bid="${blk.id}" type="button">🖼 From project</button>
        </div>
        ${blk.images.length ? '' : '<span class="sd-drop-hint">or drop · paste images here</span>'}
        <input type="file" accept="image/*" multiple hidden data-file="${blk.id}" />
      </div>
      <input class="sd-note" data-field="note" data-bid="${blk.id}" placeholder="${esc(sec.notePh)}" value="${esc(blk.note)}" aria-label="${sec.one} ${idx} note" />
    </div>`;
  }

  function assetsHtml(b, nums) {
    const L = limitsFor(version());
    const inbox = b.inbox.length ? `<div class="sd-inbox">
        <div class="sd-inbox-head"><b>📥 Unsorted · ${b.inbox.length}</b><span>Drag each image into its section — unsorted images aren't sent.</span></div>
        <div class="sd-drop" data-drop="inbox">${b.inbox.map(img => thumbHtml(img, 0)).join('')}</div>
      </div>` : '';
    const sections = SD_SECTIONS.map(sec => {
      const blocks = b.blocks.filter(x => x.kind === sec.kind);
      return `<section class="sd-sec" data-kind="${sec.kind}">
        <div class="sd-sec-head"><h4>${sec.icon} ${sec.title}</h4><span class="sd-sec-hint">${sec.hint}</span>
          ${sec.multi ? `<button class="mini-btn" data-act="add-block" data-kind="${sec.kind}" type="button">＋ ${sec.add}</button>` : ''}</div>
        <div class="sd-blocks">${blocks.map((blk, i) => blockHtml(blk, sec, i + 1, blocks.length, nums)).join('')}</div>
      </section>`;
    }).join('');
    return `<div class="sd-assets${drawer.open ? ' with-drawer' : ''}">
      <div class="sd-sections">${inbox}${sections}
        <div class="sd-foot">
          <span class="sd-count${nums.size > L.maxImages ? ' sd-over' : ''}">${nums.size} / ${L.maxImages} images · numbered in OpenArt upload order</span>
          <button class="generate-btn sd-next" data-act="step" data-step="prompt" type="button">Next: write the prompt →</button>
        </div>
      </div>
      ${drawer.open ? drawerHtml() : ''}
    </div>`;
  }

  function drawerItems(tab) {
    const pid = state.current?.id;
    if (tab === 'assets') return (state.current?.characters || []).filter(c => c.reference?.file).map(c => {
      const tag = c.tag || tagSlug(c.name);
      return { url: `/media/${pid}/images/${c.reference.file}`, name: `${c.name} (@${tag})`, title: `${c.name} · @${tag}`, asset: { tag, type: c.type || 'character', name: c.name } };
    });
    if (tab === 'refs') return (state.current?.references || []).map(r => ({ url: r.url, name: r.file, title: 'Kept reference' }));
    return (state.current?.images || []).map(im => ({ url: `/media/${pid}/images/${im.file}`, name: im.file, title: im.prompt || '' }));
  }

  function drawerHtml() {
    const tgt = findBlock(drawer.target);
    const items = drawerItems(drawer.tab);
    const tabs = [['generated', 'Generated'], ['assets', 'Assets'], ['refs', 'References']];
    const empty = { generated: 'No generated images in this project yet.', assets: 'No built assets yet — make them in the Assets tab.', refs: 'No kept references yet.' }[drawer.tab];
    return `<aside class="sd-drawer">
      <div class="sd-drawer-head"><b>Project images</b><button class="sd-x" data-act="drawer-close" type="button" title="Close">✕</button></div>
      <div class="mode-toggle sd-drawer-tabs">${tabs.map(([k, l]) => `<button class="seg${drawer.tab === k ? ' active' : ''}" data-act="drawer-tab" data-tab="${k}" type="button">${l} · ${drawerItems(k).length}</button>`).join('')}</div>
      <p class="sd-drawer-hint">Click to add to <b>${esc(tgt ? labelOf(tgt) : '—')}</b> — or drag into any block.</p>
      ${items.length ? `<div class="sd-drawer-grid">${items.map(it => `<button class="fav-thumb sd-pick" draggable="true" data-act="drawer-pick" data-src="${encodeURIComponent(JSON.stringify(it))}" title="${esc(it.title)}" type="button"><img src="${esc(it.url)}" alt="" loading="lazy" draggable="false" /></button>`).join('')}</div>`
        : `<div class="fav-empty">${empty}</div>`}
    </aside>`;
  }

  function railHtml(b) {
    const items = orderedImages(b);
    const list = items.map(it => {
      const tag = blockTag(it.block, it.blockIndex);
      return `<li class="sd-rail-item" data-kind="${it.sec.kind}">
        <span class="sd-rail-n">${it.n}</span>
        <img src="${esc(it.img.url)}" alt="" data-act="view" data-iid="${it.img.id}" title="Click to enlarge" />
        <span class="sd-rail-meta"><b>${it.sec.icon} ${esc(blockLabel(it.block, it.blockIndex))}</b><small>${it.of > 1 ? `${it.k} of ${it.of}` : it.sec.one}</small></span>
        <button class="sd-chip" data-act="tag" data-tag="${esc(tag)}" type="button" title="Insert @${esc(tag)} into the brief">@${esc(tag)}</button>
      </li>`;
    }).join('');
    const loose = b.inbox.length;
    return `<aside class="sd-rail">
      <div class="sd-rail-head"><span class="field-label">Upload order</span><button class="mini-btn" data-act="step" data-step="assets" type="button">✎ Edit</button></div>
      ${items.length ? `<ol class="sd-rail-list">${list}</ol>` : '<p class="sd-rail-empty">No reference images — the prompt will be text only.</p>'}
      ${loose ? `<p class="sd-warn">${loose} unsorted image${loose === 1 ? '' : 's'} won't be sent — sort ${loose === 1 ? 'it' : 'them'} in ① Assets.</p>` : ''}
      ${items.length ? '<button class="mini-btn sd-dl" data-act="download" type="button" title="Download every image, numbered in upload order, ready for OpenArt">⬇ Download in order</button>' : ''}
    </aside>`;
  }

  function shotHtml(s, i, n, t, L) {
    return `<div class="sd-shot" data-sid="${s.id}">
      <div class="sd-shot-head">
        <b class="sd-shot-n">Shot ${i + 1}</b>
        <span class="sd-shot-time" data-time="${s.id}">${fmtSec(t.start)}–${fmtSec(t.end)}s</span>
        <input type="range" class="sd-range sd-shot-len" data-shot-len="${s.id}" min="${SHOT_MIN}" max="${L.maxLen}" step="${SHOT_STEP}" value="${s.len}" aria-label="Shot ${i + 1} length in seconds" />
        <output class="sd-shot-out" data-out="${s.id}">${fmtSec(s.len)}s</output>
        <span class="sd-shot-acts">
          <button class="sd-icon" data-act="shot-up" data-sid="${s.id}" type="button" title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
          <button class="sd-icon" data-act="shot-down" data-sid="${s.id}" type="button" title="Move down"${i === n - 1 ? ' disabled' : ''}>↓</button>
          <button class="sd-icon" data-act="rm-shot" data-sid="${s.id}" type="button" title="Remove shot"${n === 1 ? ' disabled' : ''}>✕</button>
        </span>
      </div>
      <div class="sd-shot-specs">
        <input list="sdSizes" data-shot="${s.id}" data-k="size" placeholder="Shot size" value="${esc(s.size)}" aria-label="Shot ${i + 1} size" />
        <input list="sdLenses" data-shot="${s.id}" data-k="lens" placeholder="Lens" value="${esc(s.lens)}" aria-label="Shot ${i + 1} lens" />
        <input list="sdMoves" data-shot="${s.id}" data-k="move" placeholder="Camera move" value="${esc(s.move)}" aria-label="Shot ${i + 1} camera move" />
      </div>
      <textarea class="sd-text sd-action" data-shot="${s.id}" data-k="action" rows="2" placeholder="What happens in this shot — action, performance, light…">${esc(s.action)}</textarea>
    </div>`;
  }

  function promptHtml(b) {
    const L = limitsFor(version());
    const director = b.mode === 'director';
    const total = director ? sumShots(b.shots) : b.length;
    const minTotal = director ? Math.max(SD_MIN_LEN, b.shots.length * SHOT_MIN) : SD_MIN_LEN;
    const dl = (id, opts) => `<datalist id="${id}">${opts.map(o => `<option value="${esc(o)}"></option>`).join('')}</datalist>`;
    const times = shotTimes(b.shots);
    const editor = director
      ? `<textarea class="sd-text sd-scene" data-field="scene" rows="2" placeholder="Scene context (optional) — where we are, the mood, what the sequence is about…">${esc(b.scene)}</textarea>
        <div class="sd-shots">${b.shots.map((s, i) => shotHtml(s, i, b.shots.length, times[i], L)).join('')}</div>
        <button class="mini-btn sd-add-shot" data-act="add-shot" type="button">＋ Add shot</button>
        ${dl('sdSizes', SIZES)}${dl('sdLenses', LENSES)}${dl('sdMoves', MOVES)}`
      : `<textarea class="sd-text" data-field="creative" placeholder="Describe the scene — who's in it, where, what happens, how it should feel. The gem breaks it into shots, lenses and camera moves. Click an @name on the left to point at a reference.">${esc(b.creative)}</textarea>`;
    const busy = busyPid === state.current?.id;
    return `<div class="sd-prompt">
      ${railHtml(b)}
      <div class="sd-brief">
        <div class="sd-brief-head">
          <div class="mode-toggle" role="group" aria-label="Brief mode">
            <button class="seg${director ? ' active' : ''}" data-act="mode" data-mode="director" type="button">🎬 Director · DOP</button>
            <button class="seg${director ? '' : ' active'}" data-act="mode" data-mode="creative" type="button">✨ Creative</button>
          </div>
          <span class="sd-mode-hint">${director ? 'Number the shots — size, lens, move and length for each. The gem keeps them exactly.' : 'Describe the scene and what we see — the gem breaks it into shots, lenses and moves.'}</span>
        </div>
        ${editor}
        <div class="sd-settings">
          <label class="sd-len"><span class="field-label">Film length</span>
            <span class="sd-len-row"><input type="range" class="sd-range" data-len="total" min="${minTotal}" max="${L.maxLen}" step="${director ? SHOT_STEP : 1}" value="${total}" aria-label="Film length in seconds" /><output class="sd-len-out">${fmtSec(total)}s</output></span>
          </label>
          <label class="sd-aspect"><span class="field-label">Aspect</span><select data-field="aspect">${ASPECTS.map(([v, l]) => `<option value="${v}"${b.aspect === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <p class="sd-len-note">${director ? `The sum of the shots — drag it to stretch or tighten them all at once. ` : ''}Up to ${L.maxLen}s on Seedance ${version()}.</p>
        <button class="generate-btn sd-generate" id="sdGenerate" data-act="generate" type="button"${busy ? ' disabled' : ''}>${busy ? '<span class="spinner"></span>Writing the prompt…' : 'Generate Seedance prompt'}</button>
      </div>
    </div>`;
  }

  // Slider moves patch the page in place — a full render mid-drag would drop the slider.
  function syncShotsDom() {
    if (!root) return;
    const b = brief(), times = shotTimes(b.shots);
    b.shots.forEach((s, i) => {
      const time = root.querySelector(`[data-time="${s.id}"]`); if (time) time.textContent = `${fmtSec(times[i].start)}–${fmtSec(times[i].end)}s`;
      const out = root.querySelector(`[data-out="${s.id}"]`); if (out) out.textContent = `${fmtSec(s.len)}s`;
      const r = root.querySelector(`[data-shot-len="${s.id}"]`); if (r && Number(r.value) !== s.len) r.value = String(s.len);
    });
    const total = root.querySelector('[data-len="total"]'); if (total && Number(total.value) !== b.length) total.value = String(b.length);
    const out = root.querySelector('.sd-len-out'); if (out) out.textContent = `${fmtSec(b.length)}s`;
  }

  // ── adding and moving images ─────────────────────────────────────────────────
  // Everything is re-encoded to a JPEG under 1568px for the gem: a brief can carry 30 images,
  // and full-size sheets would overrun the request. Downloads still use the original file.
  async function addFiles(target, files) {
    const list = listFor(target);
    if (!list) return 0;
    const imgs = files.filter(f => (f.type || '').startsWith('image/'));
    if (!imgs.length) { toast('Only image files can be added.', true); return 0; }
    let n = 0;
    for (const f of imgs) {
      try {
        list.push({ id: sdId(), name: f.name || 'pasted image', mimeType: 'image/jpeg', data: await imgFileToB64(f), url: URL.createObjectURL(f), src: 'upload' });
        n++;
      } catch (e) { toast(e.message || 'Could not read that image.', true); }
    }
    if (target !== 'inbox') activeBid = target;
    render();
    return n;
  }

  async function addUrl(target, item) {
    const list = listFor(target);
    if (!list || !item?.url) return false;
    const url = absUrl(item.url);
    if (list.some(x => absUrl(x.url) === url)) { toast(target === 'inbox' ? 'Already waiting in Unsorted.' : 'Already in this block.'); return false; }
    try {
      const blob = await (await mediaFetch(url)).blob();
      if (!(blob.type || '').startsWith('image/')) throw new Error('not an image');
      list.push({ id: sdId(), name: item.name || url.split('/').pop(), mimeType: 'image/jpeg', data: await imgFileToB64(blob), url, src: item.asset ? 'asset' : 'project', asset: item.asset || null });
    } catch { toast('Could not add that image.', true); return false; }
    const blk = target === 'inbox' ? null : findBlock(target);
    // An asset dropped into an unnamed block names it, and its @tag carries over.
    if (blk && item.asset && secOf(blk.kind).multi && !blk.name.trim()) { blk.name = item.asset.name; blk.tag = item.asset.tag; }
    if (blk) activeBid = blk.id;
    render();
    return true;
  }

  function moveImage(iid, target, beforeIid) {
    if (!iid || iid === beforeIid) return;
    const from = locate(iid), to = listFor(target);
    if (!from || !to) return;
    const [img] = from.list.splice(from.i, 1);
    let at = beforeIid ? to.findIndex(x => x.id === beforeIid) : -1;
    if (at < 0) at = to.length;
    to.splice(at, 0, img);
    if (target !== 'inbox') activeBid = target;
    render();
  }

  function viewImage(iid) {
    const b = brief(), loc = locate(iid);
    if (!loc) return;
    const all = loc.list === b.inbox ? b.inbox : orderedImages(b).map(it => it.img);
    openLightbox(all.map(x => ({ src: x.url, caption: x.name || '' })), Math.max(0, all.findIndex(x => x.id === iid)));
  }

  async function downloadInOrder(btn) {
    const items = orderedImages(brief());
    btn.disabled = true;
    let n = 0;
    for (const it of items) {
      try {
        const blob = await (await mediaFetch(it.img.url)).blob();
        const ext = /png/.test(blob.type) ? 'png' : /webp/.test(blob.type) ? 'webp' : /gif/.test(blob.type) ? 'gif' : 'jpg';
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = `${String(it.n).padStart(2, '0')}-${blockTag(it.block, it.blockIndex)}${it.of > 1 ? `-${it.k}` : ''}.${ext}`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 15000);
        n++;
        await new Promise(r => setTimeout(r, 200));   // browsers drop downloads fired back to back
      } catch { /* skip one that can't be fetched */ }
    }
    btn.disabled = false;
    toast(n ? `Downloaded ${n} image${n === 1 ? '' : 's'}, numbered in upload order.` : 'Nothing could be downloaded.', !n);
  }

  // ── the brief ────────────────────────────────────────────────────────────────
  function setMode(mode) {
    const b = brief(), L = limitsFor(version());
    if (b.mode === mode) return;
    if (mode === 'director') {
      if (!b.shots.length) b.shots = [newShot(), newShot(), newShot()];
      setShotLens(b, rescaleShots(b.shots.map(s => s.len), Math.min(L.maxLen, Math.max(SD_MIN_LEN, b.length))));
    }
    b.mode = mode;
    render();
  }

  function addShot() {
    const b = brief(), L = limitsFor(version());
    if ((b.shots.length + 1) * SHOT_MIN > L.maxLen) { toast(`Seedance ${version()} fits at most ${Math.floor(L.maxLen / SHOT_MIN)} one-second shots.`, true); return; }
    const s = newShot(3);
    b.shots.push(s);
    if (sumShots(b.shots) > L.maxLen) { setShotLens(b, rescaleShots(b.shots.map(x => x.len), L.maxLen)); toast(`Tightened the shots to fit ${L.maxLen}s.`); }
    b.length = sumShots(b.shots);
    render();
    root?.querySelector(`[data-shot="${s.id}"][data-k="action"]`)?.focus();
  }

  function removeShot(sid) {
    const b = brief();
    const i = b.shots.findIndex(s => s.id === sid);
    if (i < 0 || b.shots.length <= 1) return;
    const s = b.shots[i];
    if ([s.action, s.size, s.lens, s.move].some(x => String(x || '').trim()) && !confirm(`Remove shot ${i + 1}?`)) return;
    b.shots.splice(i, 1);
    if (sumShots(b.shots) < SD_MIN_LEN) setShotLens(b, rescaleShots(b.shots.map(x => x.len), SD_MIN_LEN));
    b.length = sumShots(b.shots);
    render();
  }

  function moveShot(sid, d) {
    const shots = brief().shots;
    const i = shots.findIndex(s => s.id === sid), j = i + d;
    if (i < 0 || j < 0 || j >= shots.length) return;
    [shots[i], shots[j]] = [shots[j], shots[i]];
    render();
  }

  function insertTag(tag) {
    const el = (lastField && lastField.isConnected) ? lastField : root?.querySelector('textarea[data-field="creative"], textarea.sd-action');
    if (!el) return;
    el.focus();
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    insertAtCursor(el, `${before && !/\s$/.test(before) ? ' ' : ''}@${tag} `);
    onInput({ target: el });   // insertAtCursor's input event doesn't bubble up to the delegate
  }

  async function generate() {
    const pid = state.current?.id;
    if (!pid || busyPid) return;
    const b = brief(), v = version();
    const err = validateBrief(b, v);
    if (err) { toast(err, true); return; }
    if (!state.config?.hasAnthropic) { toast('Add your ANTHROPIC_API_KEY to .env first.', true); return; }
    const c = composeBrief(b, { version: v });
    busyPid = pid;
    render();
    let ok = false;
    try {
      ok = await runTurn({
        sendText: c.text, history: [],   // every brief is a fresh scene
        images: c.images.map(i => ({ mimeType: i.mimeType, data: i.data })),
        extra: { seedanceMode: c.mode, seedanceLength: c.length, seedanceAspect: c.aspect },
      });
    } finally {
      busyPid = null;
      render();
    }
    // On a narrow screen the prompts sit below the brief — bring the new one into view.
    if (ok && root?.isConnected) root.closest('.sd-body')?.querySelector('.sd-out')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ── events (delegated from #sdMain, so they survive every re-render) ──────────
  async function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || !root.contains(btn)) {
      const th = e.target.closest('.sd-thumb');
      if (th) viewImage(th.dataset.iid);
      return;
    }
    const b = brief();
    switch (btn.dataset.act) {
      case 'step': b.step = btn.dataset.step; drawer.open = false; render(); root.scrollTop = 0; return;
      case 'reset':
        if (!confirm('Clear every image and the whole brief for this project?')) return;
        state.sdBriefs[state.current.id] = newBrief();
        drawer.open = false; activeBid = null;
        return render();
      case 'add-block': {
        const blk = insertBlock(btn.dataset.kind);
        activeBid = blk.id;
        render();
        root.querySelector(`.sd-name[data-bid="${blk.id}"]`)?.focus();
        return;
      }
      case 'rm-block': {
        const blk = findBlock(btn.dataset.bid);
        if (!blk || (blk.images.length && !confirm(`Remove ${labelOf(blk)} and its ${blk.images.length} image${blk.images.length === 1 ? '' : 's'}?`))) return;
        b.blocks = b.blocks.filter(x => x !== blk);
        if (drawer.target === blk.id) drawer.open = false;
        return render();
      }
      case 'upload': activeBid = btn.dataset.bid; root.querySelector(`input[data-file="${btn.dataset.bid}"]`)?.click(); return;
      case 'from-project': activeBid = btn.dataset.bid; drawer.open = true; drawer.target = btn.dataset.bid; return render();
      case 'drawer-close': drawer.open = false; return render();
      case 'drawer-tab': drawer.tab = btn.dataset.tab; return render();
      case 'drawer-pick':
        if (!findBlock(drawer.target)) { toast('Choose a block first — use "From project" on it.', true); return; }
        btn.disabled = true;
        await addUrl(drawer.target, JSON.parse(decodeURIComponent(btn.dataset.src)));
        btn.disabled = false;
        return;
      case 'rm-img': { const loc = locate(btn.dataset.iid); if (loc) { loc.list.splice(loc.i, 1); render(); } return; }
      case 'view': return viewImage(btn.dataset.iid);
      case 'mode': return setMode(btn.dataset.mode);
      case 'add-shot': return addShot();
      case 'rm-shot': return removeShot(btn.dataset.sid);
      case 'shot-up': return moveShot(btn.dataset.sid, -1);
      case 'shot-down': return moveShot(btn.dataset.sid, 1);
      case 'tag': return insertTag(btn.dataset.tag);
      case 'download': return downloadInOrder(btn);
      case 'generate': return generate();
    }
  }

  function onInput(e) {
    const t = e.target, b = brief(), L = limitsFor(version());
    if (t.dataset.len === 'total') {
      const v = Number(t.value);
      if (b.mode === 'director') { setShotLens(b, rescaleShots(b.shots.map(s => s.len), v)); syncShotsDom(); }
      else { b.length = Math.min(L.maxLen, Math.max(SD_MIN_LEN, v)); const out = root.querySelector('.sd-len-out'); if (out) out.textContent = `${fmtSec(b.length)}s`; }
      return;
    }
    if (t.dataset.shotLen) {
      const i = b.shots.findIndex(s => s.id === t.dataset.shotLen);
      if (i < 0) return;
      b.shots[i].len = clampShotLen(b.shots.map(s => s.len), i, Number(t.value), { maxTotal: L.maxLen });
      b.length = sumShots(b.shots);
      syncShotsDom();
      return;
    }
    const f = t.dataset.field;
    if (f === 'creative' || f === 'scene') { b[f] = t.value; return; }
    if ((f === 'name' || f === 'note') && t.dataset.bid) {
      const blk = findBlock(t.dataset.bid);
      if (!blk) return;
      blk[f] = t.value;
      if (f === 'name') {
        blk.tag = '';   // a hand-typed name takes over from an asset's tag
        const chip = root.querySelector(`[data-chip="${blk.id}"]`);
        if (chip) chip.textContent = `@${blockTag(blk, kindIndex(blk))}`;
      }
      return;
    }
    if (t.dataset.shot && t.dataset.k) {
      const s = b.shots.find(x => x.id === t.dataset.shot);
      if (s) s[t.dataset.k] = t.value;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset.file) { const files = [...t.files]; t.value = ''; addFiles(t.dataset.file, files); return; }
    if (t.dataset.field === 'aspect') brief().aspect = t.value;
  }

  function setActive(bid) {
    if (activeBid === bid) return;
    activeBid = bid;
    root.querySelectorAll('.sd-block').forEach(el => el.classList.toggle('sd-active', el.dataset.bid === bid));
  }
  function onFocus(e) {
    if (e.target.matches('textarea.sd-text, .sd-shot-specs input')) lastField = e.target;
    const blk = e.target.closest('.sd-block');
    if (blk) setActive(blk.dataset.bid);
  }
  function onPointer(e) { const blk = e.target.closest('.sd-block'); if (blk) setActive(blk.dataset.bid); }

  const dragTypes = (e) => [...(e.dataTransfer?.types || [])];
  const isOurDrag = (e) => dragTypes(e).some(t => t === 'Files' || t === DRAG.move || t === DRAG.item || t === DRAG.image);
  function clearDragMarks() { root?.querySelectorAll('.drag, .sd-dragging').forEach(el => el.classList.remove('drag', 'sd-dragging')); }
  function onDragStart(e) {
    const th = e.target.closest?.('.sd-thumb');
    if (th) { e.dataTransfer.setData(DRAG.move, th.dataset.iid); e.dataTransfer.effectAllowed = 'move'; th.classList.add('sd-dragging'); return; }
    const pick = e.target.closest?.('.sd-pick');
    if (pick) {
      e.dataTransfer.setData(DRAG.item, pick.dataset.src);
      e.dataTransfer.setData(DRAG.image, absUrl(JSON.parse(decodeURIComponent(pick.dataset.src)).url));
      e.dataTransfer.effectAllowed = 'copy';
    }
  }
  function onDragOver(e) {
    if (!isOurDrag(e)) return;
    e.preventDefault();   // anywhere in the builder takes a drop; outside a block, files go to Unsorted
    const zone = e.target.closest?.('[data-drop]');
    root.querySelectorAll('.sd-drop.drag').forEach(z => { if (z !== zone) z.classList.remove('drag'); });
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
    clearDragMarks();
    const zone = e.target.closest?.('[data-drop]');
    const target = zone ? zone.dataset.drop : null;
    const types = dragTypes(e);
    if (types.includes(DRAG.move)) { if (target) moveImage(e.dataTransfer.getData(DRAG.move), target, e.target.closest?.('.sd-thumb')?.dataset.iid || null); return; }
    if (types.includes('Files')) {
      const n = await addFiles(target || 'inbox', [...(e.dataTransfer.files || [])]);
      if (n && !target) toast(`Added to Unsorted — drag ${n === 1 ? 'it' : 'them'} into a section.`);
      return;
    }
    const raw = e.dataTransfer.getData(DRAG.item);
    const item = raw ? JSON.parse(decodeURIComponent(raw)) : { url: e.dataTransfer.getData(DRAG.image) };
    const ok = await addUrl(target || 'inbox', item);
    if (ok && !target) toast('Added to Unsorted — drag it into a section.');
  }

  // A pasted image lands in the block last touched (else Unsorted); pasted text still pastes.
  function wirePaste() {
    if (pasteWired) return;
    pasteWired = true;
    document.addEventListener('paste', async (e) => {
      if (state.activeTab !== 'seedance' || !root || !root.isConnected) return;
      const files = filesFromPaste(e);
      if (!files.length) return;
      e.preventDefault();
      const text = e.clipboardData.getData('text');
      const el = document.activeElement;
      if (text && el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'))) {
        insertAtCursor(el, text);
        if (root.contains(el)) onInput({ target: el });
      }
      const target = activeBid && findBlock(activeBid) ? activeBid : 'inbox';
      const n = await addFiles(target, files);
      if (n) toast(target === 'inbox' ? `Pasted into Unsorted — drag ${n === 1 ? 'it' : 'them'} into a section.` : `Pasted into ${labelOf(findBlock(target))}.`);
    });
  }

  // ── public ───────────────────────────────────────────────────────────────────
  function mount(el) {
    root = el;
    if (mountedPid !== state.current?.id) { mountedPid = state.current?.id; drawer.open = false; activeBid = null; lastField = null; }
    wirePaste();
    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    el.addEventListener('focusin', onFocus);
    el.addEventListener('pointerdown', onPointer);
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);
    el.addEventListener('dragend', clearDragMarks);
    render();
  }

  // The version toggle moved: fit the length to the new maximum, then redraw the limits.
  function refresh() {
    const b = brief(), L = limitsFor(version());
    let fitted = false;
    if (b.mode === 'director' && b.shots.length && sumShots(b.shots) > L.maxLen) { setShotLens(b, rescaleShots(b.shots.map(s => s.len), L.maxLen)); fitted = true; }
    if (b.mode !== 'director' && b.length > L.maxLen) { b.length = L.maxLen; fitted = true; }
    if (fitted) toast(`Film length fitted to Seedance ${version()}'s ${L.maxLen}s.`);
    render();
  }

  // From the Assets tab: the sheet goes to its type's section — a character into its own block.
  async function addAsset(char) {
    const b = brief();
    b.step = 'assets';
    const kind = ASSET_KIND[char.type || 'character'] || 'prop';
    const tag = char.tag || tagSlug(char.name);
    const url = absUrl(`/media/${state.current.id}/images/${char.reference.file}`);
    const holder = b.blocks.find(x => x.images.some(i => absUrl(i.url) === url));
    if (holder) { activeBid = holder.id; return { status: 'exists', section: secOf(holder.kind).title }; }
    let blk = secOf(kind).multi ? b.blocks.find(x => x.kind === kind && !x.images.length && !x.name.trim()) : b.blocks.find(x => x.kind === kind);
    if (!blk) blk = insertBlock(kind);
    const ok = await addUrl(blk.id, { url, name: `${char.name} (@${tag})`, asset: { tag, type: char.type || 'character', name: char.name } });
    return { status: ok ? 'added' : 'failed', section: secOf(kind).title };
  }

  // From an image card dropped on the tab button: it waits in Unsorted until sorted.
  function addToInbox(url) {
    brief().step = 'assets';
    return addUrl('inbox', { url });
  }

  // A follow-up keeps the brief's mode, so a revised prompt keeps its shot format.
  const followupExtra = () => ({ seedanceMode: brief().mode });

  return { mount, refresh, addAsset, addToInbox, followupExtra };
}
