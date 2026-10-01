// ── Video prompt builder ─────────────────────────────────────────────────────────
// The Video tab builds its brief in two steps instead of one chat box, then writes it for the
// model picked at its end — Seedance 2.0, Seedance 2.5 or Kling 3.0 (docs/seedance.md,
// docs/kling.md). The chat keeps its old id, 'seedance', so the tab's history carries on.
// ① References, in one of two modes:
//   - References: the look (one frame, always @image1 — "Use project gem" takes the project's own),
//     the location(s), one block per character, the props. They're numbered @image1, @image2 … in
//     that order, which is the order they're uploaded to OpenArt / Higgsfield, and every file gets
//     its role.
//   - Start & End frame: the frame the clip opens on (@image1) and the one it lands on (@image2).
// ② Prompt: director/DOP (a numbered shot list with a length per shot) or creative (a description
//   the gem breaks into shots), the film length, the aspect ratio — and the model. The images stay
//   on the side with their @image tags.
// The pure helpers up top are what the tests import; createSeedance() wires them to the page,
// borrowing app.js's helpers the way crm.js does.

export const SD_SECTIONS = [
  { kind: 'look', icon: '🎨', title: 'Look & cinematography', one: 'Look', noun: 'look', multi: false, single: true,
    hint: 'Lenses, lighting, grade — style only, nothing in it appears on screen. One frame, always @image1.',
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
// Start & End mode's two slots, shaped like sections so the same code draws and numbers them.
export const FRAME_SECS = [
  { kind: 'start', icon: '▶', title: 'Start frame', one: 'Start frame', noun: 'frame', multi: false, single: true,
    hint: 'The clip opens exactly on this frame — @image1.', notePh: '', railNote: 'the clip opens on it',
    role: 'START FRAME', purpose: 'the clip opens exactly on this frame — its composition, people, place and look are locked' },
  { kind: 'end', icon: '⏹', title: 'End frame', one: 'End frame', noun: 'frame', multi: false, single: true,
    hint: 'The clip lands exactly on this frame — @image2.', notePh: '', railNote: 'the clip lands on it',
    role: 'END FRAME', purpose: 'the clip ends exactly on this frame' },
];
const secOf = (kind) => SD_SECTIONS.find(s => s.kind === kind) || FRAME_SECS.find(s => s.kind === kind) || SD_SECTIONS[SD_SECTIONS.length - 1];

// Which section an Assets-tab asset lands in when it's sent here.
export const ASSET_KIND = { character: 'character', mascot: 'character', location: 'location', look: 'look', vehicle: 'prop', product: 'prop', prop: 'prop' };

// The aspect ratio is required: neither model can change it after the render.
const ASPECT_LABELS = { '16:9': '16:9 wide', '9:16': '9:16 vertical', '21:9': '21:9 cinema', '1:1': '1:1 square', '4:3': '4:3', '3:4': '3:4 portrait' };
export const SD_ASPECTS = ['16:9', '9:16', '21:9', '1:1', '4:3', '3:4'];
export const KLING_ASPECTS = ['16:9', '9:16', '1:1'];

// What each model takes (docs/seedance.md, docs/kling.md): clip length, the shortest shot, how many
// shots fit one clip, how many reference images go with it, and its frame shapes.
export const VIDEO_MODELS = {
  'seedance-2.0': { id: 'seedance-2.0', label: 'Seedance 2.0', family: 'seedance', version: '2.0', minLen: 4, maxLen: 15, maxImages: 9, minShot: 1, maxShots: 0,
    aspects: SD_ASPECTS, note: 'Up to 15s and 9 reference images; sound written in prose.' },
  'seedance-2.5': { id: 'seedance-2.5', label: 'Seedance 2.5', family: 'seedance', version: '2.5', minLen: 4, maxLen: 30, maxImages: 30, minShot: 1, maxShots: 0,
    aspects: SD_ASPECTS, note: 'Up to 30s and 30 reference images; native sound with its bracket grammar.' },
  'kling-3.0': { id: 'kling-3.0', label: 'Kling 3.0', family: 'kling', minLen: 3, maxLen: 15, maxImages: 4, minShot: 3, maxShots: 6,
    aspects: KLING_ASPECTS, note: 'Up to 15s and 4 reference images; cuts of 3s or more, 512 characters a shot.' },
};
export const MODEL_IDS = ['seedance-2.0', 'seedance-2.5', 'kling-3.0'];
// A model id — or an old Seedance version string, '2.0' / '2.5' — to the model it means.
export const normModel = (m) => (VIDEO_MODELS[m] ? m : VIDEO_MODELS[`seedance-${m}`] ? `seedance-${m}` : 'seedance-2.5');
export const modelOf = (m) => VIDEO_MODELS[normModel(m)];
export const limitsFor = (m) => modelOf(m);
export const SD_MIN_LEN = 4;                       // shortest clip Seedance renders
export const SHOT_MIN = 1, SHOT_STEP = 0.5;        // per-shot slider, in seconds (Kling's floor is 3)

// Letters in any script count, so a Hebrew name keeps a Hebrew tag (מאיה) rather than a blank one.
export const tagSlug = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 32);
export const fmtSec = (s) => String(Math.round(Number(s || 0) * 10) / 10);

// The supported frame shape closest to a picture's (a start frame sets the clip's).
export function nearestAspect(w, h, list = SD_ASPECTS) {
  if (!(w > 0 && h > 0)) return '';
  const r = Math.log(w / h);
  let best = '', gap = Infinity;
  for (const a of list) {
    const [x, y] = a.split(':').map(Number);
    const d = Math.abs(Math.log(x / y) - r);
    if (d < gap) { gap = d; best = a; }
  }
  return best;
}

let _seq = 0;
export const sdId = () => `sd${Date.now().toString(36)}${(_seq++).toString(36)}`;
export const newBlock = (kind) => ({ id: sdId(), kind, name: '', tag: '', note: '', images: [] });
export const newShot = (len = 3) => ({ id: sdId(), len, size: '', lens: '', move: '', action: '' });
export function newBrief() {
  return {
    step: 'assets', mode: 'creative', gen: 'refs',   // gen: 'refs' (references) | 'frames' (start & end)
    blocks: SD_SECTIONS.map(s => newBlock(s.kind)),   // one empty block per section to start
    frames: { start: newBlock('start'), end: newBlock('end') },
    inbox: [],                                        // dropped on the tab button, not sorted yet — never sent
    creative: '', scene: '', shots: [], length: 10, aspect: '',
    motion: '', move: '', frameWH: null,              // Start & End: the journey, the camera, the start frame's size
  };
}

// A block's name in file names and the old @name scheme: its asset tag, else its name, else its
// place in the section. (Prompts point at files by @image number.)
export const blockTag = (block, idx) => block.tag || tagSlug(block.name) || (block.kind === 'look' ? 'look' : `${block.kind}${idx}`);
// An Assets-tab asset's @tag. Hebrew-named assets saved before tags kept Hebrew letters all got
// the generic 'asset', so their name makes the better tag.
export const assetTag = (c) => (c.tag && c.tag !== 'asset' ? c.tag : tagSlug(c.name) || c.tag || 'asset');
export function blockLabel(block, idx) {
  const sec = secOf(block.kind);
  return sec.multi ? (String(block.name || '').trim() || `${sec.one} ${idx}`) : sec.title;
}

// Every image in upload order — the start and end frames in that mode; otherwise sections in
// order, blocks in order, images in order. The position is the @image number.
export function orderedImages(brief) {
  const out = [];
  const add = (block, sec, blockIndex) => block.images.forEach((img, ii) => out.push({
    n: out.length + 1, img, block, sec, blockIndex, k: ii + 1, of: block.images.length,
  }));
  if (brief.gen === 'frames') {
    for (const sec of FRAME_SECS) if (brief.frames?.[sec.kind]) add(brief.frames[sec.kind], sec, 1);
    return out;
  }
  for (const sec of SD_SECTIONS) brief.blocks.filter(b => b.kind === sec.kind).forEach((block, bi) => add(block, sec, bi + 1));
  return out;
}
// "@image3", or "@image3–4" for a block of several views.
export const imageRange = (ns) => (ns.length > 1 ? `@image${ns[0]}–${ns[ns.length - 1]}` : ns.length ? `@image${ns[0]}` : '');

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

// The role an image carries to the gem, with its tag ("CHARACTER 1 "Maya" (@image3) — …").
function roleLine({ n, block, sec, blockIndex, k, of }) {
  const name = String(block.name || '').trim();
  return `${sec.role}${sec.multi ? ` ${blockIndex}` : ''}${name ? ` "${name}"` : ''}${of > 1 ? `, view ${k} of ${of} of this one ${sec.noun}` : ''} (@image${n}) — ${sec.purpose}`;
}
function manifestLine(it) {
  const note = String(it.block.note || '').trim();
  return `Image ${it.n} = ${roleLine(it)}.${note && it.k === 1 ? ` Note: ${note}` : ''}`;
}

// Blocks with a name or note but no image still belong in the scene — the gem writes them in words.
function imagelessLines(brief) {
  const out = [];
  for (const sec of SD_SECTIONS) {
    brief.blocks.filter(b => b.kind === sec.kind).forEach((b, i) => {
      const name = String(b.name || '').trim(), note = String(b.note || '').trim();
      if (b.images.length || (!name && !note)) return;
      out.push(`${sec.role}${sec.multi ? ` ${i + 1}` : ''}${name ? ` "${name}"` : ''}${note ? ` — ${note}` : ''}`);
    });
  }
  return out;
}

function shotLine(s, i, t) {
  const specs = [s.size, s.lens, s.move].map(x => String(x || '').trim()).filter(Boolean);
  const action = String(s.action || '').trim().replace(/\s*\n+\s*/g, ' ');
  return `Shot ${i + 1} · ${fmtSec(t.start)}–${fmtSec(t.end)}s${specs.map(x => ` · ${x}`).join('')}${action ? ` — ${action}` : ''}`;
}

// The message the gem receives: the role-labeled upload list, then the brief in its mode. Its
// images carry their roles too, so the server labels each one ("Image 3 — CHARACTER …:") and the
// chat can show the upload order under the prompt.
export function composeBrief(brief, { model, version } = {}) {
  const M = modelOf(model || version);
  const items = orderedImages(brief);
  const frames = brief.gen === 'frames';
  const director = !frames && brief.mode === 'director';
  const length = director ? sumShots(brief.shots) : Math.min(M.maxLen, Math.max(M.minLen, Number(brief.length) || M.minLen));
  const aspect = brief.aspect || '';
  const settings = `MODEL: ${M.label} · LENGTH: ${fmtSec(length)}s${aspect ? ` · ASPECT RATIO: ${aspect}` : ''}`;
  const out = [];
  if (frames) {
    if (items.length) out.push(`START & END FRAMES — upload in this exact order:\n${items.map(manifestLine).join('\n')}`);
    out.push(`BRIEF MODE: START & END FRAMES — one continuous take from the first frame to the last.\n${settings}`);
    const motion = String(brief.motion || '').trim(), move = String(brief.move || '').trim();
    out.push(motion ? `WHAT HAPPENS BETWEEN THEM:\n${motion}` : 'WHAT HAPPENS BETWEEN THEM: read it from the two frames.');
    if (move) out.push(`CAMERA: ${move}`);
  } else {
    if (items.length) out.push(`ATTACHED REFERENCE FILES — upload in this exact order (OpenArt and Higgsfield number them @image1, @image2 …):\n${items.map(manifestLine).join('\n')}`);
    const loose = imagelessLines(brief);
    if (loose.length) out.push(`ALSO IN THE SCENE, WITHOUT A REFERENCE IMAGE:\n${loose.join('\n')}`);
    if (director) {
      out.push(`BRIEF MODE: DIRECTOR / DOP — keep my shot list exactly.\n${settings}`);
      if (String(brief.scene || '').trim()) out.push(`SCENE: ${brief.scene.trim()}`);
      const times = shotTimes(brief.shots);
      out.push(`SHOT LIST — ${brief.shots.length} shot${brief.shots.length === 1 ? '' : 's'}, ${fmtSec(length)}s:\n${brief.shots.map((s, i) => shotLine(s, i, times[i])).join('\n')}`);
    } else {
      out.push(`BRIEF MODE: CREATIVE — break the scene into shots yourself.\n${settings}`);
      out.push(`SCENE:\n${String(brief.creative || '').trim()}`);
    }
  }
  return {
    text: out.join('\n\n'),
    images: items.map(it => ({ ...it.img, label: roleLine(it), role: it.sec.kind, refName: String(it.block.name || '').trim() })),
    length, mode: director ? 'director' : 'creative', gen: frames ? 'frames' : 'refs', aspect, model: M.id,
  };
}

// Why the brief can't be sent yet ('' when it can).
export function validateBrief(brief, model = 'seedance-2.5') {
  const M = modelOf(model);
  const pickAspect = () => (SD_ASPECTS.includes(brief.aspect) && !M.aspects.includes(brief.aspect)
    ? `${M.label} renders ${M.aspects.join(', ')} — pick one of those.` : 'Choose an aspect ratio first.');
  if (brief.gen === 'frames') {
    if (!brief.frames?.start?.images.length) return 'Add the start frame first — it\'s @image1.';
    if (!brief.frames?.end?.images.length) return 'Add the end frame — it\'s @image2.';
    if (!M.aspects.includes(brief.aspect)) return pickAspect();
    return '';
  }
  if (!brief.blocks.find(b => b.kind === 'look')?.images.length) return 'Add the look first — ✦ Use project gem, or a look frame. It\'s always @image1.';
  const count = orderedImages(brief).length;
  if (count > M.maxImages) return `${M.label} takes up to ${M.maxImages} reference images — this brief has ${count}. Remove ${count - M.maxImages}${M.id === 'seedance-2.5' ? '' : ', or switch to Seedance 2.5'}.`;
  if (!M.aspects.includes(brief.aspect)) return pickAspect();
  if (brief.mode === 'director') {
    if (!brief.shots.length) return 'Add at least one shot.';
    if (!brief.shots.some(s => String(s.action || '').trim())) return 'Write what happens in at least one shot.';
    if (M.maxShots && brief.shots.length > M.maxShots) return `${M.label} fits at most ${M.maxShots} shots in one clip — remove ${brief.shots.length - M.maxShots}.`;
    if (M.minShot > SHOT_MIN && brief.shots.some(s => Number(s.len) < M.minShot)) return `${M.label} needs every shot to run at least ${M.minShot}s.`;
    const total = sumShots(brief.shots);
    if (total > M.maxLen) return `The shots run ${fmtSec(total)}s — ${M.label} takes up to ${M.maxLen}s. ${M.minShot > SHOT_MIN && brief.shots.length * M.minShot > M.maxLen ? 'Remove a shot.' : 'Shorten some shots.'}`;
    if (total < M.minLen) return `The shots run ${fmtSec(total)}s — ${M.label} needs at least ${M.minLen}s.`;
  } else if (!String(brief.creative || '').trim()) return 'Describe the scene first.';
  return '';
}

// The @word the caret sits in, if any: an @ at the start or after a space or bracket, then no spaces.
export function mentionAt(value, caret) {
  const m = /(?:^|[\s([{"'“«])@([^\s@]*)$/u.exec(String(value || '').slice(0, caret));
  return m ? { start: caret - m[1].length - 1, query: m[1] } : null;
}

// The @ menu's entries: each reference with a picture (picked, it writes its @image tag) or just
// a name (picked, it writes the name). Best matches first — a tag, name or section that starts
// with what's typed ("@image", "@3" and "@ma" all work; "@char" lists the characters), then one of
// its words that does ("@cole" → Maya Cole), then, from three letters on, anything containing it
// ("@room" → Showroom). Hebrew names match the same way.
export function mentionCandidates(brief, query = '') {
  const q = String(query || '').toLowerCase();
  const nums = new Map(orderedImages(brief).map(it => [it.img.id, it.n]));
  const frames = brief.gen === 'frames';
  const out = [];
  for (const sec of frames ? FRAME_SECS : SD_SECTIONS) {
    const blocks = frames ? [brief.frames?.[sec.kind]].filter(Boolean) : brief.blocks.filter(b => b.kind === sec.kind);
    blocks.forEach((b, i) => {
      const name = String(b.name || '').trim();
      if (!b.images.length && !name) return;
      const ns = b.images.map(img => nums.get(img.id)).filter(Boolean);
      out.push({
        tag: ns.length ? `image${ns[0]}` : '', insert: ns.length ? `@image${ns[0]}` : name, nums: ns,
        label: blockLabel(b, i + 1), kind: sec.kind, icon: sec.icon, one: sec.one, thumb: b.images[0]?.url || '', range: imageRange(ns),
      });
    });
  }
  if (!q) return out;
  const words = (s) => s.split(/[\s_\-–—&/]+/).filter(Boolean);
  const rank = (c) => {
    const num = /^(?:image)?(\d+)$/.exec(q);
    if (num) return c.nums.includes(Number(num[1])) ? 0 : 3;
    const fields = [c.tag, c.label, c.one].map(s => String(s).toLowerCase());
    if (fields.some(f => f && f.startsWith(q))) return 0;
    if (fields.some(f => words(f).some(w => w.startsWith(q)))) return 1;
    return q.length >= 3 && fields.some(f => f.includes(q)) ? 2 : 3;
  };
  return out.map(c => [c, rank(c)]).filter(([, r]) => r < 3).sort((a, b) => a[1] - b[1]).map(([c]) => c);
}

const SIZES = ['Extreme wide', 'Wide', 'Full shot', 'Medium wide', 'Medium', 'Medium close-up', 'Close-up', 'Extreme close-up', 'Insert / detail', 'Over-the-shoulder', 'POV', 'Two-shot'];
const LENSES = ['14mm ultra-wide', '18mm', '24mm', '28mm', '35mm', '40mm anamorphic', '50mm', '65mm', '85mm', '100mm macro', '135mm', '200mm tele'];
const MOVES = ['Locked-off', 'Slow push-in', 'Pull-out', 'Pan', 'Tilt', 'Dolly / track', 'Tracking', 'Handheld', 'Gimbal follow', 'Crane up', 'Crane down', 'Orbit', 'Whip pan', 'Rack focus', 'Drone / aerial', 'Snap zoom'];

// Drag payloads: a block thumbnail being moved, a project-drawer image, or a Library card.
const DRAG = { move: 'text/avs-sd-move', item: 'text/avs-sd-item', image: 'text/avs-image' };

export function createSeedance({ escapeHtml: esc, toast, state, mediaFetch, imgFileToB64, filesFromPaste, insertAtCursor, openLightbox, runTurn,
  briefKey = () => state.current?.id || '_' }) {
  let root = null;           // #sdMain while the tab is open — re-created on every visit
  let mountedKey = null;
  let busyKey = null;        // the brief (project + scene) whose prompt is being written
  let activeBid = null;      // the block a pasted image lands in (the last one touched)
  let lastField = null;      // the brief field an @image chip inserts into
  let pasteWired = false;
  const drawer = { open: false, target: null, tab: 'generated' };

  // One brief per project and scene (briefKey), kept in this browser's memory.
  const brief = () => {
    state.sdBriefs = state.sdBriefs || {};
    const k = briefKey();
    return state.sdBriefs[k] || (state.sdBriefs[k] = newBrief());
  };
  const modelId = () => normModel(state.videoModel);
  const model = () => modelOf(state.videoModel);
  const absUrl = (u) => { try { return new URL(u, location.href).href; } catch { return String(u || ''); } };
  const allBlocks = (b) => [...b.blocks, b.frames.start, b.frames.end];
  const findBlock = (bid) => allBlocks(brief()).find(b => b.id === bid) || null;
  const listFor = (target) => (target === 'inbox' ? brief().inbox : findBlock(target)?.images || null);
  const kindIndex = (block) => (brief().blocks.filter(b => b.kind === block.kind).indexOf(block) + 1) || 1;
  const labelOf = (block) => blockLabel(block, kindIndex(block));
  const lookBlock = () => brief().blocks.find(b => b.kind === 'look');
  function locate(iid) {
    const b = brief();
    for (const list of [b.inbox, ...allBlocks(b).map(x => x.images)]) {
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
  const shotMin = () => model().minShot || SHOT_MIN;

  // The project's own look frame — the one its ⚙ Tune analyzed (this tab's gem, else NB Frames').
  function projectLook() {
    const gb = state.current?.gemBuilders || {};
    const video = gb.seedance?.styleRef, frames = gb['nb-frames']?.styleRef;
    if (video?.url) return { url: video.url, from: 'the Video gem' };
    if (frames?.url) return { url: frames.url, from: 'NB Frames\' gem' };
    return null;
  }

  // ── render ────────────────────────────────────────────────────────────────────
  function render() {
    closeMention();   // its field is about to be replaced
    if (!root || !root.isConnected) return;
    const b = brief(), M = model();
    // a project whose video Tune sets a default ratio starts with it chosen
    const tuneAspect = state.current?.gemBuilders?.seedance?.aspectRatio;
    if (!b.aspect && b.gen !== 'frames' && M.aspects.includes(tuneAspect)) b.aspect = tuneAspect;
    const body = root.closest('.sd-body');
    if (body) { body.classList.toggle('step-assets', b.step !== 'prompt'); body.classList.toggle('step-prompt', b.step === 'prompt'); }
    const nums = new Map(orderedImages(b).map(it => [it.img.id, it.n]));
    root.innerHTML = stepsHtml(b, nums.size) + (b.step === 'prompt' ? promptHtml(b) : assetsHtml(b, nums));
  }

  function stepsHtml(b, count) {
    const M = model(), frames = b.gen === 'frames';
    const max = frames ? 2 : M.maxImages;
    return `<div class="sd-steps">
      <button class="sd-step${b.step !== 'prompt' ? ' active' : ''}" data-act="step" data-step="assets" type="button"><span class="sd-step-n">1</span>${frames ? 'Start & End' : 'References'}<em class="${count > max ? 'sd-over' : ''}">${count} / ${max} images</em></button>
      <span class="sd-step-line"></span>
      <button class="sd-step${b.step === 'prompt' ? ' active' : ''}" data-act="step" data-step="prompt" type="button"><span class="sd-step-n">2</span>Prompt<em>${frames ? 'Start → End' : b.mode === 'director' ? 'Director · DOP' : 'Creative'} · ${M.label}</em></button>
      <button class="mini-btn ghost sd-reset" data-act="reset" type="button" title="Clear every image and the brief for this scene">Reset</button>
    </div>`;
  }

  function thumbHtml(img, n) {
    return `<div class="sd-thumb" draggable="true" data-iid="${img.id}" title="${n ? `@image${n} · ` : ''}${esc(img.name || 'image')} — drag to move · click to enlarge">
      <img src="${esc(img.url)}" alt="" draggable="false" />${n ? `<span class="sd-n">${n}</span>` : ''}
      <button class="sd-x" data-act="rm-img" data-iid="${img.id}" type="button" title="Remove">✕</button>
    </div>`;
  }

  function blockHtml(blk, sec, idx, count, nums) {
    const tag = imageRange(blk.images.map(i => nums.get(i.id)).filter(Boolean));
    const cls = ['sd-block', blk.id === activeBid ? 'sd-active' : '', drawer.open && drawer.target === blk.id ? 'sd-target' : ''].filter(Boolean).join(' ');
    const frame = sec.kind === 'start' || sec.kind === 'end';
    return `<div class="${cls}" data-bid="${blk.id}" data-kind="${sec.kind}">
      <div class="sd-block-head">
        ${sec.multi ? `<input class="sd-name" dir="auto" data-field="name" data-bid="${blk.id}" placeholder="${esc(sec.namePh)}" value="${esc(blk.name)}" aria-label="${sec.one} ${idx} name" />`
          : frame ? `<b class="sd-block-title">${sec.icon} ${sec.title}</b>` : ''}
        <span class="sd-chip${tag ? '' : ' sd-chip-empty'}" title="Its tag in the prompt — OpenArt and Higgsfield number the uploads in this order">${tag || 'no image yet'}</span>
        ${sec.multi && count > 1 ? `<button class="sd-x" data-act="rm-block" data-bid="${blk.id}" type="button" title="Remove this ${sec.one.toLowerCase()}">✕</button>` : ''}
      </div>
      <div class="sd-drop" data-drop="${blk.id}">
        ${blk.images.map(img => thumbHtml(img, nums.get(img.id))).join('')}
        <div class="sd-add">
          ${sec.kind === 'look' ? '<button class="sd-add-btn sd-gem" data-act="use-gem" type="button" title="Use the look frame from this project\'s ⚙ Tune — no upload needed">✦ Use project gem</button>' : ''}
          <button class="sd-add-btn" data-act="upload" data-bid="${blk.id}" type="button">⬆ Upload</button>
          <button class="sd-add-btn" data-act="from-project" data-bid="${blk.id}" type="button">🖼 From project</button>
        </div>
        ${blk.images.length ? (sec.single ? '<span class="sd-drop-hint">drop to replace</span>' : '') : `<span class="sd-drop-hint">or drop · paste ${sec.single ? 'the image' : 'images'} here</span>`}
        <input type="file" accept="image/*"${sec.single ? '' : ' multiple'} hidden data-file="${blk.id}" />
      </div>
      ${sec.notePh ? `<input class="sd-note" dir="auto" data-field="note" data-bid="${blk.id}" placeholder="${esc(sec.notePh)}" value="${esc(blk.note)}" aria-label="${sec.one} ${idx} note" />` : ''}
    </div>`;
  }

  function assetsHtml(b, nums) {
    const M = model(), frames = b.gen === 'frames';
    const count = nums.size, max = frames ? 2 : M.maxImages;
    const gen = `<div class="sd-gen">
        <div class="mode-toggle" role="group" aria-label="Generation mode">
          <button class="seg${frames ? '' : ' active'}" data-act="gen" data-gen="refs" type="button">🧩 References</button>
          <button class="seg${frames ? ' active' : ''}" data-act="gen" data-gen="frames" type="button">🎞 Start &amp; End frame</button>
        </div>
        <span class="sd-gen-hint">${frames ? 'The frame the clip opens on (@image1) and the one it lands on (@image2) — the prompt writes the journey between them.'
          : 'The look is always @image1, then the location, the characters and the props — the order you upload them in, and the @image tag each one gets.'}</span>
      </div>`;
    const inbox = b.inbox.length ? `<div class="sd-inbox">
        <div class="sd-inbox-head"><b>📥 Unsorted · ${b.inbox.length}</b><span>Drag each image into its ${frames ? 'slot' : 'section'} — unsorted images aren't sent.</span></div>
        <div class="sd-drop" data-drop="inbox">${b.inbox.map(img => thumbHtml(img, 0)).join('')}</div>
      </div>` : '';
    const sections = frames
      ? `<section class="sd-sec sd-frames" data-kind="frames">
          <div class="sd-sec-head"><h4>🎞 Start &amp; End frame</h4><span class="sd-sec-hint">One continuous take from the first frame to the last. Both are required.</span></div>
          <div class="sd-blocks sd-frame-blocks">${FRAME_SECS.map(sec => blockHtml(b.frames[sec.kind], sec, 1, 1, nums)).join('')}</div>
        </section>`
      : SD_SECTIONS.map(sec => {
        const blocks = b.blocks.filter(x => x.kind === sec.kind);
        return `<section class="sd-sec" data-kind="${sec.kind}">
          <div class="sd-sec-head"><h4>${sec.icon} ${sec.title}</h4>${sec.kind === 'look' ? '<span class="sd-req">required · @image1</span>' : ''}<span class="sd-sec-hint">${sec.hint}</span>
            ${sec.multi ? `<button class="mini-btn" data-act="add-block" data-kind="${sec.kind}" type="button">＋ ${sec.add}</button>` : ''}</div>
          <div class="sd-blocks">${blocks.map((blk, i) => blockHtml(blk, sec, i + 1, blocks.length, nums)).join('')}</div>
        </section>`;
      }).join('');
    return `<div class="sd-assets${drawer.open ? ' with-drawer' : ''}">
      <div class="sd-sections">${gen}${inbox}${sections}
        <div class="sd-foot">
          <span class="sd-count${count > max ? ' sd-over' : ''}">${count} / ${max} images${frames ? '' : ` for ${M.label}`} · uploaded in this order as @image1${count > 1 ? `–@image${count}` : ''}</span>
          <button class="generate-btn sd-next" data-act="step" data-step="prompt" type="button">Next: write the prompt →</button>
        </div>
      </div>
      ${drawer.open ? drawerHtml() : ''}
    </div>`;
  }

  function drawerItems(tab) {
    const pid = state.current?.id;
    if (tab === 'assets') return (state.current?.characters || []).filter(c => c.reference?.file).map(c => {
      const tag = assetTag(c);
      return { url: `/media/${pid}/images/${c.reference.file}`, name: c.name, title: `${c.name} · @${tag}`, asset: { tag, type: c.type || 'character', name: c.name } };
    });
    if (tab === 'refs') return (state.current?.references || []).map(r => ({ url: r.url, name: r.file, title: 'Kept reference' }));
    return (state.current?.images || []).map(im => ({ url: `/media/${pid}/images/${im.file}`, name: im.title || im.file, title: im.title || im.prompt || '' }));
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
    const frames = b.gen === 'frames';
    const list = items.map(it => `<li class="sd-rail-item" data-kind="${it.sec.kind}">
        <span class="sd-rail-n">${it.n}</span>
        <img src="${esc(it.img.url)}" alt="" data-act="view" data-iid="${it.img.id}" title="Click to enlarge" />
        <span class="sd-rail-meta"><b dir="auto">${it.sec.icon} ${esc(blockLabel(it.block, it.blockIndex))}</b><small>${it.of > 1 ? `view ${it.k} of ${it.of}` : it.sec.railNote || it.sec.one}</small></span>
        <button class="sd-chip" data-act="tag" data-tag="image${it.n}" type="button" title="Insert @image${it.n} into the brief">@image${it.n}</button>
      </li>`).join('');
    const loose = b.inbox.length;
    const noLook = !frames && !lookBlock()?.images.length;
    const missing = frames ? FRAME_SECS.filter(s => !b.frames[s.kind].images.length).map(s => s.title.toLowerCase()) : [];
    return `<aside class="sd-rail">
      <div class="sd-rail-head"><span class="field-label">Upload order</span><button class="mini-btn" data-act="step" data-step="assets" type="button">✎ Edit</button></div>
      ${noLook ? '<p class="sd-warn">No look yet — it\'s required, and it\'s @image1. <button class="mini-btn sd-gem" data-act="use-gem" type="button">✦ Use project gem</button></p>' : ''}
      ${missing.length ? `<p class="sd-warn">Add the ${missing.join(' and the ')} in ① Start &amp; End.</p>` : ''}
      ${items.length ? `<ol class="sd-rail-list">${list}</ol>` : (frames ? '' : '<p class="sd-rail-empty">No reference images yet.</p>')}
      ${loose ? `<p class="sd-warn">${loose} unsorted image${loose === 1 ? '' : 's'} won't be sent — sort ${loose === 1 ? 'it' : 'them'} in ① ${frames ? 'Start &amp; End' : 'References'}.</p>` : ''}
      ${items.length ? '<button class="mini-btn sd-dl" data-act="download" type="button" title="Download every image, numbered in upload order, ready for OpenArt or Higgsfield">⬇ Download in order</button>' : ''}
    </aside>`;
  }

  function shotHtml(s, i, n, t, M) {
    return `<div class="sd-shot" data-sid="${s.id}">
      <div class="sd-shot-head">
        <b class="sd-shot-n">Shot ${i + 1}</b>
        <span class="sd-shot-time" data-time="${s.id}">${fmtSec(t.start)}–${fmtSec(t.end)}s</span>
        <input type="range" class="sd-range sd-shot-len" data-shot-len="${s.id}" min="${M.minShot || SHOT_MIN}" max="${M.maxLen}" step="${SHOT_STEP}" value="${s.len}" aria-label="Shot ${i + 1} length in seconds" />
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
      <textarea class="sd-text sd-action" dir="auto" data-shot="${s.id}" data-k="action" rows="2" placeholder="What happens in this shot — action, performance, light… Type @ to point at a reference.">${esc(s.action)}</textarea>
    </div>`;
  }

  // The model toggle sits right before the button that writes the prompt.
  function launchHtml() {
    const id = modelId(), M = model();
    return `<div class="sd-launch">
      <span class="field-label">Write it for</span>
      <div class="mode-toggle sd-models" role="group" aria-label="Model">${MODEL_IDS.map(m => `<button class="seg${m === id ? ' active' : ''}" data-act="model" data-model="${m}" type="button">${VIDEO_MODELS[m].label}</button>`).join('')}</div>
      <span class="sd-model-note">${M.note}</span>
    </div>`;
  }

  function promptHtml(b) {
    const M = model(), frames = b.gen === 'frames';
    const director = !frames && b.mode === 'director';
    const total = director ? sumShots(b.shots) : b.length;
    const minTotal = director ? Math.max(M.minLen, b.shots.length * shotMin()) : M.minLen;
    const dl = (id, opts) => `<datalist id="${id}">${opts.map(o => `<option value="${esc(o)}"></option>`).join('')}</datalist>`;
    const times = shotTimes(b.shots);
    const editor = frames
      ? `<textarea class="sd-text" dir="auto" data-field="motion" placeholder="What happens between the start and the end frame — the action, how the camera travels, how it should feel. Leave it empty and the gem reads the journey from the two frames. Type @ to point at a frame.">${esc(b.motion)}</textarea>
        <label class="sd-move"><span class="field-label">Camera move — optional</span><input list="sdMoves" data-field="move" placeholder="e.g. Slow push-in" value="${esc(b.move)}" /></label>
        ${dl('sdMoves', MOVES)}`
      : director
        ? `<textarea class="sd-text sd-scene" dir="auto" data-field="scene" rows="2" placeholder="Scene context (optional) — where we are, the mood, what the sequence is about…">${esc(b.scene)}</textarea>
          <div class="sd-shots">${b.shots.map((s, i) => shotHtml(s, i, b.shots.length, times[i], M)).join('')}</div>
          <button class="mini-btn sd-add-shot" data-act="add-shot" type="button">＋ Add shot</button>
          ${dl('sdSizes', SIZES)}${dl('sdLenses', LENSES)}${dl('sdMoves', MOVES)}`
        : `<textarea class="sd-text" dir="auto" data-field="creative" placeholder="Describe the scene — who's in it, where, what happens, how it should feel. The gem breaks it into shots, lenses and camera moves. Click an @image tag on the left, or type @, to point at a reference.">${esc(b.creative)}</textarea>`;
    const busy = busyKey === briefKey();
    const aspects = M.aspects.map(v => `<option value="${v}"${b.aspect === v ? ' selected' : ''}>${ASPECT_LABELS[v] || v}</option>`).join('');
    return `<div class="sd-prompt">
      ${railHtml(b)}
      <div class="sd-brief">
        <div class="sd-brief-head">
          ${frames ? '<span class="sd-mode-hint">🎞 Start &amp; End — describe the journey from the first frame to the last. The frames themselves are locked: the clip opens on @image1 and lands on @image2.</span>'
            : `<div class="mode-toggle" role="group" aria-label="Brief mode">
            <button class="seg${director ? ' active' : ''}" data-act="mode" data-mode="director" type="button">🎬 Director · DOP</button>
            <button class="seg${director ? '' : ' active'}" data-act="mode" data-mode="creative" type="button">✨ Creative</button>
          </div>
          <span class="sd-mode-hint">${director ? 'Number the shots — size, lens, move and length for each. The gem keeps them exactly.' : 'Describe the scene and what we see — the gem breaks it into shots, lenses and moves.'}</span>`}
        </div>
        ${editor}
        <div class="sd-settings">
          <label class="sd-len"><span class="field-label">Film length</span>
            <span class="sd-len-row"><input type="range" class="sd-range" data-len="total" min="${minTotal}" max="${M.maxLen}" step="${director ? SHOT_STEP : 1}" value="${total}" aria-label="Film length in seconds" /><output class="sd-len-out">${fmtSec(total)}s</output></span>
          </label>
          <label class="sd-aspect"><span class="field-label">Aspect ratio *</span><select data-field="aspect" required aria-required="true">
            <option value="" disabled${M.aspects.includes(b.aspect) ? '' : ' selected'}>Choose…</option>${aspects}</select></label>
        </div>
        <p class="sd-len-note">${director ? 'The sum of the shots — drag it to stretch or tighten them all at once. ' : ''}${frames ? 'The aspect follows the start frame (OpenArt and Kling lock it to it). ' : ''}Up to ${M.maxLen}s on ${M.label}${M.minShot > SHOT_MIN && director ? `, every shot ${M.minShot}s or more` : ''}.</p>
        ${launchHtml()}
        <button class="generate-btn sd-generate" id="sdGenerate" data-act="generate" type="button"${busy ? ' disabled' : ''}>${busy ? '<span class="spinner"></span>Writing the prompt…' : `Generate ${M.label} prompt`}</button>
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
  // The look and each frame hold one image: a new one replaces it.
  function makeRoom(target, list) {
    const blk = target === 'inbox' ? null : findBlock(target);
    if (blk && secOf(blk.kind).single && list.length) { list.splice(0, list.length); return secOf(blk.kind).title; }
    return '';
  }
  async function addFiles(target, files) {
    const list = listFor(target);
    if (!list) return 0;
    let imgs = files.filter(f => (f.type || '').startsWith('image/'));
    if (!imgs.length) { toast('Only image files can be added.', true); return 0; }
    const blk = target === 'inbox' ? null : findBlock(target);
    if (blk && secOf(blk.kind).single) imgs = imgs.slice(0, 1);
    let n = 0, replaced = '';
    for (const f of imgs) {
      try {
        const img = { id: sdId(), name: f.name || 'pasted image', mimeType: 'image/jpeg', data: await imgFileToB64(f), url: URL.createObjectURL(f), src: 'upload' };
        replaced = makeRoom(target, list) || replaced;
        list.push(img);
        n++;
      } catch (e) { toast(e.message || 'Could not read that image.', true); }
    }
    if (target !== 'inbox') activeBid = target;
    if (replaced) toast(`${replaced} replaced.`);
    if (n && blk?.kind === 'start') readFrameShape(list[0].url);
    render();
    return n;
  }

  async function addUrl(target, item) {
    const list = listFor(target);
    if (!list || !item?.url) return false;
    const url = absUrl(item.url);
    if (list.some(x => absUrl(x.url) === url)) { toast(target === 'inbox' ? 'Already waiting in Unsorted.' : 'Already in this block.'); return false; }
    let img;
    try {
      const blob = await (await mediaFetch(url)).blob();
      if (!(blob.type || '').startsWith('image/')) throw new Error('not an image');
      img = { id: sdId(), name: item.name || url.split('/').pop(), mimeType: 'image/jpeg', data: await imgFileToB64(blob), url, src: item.asset ? 'asset' : 'project', asset: item.asset || null };
    } catch { toast('Could not add that image.', true); return false; }
    const replaced = makeRoom(target, list);
    list.push(img);
    const blk = target === 'inbox' ? null : findBlock(target);
    // An asset dropped into an unnamed block names it.
    if (blk && item.asset && secOf(blk.kind).multi && !blk.name.trim()) { blk.name = item.asset.name; blk.tag = item.asset.tag; }
    if (blk) activeBid = blk.id;
    if (replaced) toast(`${replaced} replaced.`);
    if (blk?.kind === 'start') readFrameShape(url);
    render();
    return true;
  }

  // A start frame sets the clip's shape: OpenArt and Kling lock the ratio to the first frame.
  function readFrameShape(url) {
    const probe = new Image();
    probe.onload = () => {
      const b = brief();
      if (b.frames.start.images[0]?.url !== url) return;   // replaced meanwhile
      b.frameWH = [probe.naturalWidth, probe.naturalHeight];
      const a = nearestAspect(probe.naturalWidth, probe.naturalHeight, model().aspects);
      if (a && a !== b.aspect) { b.aspect = a; toast(`Aspect ratio set to ${a}, from the start frame.`); render(); }
    };
    probe.src = url;
  }

  function moveImage(iid, target, beforeIid) {
    if (!iid || iid === beforeIid) return;
    const from = locate(iid), to = listFor(target);
    if (!from || !to || from.list === to && to.length === 1) return;
    const [img] = from.list.splice(from.i, 1);
    // A one-image slot that's taken (the look, a frame): the image already there swaps into the
    // moved one's place — start ⇄ end, say — or, from a bigger list, steps aside to Unsorted.
    const blk = target === 'inbox' ? null : findBlock(target);
    if (blk && secOf(blk.kind).single && to.length) {
      const old = to.splice(0, to.length);
      const fromBlk = allBlocks(brief()).find(x => x.images === from.list);
      (fromBlk && secOf(fromBlk.kind).single ? from.list : brief().inbox).push(...old);
    }
    let at = beforeIid ? to.findIndex(x => x.id === beforeIid) : -1;
    if (at < 0) at = to.length;
    to.splice(at, 0, img);
    if (target !== 'inbox') activeBid = target;
    const start = brief().frames.start.images[0];
    if (start && (blk?.kind === 'start' || from.list === brief().frames.start.images)) readFrameShape(start.url);
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
        const what = tagSlug(it.block.name) || it.sec.kind;
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = `${String(it.n).padStart(2, '0')}-image${it.n}-${what}${it.of > 1 ? `-${it.k}` : ''}.${ext}`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 15000);
        n++;
        await new Promise(r => setTimeout(r, 200));   // browsers drop downloads fired back to back
      } catch { /* skip one that can't be fetched */ }
    }
    btn.disabled = false;
    toast(n ? `Downloaded ${n} image${n === 1 ? '' : 's'}, numbered in upload order.` : 'Nothing could be downloaded.', !n);
  }

  async function useProjectGem() {
    const pl = projectLook();
    if (!pl) { toast('This project\'s gem has no look frame yet — open ⚙ Tune gem above, attach a graded look frame and Analyze it. Or upload a look frame here.', true); return false; }
    const look = lookBlock();
    if (look.images.some(i => absUrl(i.url) === absUrl(pl.url))) { toast('The project gem\'s look is already @image1.'); return true; }
    const ok = await addUrl(look.id, { url: pl.url, name: `Project look (from ${pl.from})` });
    if (ok) toast(`The look from ${pl.from} is @image1.`);
    return ok;
  }

  // ── the brief ────────────────────────────────────────────────────────────────
  function setMode(mode) {
    const b = brief(), M = model();
    if (b.mode === mode) return;
    if (mode === 'director') {
      if (!b.shots.length) b.shots = [newShot(Math.max(3, shotMin())), newShot(Math.max(3, shotMin())), newShot(Math.max(3, shotMin()))];
      setShotLens(b, rescaleShots(b.shots.map(s => s.len), Math.min(M.maxLen, Math.max(M.minLen, b.length)), { min: shotMin() }));
    }
    b.mode = mode;
    render();
  }

  function setGen(gen) {
    const b = brief();
    if (b.gen === gen) return;
    b.gen = gen;
    drawer.open = false; activeBid = null;
    // a start frame already in place sets the shape again
    if (gen === 'frames' && b.frameWH) b.aspect = nearestAspect(b.frameWH[0], b.frameWH[1], model().aspects) || b.aspect;
    render();
  }

  // The model fits the brief to what it takes — length, shot floor, frame shapes — and says so.
  function setModel(id) {
    const next = normModel(id);
    if (next === modelId()) return;
    state.videoModel = next;
    const M = modelOf(next);
    try { localStorage.setItem('avs:videoModel', next); } catch {}
    if (M.version) state.seedanceVersion = M.version;   // older calls still read it
    const b = brief(), notes = [];
    if (b.shots.length) {
      const total = sumShots(b.shots);
      const fit = Math.min(M.maxLen, Math.max(M.minLen, total));
      if (fit !== total || b.shots.some(s => s.len < (M.minShot || SHOT_MIN))) {
        setShotLens(b, rescaleShots(b.shots.map(s => s.len), fit, { min: M.minShot || SHOT_MIN }));
        if (b.mode === 'director') notes.push(`shots fitted to ${fmtSec(sumShots(b.shots))}s`);
      }
    }
    if (b.mode !== 'director' || !b.shots.length) b.length = Math.min(M.maxLen, Math.max(M.minLen, b.length));
    if (b.aspect && !M.aspects.includes(b.aspect)) {
      const wh = b.gen === 'frames' && b.frameWH;
      b.aspect = wh ? nearestAspect(wh[0], wh[1], M.aspects) : '';
      notes.push(b.aspect ? `aspect ${b.aspect}` : `pick an aspect it renders (${M.aspects.join(', ')})`);
    }
    const count = orderedImages(b).length;
    if (b.gen !== 'frames' && count > M.maxImages) notes.push(`it takes ${M.maxImages} reference images — this brief has ${count}`);
    if (b.mode === 'director' && M.maxShots && b.shots.length > M.maxShots) notes.push(`it fits ${M.maxShots} shots — this list has ${b.shots.length}`);
    render();
    if (notes.length) toast(`${M.label}: ${notes.join(' · ')}.`, count > M.maxImages);
  }

  function addShot() {
    const b = brief(), M = model(), min = shotMin();
    if ((M.maxShots && b.shots.length >= M.maxShots) || (b.shots.length + 1) * min > M.maxLen) {
      toast(`${M.label} fits ${M.maxShots && M.maxShots * min <= M.maxLen ? M.maxShots : Math.floor(M.maxLen / min)} shots of ${min}s or more in ${M.maxLen}s.`, true);
      return;
    }
    const s = newShot(Math.max(3, min));
    b.shots.push(s);
    if (sumShots(b.shots) > M.maxLen) { setShotLens(b, rescaleShots(b.shots.map(x => x.len), M.maxLen, { min })); toast(`Tightened the shots to fit ${M.maxLen}s.`); }
    b.length = sumShots(b.shots);
    render();
    root?.querySelector(`[data-shot="${s.id}"][data-k="action"]`)?.focus();
  }

  function removeShot(sid) {
    const b = brief(), M = model();
    const i = b.shots.findIndex(s => s.id === sid);
    if (i < 0 || b.shots.length <= 1) return;
    const s = b.shots[i];
    if ([s.action, s.size, s.lens, s.move].some(x => String(x || '').trim()) && !confirm(`Remove shot ${i + 1}?`)) return;
    b.shots.splice(i, 1);
    if (sumShots(b.shots) < M.minLen) setShotLens(b, rescaleShots(b.shots.map(x => x.len), M.minLen, { min: shotMin() }));
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
    const el = (lastField && lastField.isConnected) ? lastField : root?.querySelector('textarea[data-field="creative"], textarea[data-field="motion"], textarea.sd-action');
    if (!el) return;
    el.focus();
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    insertAtCursor(el, `${before && !/\s$/.test(before) ? ' ' : ''}@${tag} `);
    onInput({ target: el });   // insertAtCursor's input event doesn't bubble up to the delegate
  }

  async function generate() {
    const pid = state.current?.id;
    if (!pid || busyKey) return;
    const b = brief(), id = modelId(), M = model();
    const err = validateBrief(b, id);
    if (err) {
      toast(err, true);
      if (!M.aspects.includes(b.aspect)) {   // point at the field that's missing
        const sel = root.querySelector('select[data-field="aspect"]');
        sel?.closest('.sd-aspect')?.classList.add('sd-missing');
        sel?.focus();
      }
      return;
    }
    if (!state.config?.hasAnthropic) { toast('Add your ANTHROPIC_API_KEY to .env first.', true); return; }
    const c = composeBrief(b, { model: id });
    busyKey = briefKey();
    render();
    let ok = false;
    try {
      ok = await runTurn({
        sendText: c.text, history: [],   // every brief is a fresh scene
        images: c.images.map(i => ({ mimeType: i.mimeType, data: i.data, label: i.label, role: i.role, refName: i.refName })),
        extra: { seedanceMode: c.mode, seedanceLength: c.length, seedanceAspect: c.aspect, videoModel: c.model, videoGen: c.gen },
      });
    } finally {
      busyKey = null;
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
        if (!confirm('Clear every image and the whole brief for this scene?')) return;
        state.sdBriefs[briefKey()] = newBrief();
        drawer.open = false; activeBid = null;
        return render();
      case 'gen': return setGen(btn.dataset.gen);
      case 'model': return setModel(btn.dataset.model);
      case 'use-gem': btn.disabled = true; await useProjectGem(); btn.disabled = false; return;
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
    const t = e.target, b = brief(), M = model();
    if (t.dataset.len === 'total') {
      const v = Number(t.value);
      if (b.mode === 'director' && b.gen !== 'frames') { setShotLens(b, rescaleShots(b.shots.map(s => s.len), v, { min: shotMin() })); syncShotsDom(); }
      else { b.length = Math.min(M.maxLen, Math.max(M.minLen, v)); const out = root.querySelector('.sd-len-out'); if (out) out.textContent = `${fmtSec(b.length)}s`; }
      return;
    }
    if (t.dataset.shotLen) {
      const i = b.shots.findIndex(s => s.id === t.dataset.shotLen);
      if (i < 0) return;
      b.shots[i].len = clampShotLen(b.shots.map(s => s.len), i, Number(t.value), { maxTotal: M.maxLen, minTotal: M.minLen, min: shotMin() });
      b.length = sumShots(b.shots);
      syncShotsDom();
      return;
    }
    const f = t.dataset.field;
    if (['creative', 'scene', 'motion', 'move'].includes(f)) { b[f] = t.value; return; }
    if ((f === 'name' || f === 'note') && t.dataset.bid) {
      const blk = findBlock(t.dataset.bid);
      if (blk) { blk[f] = t.value; if (f === 'name') blk.tag = ''; }   // a hand-typed name takes over from an asset's tag
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
    if (t.dataset.field === 'aspect') { brief().aspect = t.value; t.closest('.sd-aspect')?.classList.remove('sd-missing'); }
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
    if (types.includes('Files') && !types.includes(DRAG.image)) {
      const n = await addFiles(target || 'inbox', [...(e.dataTransfer.files || [])]);
      if (n && !target) toast(`Added to Unsorted — drag ${n === 1 ? 'it' : 'them'} into a ${brief().gen === 'frames' ? 'slot' : 'section'}.`);
      return;
    }
    const raw = e.dataTransfer.getData(DRAG.item);
    const item = raw ? JSON.parse(decodeURIComponent(raw)) : { url: e.dataTransfer.getData(DRAG.image) };
    const ok = await addUrl(target || 'inbox', item);
    if (ok && !target) toast(`Added to Unsorted — drag it into a ${brief().gen === 'frames' ? 'slot' : 'section'}.`);
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
      if (n) toast(target === 'inbox' ? `Pasted into Unsorted — drag ${n === 1 ? 'it' : 'them'} into place.` : `Pasted into ${labelOf(findBlock(target))}.`);
    });
  }

  // ── the @ menu ───────────────────────────────────────────────────────────────
  // Typing @ in a brief field or the follow-up box lists this brief's references; picking one
  // writes its @image tag (or the name of one without an image), so the gem knows exactly which
  // file a line is about.
  const MENTION_FIELDS = 'textarea.sd-text, #chatInput';
  let mention = null;   // { el, box, start, items, index } while the menu is open
  let mentionWired = false;

  function closeMention() { if (mention) { mention.box.remove(); mention = null; } }

  // Where the caret sits on screen: a hidden copy of the field, laid out the same, up to the caret.
  function caretPoint(el, pos) {
    const cs = getComputedStyle(el);
    const mirror = document.createElement('div');
    for (const p of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
      'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
      'textTransform', 'wordSpacing', 'textIndent', 'direction', 'tabSize']) mirror.style[p] = cs[p];
    Object.assign(mirror.style, { position: 'fixed', top: '0', left: '0', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', borderStyle: 'solid' });
    mirror.textContent = el.value.slice(0, pos);
    const mark = mirror.appendChild(document.createElement('span'));
    mark.textContent = '@';
    document.body.appendChild(mirror);
    const r = el.getBoundingClientRect();
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const x = r.left + mark.offsetLeft - el.scrollLeft;
    const top = r.top + mark.offsetTop - el.scrollTop;
    mirror.remove();
    return { x, top, bottom: top + line };
  }

  function paintMention() {
    const m = mention;
    m.box.innerHTML = m.items.length
      ? `<div class="sd-mention-head">References · ↑↓ · Enter</div>${m.items.map((it, i) => `
        <button class="sd-mention-item${i === m.index ? ' active' : ''}" data-kind="${it.kind}" data-i="${i}" type="button" role="option" aria-selected="${i === m.index}">
          ${it.thumb ? `<img src="${esc(it.thumb)}" alt="" />` : `<span class="sd-mention-ph">${it.icon}</span>`}
          <span class="sd-mention-main"><b dir="auto">${esc(it.range || it.label)}</b><small dir="auto">${it.icon} ${esc(it.range ? it.label : `${it.one} · no image`)}</small></span>
        </button>`).join('')}`
      : `<div class="sd-mention-empty">No references yet — add them in ① ${brief().gen === 'frames' ? 'Start &amp; End' : 'References'}.</div>`;
    // below the caret's line, or above it when the field sits low (the follow-up box)
    const p = caretPoint(m.el, m.start);
    const w = m.box.offsetWidth, h = m.box.offsetHeight;
    m.box.style.left = `${Math.max(8, Math.min(p.x, innerWidth - w - 8))}px`;
    m.box.style.top = `${p.bottom + 4 + h > innerHeight - 8 ? Math.max(8, p.top - h - 4) : p.bottom + 4}px`;
    m.box.querySelector('.sd-mention-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  function onMentionInput(e) {
    const el = e.target;
    if (!el.matches?.(MENTION_FIELDS)) return;
    const at = mentionAt(el.value, el.selectionStart ?? el.value.length);
    const b = brief();
    const items = at ? mentionCandidates(b, at.query) : [];
    const noRefs = !orderedImages(b).length && !b.blocks.some(x => String(x.name || '').trim());
    if (!at || (!items.length && !(noRefs && !at.query))) { closeMention(); return; }
    if (!mention || mention.el !== el) {
      closeMention();
      const box = document.createElement('div');
      box.className = 'sd-mention';
      box.setAttribute('role', 'listbox');
      // mousedown, not click: picking must not take the focus away from the field
      box.addEventListener('mousedown', (ev) => { ev.preventDefault(); const it = ev.target.closest('.sd-mention-item'); if (it) pickMention(+it.dataset.i); });
      document.body.appendChild(box);
      mention = { el, box, index: 0 };
    }
    Object.assign(mention, { start: at.start, items, index: Math.min(mention.index, Math.max(0, items.length - 1)) });
    paintMention();
  }

  function onMentionKey(e) {
    const m = mention;
    if (!m || e.target !== m.el) return;
    const n = m.items.length;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
      m.index = (m.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      paintMention();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && n) pickMention(m.index);
    else if (e.key === 'Escape') closeMention();
    else return;
    e.preventDefault();
    e.stopPropagation();   // the follow-up box sends on Enter — not while the menu is open
  }

  function pickMention(i) {
    const m = mention, item = m?.items[i];
    if (!item) return;
    const el = m.el, end = el.selectionStart ?? el.value.length;
    const text = `${item.insert} `;
    el.value = el.value.slice(0, m.start) + text + el.value.slice(end);
    el.setSelectionRange(m.start + text.length, m.start + text.length);
    closeMention();
    if (root?.contains(el)) onInput({ target: el });   // a brief field: keep the brief in step
    else el.dispatchEvent(new Event('input'));          // the follow-up box: let it resize
    el.focus();
  }

  function wireMentions(panel) {
    panel.addEventListener('input', onMentionInput);
    panel.addEventListener('keydown', onMentionKey, true);   // capture: ahead of the field's own Enter
    panel.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) onMentionInput(e); });
    panel.addEventListener('click', (e) => { if (e.target.matches?.(MENTION_FIELDS)) onMentionInput(e); });
    panel.addEventListener('focusout', (e) => { if (mention && e.target === mention.el) closeMention(); });
    panel.addEventListener('scroll', () => { if (mention) paintMention(); }, true);   // follow the caret
    if (!mentionWired) {   // a click anywhere else closes it — even after the tab is gone
      mentionWired = true;
      document.addEventListener('mousedown', (e) => { if (mention && !mention.box.contains(e.target) && e.target !== mention.el) closeMention(); });
    }
  }

  // ── public ───────────────────────────────────────────────────────────────────
  function mount(el) {
    root = el;
    if (mountedKey !== briefKey()) { mountedKey = briefKey(); drawer.open = false; activeBid = null; lastField = null; }
    wirePaste();
    const panel = el.closest('.sd-panel');
    if (panel) wireMentions(panel);
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

  const refresh = () => render();

  // From the Assets tab: the sheet goes to its type's section — a character into its own block, a
  // look into the look (replacing one that's there). A finished frame has no section: in Start &
  // End mode it fills the first empty frame slot, otherwise it waits in Unsorted. Anything else
  // switches a Start & End brief back to References, where it belongs.
  async function addAsset(char) {
    const b = brief();
    b.step = 'assets';
    const tag = assetTag(char);
    const url = absUrl(`/media/${state.current.id}/images/${char.reference.file}`);
    const holder = allBlocks(b).find(x => x.images.some(i => absUrl(i.url) === url));
    if (holder && (holder.kind === 'start' || holder.kind === 'end' ? b.gen === 'frames' : b.gen !== 'frames')) {
      activeBid = holder.id;
      return { status: 'exists', section: labelOf(holder) };
    }
    if (!ASSET_KIND[char.type || 'character']) {
      if (b.gen === 'frames') {
        const slot = FRAME_SECS.map(s => b.frames[s.kind]).find(x => !x.images.length);
        if (slot) { const ok = await addUrl(slot.id, { url, name: char.name }); return { status: ok ? 'added' : 'failed', section: secOf(slot.kind).title }; }
      }
      if (b.inbox.some(i => absUrl(i.url) === url)) return { status: 'exists', section: 'Unsorted' };
      const ok = await addUrl('inbox', { url, name: `${char.name} (@${tag})` });
      return { status: ok ? 'added' : 'failed', section: 'Unsorted' };
    }
    const switched = b.gen === 'frames';
    b.gen = 'refs';
    const kind = ASSET_KIND[char.type || 'character'];
    let blk = secOf(kind).multi ? b.blocks.find(x => x.kind === kind && !x.images.length && !x.name.trim()) : b.blocks.find(x => x.kind === kind);
    if (!blk) blk = insertBlock(kind);
    const ok = await addUrl(blk.id, { url, name: char.name, asset: { tag, type: char.type || 'character', name: char.name } });
    return { status: ok ? 'added' : 'failed', section: secOf(kind).title, switched };
  }

  // From an image card dropped on the tab button: it waits in Unsorted until sorted.
  function addToInbox(url) {
    brief().step = 'assets';
    return addUrl('inbox', { url });
  }

  // A follow-up keeps the brief's model and modes, so a revised prompt keeps its format.
  const followupExtra = () => ({ seedanceMode: brief().mode, videoModel: modelId(), videoGen: brief().gen });

  return { mount, refresh, addAsset, addToInbox, followupExtra };
}
