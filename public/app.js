// ── AI Video Studio — frontend ────────────────────────────────────────────────
import { createCrm } from './crm.js?v=1';
import { createSeedance, assetTag } from './seedance.js?v=3';
import { createRefBoard } from './refboard.js?v=1';
import { createScenes, GENERAL, chatKey as sceneChatKey, imageScene, sortScenes } from './scenes.js?v=1';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Auth: when Google sign-in is on, every request carries the current user's Firebase
// ID token. _firebaseAuth is set by initAuth(); it stays null in open (local) mode,
// so authHeader() is a no-op and nothing changes for local development.
let _firebaseAuth = null;
let _fs = null, _fsApi = null;   // Firestore + { collection, doc, onSnapshot } — set in initAuth, used for live sync
async function authHeader() {
  const u = _firebaseAuth?.currentUser;
  if (!u) return {};
  try { return { Authorization: `Bearer ${await u.getIdToken()}` }; } catch { return {}; }
}
// fetch() that carries the auth token — for non-JSON requests (image/media blobs).
async function mediaFetch(url, opts = {}) {
  return fetch(url, { ...opts, headers: { ...(await authHeader()), ...(opts.headers || {}) } });
}
const api = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(await authHeader()), ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
};
// Read a file as base64. USER-UPLOADED images are downscaled (<=1568px) and re-encoded to JPEG,
// so oversized or HEIC/odd-format references don't 400 the APIs (Anthropic caps images at 5 MB
// and only accepts JPEG/PNG/GIF/WebP) or bloat the request. Blobs (already-valid server images
// being re-attached) pass through raw. The server's sniffImageMime corrects the media type.
const rawFileToB64 = (file) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result.split(',')[1]);
  fr.onerror = rej;
  fr.readAsDataURL(file);
});
const imgFileToB64 = (file, maxDim = 1568, quality = 0.9) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    resolve(c.toDataURL('image/jpeg', quality).split(',')[1]);
  };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read this image — if it's an iPhone HEIC photo, export it as JPEG or PNG first.")); };
  img.src = url;
});
const fileToB64 = (file) =>
  (file instanceof File && (file.type || '').startsWith('image/')) ? imgFileToB64(file) : rawFileToB64(file);
// Pull image files out of a clipboard paste event (returns [] if none).
const filesFromPaste = (e) => {
  const out = [];
  for (const it of (e.clipboardData?.items || [])) {
    if (it.kind === 'file' && (it.type || '').startsWith('image/')) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
};
// True when a drag event is carrying OS files (vs. text/elements).
const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
// Insert text at the cursor of a textarea/input (used when a paste carries text + image together).
function insertAtCursor(el, text) {
  if (!el || !text) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  try { el.selectionStart = el.selectionEnd = pos; } catch {}
  el.dispatchEvent(new Event('input'));   // trigger autosize
}
const timeAgo = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const toast = (msg, err = false) => {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
};

// The CRM lives in its own module (crm.js); it borrows the helpers it needs from here.
const crm = createCrm({ $, api, escapeHtml, toast, firestore: () => ({ fs: _fs, fsApi: _fsApi }) });

const GEM_META = {
  'nb-frames': { name: 'NB Frames', blurb: 'Sort references on the right — composition, location, characters, props — or attach any image, then describe the scene. Returns <b>3</b> cinematic Nano Banana 2 prompts that point at each reference by number.' },
  'kling': { name: 'Kling Prompter', blurb: 'Attach your still + describe the motion. Returns <b>3</b> Kling 3.0 video prompts <span style="white-space:nowrap">(<bdi>דיוק ועקביות / דינמי / התפתחות</bdi>).</span>' },
  'kling-advisor': { name: 'Kling V2V', blurb: 'Attach your source clip with <b>🎬</b> (the gem reads frames from it) and say what to change. Returns the best Kling 3.0 Omni <b>video-to-video</b> prompt (restyle / relight / transform) with why &amp; what to watch.' },
  // One tab, two engines (the toggle in its header switches between these two gems).
  'nb-advisor': { name: 'Advisor & Tweaks', blurb: 'Attach the image(s) and say what to change — everything else stays the same. Returns the best <b>Nano Banana</b> edit prompt with a quick rationale.' },
  'gpt-advisor': { name: 'Advisor & Tweaks', blurb: 'Say what you want — a swap, an edit, or a new image — and attach reference(s). Returns the best <b>GPT Image 2 (ChatGPT)</b> prompt, tuned to keep your frame\'s look &amp; color.' },
  'storyboard': { name: 'Storyboard', blurb: 'Set a storyboard style once (attach a style reference in Tune gem), then describe any frame — or turn a whole script into a board with <b>📜 From script</b>. Returns Nano Banana prompts that draw each shot as a <b>storyboard panel</b> in your style. Attach a character reference to keep them recognizable.' },
  // The Video tab — one brief, written for Seedance 2.0 / 2.5 or Kling 3.0 (its chat id stays 'seedance').
  'seedance': { name: 'Video prompt', blurb: '① Sort the references — the look (<b>@image1</b>), location, characters, props — or load a <b>start &amp; end frame</b>. ② Write the shots as director/DOP, or describe the scene. ③ Pick <b>Seedance 2.0, 2.5 or Kling 3.0</b> and get one paste-ready prompt with its upload order.' },
};

// Suggestion lists for the NB Frames per-project cinematography builder (datalists; free text still allowed).
const BUILDER_OPTS = {
  look: ['High-gloss beauty', 'Clinical-luxe', 'Editorial documentary', 'Moody cinematic', 'Product hero', 'Warm lifestyle', 'Cultural editorial'],
  lighting: ['Clamshell beauty (soft 5600K)', 'Soft window / natural', 'Golden-hour warmth', 'Hard chiaroscuro', 'High-key bright & even', 'Overcast soft'],
  lens: ['ARRI Alexa Mini LF + Cooke S4/i primes, short-tele ~70–135mm, creamy bokeh', 'ARRI Alexa 35 + Zeiss Supreme primes, normal ~40–60mm, natural', 'Sony Venice 2 + Zeiss Supreme primes, wide ~24–35mm, environmental depth', 'ARRI + Cooke Anamorphic/i, oval bokeh & horizontal flares, ~40–75mm', 'RED V-Raptor + Zeiss Master Prime, clinical & sharp, ~50–100mm'],
  palette: ['Vibrant high-key', 'Muted pastel', 'Teal & orange', 'Warm earthy', 'Desaturated editorial', 'Clean clinical whites'],
  grain: ['Match the reference exactly', 'Clean, near-grainless digital', 'Fine natural 35mm film grain', 'Subtle grain with gentle halation', 'Heavier organic film grain', '16mm — coarser, textured'],
  wardrobe: ['Describe wardrobe richly in prose', 'Keep wardrobe as in the reference', 'Minimal styling direction'],
};

// Builds the Tune-gem panel body: a guided cinematography builder for nb-frames, a freetext box for the others.
function gemEditorBody(gemId, meta) {
  const baseView = `
    <details class="gem-base">
      <summary>View base ${meta.name} gem (read-only — edit gems/*.txt to change for all projects)</summary>
      <pre id="gemBaseView">loading…</pre>
    </details>`;
  const saveRow = `
    <div class="gem-save-row">
      <button class="mini-btn" id="saveGem">Save direction</button>
      <button class="mini-btn ghost" id="resetGem" title="Wipe this project's direction for ${escapeHtml(meta.name)} and start a fresh setup">Reset setup</button>
      <span class="saved-flash hidden" id="gemSaved">saved ✓</span>
    </div>`;
  const dl = (id, arr) => `<datalist id="${id}">${arr.map(o => `<option value="${escapeHtml(o)}"></option>`).join('')}</datalist>`;

  if (gemId === 'nb-frames') {
    return `
      <div class="bf-analyze">
        <span class="field-label">Build from a reference image — attach or paste a look/style frame and let the model read its cinematography into the fields below as a reusable look (adaptable ranges, not this frame's exact settings).</span>
        <div class="bf-analyze-row">
          <div class="ref-row" id="bfRefRow"><button class="ref-add" id="bfRefAdd" type="button">＋</button><input type="file" id="bfRefInput" accept="image/*" multiple hidden /></div>
          <button class="mini-btn primary" id="bfAnalyze" type="button">✨ Analyze &amp; build</button>
        </div>
      </div>
      <span class="field-label">Cinematography fields — these compile into the direction layered on the base NB Frames gem (for this project only). Analyze fills them; edit any by hand. Describe each as an adaptable range or family (e.g. a focal-length range, not one locked focal length) so the look stays modular across different shots and frame sizes — EXCEPT the camera body and lens series, which are named specifically (e.g. ARRI Alexa Mini LF + Cooke S4/i primes) and stay constant.</span>
      <div class="builder-grid">
        <label class="bf">Campaign / subject<input id="bf_campaign" placeholder="e.g. Clalit Smile dental campaign" /></label>
        <label class="bf">Medium &amp; style<input id="bf_medium" placeholder="e.g. Photograph / cinematic film still — or Storyboard illustration, Digital painting, 3D render, Anime…" /></label>
        <label class="bf">Look &amp; vibe<input id="bf_look" list="dl_look" placeholder="e.g. Clinical-luxe" /></label>
        <label class="bf">Lighting style<input id="bf_lighting" list="dl_lighting" placeholder="e.g. High-key bright &amp; even" /></label>
        <label class="bf">Lens &amp; camera<input id="bf_lens" list="dl_lens" placeholder="e.g. ARRI Alexa Mini LF + Cooke S4/i primes, short-tele ~70–135mm (name the rig; focal length is a range)" /></label>
        <label class="bf">Color &amp; palette<input id="bf_palette" list="dl_palette" placeholder="e.g. Clean clinical whites" /></label>
        <label class="bf">Grain &amp; finish<input id="bf_grain" list="dl_grain" placeholder="e.g. fine natural 35mm grain — read from the reference" /></label>
        <label class="bf">Environment bias<input id="bf_environment" placeholder="e.g. bright airy modern clinics" /></label>
        <label class="bf">Default aspect ratio
          <select id="bf_aspectRatio">
            <option value="">(let the brief decide)</option>
            <option value="1:1">1:1 square</option>
            <option value="4:5">4:5 portrait</option>
            <option value="3:4">3:4 portrait</option>
            <option value="9:16">9:16 vertical</option>
            <option value="16:9">16:9 wide</option>
            <option value="21:9">21:9 cinema</option>
          </select>
        </label>
        <label class="bf">Wardrobe &amp; styling<input id="bf_wardrobe" list="dl_wardrobe" placeholder="e.g. describe wardrobe richly in prose" /></label>
      </div>
      <label class="bf bf-wide">Additional direction (freetext)<textarea id="bf_extra" placeholder="Anything else: campaign vibe, do's &amp; don'ts, mood, references…"></textarea></label>
      ${saveRow}
      <details class="gem-base" open>
        <summary>Compiled direction the gem receives (read-only preview)</summary>
        <pre id="gemCompiled" class="compiled">—</pre>
      </details>
      ${baseView}
      ${dl('dl_look', BUILDER_OPTS.look)}${dl('dl_lighting', BUILDER_OPTS.lighting)}${dl('dl_lens', BUILDER_OPTS.lens)}${dl('dl_palette', BUILDER_OPTS.palette)}${dl('dl_grain', BUILDER_OPTS.grain)}${dl('dl_wardrobe', BUILDER_OPTS.wardrobe)}`;
  }

  if (gemId === 'storyboard') {
    return `
      <div class="bf-analyze">
        <span class="field-label">Build from a storyboard-style reference — attach or paste a frame drawn in the storyboard style you want (any medium: pencil, ink, marker, digital). The model reads its drawing style into a reusable profile every panel follows. It captures the STYLE only, never the reference's scene.</span>
        <div class="bf-analyze-row">
          <div class="ref-row" id="bfRefRow"><button class="ref-add" id="bfRefAdd" type="button">＋</button><input type="file" id="bfRefInput" accept="image/*" multiple hidden /></div>
          <button class="mini-btn primary" id="bfAnalyze" type="button">✨ Analyze style</button>
        </div>
      </div>
      <label class="bf bf-wide">Storyboard style profile — the drawing style layered on the base Storyboard gem for this project only. Analyze fills it; edit any of it by hand. Describe the medium, linework, shading, and palette — not any specific scene.<textarea id="sb_style" placeholder="e.g. Loose black-ink storyboard panels with confident, varied line weight; light grey-marker shading for volume; sparse background detail; on warm toned paper…"></textarea></label>
      ${saveRow}
      ${baseView}`;
  }

  if (gemId === 'seedance') {
    return `
      <div class="bf-analyze">
        <span class="field-label">Build from a look reference — attach or paste a graded frame (your film look) and the model reads its cinematography into the fields below as the project's VIDEO look system: a locked film/style line for every technical block + adaptive lighting, lens, and camera families.</span>
        <div class="bf-analyze-row">
          <div class="ref-row" id="bfRefRow"><button class="ref-add" id="bfRefAdd" type="button">＋</button><input type="file" id="bfRefInput" accept="image/*" multiple hidden /></div>
          <button class="mini-btn primary" id="bfAnalyze" type="button">✨ Analyze &amp; build</button>
        </div>
      </div>
      <span class="field-label">Video look fields — compiled into the direction every Seedance prompt follows (this project only). The film/style line is repeated VERBATIM in every prompt's technical block — that repetition + the attached Look asset is what holds one look across the whole film. Describe families/ranges, not one frame's locked values.</span>
      <div class="builder-grid">
        <label class="bf">Project / campaign<input id="sd_project" placeholder="e.g. Hero car launch film" /></label>
        <label class="bf">Film / style line (locked, verbatim)<input id="sd_film" list="dl_sd_film" placeholder="e.g. Kodak 500T film grain, organic color, soft contrast, filmic look" /></label>
        <label class="bf">Color &amp; grade<input id="sd_palette" list="dl_palette" placeholder="e.g. warm subject vs cool dusk surroundings, filmic roll-off" /></label>
        <label class="bf">Lighting character<input id="sd_lighting" list="dl_lighting" placeholder="e.g. soft directional key, punchy contrast, clean shadows" /></label>
        <label class="bf">Lens &amp; framing feel<input id="sd_lens" list="dl_lens" placeholder="e.g. ARRI Alexa Mini LF + Cooke S4/i, ~35–85mm, creamy falloff" /></label>
        <label class="bf">Camera movement energy<input id="sd_camera" list="dl_sd_camera" placeholder="e.g. smooth deliberate dollies and holds, no handheld shake" /></label>
        <label class="bf">World / atmosphere bias<input id="sd_world" placeholder="e.g. light haze, dense practicals, deep backgrounds" /></label>
        <label class="bf">Default aspect ratio
          <select id="sd_aspectRatio">
            <option value="">(per generation)</option>
            <option value="16:9">16:9 wide</option>
            <option value="21:9">21:9 cinema</option>
            <option value="9:16">9:16 vertical</option>
            <option value="1:1">1:1 square</option>
            <option value="4:3">4:3</option>
            <option value="3:4">3:4 portrait</option>
          </select>
        </label>
        <label class="bf">Default sound policy
          <select id="sd_sound">
            <option value="">(per generation)</option>
            <option value="SFX only, no music">SFX only, no music</option>
            <option value="SFX + score">SFX + score</option>
            <option value="Dialogue + SFX, no music">Dialogue + SFX, no music</option>
            <option value="Dialogue + SFX + score">Dialogue + SFX + score</option>
          </select>
        </label>
      </div>
      <label class="bf bf-wide">Additional direction (freetext)<textarea id="sd_extra" placeholder="Anything else: recurring motifs, pacing, do's &amp; don'ts, brand rules…"></textarea></label>
      ${saveRow}
      <details class="gem-base" open>
        <summary>Compiled direction the gem receives (read-only preview)</summary>
        <pre id="gemCompiled" class="compiled">—</pre>
      </details>
      ${baseView}
      ${dl('dl_sd_film', ['Kodak 500T film grain, organic color, soft contrast, filmic look', 'Kodak 250D — sunlit warmth, fine natural grain, gentle contrast', 'Clean digital cinema — neutral color, high dynamic range, crisp finish', 'Heavy 16mm grain — vintage, handmade, textured', 'Neon noir — deep blacks, glowing highlights, high contrast'])}
      ${dl('dl_sd_camera', ['Locked-off and composed — tripod holds, slow deliberate moves', 'Smooth cinematic — dollies, cranes, gimbal glides', 'Handheld documentary — organic drift, quick reframes', 'Kinetic action — whip pans, speed ramps, chasing moves'])}
      ${dl('dl_palette', BUILDER_OPTS.palette)}${dl('dl_lighting', BUILDER_OPTS.lighting)}${dl('dl_lens', BUILDER_OPTS.lens)}`;
  }

  return `
    <span class="field-label">Project-specific direction — extends the base ${meta.name} gem for this project only (vibe, constraints, style).</span>
    <textarea id="gemOverride" placeholder="e.g. moody neon-noir motion, heavy rain physics, slow deliberate camera moves…"></textarea>
    ${saveRow}
    ${baseView}`;
}

// Loads gem base + project direction into the editor and wires Save (builder for nb-frames, freetext otherwise).
async function loadGemEditor(gemId) {
  const pid = state.current.id;
  const { base, override, builder } = await api(`/api/projects/${pid}/gems/${gemId}`);
  // Left the tab (or the project) while this loaded? Then the editor on screen belongs to another
  // gem — filling it with this one's settings would let Save write them onto the wrong gem.
  if (state.activeTab !== gemId || state.current?.id !== pid || !$('#gemEditor')) return;
  const bv = $('#gemBaseView'); if (bv) bv.textContent = base || '(empty)';

  if (gemId === 'nb-frames') {
    const b = builder || {};
    const fieldIds = ['campaign', 'medium', 'look', 'lighting', 'lens', 'palette', 'grain', 'environment', 'aspectRatio', 'wardrobe', 'extra'];
    const styleIds = ['medium', 'look', 'lighting', 'lens', 'palette', 'grain', 'environment', 'aspectRatio', 'wardrobe', 'extra'];
    fieldIds.forEach(k => { const el = $('#bf_' + k); if (el) el.value = b[k] || ''; });
    const cp = $('#gemCompiled'); if (cp) cp.textContent = override || '— (analyze a reference or fill the fields, then Save) —';

    let styleRef = b.styleRef || null;   // {file, mimeType, url} — persisted look reference
    let pending = [];                    // newly attached {mimeType, data, url} awaiting analysis

    const renderBfRefs = () => {
      const row = $('#bfRefRow'); if (!row) return;
      $$('.thumb', row).forEach(t => t.remove());
      const add = $('#bfRefAdd');
      const items = [];
      if (styleRef) items.push({ url: styleRef.url, saved: true });
      pending.forEach((pp, i) => items.push({ url: pp.url, i }));
      items.forEach(it => {
        const t = document.createElement('div');
        t.className = 'thumb' + (it.saved ? ' saved' : '');
        t.innerHTML = `<img src="${it.url}" />` + (it.saved ? '' : `<button class="rm" type="button" data-i="${it.i}">✕</button>`);
        if (!it.saved) t.querySelector('.rm').onclick = () => { pending.splice(it.i, 1); renderBfRefs(); };
        row.insertBefore(t, add);
      });
    };
    renderBfRefs();

    $('#bfRefAdd').onclick = () => $('#bfRefInput').click();
    $('#bfRefInput').onchange = async (e) => {
      for (const f of e.target.files) {
        const data = await fileToB64(f);
        pending.push({ mimeType: f.type, data, url: URL.createObjectURL(f) });
      }
      renderBfRefs(); e.target.value = '';
    };

    $('#bfAnalyze').onclick = async () => {
      if (!pending.length) { toast('Attach a reference image first.', true); return; }
      if (!state.config.hasAnthropic) { toast('Add your ANTHROPIC_API_KEY to .env first.', true); return; }
      const btn = $('#bfAnalyze'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Analyzing…';
      try {
        const images = pending.map(pp => ({ mimeType: pp.mimeType, data: pp.data }));
        const { builder: filled } = await api(`/api/projects/${state.current.id}/gems/nb-frames/analyze`, {
          method: 'POST', body: JSON.stringify({ images }),
        });
        styleIds.forEach(k => { const el = $('#bf_' + k); if (el && typeof filled[k] === 'string') el.value = filled[k]; });
        if (filled.styleRef) { styleRef = filled.styleRef; pending = []; renderBfRefs(); }
        toast('Fields filled from the reference — review & Save.');
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false; btn.innerHTML = '✨ Analyze & build';
      }
    };

    // Paste an image anywhere in the builder's freetext box to queue it for analysis.
    const bfExtra = $('#bf_extra');
    if (bfExtra) bfExtra.addEventListener('paste', async (e) => {
      const files = filesFromPaste(e);
      if (!files.length) return;
      e.preventDefault();
      const text = e.clipboardData.getData('text');
      if (text) insertAtCursor(bfExtra, text);       // direction text + reference image(s) together
      for (const f of files) {
        const data = await fileToB64(f);
        pending.push({ mimeType: f.type, data, url: URL.createObjectURL(f) });
      }
      renderBfRefs();
      toast('Reference pasted — click "Analyze & build".');
    });

    $('#saveGem').onclick = async () => {
      const vals = {};
      fieldIds.forEach(k => { vals[k] = ($('#bf_' + k)?.value || '').trim(); });
      if (styleRef) vals.styleRef = styleRef;
      const p = await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify({ gemBuilders: { 'nb-frames': vals } }) });
      state.current.gemOverrides = p.gemOverrides; state.current.gemBuilders = p.gemBuilders;
      const cp2 = $('#gemCompiled'); if (cp2) cp2.textContent = (p.gemOverrides && p.gemOverrides['nb-frames']) || '— (empty) —';
      flashSaved();
    };

    $('#resetGem').onclick = async () => {
      if (!confirm(`Reset the ${GEM_META[gemId].name} setup for this project? This clears all cinematography fields, the saved look reference, and the project direction.`)) return;
      const p = await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify({ gemBuilders: { 'nb-frames': {} } }) });
      state.current.gemOverrides = p.gemOverrides; state.current.gemBuilders = p.gemBuilders;
      fieldIds.forEach(k => { const el = $('#bf_' + k); if (el) el.value = ''; });
      styleRef = null; pending = []; renderBfRefs();
      const cp3 = $('#gemCompiled'); if (cp3) cp3.textContent = '— (analyze a reference or fill the fields, then Save) —';
      flashSaved();
    };
  } else if (gemId === 'storyboard') {
    const b = builder || {};
    const styleEl = $('#sb_style'); if (styleEl) styleEl.value = override || '';

    let styleRef = b.styleRef || null;   // {file, mimeType, url} — persisted storyboard-style reference
    let pending = [];                    // newly attached {mimeType, data, url} awaiting analysis

    const renderBfRefs = () => {
      const row = $('#bfRefRow'); if (!row) return;
      $$('.thumb', row).forEach(t => t.remove());
      const add = $('#bfRefAdd');
      const items = [];
      if (styleRef) items.push({ url: styleRef.url, saved: true });
      pending.forEach((pp, i) => items.push({ url: pp.url, i }));
      items.forEach(it => {
        const t = document.createElement('div');
        t.className = 'thumb' + (it.saved ? ' saved' : '');
        t.innerHTML = `<img src="${it.url}" />` + (it.saved ? '' : `<button class="rm" type="button" data-i="${it.i}">✕</button>`);
        if (!it.saved) t.querySelector('.rm').onclick = () => { pending.splice(it.i, 1); renderBfRefs(); };
        row.insertBefore(t, add);
      });
    };
    renderBfRefs();

    $('#bfRefAdd').onclick = () => $('#bfRefInput').click();
    $('#bfRefInput').onchange = async (e) => {
      for (const f of e.target.files) {
        const data = await fileToB64(f);
        pending.push({ mimeType: f.type, data, url: URL.createObjectURL(f) });
      }
      renderBfRefs(); e.target.value = '';
    };

    $('#bfAnalyze').onclick = async () => {
      if (!pending.length) { toast('Attach a storyboard-style reference first.', true); return; }
      if (!state.config.hasAnthropic) { toast('Add your ANTHROPIC_API_KEY to .env first.', true); return; }
      const btn = $('#bfAnalyze'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Analyzing…';
      try {
        const images = pending.map(pp => ({ mimeType: pp.mimeType, data: pp.data }));
        const { style, styleRef: sref } = await api(`/api/projects/${state.current.id}/gems/storyboard/analyze`, {
          method: 'POST', body: JSON.stringify({ images }),
        });
        if (styleEl && typeof style === 'string') styleEl.value = style;
        if (sref) { styleRef = sref; pending = []; renderBfRefs(); }
        toast('Style profile filled from the reference — review & Save.');
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false; btn.innerHTML = '✨ Analyze style';
      }
    };

    // Paste an image into the style box to queue it for analysis (text still lands in the box).
    if (styleEl) styleEl.addEventListener('paste', async (e) => {
      const files = filesFromPaste(e);
      if (!files.length) return;
      e.preventDefault();
      const text = e.clipboardData.getData('text');
      if (text) insertAtCursor(styleEl, text);
      for (const f of files) {
        const data = await fileToB64(f);
        pending.push({ mimeType: f.type, data, url: URL.createObjectURL(f) });
      }
      renderBfRefs();
      toast('Reference pasted — click "Analyze style".');
    });

    $('#saveGem').onclick = async () => {
      const val = ($('#sb_style')?.value || '').trim();
      const body = { gemOverrides: { 'storyboard': val }, gemBuilders: { 'storyboard': styleRef ? { styleRef } : {} } };
      const p = await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      state.current.gemOverrides = p.gemOverrides; state.current.gemBuilders = p.gemBuilders;
      flashSaved();
    };

    $('#resetGem').onclick = async () => {
      if (!confirm(`Reset the ${GEM_META[gemId].name} setup for this project? This clears the storyboard style profile and the saved style reference.`)) return;
      const p = await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify({ gemOverrides: { 'storyboard': '' }, gemBuilders: { 'storyboard': {} } }) });
      state.current.gemOverrides = p.gemOverrides; state.current.gemBuilders = p.gemBuilders;
      if (styleEl) styleEl.value = '';
      styleRef = null; pending = []; renderBfRefs();
      flashSaved();
    };
  } else if (gemId === 'seedance') {
    const b = builder || {};
    const fieldIds = ['project', 'film', 'palette', 'lighting', 'lens', 'camera', 'world', 'aspectRatio', 'sound', 'extra'];
    const styleIds = ['film', 'palette', 'lighting', 'lens', 'camera', 'world', 'extra'];   // what the analyzer fills
    fieldIds.forEach(k => { const el = $('#sd_' + k); if (el) el.value = b[k] || ''; });
    const cp = $('#gemCompiled'); if (cp) cp.textContent = override || '— (analyze a look frame or fill the fields, then Save) —';

    let styleRef = b.styleRef || null;   // {file, mimeType, url} — persisted look frame
    let pending = [];                    // newly attached {mimeType, data, url} awaiting analysis

    const renderBfRefs = () => {
      const row = $('#bfRefRow'); if (!row) return;
      $$('.thumb', row).forEach(t => t.remove());
      const add = $('#bfRefAdd');
      const items = [];
      if (styleRef) items.push({ url: styleRef.url, saved: true });
      pending.forEach((pp, i) => items.push({ url: pp.url, i }));
      items.forEach(it => {
        const t = document.createElement('div');
        t.className = 'thumb' + (it.saved ? ' saved' : '');
        t.innerHTML = `<img src="${it.url}" />` + (it.saved ? '' : `<button class="rm" type="button" data-i="${it.i}">✕</button>`);
        if (!it.saved) t.querySelector('.rm').onclick = () => { pending.splice(it.i, 1); renderBfRefs(); };
        row.insertBefore(t, add);
      });
    };
    renderBfRefs();

    $('#bfRefAdd').onclick = () => $('#bfRefInput').click();
    $('#bfRefInput').onchange = async (e) => {
      for (const f of e.target.files) {
        const data = await fileToB64(f);
        pending.push({ mimeType: f.type, data, url: URL.createObjectURL(f) });
      }
      renderBfRefs(); e.target.value = '';
    };

    $('#bfAnalyze').onclick = async () => {
      if (!pending.length) { toast('Attach a look frame first.', true); return; }
      if (!state.config.hasAnthropic) { toast('Add your ANTHROPIC_API_KEY to .env first.', true); return; }
      const btn = $('#bfAnalyze'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Analyzing…';
      try {
        const images = pending.map(pp => ({ mimeType: pp.mimeType, data: pp.data }));
        const { builder: filled } = await api(`/api/projects/${state.current.id}/gems/seedance/analyze`, {
          method: 'POST', body: JSON.stringify({ images }),
        });
        styleIds.forEach(k => { const el = $('#sd_' + k); if (el && typeof filled[k] === 'string') el.value = filled[k]; });
        if (filled.styleRef) { styleRef = filled.styleRef; pending = []; renderBfRefs(); }
        toast('Video look read from the reference — review & Save.');
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false; btn.innerHTML = '✨ Analyze & build';
      }
    };

    // Paste an image into the freetext box to queue it for analysis.
    const sdExtra = $('#sd_extra');
    if (sdExtra) sdExtra.addEventListener('paste', async (e) => {
      const files = filesFromPaste(e);
      if (!files.length) return;
      e.preventDefault();
      const text = e.clipboardData.getData('text');
      if (text) insertAtCursor(sdExtra, text);
      for (const f of files) {
        const data = await fileToB64(f);
        pending.push({ mimeType: f.type, data, url: URL.createObjectURL(f) });
      }
      renderBfRefs();
      toast('Reference pasted — click "Analyze & build".');
    });

    $('#saveGem').onclick = async () => {
      const vals = {};
      fieldIds.forEach(k => { vals[k] = ($('#sd_' + k)?.value || '').trim(); });
      if (styleRef) vals.styleRef = styleRef;
      const p = await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify({ gemBuilders: { 'seedance': vals } }) });
      state.current.gemOverrides = p.gemOverrides; state.current.gemBuilders = p.gemBuilders;
      const cp2 = $('#gemCompiled'); if (cp2) cp2.textContent = (p.gemOverrides && p.gemOverrides['seedance']) || '— (empty) —';
      flashSaved();
    };

    $('#resetGem').onclick = async () => {
      if (!confirm(`Reset the ${GEM_META[gemId].name} setup for this project? This clears all video look fields, the saved look frame, and the project direction.`)) return;
      const p = await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify({ gemBuilders: { 'seedance': {} } }) });
      state.current.gemOverrides = p.gemOverrides; state.current.gemBuilders = p.gemBuilders;
      fieldIds.forEach(k => { const el = $('#sd_' + k); if (el) el.value = ''; });
      styleRef = null; pending = []; renderBfRefs();
      const cp3 = $('#gemCompiled'); if (cp3) cp3.textContent = '— (analyze a look frame or fill the fields, then Save) —';
      flashSaved();
    };
  } else {
    const ov = $('#gemOverride'); if (ov) ov.value = override || '';
    $('#saveGem').onclick = async () => {
      const val = $('#gemOverride').value;
      const p = await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify({ gemOverrides: { [gemId]: val } }) });
      state.current.gemOverrides = p.gemOverrides;
      flashSaved();
    };
    $('#resetGem').onclick = async () => {
      if (!confirm(`Reset the ${GEM_META[gemId].name} setup for this project? This clears the project direction.`)) return;
      const p = await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify({ gemOverrides: { [gemId]: '' } }) });
      state.current.gemOverrides = p.gemOverrides;
      const ov2 = $('#gemOverride'); if (ov2) ov2.value = '';
      flashSaved();
    };
  }
}
function flashSaved() {
  const f = $('#gemSaved'); if (!f) return;
  f.classList.remove('hidden'); setTimeout(() => f.classList.add('hidden'), 1800);
}

const state = {
  config: null,
  projects: [],
  current: null,        // full project object
  // The Kling tab folded into the Video tab (chat id 'seedance'), so a remembered 'kling' opens there.
  activeTab: (() => {
    const t = localStorage.getItem('avs:lastTab') === 'kling' ? 'seedance' : localStorage.getItem('avs:lastTab');
    return ['nb-frames','characters','seedance','kling-advisor','nb-advisor','gpt-advisor','storyboard','swap','generate','library'].includes(t) ? t : 'nb-frames';
  })(),
  attachments: {},      // per-gem: array of {name, mimeType, data, url, asset?:{tag,type,name}}
  refImages: [],        // for generate panel
  klingMode: localStorage.getItem('avs:klingMode') || 'single',  // 'single' (3 variations) | 'multi' (multi-shot)
  seedanceVersion: localStorage.getItem('avs:seedanceVersion') || '2.5',  // '2.5' (30s, 50 refs) | '2.0' (15s, 12 refs)
  // The Video tab's model, picked at the end of its brief (seedance.js): 'seedance-2.0' | 'seedance-2.5' | 'kling-3.0'.
  videoModel: localStorage.getItem('avs:videoModel') || (localStorage.getItem('avs:seedanceVersion') === '2.0' ? 'seedance-2.0' : 'seedance-2.5'),
  assetType: 'character',  // Assets tab: which asset type the builder form is set to
  nbModel: localStorage.getItem('avs:nbModel') || 'nb2',         // 'nb2' (flash) | 'pro' (Nano Banana Pro)
  genAR: localStorage.getItem('avs:genAR') ?? '16:9',            // generator aspect ratio — defaults to 16:9, remembers last pick
  expSplit: localStorage.getItem('avs:expSplit') || 3,           // expense split — defaults to 3 ways, remembers last pick
  sdBriefs: {},            // Seedance tab: the brief being built, per project + scene (seedance.js)
  nbBoards: {},            // NB Frames: the reference board, per project + scene (refboard.js)
  sceneId: GENERAL,        // the scene picked in the strip (scenes.js)
  sceneBags: {},           // each scene's unsent work while another scene is open (see setScene)
};

// ── Scenes (scenes.js) ────────────────────────────────────────────────────────
// The active scene decides which chat a gem tab shows and which scene new images land in.
const scenes = createScenes({ state, api, toast, escapeHtml,
  onSwitch: (id) => setScene(id),
  onImageDrop: (url, sceneId) => moveImageToScene(imageByUrl(url), sceneId),
  onDeleted: (id) => sceneDeleted(id),
  onChanged: () => refreshImageViews() });
const activeScene = () => scenes.activeId();
const chatKey = (gemId) => sceneChatKey(gemId, activeScene());
const sceneParam = () => (activeScene() === GENERAL ? {} : { sceneId: activeScene() });
const hasScenes = () => (state.current?.scenes || []).length > 0;
const inScene = (im) => imageScene(im, state.current?.scenes) === activeScene();
// Per project + scene: the key the Seedance brief, the reference board and the unsent work keep.
const sceneSlot = (scene = state.sceneId || GENERAL) => `${state.current?.id || '_'}:${scene}`;

// The Seedance tab's brief builder lives in its own module (seedance.js), like the CRM.
const seedance = createSeedance({ escapeHtml, toast, state, mediaFetch, imgFileToB64, filesFromPaste, insertAtCursor, openLightbox,
  runTurn: (turn) => runChatTurn('seedance', turn), briefKey: () => sceneSlot() });
// NB Frames' reference board — composition, location, characters, props — beside its chat.
const refboard = createRefBoard({ escapeHtml, toast, state, mediaFetch, imgFileToB64, filesFromPaste, openLightbox,
  boardKey: () => sceneSlot() });

// ── boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  state.config = await api('/api/health');
  $('#modelLine').textContent = `${state.config.claudeModel} · NB2 ${state.config.nb2Size}`;
  renderKeyStatus();
  await loadProjects();
  wireGlobal();
  // Auto-open the last-used project so existing work is never hidden behind a blank screen.
  // Falls back to the most recent project that actually has content (so a blank/duplicate can't hijack the screen).
  const last = localStorage.getItem('avs:lastProject');
  let pick = (last && state.projects.find(p => p.id === last)) ? last : null;
  if (!pick) {
    const withContent = state.projects.find(p => ((p.imageCount || 0) + (p.chatCount || 0)) > 0);
    pick = (withContent || state.projects[0])?.id;
  }
  startProjectListSync();          // live sidebar (projects added/renamed/deleted by either user)
  crm.start();                     // leads: the live list + the sidebar's new-lead count
  // The lead-alert email links straight to app.shyow.io/#crm.
  if (location.hash === '#crm') openCrm();
  else if (pick) openProject(pick);
}
function renderKeyStatus() {
  const c = state.config;
  $('#keyStatus').innerHTML =
    `Claude key ${c.hasAnthropic ? '<b>ok</b>' : '<span class="bad">missing</span>'}<br>` +
    `Gemini key ${c.hasGemini ? '<b>ok</b>' : '<span class="bad">missing</span>'}`;
}

// The sidebar folds to a narrow rail of icons; the choice is remembered (index.html applies it
// before the first paint, so a collapsed sidebar never flashes open on load).
function setSidebarCollapsed(collapsed) {
  $('#app').classList.toggle('sb-collapsed', collapsed);
  const t = $('#sidebarToggle');
  const label = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
  t.title = label; t.setAttribute('aria-label', label); t.setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem('avs:sidebar', collapsed ? 'collapsed' : ''); } catch {}
}

// Tabs come in groups — Images, Videos, Assets (each tab's data-group in index.html); only the open
// group's tabs show. A group button opens the tab last used in that group.
// A tab button can stand for two tabs (data-also): Advisor & Tweaks is the Nano Banana advisor
// or the GPT one, whichever its toggle last picked.
const tabButton = (tab) => $(`#wsTabs .tab[data-tab="${tab}"]`) || $(`#wsTabs .tab[data-also="${tab}"]`);
const tabGroupOf = (tab) => tabButton(tab)?.dataset.group || 'image';
const advisorTab = () => { try { return localStorage.getItem('avs:advisorEngine') === 'gpt' ? 'gpt-advisor' : 'nb-advisor'; } catch { return 'nb-advisor'; } };
const tabOfButton = (t) => (t.dataset.also ? advisorTab() : t.dataset.tab);
function showTabGroup(group) {
  $$('#wsGroups .ws-group').forEach(b => b.classList.toggle('active', b.dataset.group === group));
  $$('#wsTabs .tab').forEach(t => t.classList.toggle('hidden', t.dataset.group !== group));
}
function openTabGroup(group) {
  let last = null;
  try { last = localStorage.getItem(`avs:lastTab:${group}`); } catch {}
  const buttons = $$(`#wsTabs .tab[data-group="${group}"]`);
  const tabs = buttons.flatMap(t => [t.dataset.tab, t.dataset.also].filter(Boolean));
  switchTab(tabs.includes(last) ? last : tabOfButton(buttons[0]));
}

function wireGlobal() {
  setSidebarCollapsed($('#app').classList.contains('sb-collapsed'));
  $('#sidebarToggle').onclick = () => setSidebarCollapsed(!$('#app').classList.contains('sb-collapsed'));
  $('#newProjectBtn').onclick = newProject;
  $('#newProjectBtn2').onclick = newProject;
  $('#showcaseBtn').onclick = openShowcase;
  $('#expensesBtn').onclick = openExpenses;
  $('#crmBtn').onclick = openCrm;
  $('#lightboxClose').onclick = () => $('#lightbox').classList.add('hidden');
  $('#lightbox').onclick = (e) => { if (e.target.id === 'lightbox') $('#lightbox').classList.add('hidden'); };
  $('#lightboxPrev').onclick = (e) => { e.stopPropagation(); lightboxNav(-1); };
  $('#lightboxNext').onclick = (e) => { e.stopPropagation(); lightboxNav(1); };
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').classList.contains('hidden')) return;
    if (e.key === 'ArrowLeft') lightboxNav(-1);
    else if (e.key === 'ArrowRight') lightboxNav(1);
    else if (e.key === 'Escape') $('#lightbox').classList.add('hidden');
  });
  $('#projectNameInput').onchange = async (e) => {
    if (!state.current) return;
    await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify({ name: e.target.value }) });
    state.current.name = e.target.value;
    await loadProjects();
  };
  $('#projectClientInput').onchange = async (e) => {
    if (!state.current) return;
    const client = cleanClient(e.target.value);
    e.target.value = client;
    try { await api(`/api/projects/${state.current.id}`, { method: 'PATCH', body: JSON.stringify({ client }) }); }
    catch (err) { toast(err.message, true); return; }
    state.current.client = client;
    setClientFolded(client, false);
    await loadProjects();
  };
  const search = $('#projectSearch');
  search.oninput = renderProjectList;
  search.onkeydown = (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; renderProjectList(); } };
  $$('#wsTabs .tab').forEach(t => {
    t.onclick = () => switchTab(tabOfButton(t));
    // Drag an image (from NB2 results / Library / Assets) onto a tab to attach it there — or onto
    // Assets to save it into the folder.
    const takes = (tab) => DROP_TABS.includes(tab) || tab === 'characters';
    t.addEventListener('dragover', (e) => {
      if (takes(tabOfButton(t)) && Array.from(e.dataTransfer.types || []).includes('text/avs-image')) {
        e.preventDefault(); t.classList.add('tab-drop');
      }
    });
    t.addEventListener('dragleave', () => t.classList.remove('tab-drop'));
    t.addEventListener('drop', (e) => {
      t.classList.remove('tab-drop');
      const url = e.dataTransfer.getData('text/avs-image');
      if (!url) return;
      e.preventDefault();
      if (t.dataset.tab === 'characters') saveToAssets([{ url }]);
      else dropImageOnTab(tabOfButton(t), url);
    });
  });
  // While an image is dragged, hovering a group shows its tabs, so a Library image can still be
  // dropped on a tab in the other group (Seedance, Kling…); the bar falls back when the drag ends.
  $$('#wsGroups .ws-group').forEach(b => {
    b.onclick = () => openTabGroup(b.dataset.group);
    b.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('text/avs-image')) showTabGroup(b.dataset.group);
    });
  });
  document.addEventListener('dragend', () => { if (state.current) showTabGroup(tabGroupOf(state.activeTab)); });
  // close any open favorites popover when clicking outside it / its toggle button
  document.addEventListener('click', (e) => {
    if (e.target.closest('.fav-picker') || e.target.closest('.fav-open')) return;
    $$('.fav-picker').forEach(p => p.classList.add('hidden'));
  });
  scenes.wire();   // the scene strip under the tabs
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.scene-menu, .card-scene')) closeSceneMenu(); });
}

// ── projects ────────────────────────────────────────────────────────────────
async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjectList();
}
// The sidebar lists projects under their client: the most recently active client first, its
// projects newest first, "No client" last. The search narrows by project or client name, and a
// client's header folds its projects away (remembered; opening a project unfolds its client).
let _foldedClients = null;
function foldedClients() {
  if (!_foldedClients) {
    try { _foldedClients = new Set(JSON.parse(localStorage.getItem('avs:foldedClients') || '[]')); } catch { _foldedClients = new Set(); }
  }
  return _foldedClients;
}
function setClientFolded(client, folded) {
  const set = foldedClients();
  if (folded) set.add(client); else set.delete(client);
  try { localStorage.setItem('avs:foldedClients', JSON.stringify([...set])); } catch {}
}
const cleanClient = (v) => String(v || '').trim().replace(/\s+/g, ' ');

function renderProjectList() {
  const list = $('#projectList');
  if (!list) return;
  const q = ($('#projectSearch')?.value || '').trim().toLowerCase();
  const groups = new Map();   // client → its projects, kept in the list's newest-first order
  for (const p of state.projects || []) {
    const client = cleanClient(p.client);
    if (q && !`${p.name} ${client}`.toLowerCase().includes(q)) continue;
    if (!groups.has(client)) groups.set(client, []);
    groups.get(client).push(p);
  }
  const order = [...groups.keys()].sort((a, b) => (!a - !b) || ((groups.get(b)[0].updatedAt || 0) - (groups.get(a)[0].updatedAt || 0)));
  list.innerHTML = '';
  if (!order.length) list.innerHTML = `<div class="pl-empty">${q ? 'No project or client matches.' : 'No projects yet.'}</div>`;
  for (const client of order) {
    const projects = groups.get(client);
    const folded = !q && foldedClients().has(client);
    const group = document.createElement('div');
    group.className = 'pl-group' + (folded ? ' folded' : '');
    group.innerHTML = `<div class="pl-client">
        <button class="pl-client-toggle" type="button" title="${folded ? 'Show' : 'Hide'} this client's projects">
          <span class="pl-caret">▾</span><span class="pl-client-name" dir="auto">${escapeHtml(client || 'No client')}</span><span class="pl-count">${projects.length}</span>
        </button>
        ${client ? '<button class="pl-client-edit" type="button" title="Rename this client">✎</button>' : ''}
      </div>`;
    group.querySelector('.pl-client-toggle').onclick = () => { setClientFolded(client, !folded); renderProjectList(); };
    const edit = group.querySelector('.pl-client-edit');
    if (edit) edit.onclick = () => renameClient(client);
    if (!folded) projects.forEach(p => group.appendChild(projectItem(p)));
    list.appendChild(group);
  }
  // the client pickers (project header, new-project form) suggest the clients that exist
  const dl = $('#clientList');
  if (dl) dl.innerHTML = [...new Set((state.projects || []).map(p => cleanClient(p.client)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b)).map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
}

function projectItem(p) {
  const el = document.createElement('div');
  el.className = 'project-item' + (state.current?.id === p.id ? ' active' : '');
  el.innerHTML = `<span class="pname" dir="auto">${escapeHtml(p.name)}</span><span class="pdel" title="Delete">🗑</span>`;
  // Whole row is clickable (matches the row's pointer cursor); re-clicking the open project is a no-op.
  el.onclick = () => { if (state.current?.id !== p.id) openProject(p.id); };
  el.querySelector('.pdel').onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${p.name}" and all its images?`)) return;
    await api(`/api/projects/${p.id}`, { method: 'DELETE' });
    if (localStorage.getItem('avs:lastProject') === p.id) localStorage.removeItem('avs:lastProject');
    if (state.current?.id === p.id) { state.current = null; showEmpty(); }
    await loadProjects();
  };
  return el;
}

// A client is just the name its projects carry, so renaming one re-labels each of its projects.
async function renameClient(client) {
  const input = prompt(`Rename the client "${client}" — every project under it moves along:`, client);
  if (input === null) return;
  const name = cleanClient(input);
  if (!name || name === client) return;
  const projects = (state.projects || []).filter(p => cleanClient(p.client) === client);
  try {
    for (const p of projects) await api(`/api/projects/${p.id}`, { method: 'PATCH', body: JSON.stringify({ client: name }) });
  } catch (e) { toast(e.message, true); }
  if (foldedClients().has(client)) { setClientFolded(client, false); setClientFolded(name, true); }
  if (state.current && projects.some(p => p.id === state.current.id)) { state.current.client = name; $('#projectClientInput').value = name; }
  await loadProjects();
  toast(`Client renamed to ${name} (${projects.length} project${projects.length === 1 ? '' : 's'}).`);
}

// ── Live sync (Firestore real-time listeners) ─────────────────────────────────
// Both users watch the same project live. The browsers subscribe DIRECTLY to Firestore
// (Google's infra), so live updates never touch our server — sync adds ~zero server load.
// Needs Firestore rules allowing the allowlisted emails to READ (writes stay server-side
// via the admin SDK). No-ops in local/open mode (no _fs).
let _projListUnsub = null;
let _projUnsubs = [];

function startProjectListSync() {
  if (!_fs || _projListUnsub) return;
  const { collection, onSnapshot } = _fsApi;
  _projListUnsub = onSnapshot(collection(_fs, 'projects'), (snap) => {
    const projects = [];
    snap.forEach(d => { const p = d.data(); if (p && p.id) projects.push({ id: p.id, name: p.name, client: p.client || '', createdAt: p.createdAt, updatedAt: p.updatedAt, imageCount: p.imageCount || 0, chatCount: p.chatCount || 0 }); });
    projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    state.projects = projects;
    renderProjectList();
  }, (err) => console.warn('[sync] project list:', err?.message || err));
}

function stopProjectSync() {
  _projUnsubs.forEach(u => { try { u(); } catch {} });
  _projUnsubs = [];
}

function syncProject(pid) {
  stopProjectSync();
  if (!_fs) return;
  const { collection, doc, onSnapshot } = _fsApi;
  const mine = () => state.current && state.current.id === pid;

  // project meta (live rename)
  _projUnsubs.push(onSnapshot(doc(_fs, 'projects', pid), (d) => {
    if (!mine() || !d.exists()) return;
    const m = d.data();
    if (m.name && m.name !== state.current.name) {
      state.current.name = m.name;
      const el = $('#projectNameInput');
      if (el && el !== document.activeElement) el.value = m.name;
    }
    if ((m.client || '') !== (state.current.client || '')) {
      state.current.client = m.client || '';
      const el = $('#projectClientInput');
      if (el && el !== document.activeElement) el.value = state.current.client;
    }
  }, (e) => console.warn('[sync] meta:', e?.message || e)));

  // chat messages per gem — the "see each other's prompts" bit. A doc is one gem's chat in one
  // scene ({sceneId}~{gemId}; General's is just {gemId}); a deleted scene's chats are removed.
  _projUnsubs.push(onSnapshot(collection(_fs, 'projects', pid, 'chats'), (snap) => {
    if (!mine()) return;
    snap.docChanges().forEach(ch => {
      const key = ch.doc.id;
      if (ch.type === 'removed') delete state.current.chats[key];
      else state.current.chats[key] = ch.doc.data().messages || [];
      if (key === chatKey(state.activeTab) && $('#chatScroll')) renderMessages(state.activeTab);
    });
  }, (e) => console.warn('[sync] chats:', e?.message || e)));

  // generated images (Nano Banana 2 + Library) — redraw from state, never re-fetch
  _projUnsubs.push(onSnapshot(collection(_fs, 'projects', pid, 'images'), (snap) => {
    if (!mine()) return;
    state.current.images = snap.docs.map(d => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    state.current.imagesLoaded = true;
    if (state.activeTab === 'generate' && !state.generating) paintGenResults();
    else if (state.activeTab === 'library' && $('#libGrid')) drawLibGrid(libImages());
  }, (e) => console.warn('[sync] images:', e?.message || e)));

  // scenes — added, renamed, reordered or deleted in either browser
  _projUnsubs.push(onSnapshot(collection(_fs, 'projects', pid, 'scenes'), (snap) => {
    if (!mine()) return;
    scenes.sync(snap.docs.map(d => d.data()));
  }, (e) => console.warn('[sync] scenes:', e?.message || e)));

  // characters
  _projUnsubs.push(onSnapshot(collection(_fs, 'projects', pid, 'characters'), (snap) => {
    if (!mine()) return;
    state.current.characters = snap.docs.map(d => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (state.activeTab === 'characters') renderCharsGallery();
  }, (e) => console.warn('[sync] characters:', e?.message || e)));

  // references — kept fresh so a reference either of us attaches is immediately
  // re-attachable by the other, without a reload
  _projUnsubs.push(onSnapshot(collection(_fs, 'projects', pid, 'references'), (snap) => {
    if (!mine()) return;
    state.current.references = snap.docs.map(d => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (!$('#refPicker')?.classList.contains('hidden')) renderRefPicker(state.activeTab);
    if (state.activeTab === 'characters') renderKeptRefs();
  }, (e) => console.warn('[sync] references:', e?.message || e)));
}

// New project: its client (an existing one or a new name) and its name. The client starts as the
// open project's, since a new project is usually more work for the same client.
function newProject() {
  let modal = $('#newProjectModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'newProjectModal'; modal.className = 'modal-overlay'; document.body.appendChild(modal); }
  const client = cleanClient(state.current?.client);
  modal.innerHTML = `
    <form class="modal-card np-card" id="npForm">
      <div class="modal-head"><h3>New project</h3><button class="modal-x" type="button" id="npX">✕</button></div>
      <p class="modal-sub">Projects sit under their client in the sidebar.</p>
      <label class="np-field"><span class="field-label">Client</span>
        <input id="npClient" list="clientList" dir="auto" autocomplete="off" placeholder="Pick a client or type a new one" value="${escapeHtml(client)}" /></label>
      <label class="np-field"><span class="field-label">Project name</span>
        <input id="npName" dir="auto" autocomplete="off" placeholder="e.g. Summer launch film" /></label>
      <div class="modal-actions">
        <button class="modal-btn ghost" type="button" id="npCancel">Cancel</button>
        <button class="modal-btn accent" type="submit" id="npGo">Create project</button>
      </div>
    </form>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('#npX', modal).onclick = close;
  $('#npCancel', modal).onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  modal.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  $('#npForm', modal).onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#npName', modal).value.trim();
    if (!name) { $('#npName', modal).focus(); toast('Give the project a name.', true); return; }
    const go = $('#npGo', modal);
    go.disabled = true;
    try {
      const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name, client: cleanClient($('#npClient', modal).value) }) });
      close();
      await loadProjects();
      openProject(p.id);
    } catch (err) { toast(err.message, true); go.disabled = false; }
  };
  (client ? $('#npName', modal) : $('#npClient', modal)).focus();
}

async function openProject(pid) {
  state.current = await api(`/api/projects/${pid}?light=1`);   // fast open; images load lazily below
  state.current.images = state.current.images || [];
  state.current.scenes = sortScenes(state.current.scenes);
  try { localStorage.setItem('avs:lastProject', pid); } catch {}
  // It opens on the scene last used in it (General when that's gone, or for a project without scenes).
  let lastScene = null;
  try { lastScene = localStorage.getItem(`avs:scene:${pid}`); } catch {}
  state.sceneId = lastScene && state.current.scenes.some(s => s.id === lastScene) ? lastScene : GENERAL;
  state.sceneBags = {};
  state.attachments = {};
  state.drafts = {};
  state.refImages = [];
  state.genFrom = null;
  $('#emptyState').classList.add('hidden');
  $('#showcaseView').classList.add('hidden');
  $('#expensesView').classList.add('hidden');
  hideCrm();
  $('#workspace').classList.remove('hidden');
  $('#projectNameInput').value = state.current.name;
  $('#projectClientInput').value = state.current.client || '';
  $('#wsMeta').textContent = `created ${new Date(state.current.createdAt).toLocaleDateString()}`;
  setClientFolded(cleanClient(state.current.client), false);   // the open project's client stays unfolded
  await loadProjects();
  switchTab(state.activeTab);
  syncProject(pid);                // live-stream this project's chats / images / characters
  // Load the (potentially large) image library in the BACKGROUND so the switch is instant.
  // The Library tab fetches its own; this keeps state.current.images ready for Generate + drag.
  api(`/api/projects/${pid}/images`).then(imgs => {
    if (state.current?.id !== pid) return;             // user switched away meanwhile
    state.current.images = imgs.map(stripUrl);
    state.current.imagesLoaded = true;
    // Generate shows recent renders from state.current.images; Library self-fetches, so leave it.
    if (state.activeTab === 'generate' && !state.generating) switchTab(state.activeTab);
    // An Advisor chat marks the tried options that are in the Library — now it knows which are.
    else if (ADVISOR_TABS.includes(state.activeTab) && $('#chatScroll .cand')) renderMessages(state.activeTab);
  }).catch(() => {});
}
function showEmpty() {
  $('#workspace').classList.add('hidden');
  $('#showcaseView').classList.add('hidden');
  $('#expensesView').classList.add('hidden');
  hideCrm();
  $('#emptyState').classList.remove('hidden');
}

// ── CRM (global): website leads + ones added by hand, worked as a pipeline (crm.js) ──
function openCrm() {
  $('#emptyState').classList.add('hidden');
  $('#workspace').classList.add('hidden');
  $('#showcaseView').classList.add('hidden');
  $('#expensesView').classList.add('hidden');
  if (location.hash !== '#crm') history.replaceState(null, '', '#crm');
  crm.open();
}
function hideCrm() {
  $('#crmView').classList.add('hidden');
  if (location.hash === '#crm') history.replaceState(null, '', location.pathname + location.search);
}

// ── Showcase (global): upload portfolio videos that power the public landing page ──
async function openShowcase() {
  $('#emptyState').classList.add('hidden');
  $('#workspace').classList.add('hidden');
  $('#expensesView').classList.add('hidden');
  hideCrm();
  const view = $('#showcaseView');
  view.classList.remove('hidden');
  view.innerHTML = `
    <div class="showcase-head">
      <h1>Showcase</h1>
      <p>Upload finished videos here — they appear in the Work section of your <a href="/landing" target="_blank" rel="noopener">public landing page</a>.</p>
    </div>
    <form class="sc-upload" id="scForm">
      <label class="sc-file"><input type="file" id="scFile" accept="video/*" required /><span>Choose video…</span></label>
      <input type="text" id="scTitle" class="sc-input" placeholder="Title (e.g. Bubble Express)" />
      <input type="text" id="scCaption" class="sc-input" placeholder="Caption (e.g. Concept spot)" />
      <button type="submit" class="new-project-btn" id="scUpload">Upload</button>
      <span class="sc-status" id="scStatus"></span>
    </form>
    <div class="showcase-list" id="scList"></div>`;
  $('#scForm').addEventListener('submit', uploadShowcase);
  $('#scFile').addEventListener('change', (e) => {
    $('#scFile').closest('.sc-file').querySelector('span').textContent = e.target.files[0]?.name || 'Choose video…';
  });
  await renderShowcaseList();
}

// ── Expenses (global): running Claude + Nano Banana spend, split by month & week ──
async function openExpenses() {
  $('#emptyState').classList.add('hidden');
  $('#workspace').classList.add('hidden');
  $('#showcaseView').classList.add('hidden');
  hideCrm();
  const view = $('#expensesView');
  view.classList.remove('hidden');
  view.innerHTML = `<div class="exp-head"><h1>Expenses</h1><p>Loading…</p></div>`;
  let u;
  try { u = await api('/api/usage'); }
  catch (e) { view.innerHTML = `<div class="exp-head"><h1>Expenses</h1><p>Couldn't load expenses: ${escapeHtml(e.message || String(e))}</p></div>`; return; }
  renderExpenses(view, u);
}

function renderExpenses(view, u) {
  const money = (n) => '$' + (n || 0).toFixed(2);
  const split = state.expSplit || 3;   // number = equal ways; '1:2' = ⅓ · ⅔ split
  const splitOpts = [{ v: '2', label: '2 · 50/50' }, { v: '1:2', label: '⅓ · ⅔' }, { v: '3', label: '3' }, { v: '4', label: '4' }, { v: '5', label: '5' }];
  const cur = u.open || u.total, settledTot = u.settled ? u.settled.total : 0;
  const closedLabel = u.closedThroughLabel || '', openLabel = u.openFromLabel || 'now';
  const perSplit = split === '1:2' ? `⅓ <b>${money(cur.total / 3)}</b> · ⅔ <b>${money(cur.total * 2 / 3)}</b>` : `<b>${money(cur.total / (parseInt(split, 10) || 2))}</b> each`;
  const row = (b) => `<tr class="${b.closed ? 'exp-settled' : ''}">
    <td>${escapeHtml(b.label)}${b.closed ? '<span class="exp-tag">settled</span>' : ''}</td>
    <td class="exp-num">${money(b.nb)}<span class="exp-sub">${b.nbImages} img</span></td>
    <td class="exp-num">${money(b.swap || 0)}<span class="exp-sub">${b.swapImages || 0} swap</span></td>
    <td class="exp-num">${money(b.claude)}<span class="exp-sub">${b.claudeCalls} calls</span></td>
    <td class="exp-num">${b.sub ? money(b.sub) : '—'}</td>
    <td class="exp-num">${b.credits ? money(b.credits) : '—'}</td>
    <td class="exp-num exp-tot">${money(b.total)}</td></tr>`;
  const claudePct = u.total.total ? Math.round((u.total.claude / u.total.total) * 100) : 0;
  view.innerHTML = `
    <div class="exp-head">
      <h1>Expenses</h1>
      <p>Running cost across all projects — Nano Banana + Swap/Edit + Claude API usage, plus fixed subscriptions.${closedLabel ? ` Settled through <b>${escapeHtml(closedLabel)}</b> (kept for the record); the current count runs fresh from <b>${escapeHtml(openLabel)}</b>.` : ' Split by month for settling up with partners.'}</p>
    </div>
    <div class="exp-cards">
      <div class="exp-card exp-hero">
        <div class="exp-card-label">Current · from ${escapeHtml(openLabel)}</div>
        <div class="exp-card-num">${money(cur.total)}</div>
        <div class="exp-split">Split <select id="expSplit">${splitOpts.map(o => `<option value="${o.v}"${String(split) === o.v ? ' selected' : ''}>${o.label}</option>`).join('')}</select> → ${perSplit}</div>
      </div>
      <div class="exp-card exp-settled-card"><div class="exp-card-label">Settled · through ${escapeHtml(closedLabel)}</div><div class="exp-card-num">${money(settledTot)}</div><div class="exp-card-sub">paid up · kept for record</div></div>
      <div class="exp-card"><div class="exp-card-label">Nano Banana · Google</div><div class="exp-card-num">${money(cur.nb)}</div><div class="exp-card-sub">${cur.nbImages} images · exact</div></div>
      <div class="exp-card"><div class="exp-card-label">Swap / Edit · fal + OpenAI</div><div class="exp-card-num">${money(cur.swap || 0)}</div><div class="exp-card-sub">${cur.swapImages || 0} renders · est.</div></div>
      <div class="exp-card"><div class="exp-card-label">Claude · Anthropic</div><div class="exp-card-num">${money(cur.claude)}</div><div class="exp-card-sub">${cur.claudeCalls} prompts · est.</div></div>
      <div class="exp-card"><div class="exp-card-label">Subscriptions</div><div class="exp-card-num">${money(cur.sub || 0)}</div><div class="exp-card-sub">ChatGPT Plus + Render</div></div>
      <div class="exp-card"><div class="exp-card-label">Extra credits</div><div class="exp-card-num">${money(cur.credits || 0)}</div><div class="exp-card-sub">one-off top-ups</div></div>
    </div>
    <h2 class="exp-h2">By month</h2>
    <table class="exp-table"><thead><tr><th>Month</th><th>Nano Banana</th><th>Swap/Edit</th><th>Claude</th><th>Subs</th><th>Credits</th><th>Total</th></tr></thead>
      <tbody>${u.months.map(row).join('') || '<tr><td colspan="7" class="exp-empty">No usage yet.</td></tr>'}</tbody></table>
    <h2 class="exp-h2">Recent weeks</h2>
    <table class="exp-table"><thead><tr><th>Week</th><th>Nano Banana</th><th>Swap/Edit</th><th>Claude</th><th>Subs</th><th>Credits</th><th>Total</th></tr></thead>
      <tbody>${u.weeks.map(row).join('') || '<tr><td colspan="7" class="exp-empty">—</td></tr>'}</tbody></table>
    <p class="exp-note">${closedLabel ? `<b>Settled through ${escapeHtml(closedLabel)}</b> — those months are paid up and kept here for the record (marked “settled”); the split above covers only the current count from ${escapeHtml(openLabel)}. All-time across everything is <b>${money(u.total.total)}</b>. ` : ''}<b>Nano Banana is exact</b> — billed per image by model + resolution. <b>Claude and Swap/Edit are estimated</b> (Claude from message sizes ±~15%; Swap ≈ $0.08 Flux / $0.21 GPT Image 2 per render). <b>Subscriptions</b> (ChatGPT Plus $20 + Render $25 /mo) are fixed monthly costs — shown in months, not weeks. <b>Extra credits</b> are one-off prepaid top-ups, added to the month they were bought (months only). For invoices, check the Anthropic, Google AI Studio, fal.ai, and OpenAI dashboards.${u.cached ? ' · cached' : ''}</p>`;
  const sel = view.querySelector('#expSplit');
  if (sel) sel.onchange = () => { state.expSplit = sel.value.includes(':') ? sel.value : parseInt(sel.value, 10); try { localStorage.setItem('avs:expSplit', sel.value); } catch {} renderExpenses(view, u); };
}

async function renderShowcaseList() {
  const list = $('#scList');
  let items = [];
  try { items = await api('/api/showcase'); } catch {}
  if (!items.length) { list.innerHTML = '<div class="sc-empty">No videos yet — upload your first above.</div>'; return; }
  list.innerHTML = '';
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'sc-card';
    card.innerHTML = `
      <video src="${it.url}" muted loop playsinline preload="metadata"></video>
      <div class="sc-card-meta"><div class="sc-card-title"></div><div class="sc-card-cap"></div></div>
      <button class="sc-del" title="Remove">✕</button>`;
    card.querySelector('.sc-card-title').textContent = it.title || 'Untitled';
    card.querySelector('.sc-card-cap').textContent = it.caption || '';
    const v = card.querySelector('video');
    card.addEventListener('mouseenter', () => v.play().catch(() => {}));
    card.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
    card.querySelector('.sc-del').addEventListener('click', async () => {
      if (!confirm('Remove this video from the showcase?')) return;
      try { await api(`/api/showcase/${it.id}`, { method: 'DELETE' }); await renderShowcaseList(); }
      catch (e) { toast('Delete failed: ' + e.message); }
    });
    list.appendChild(card);
  }
}

async function uploadShowcase(e) {
  e.preventDefault();
  const file = $('#scFile').files[0];
  if (!file) return;
  const status = $('#scStatus'), btn = $('#scUpload');
  status.textContent = 'Uploading…'; btn.disabled = true;
  try {
    const fd = new FormData();
    fd.append('video', file);
    fd.append('title', $('#scTitle').value || '');
    fd.append('caption', $('#scCaption').value || '');
    const r = await fetch('/api/showcase', { method: 'POST', headers: await authHeader(), body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Upload failed (${r.status})`);
    status.textContent = 'Uploaded ✓';
    $('#scForm').reset();
    $('#scFile').closest('.sc-file').querySelector('span').textContent = 'Choose video…';
    await renderShowcaseList();
  } catch (err) {
    status.textContent = 'Failed: ' + err.message;
  } finally { btn.disabled = false; }
}

// ── scenes: switching, moving images ─────────────────────────────────────────
// Each scene keeps its own unsent work — composer text and images, the Nano Banana prompt and its
// references — so switching scenes never carries one scene's half-written brief into another.
// The Seedance brief and the NB Frames board are kept per scene by their modules (sceneSlot).
function stashSceneBag(scene) { state.sceneBags[sceneSlot(scene)] = { attachments: state.attachments, refImages: state.refImages, drafts: state.drafts, genFrom: state.genFrom }; }
function loadSceneBag(scene) {
  const b = state.sceneBags[sceneSlot(scene)] || {};
  state.attachments = b.attachments || {};
  state.refImages = b.refImages || [];
  state.drafts = b.drafts || {};
  state.genFrom = b.genFrom || null;   // the chat the Nano Banana prompt came from (its recipe)
}
// discard: the scene being left is gone, so its unsent work goes with it.
function setScene(id, { discard = false } = {}) {
  if (!state.current) return;
  const next = id !== GENERAL && (state.current.scenes || []).some(s => s.id === id) ? id : GENERAL;
  const prev = state.sceneId || GENERAL;
  if (next === prev) { scenes.render(); return; }
  if (discard) delete state.sceneBags[sceneSlot(prev)];
  else { saveDrafts(); stashSceneBag(prev); }
  $('#wsBody').innerHTML = '';   // so switchTab can't save this scene's text into the next one's drafts
  state.sceneId = next;
  try { localStorage.setItem(`avs:scene:${state.current.id}`, next); } catch {}
  loadSceneBag(next);
  closeSceneMenu();
  scenes.render();
  switchTab(state.activeTab);
}
// A scene was deleted (here or in the other browser): its chats go, its images return to General.
function sceneDeleted(id) {
  if (!state.current) return;
  for (const k of Object.keys(state.current.chats || {})) if (k.startsWith(`${id}~`)) delete state.current.chats[k];
  for (const im of state.current.images || []) if (im.sceneId === id) delete im.sceneId;
  delete state.nbBoards[sceneSlot(id)];
  delete state.sdBriefs[sceneSlot(id)];
  if ((state.sceneId || GENERAL) === id) setScene(GENERAL, { discard: true });
  else { delete state.sceneBags[sceneSlot(id)]; scenes.render(); refreshImageViews(); }
}
// The project's images with their URLs, as the Library grid draws them.
const libImages = () => (state.current?.images || []).map(im => ({ ...im, url: `/media/${state.current.id}/images/${im.file}` }));
// After images move between scenes (or scenes are renamed / reordered), redraw what shows them.
function refreshImageViews() {
  if (!state.current) return;
  if (state.activeTab === 'library' && $('#libGrid')) { renderLibScope(); drawLibGrid(libImages()); }
  else if (state.activeTab === 'generate' && !state.generating) { paintGenResults(); const h = $('#genResultsHead'); if (h) h.textContent = genResultsTitle(); }
}
// One of this project's Library images, from the URL an image drag carries (null for anything
// else — an asset sheet, say, which belongs to the whole project rather than a scene).
function imageByUrl(url) {
  try {
    const u = new URL(url, location.href);
    const prefix = `/media/${state.current.id}/images/`;
    if (!u.pathname.startsWith(prefix)) return null;
    const file = decodeURIComponent(u.pathname.slice(prefix.length));
    return (state.current.images || []).find(im => im.file === file) || null;
  } catch { return null; }
}
async function moveImageToScene(im, sceneId) {
  if (!state.current) return;
  if (!im) { toast('Only this project\'s generated or uploaded images move between scenes — Assets belong to the whole project.', true); return; }
  if (imageScene(im, state.current.scenes) === sceneId) { toast(`It's already in ${scenes.label(sceneId)}.`); return; }
  try {
    const rec = await api(`/api/projects/${state.current.id}/images/${im.id}`, { method: 'PATCH', body: JSON.stringify({ sceneId: sceneId === GENERAL ? '' : sceneId }) });
    if (rec.sceneId) im.sceneId = rec.sceneId; else delete im.sceneId;
    toast(`Moved to ${scenes.label(sceneId)}.`);
    refreshImageViews();
  } catch (e) { toast(e.message, true); }
}
// The scene menu on an image card: pick the scene to move it to.
function closeSceneMenu() { $$('.scene-menu').forEach(m => m.remove()); }
function openSceneMenu(btn, imgId) {
  const open = $('.scene-menu');
  closeSceneMenu();
  if (open && open.dataset.img === imgId) return;   // a second click on the same chip closes it
  const im = (state.current?.images || []).find(x => x.id === imgId);
  if (!im) return;
  const cur = imageScene(im, state.current.scenes);
  const menu = document.createElement('div');
  menu.className = 'scene-menu';
  menu.dataset.img = imgId;
  menu.innerHTML = `<div class="sm-head">Move to scene</div>` + [GENERAL, ...scenes.list().map(s => s.id)].map(id =>
    `<button type="button" data-scene="${id}"${id === cur ? ' class="on" aria-current="true"' : ''}><span>${id === cur ? '✓' : ''}</span><span dir="auto">${escapeHtml(scenes.label(id))}</span></button>`).join('');
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 6 + menu.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 6) : r.bottom + 6}px`;
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-scene]');
    if (!b) return;
    closeSceneMenu();
    if (b.dataset.scene !== cur) moveImageToScene(im, b.dataset.scene);
  };
}

// ── tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  saveDrafts();                                  // keep the outgoing tab's unsent text inputs
  state.activeTab = tab;
  const group = tabGroupOf(tab);
  try { localStorage.setItem('avs:lastTab', tab); localStorage.setItem(`avs:lastTab:${group}`, tab); } catch {}
  $$('#wsTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab || t.dataset.also === tab));
  showTabGroup(group);
  scenes.render();                               // the scene strip (hidden in Assets)
  const body = $('#wsBody');
  body.innerHTML = '';
  if (tab === 'generate') renderGenerate(body);
  else if (tab === 'characters') renderCharacters(body);
  else if (tab === 'swap') renderSwap(body);
  else if (tab === 'library') renderLibrary(body);
  else renderChat(body, tab);
  restoreDrafts();                               // restore the incoming tab's text inputs
}

// ── Swap / Edit tab: faithful in-context editing (Flux Kontext / GPT Image) — keeps image 1. ──
// Fill a slot ('base'/'char') from a File — used by browse, paste, and drop. Images re-encode to JPEG.
async function loadSwapSlot(which, file) {
  if (!file || !(file.type || '').startsWith('image/')) { toast("That doesn't look like an image.", true); return false; }
  try {
    state.swap = state.swap || { base: null, char: null, prompt: '', model: 'flux' };
    state.swap[which] = { data: await fileToB64(file), mimeType: 'image/jpeg', preview: URL.createObjectURL(file) };
    renderSwap($('#wsBody'));
    return true;
  } catch (e) { toast(e.message || 'Could not read that image.', true); return false; }
}
const swapFirstEmpty = () => (!state.swap?.base ? 'base' : (!state.swap.char ? 'char' : 'base'));
// One document-level paste listener, active only on the Swap tab: an image on the clipboard lands
// in the first empty slot; a text-only paste falls through so it can land in the prompt box.
let _swapPasteWired = false;
function wireSwapPaste() {
  if (_swapPasteWired) return; _swapPasteWired = true;
  document.addEventListener('paste', async (e) => {
    if (state.activeTab !== 'swap') return;
    const files = filesFromPaste(e);
    if (!files.length) return;
    e.preventDefault();
    const which = swapFirstEmpty();
    if (await loadSwapSlot(which, files[0])) toast(`Pasted into image ${which === 'base' ? '1' : '2'}.`);
  });
}

function renderSwap(body) {
  const s = state.swap || (state.swap = { base: null, char: null, prompt: '', model: (state.config?.hasOpenai ? 'gptimage' : 'flux'), ab: false });
  const slot = (which, im, label, opt) => `<label class="swap-slot${opt ? ' opt' : ''}" data-which="${which}">
    <input type="file" accept="image/*" hidden />
    <div class="swap-slot-inner">${im ? `<img src="${im.preview}" />` : `<span>＋ ${label}</span>`}</div>
    ${im ? `<button class="swap-clear" data-which="${which}" title="Remove">×</button>` : ''}
  </label>`;
  const cfg = state.config || {};
  const noKey = !(cfg.hasFal || cfg.hasOpenai);
  const hasGpt = !!cfg.hasOpenai;
  body.innerHTML = `
    <div class="swap-panel">
      <p class="field-label">Full-character swap — drops the <b>whole character</b> from image 2 (head to toe + styling) into image 1 and blends it in, keeping image 1's scene, other people, and <b>exact framing</b>. Name who to replace in the prompt (e.g. "the man in the middle"). One image + an instruction = an adjustment.</p>
      ${noKey ? '<div class="swap-nokey">⚠ Needs a fal.ai key. Add <code>FAL_KEY</code> to your .env (and Render), then reload.</div>' : ''}
      <div class="swap-slots">
        ${slot('base', s.base, 'Image 1 — base (keep this)')}
        <div class="swap-arrow">⇄</div>
        ${slot('char', s.char, 'Image 2 — new character (full body)', true)}
      </div>
      <div class="swap-hint">Click a slot to browse · paste (Ctrl/⌘V) · or drag an image straight in</div>
      <textarea id="swapPrompt" class="swap-prompt" placeholder="Two images → name who to replace with image 2's character (e.g. 'replace the man in the middle with the woman in image 2'). One image → describe the adjustment (e.g. 'change the background to a night city street').">${escapeHtml(s.prompt || '')}</textarea>
      <div class="swap-controls">
        <div class="swap-left">
          <div class="swap-model">
            <button class="seg ${s.model === 'gptimage' ? 'on' : ''}" data-model="gptimage"${hasGpt ? '' : ' disabled title="Set OPENAI_API_KEY to enable GPT Image"'}>GPT Image 2${hasGpt ? '' : ' 🔒'}</button>
            <button class="seg ${s.model === 'flux' ? 'on' : ''}" data-model="flux">Flux Kontext</button>
          </div>
          ${s.model === 'gptimage' ? `<button class="swap-ab ${s.ab ? 'on' : ''}" id="swapAb" title="A/B — run two prompt-enhancement strategies and compare side by side (2× cost)">A/B</button>` : ''}
        </div>
        <button class="new-project-btn" id="swapBtn"${noKey ? ' disabled' : ''}>${s.ab && s.model === 'gptimage' ? '⇄ Run A/B' : '⇄ Run'}</button>
      </div>
      <div id="swapResults" class="results-grid"></div>
    </div>`;
  wireSwapPaste();                                       // paste an image anywhere in the tab → first empty slot
  const panel = $('.swap-panel', body);
  $$('.swap-slot input', body).forEach(inp => inp.onchange = (e) => {
    loadSwapSlot(e.target.closest('.swap-slot').dataset.which, e.target.files[0]);
  });
  // Drag & drop onto a specific slot — OS image files, or a Library thumbnail (text/avs-image).
  $$('.swap-slot', body).forEach(sl => {
    const which = sl.dataset.which;
    const hot = (e) => dragHasFiles(e) || [...(e.dataTransfer.types || [])].includes('text/avs-image');
    sl.addEventListener('dragover', (e) => { if (hot(e)) { e.preventDefault(); e.stopPropagation(); sl.classList.add('drag'); panel.classList.remove('drag-over'); } });
    sl.addEventListener('dragleave', (e) => { if (!sl.contains(e.relatedTarget)) sl.classList.remove('drag'); });
    sl.addEventListener('drop', async (e) => {
      if (!hot(e)) return;
      e.preventDefault(); e.stopPropagation(); sl.classList.remove('drag');
      if (dragHasFiles(e)) { loadSwapSlot(which, [...e.dataTransfer.files].find(f => (f.type || '').startsWith('image/'))); return; }
      const url = e.dataTransfer.getData('text/avs-image');
      if (!url) return;
      try { const a = await urlToAttachment(url); state.swap[which] = { data: a.data, mimeType: a.mimeType, preview: url }; renderSwap(body); }
      catch { toast('Could not add that image.', true); }
    });
  });
  // Drop anywhere else in the panel → first empty slot ("drop directly to the tab").
  panel.addEventListener('dragover', (e) => { if (dragHasFiles(e)) { e.preventDefault(); panel.classList.add('drag-over'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag-over'); });
  panel.addEventListener('drop', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault(); panel.classList.remove('drag-over');
    const f = [...e.dataTransfer.files].find(x => (x.type || '').startsWith('image/'));
    if (f) loadSwapSlot(swapFirstEmpty(), f); else toast('Only image files can be dropped here.', true);
  });
  $$('.swap-clear', body).forEach(b => b.onclick = (e) => { e.preventDefault(); state.swap[b.dataset.which] = null; renderSwap(body); });
  $$('.swap-model .seg', body).forEach(b => b.onclick = () => { if (b.disabled) return; state.swap.model = b.dataset.model; renderSwap(body); });
  const abBtn = $('#swapAb', body); if (abBtn) abBtn.onclick = () => { state.swap.ab = !state.swap.ab; renderSwap(body); };
  const pt = $('#swapPrompt', body); if (pt) pt.oninput = () => { state.swap.prompt = pt.value; };
  const btn = $('#swapBtn', body); if (btn && !noKey) btn.onclick = () => doSwap(body);
}

async function doSwap(body) {
  const s = state.swap;
  if (!s.base) { toast('Attach image 1 (the base).', true); return; }
  if (!s.char && !s.prompt.trim()) { toast('Add a second image to swap, or describe an adjustment in the prompt.', true); return; }
  const ab = !!(s.ab && s.model === 'gptimage' && s.char);   // A/B needs GPT Image + a second image
  const btn = $('#swapBtn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Working…';
  const results = $('#swapResults');
  results.insertAdjacentHTML('afterbegin', `<div class="skeleton gen-skel"><div class="gen-load"><span class="spinner-lg"></span><span class="gen-load-label">${ab ? 'Running A/B…' : 'Working…'}</span></div></div>`);
  try {
    const images = [{ mimeType: s.base.mimeType, data: s.base.data }];
    if (s.char) images.push({ mimeType: s.char.mimeType, data: s.char.data });
    const resp = await api(`/api/projects/${state.current.id}/swap`, {
      method: 'POST', body: JSON.stringify({ prompt: s.prompt, images, model: s.model, ab, ...sceneParam() }),
    });
    results.querySelector('.gen-skel')?.remove();
    const list = resp.images || (resp.image ? [resp.image] : []);
    if (list.length) {
      for (const im of list) state.current.images = [stripUrl(im), ...(state.current.images || [])];
      const html = list.map(im => im.variant
        ? `<div class="ab-cell"><span class="ab-badge">${im.variant}</span>${imgCard(im)}</div>`
        : imgCard(im)).join('');
      results.insertAdjacentHTML('afterbegin', html);
      $$('.img-card', results).forEach(c => c.classList.add('gen-reveal'));
      wireImageCards(results);
      toast(resp.ab ? 'A/B done ✓ — compare A vs B (both saved to the Library)' : 'Done ✓ — saved to the Library');
    }
  } catch (e) {
    results.querySelector('.gen-skel')?.remove();
    toast(e.message, true);
  } finally {
    const b = $('#swapBtn'); if (b) { b.disabled = false; b.textContent = (s.ab && s.model === 'gptimage') ? '⇄ Run A/B' : '⇄ Run'; }
  }
}

// Per-tab draft persistence: any composer/prompt input marked [data-draft] is remembered
// across tab switches (keyed by tab + input id), so typed-but-unsent text is never lost —
// covers the chat composer, the Nano Banana 2 prompt, and the Characters form.
function saveDrafts() {
  state.drafts = state.drafts || {};
  document.querySelectorAll('#wsBody [data-draft]').forEach(el => { state.drafts[`${state.activeTab}:${el.id}`] = el.value; });
}
function restoreDrafts() {
  if (!state.drafts) return;
  document.querySelectorAll('#wsBody [data-draft]').forEach(el => {
    const v = state.drafts[`${state.activeTab}:${el.id}`];
    if (v) { el.value = v; el.dispatchEvent(new Event('input')); }
  });
}

// ── CHAT panels (gems) ─────────────────────────────────────────────────────────
function renderChat(body, gemId) {
  const meta = GEM_META[gemId];
  const km = state.klingMode || 'single';
  const klingToggle = gemId === 'kling' ? `
        <div class="mode-toggle" id="klingModeToggle" title="Single = three variations of one shot · Multi-shot = one prompt per shot (put the shot count in your message)">
          <button class="seg ${km === 'single' ? 'active' : ''}" data-mode="single" type="button">Single · 3</button>
          <button class="seg ${km === 'multi' ? 'active' : ''}" data-mode="multi" type="button">Multi-shot</button>
        </div>` : '';
  // (The Video tab picks its model — Seedance 2.0 / 2.5, Kling 3.0 — at the end of its brief, in seedance.js.)
  // Advisor & Tweaks: one tab, and the toggle decides which engine the advice is written for.
  const advisorToggle = gemId === 'nb-advisor' || gemId === 'gpt-advisor' ? `
        <div class="mode-toggle" id="advisorEngine" title="Which model to write the prompt for — the reply follows your pick">
          <button class="seg ${gemId === 'nb-advisor' ? 'active' : ''}" data-engine="nb-advisor" type="button">🍌 Nano Banana</button>
          <button class="seg ${gemId === 'gpt-advisor' ? 'active' : ''}" data-engine="gpt-advisor" type="button">GPT Image</button>
        </div>` : '';
  // Storyboard: besides one frame at a time, a whole script in and a titled frame per beat out.
  const scriptToggle = gemId === 'storyboard'
    ? `<button class="mini-btn${state.sbScriptOpen ? ' on' : ''}" id="sbScriptToggle" type="button" title="Turn a whole script into a storyboard">📜 From script</button>` : '';
  const scriptPanel = gemId === 'storyboard' ? `
    <div class="sb-script${state.sbScriptOpen ? '' : ' hidden'}" id="sbScript">
      <p class="sb-script-head"><b>Storyboard from a script.</b> Paste it or load the file (PDF, Word, Final Draft, Fountain or text), pick how many frames, and each comes back as a titled Nano Banana prompt in this project's storyboard style (⚙ Tune gem). Images attached below — a character, say — ride along.</p>
      <textarea id="sbScriptText" data-draft dir="auto" placeholder="Paste the script here — or drop its file on this box…"></textarea>
      <div class="sb-script-row">
        <label class="mini-btn sb-file">📄 Load a file<input type="file" id="sbScriptFile" accept=".txt,.md,.fountain,.fdx,.pdf,.docx" hidden /></label>
        <span class="sb-script-meta" id="sbScriptMeta"></span>
        <label class="sb-frames">Frames <input type="number" id="sbFrames" data-draft min="1" max="30" step="1" value="8" /></label>
        <button class="send-btn" id="sbScriptGo" type="button">Build storyboard</button>
      </div>
    </div>` : '';
  // Seedance swaps the attach-and-type composer for its brief builder (seedance.js); the chat
  // moves to a side column, and its box is left for text follow-ups on the last prompt.
  const sd = gemId === 'seedance';
  const composer = `
    <div class="composer">
      ${sd ? '' : `<div class="fav-picker hidden" id="favPicker"></div>
      <div class="fav-picker hidden" id="refPicker"></div>
      <div class="composer-attach" id="composerAttach"></div>`}
      <div class="composer-row">
        ${sd ? '' : `<button class="attach-btn" id="attachBtn" title="Attach or paste an image">📎</button>
        <button class="attach-btn fav-open" id="favBtn" title="Add from this project's liked images">♥</button>
        <button class="attach-btn fav-open" id="refBtn" title="Re-attach a reference you've used before in this project">🕘</button>
        <input type="file" id="fileInput" accept="image/*" multiple hidden />
        ${gemId === 'kling-advisor' ? `<button class="attach-btn" id="videoBtn" title="Attach the source clip — the gem reads frames sampled across it">🎬</button>
        <input type="file" id="videoInput" accept="video/*" hidden />` : ''}`}
        <textarea id="chatInput" data-draft rows="1" placeholder="${chatPlaceholder(gemId)}"></textarea>
        <button class="send-btn" id="sendBtn">Send</button>
      </div>
    </div>`;
  // NB Frames: the chat on the left, its reference board (refboard.js) in the column beside it.
  const nbf = gemId === 'nb-frames';
  const panel = document.createElement('div');
  panel.className = 'chat-panel' + (sd ? ' sd-panel' : '');
  panel.innerHTML = `
    <div class="chat-intro">
      <div class="ci-text"><b>${meta.name}.</b> ${meta.blurb}</div>
      <div class="chat-actions">
        ${klingToggle}${advisorToggle}${scriptToggle}
        <button class="mini-btn" id="gemEditToggle">⚙ Tune gem</button>
        <button class="mini-btn" id="clearChat" title="${hasScenes() ? `Clear this chat in ${escapeHtml(scenes.label(activeScene()))} only` : 'Clear this chat'}">Clear</button>
      </div>
    </div>
    <div class="gem-editor hidden" id="gemEditor">
      <div class="gem-body">${gemEditorBody(gemId, meta)}</div>
    </div>
    ${sd ? `<div class="sd-body" id="sdBody">
      <div class="sd-main" id="sdMain"></div>
      <div class="sd-out">
        <div class="sd-out-head field-label">Prompts</div>
        <div class="chat-scroll" id="chatScroll"></div>${composer}
      </div>
    </div>` : nbf ? `<div class="nbf-body">
      <div class="nbf-chat"><div class="chat-scroll" id="chatScroll"></div>${composer}</div>
      <aside class="rb" id="refBoard" aria-label="References"></aside>
    </div>` : `${scriptPanel}<div class="chat-scroll" id="chatScroll"></div>${composer}`}`;
  body.appendChild(panel);

  // gem editor (guided cinematography builder for nb-frames, freetext for others)
  $('#gemEditToggle').onclick = () => $('#gemEditor').classList.toggle('hidden');
  loadGemEditor(gemId);

  // Kling output-mode toggle: single (3 variations) vs multi-shot (count from the prompt)
  if (gemId === 'kling') {
    $$('#klingModeToggle .seg').forEach(b => b.onclick = () => {
      state.klingMode = b.dataset.mode;
      try { localStorage.setItem('avs:klingMode', state.klingMode); } catch {}
      $$('#klingModeToggle .seg').forEach(s => s.classList.toggle('active', s.dataset.mode === state.klingMode));
    });
  }
  // Advisor engine: each engine keeps its own conversation, but what's being written — the text and
  // any attached images — moves across, so flipping the toggle never loses the request.
  $$('#advisorEngine .seg').forEach(b => b.onclick = () => {
    const to = b.dataset.engine;
    if (to === gemId) return;
    try { localStorage.setItem('avs:advisorEngine', to === 'gpt-advisor' ? 'gpt' : 'nb'); } catch {}
    const ta = $('#chatInput');
    if (ta && ta.value.trim()) {
      state.drafts = state.drafts || {};
      state.drafts[`${to}:chatInput`] = ta.value;
      ta.value = '';   // so the outgoing tab doesn't keep a copy of it
    }
    if (state.attachments[gemId]?.length) {
      state.attachments[to] = [...(state.attachments[to] || []), ...state.attachments[gemId]];
      state.attachments[gemId] = [];
    }
    switchTab(to);
  });
  if (gemId === 'storyboard') wireScriptPanel();
  // Clear empties this gem's chat in the open scene only.
  $('#clearChat').onclick = async () => {
    const key = chatKey(gemId);
    await api(`/api/projects/${state.current.id}/chat/clear`, { method: 'POST', body: JSON.stringify({ gemId, ...sceneParam() }) });
    state.current.chats[key] = [];
    renderMessages(gemId);
  };

  state.current.chats = state.current.chats || {};
  state.current.chats[chatKey(gemId)] = state.current.chats[chatKey(gemId)] || [];   // a new gem or scene has no chat doc yet
  state.attachments[gemId] = state.attachments[gemId] || [];
  if (!sd) wireAttachments(panel, gemId);   // Seedance collects its images in the brief builder

  // textarea autosize + enter to send
  const ta = $('#chatInput');
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; };
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(gemId); } };
  $('#sendBtn').onclick = () => sendChat(gemId);

  renderMessages(gemId);
  if (sd) seedance.mount($('#sdMain'));
  else renderAttachments(gemId);
  if (nbf) refboard.mount($('#refBoard'));
}

// The chat composer's image inputs: browse, favorites, kept references, drag & drop, paste.
function wireAttachments(panel, gemId) {
  $('#attachBtn').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = async (e) => {
    for (const f of e.target.files) {
      const data = await fileToB64(f);
      state.attachments[gemId].push({ name: f.name, mimeType: f.type, data, url: URL.createObjectURL(f) });
    }
    renderAttachments(gemId);
    e.target.value = '';
  };

  // add from this project's favorites
  $('#favBtn').onclick = (e) => {
    e.stopPropagation();
    const picker = $('#favPicker');
    const opening = picker.classList.contains('hidden');
    picker.classList.toggle('hidden');
    $('#refPicker')?.classList.add('hidden');
    if (opening) renderFavPicker(gemId);
  };

  // re-attach a reference already used in this project — every image ever attached in a
  // chat is kept, so a file only ever has to be found on disk once
  $('#refBtn').onclick = (e) => {
    e.stopPropagation();
    const picker = $('#refPicker');
    const opening = picker.classList.contains('hidden');
    picker.classList.toggle('hidden');
    $('#favPicker')?.classList.add('hidden');
    if (opening) renderRefPicker(gemId);
  };

  // Kling V2V: the source clip itself, read into frames for the gem (see addClipFrames)
  if (gemId === 'kling-advisor') {
    $('#videoBtn').onclick = () => $('#videoInput').click();
    $('#videoInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addClipFrames(f, gemId); };
  }

  // drag & drop image files from the OS straight into the chat
  panel.addEventListener('dragover', (e) => { if (dragHasFiles(e)) { e.preventDefault(); panel.classList.add('drag-over'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag-over'); });
  panel.addEventListener('drop', async (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    panel.classList.remove('drag-over');
    const video = [...(e.dataTransfer.files || [])].find(f => (f.type || '').startsWith('video/'));
    if (video && gemId === 'kling-advisor') { addClipFrames(video, gemId); return; }
    const files = [...(e.dataTransfer.files || [])].filter(f => (f.type || '').startsWith('image/'));
    if (!files.length) { toast(gemId === 'kling-advisor' ? 'Drop the source video or image files here.' : 'Only image files can be dropped here.', true); return; }
    for (const f of files) {
      const data = await fileToB64(f);
      state.attachments[gemId].push({ name: f.name, mimeType: f.type, data, url: URL.createObjectURL(f) });
    }
    renderAttachments(gemId);
    toast(`${files.length} image${files.length > 1 ? 's' : ''} added.`);
  });

  // paste image(s) into the message box
  const ta = $('#chatInput');
  ta.addEventListener('paste', async (e) => {
    const files = filesFromPaste(e);
    if (!files.length) return;            // text-only → let the default paste happen
    e.preventDefault();
    const text = e.clipboardData.getData('text');   // capture before any await (clipboard is sync)
    if (text) insertAtCursor(ta, text);              // paste text + image(s) together
    for (const f of files) {
      const data = await fileToB64(f);
      state.attachments[gemId].push({ name: f.name || 'pasted.png', mimeType: f.type, data, url: URL.createObjectURL(f) });
    }
    renderAttachments(gemId);
  });
}

// ── Kling V2V: the source clip ────────────────────────────────────────────────
// The gem can't play a video, so the clip is read here, in the browser: a few frames sampled
// across it (4 for a short clip, up to 8 for a long one), sent in time order with their
// timestamps. Only the frames leave the browser — the video itself is never uploaded.
async function sampleVideoFrames(file) {
  const unreadable = `${file.name} can't be read in the browser — export it as MP4 (H.264) and try again.`;
  // Wait for one event on the video; an error or a stall ends the wait instead. Each wait removes
  // its own listeners and timer, so nothing fires once the frames are read.
  const waitFor = (v, ev, ms = 8000) => new Promise((resolve, reject) => {
    const done = (fn, arg) => { clearTimeout(timer); v.removeEventListener(ev, onEvent); v.removeEventListener('error', onError); fn(arg); };
    const onEvent = () => done(resolve);
    const onError = () => done(reject, new Error(unreadable));
    const timer = setTimeout(() => done(reject, new Error(`${file.name} took too long to read — export it as MP4 (H.264) and try again.`)), ms);
    v.addEventListener(ev, onEvent);
    v.addEventListener('error', onError);
  });
  const src = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  try {
    const loaded = waitFor(v, 'loadedmetadata');
    v.src = src;
    await loaded;
    let duration = v.duration;
    if (!Number.isFinite(duration)) {   // some WebMs only learn their length at the end
      const seeked = waitFor(v, 'seeked');
      v.currentTime = 1e9;
      await seeked;
      duration = v.duration;
    }
    if (!Number.isFinite(duration) || duration <= 0 || !v.videoWidth) throw new Error(unreadable);
    const n = duration <= 5 ? 4 : duration <= 10 ? 6 : 8;
    const scale = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale);
    const g = canvas.getContext('2d');
    const frames = [];
    for (let i = 0; i < n; i++) {
      const t = Math.max(0, Math.min(duration - 0.05, (duration * i) / (n - 1)));   // the first frame to (almost) the last
      const seeked = waitFor(v, 'seeked');
      v.currentTime = t;
      await seeked;
      g.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
      frames.push({ t, data: await rawFileToB64(blob), url: URL.createObjectURL(blob) });
    }
    return { frames, duration, width: v.videoWidth, height: v.videoHeight };
  } finally {
    v.removeAttribute('src');
    URL.revokeObjectURL(src);
  }
}
async function addClipFrames(file, gemId) {
  toast(`Reading ${file.name}…`);
  try {
    const { frames, duration, width, height } = await sampleVideoFrames(file);
    const atts = (state.attachments[gemId] || []).filter(a => !a.clip);   // one source clip at a time
    frames.forEach((f, i) => atts.push({ name: `${file.name} @ ${f.t.toFixed(1)}s`, mimeType: 'image/jpeg', data: f.data, url: f.url,
      clip: { name: file.name, t: f.t, i: i + 1, of: frames.length, duration, width, height } }));
    state.attachments[gemId] = atts;
    if (state.activeTab === gemId) renderAttachments(gemId);
    toast(`${frames.length} frames read from ${file.name} (${duration.toFixed(1)}s) — the gem will see them.`);
  } catch (e) { toast(e.message || `Couldn't read ${file.name}.`, true); }
}
// What the gem is told about the clip: which of the attached images are its frames, and when.
function clipManifest(atts) {
  const frames = atts.map((a, i) => ({ a, n: i + 1 })).filter(x => x.a.clip);
  if (!frames.length) return '';
  const c = frames[0].a.clip;
  const nums = frames.map(x => x.n);
  const which = nums.length === atts.length ? `The ${nums.length} attached images are` : `Images ${nums[0]}–${nums[nums.length - 1]} are`;
  return `SOURCE CLIP (video-to-video) — "${c.name}", ${c.duration.toFixed(1)}s, ${c.width}×${c.height}. ${which} frames sampled from it in order, at ${frames.map(x => `${x.a.clip.t.toFixed(1)}s`).join(', ')} — read the clip from them.`;
}

// ── Storyboard from a script ──────────────────────────────────────────────────
function wireScriptPanel() {
  const panel = $('#sbScript'), ta = $('#sbScriptText'), meta = $('#sbScriptMeta'), toggle = $('#sbScriptToggle');
  const count = () => {
    const words = ta.value.trim().split(/\s+/).filter(Boolean).length;
    meta.textContent = words ? `${words.toLocaleString()} words${state.sbScriptName ? ` · ${state.sbScriptName}` : ''}` : '';
  };
  toggle.onclick = () => {
    state.sbScriptOpen = !state.sbScriptOpen;
    panel.classList.toggle('hidden', !state.sbScriptOpen);
    toggle.classList.toggle('on', state.sbScriptOpen);
    if (state.sbScriptOpen) ta.focus();
  };
  ta.addEventListener('input', () => { if (!ta.value.trim()) state.sbScriptName = ''; count(); });
  const load = async (file) => {
    meta.textContent = `Reading ${file.name}…`;
    try {
      const text = (await scriptFileText(file)).trim();
      if (!text) throw new Error(`No text found in ${file.name} — if it's a scanned PDF, paste the script's text instead.`);
      ta.value = text;
      state.sbScriptName = file.name;
      toast(`Loaded ${file.name}.`);
    } catch (e) { toast(e.message || `Couldn't read ${file.name}.`, true); }
    count();
  };
  $('#sbScriptFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) load(f); };
  // A script file dropped on the box loads into it, rather than attaching to the chat as an image.
  ta.addEventListener('dragover', (e) => { if (dragHasFiles(e)) { e.preventDefault(); e.stopPropagation(); ta.classList.add('drag'); } });
  ta.addEventListener('dragleave', () => ta.classList.remove('drag'));
  ta.addEventListener('drop', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    ta.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) load(f);
  });
  $('#sbScriptGo').onclick = buildStoryboardFromScript;
  count();
}

// A script file's text, read in the browser: plain text and Fountain as they are, Final Draft
// (.fdx) from its XML, PDF through pdf.js and Word (.docx) through mammoth — each fetched from the
// CDN the first time it's needed.
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.9.0/mammoth.browser.min.js';
async function scriptFileText(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') {
    const pdfjs = await import(PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_URL.replace('pdf.min.mjs', 'pdf.worker.min.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const { items } = await (await doc.getPage(i)).getTextContent();
      pages.push(items.map(it => it.str + (it.hasEOL ? '\n' : '')).join(''));
    }
    return pages.join('\n\n');
  }
  if (ext === 'docx') {
    if (!window.mammoth) await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MAMMOTH_URL; s.onload = resolve;
      s.onerror = () => reject(new Error("Couldn't load the Word reader — paste the script's text instead."));
      document.head.appendChild(s);
    });
    return (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  if (ext === 'doc') throw new Error('Old .doc files can\'t be read here — save it as .docx or PDF, or paste the text.');
  const text = await file.text();
  if (ext === 'fdx') {
    // Final Draft: one <Paragraph Type="…"> per line; headings, names and transitions in capitals
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    return [...xml.querySelectorAll('Content > Paragraph')].map(p => {
      const line = [...p.querySelectorAll('Text')].map(t => t.textContent).join('');
      return ['Scene Heading', 'Character', 'Transition'].includes(p.getAttribute('Type')) ? line.toUpperCase() : line;
    }).join('\n');
  }
  return text;
}

// The whole script in, exactly N titled frames out — drawn in the project's storyboard style
// (its ⚙ Tune). The chat keeps a one-line note of the run rather than the script itself.
async function buildStoryboardFromScript() {
  const script = $('#sbScriptText').value.trim();
  const frames = Math.max(1, Math.min(30, Math.round(Number($('#sbFrames').value) || 8)));
  $('#sbFrames').value = frames;
  if (!script) { toast('Paste the script or load its file first.', true); return; }
  if (!state.config.hasAnthropic) { toast('Add your ANTHROPIC_API_KEY to .env first.', true); return; }
  const atts = state.attachments.storyboard || [];   // e.g. a character reference, so they stay recognizable
  const btn = $('#sbScriptGo');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Reading the script…';
  const words = script.split(/\s+/).filter(Boolean).length;
  const ok = await runChatTurn('storyboard', {
    sendText: `STORYBOARD FROM SCRIPT — ${frames} frame${frames === 1 ? '' : 's'}.\n\nSCRIPT:\n${script}`,
    display: `📜 Storyboard from a script — ${frames} frame${frames === 1 ? '' : 's'}${state.sbScriptName ? ` · ${state.sbScriptName}` : ''} (${words.toLocaleString()} words)`,
    images: atts.map(a => ({ mimeType: a.mimeType, data: a.data })), history: [], extra: { storyboardFrames: frames },
  });
  if (ok) { state.attachments.storyboard = []; if (state.activeTab === 'storyboard') renderAttachments('storyboard'); }
  const b = $('#sbScriptGo');
  if (b) { b.disabled = false; b.textContent = 'Build storyboard'; }
}

function chatPlaceholder(gemId) {
  return {
    'nb-frames': 'Describe the scene & action — the references on the right carry identity, place and framing…',
    'kling': 'Describe the motion you want from the attached still…',
    'kling-advisor': 'Attach the source clip with 🎬, then say how to restyle / transform it…',
    'nb-advisor': 'Everything will stay the same except… (write what you want to change)',
    'gpt-advisor': 'Describe the swap / edit / image you want (attach the frame + any reference)…',
    'storyboard': 'Describe the frame / shot to draw as a storyboard panel (attach a character reference to keep them recognizable)…',
    'seedance': 'Ask for a change to the last prompt — e.g. make shot 2 slower, move it to night…',
  }[gemId];
}

function renderAttachments(gemId) {
  const wrap = $('#composerAttach');
  if (!wrap) return;
  const atts = state.attachments[gemId] || [];
  wrap.innerHTML = atts.map((a, i) =>
    `<div class="thumb"><img src="${a.url}" />${a.clip ? `<span class="thumb-t" title="Frame ${a.clip.i} of ${a.clip.of} from ${escapeHtml(a.clip.name)}">🎬 ${a.clip.t.toFixed(1)}s</span>` : ''}<button class="rm" data-i="${i}">✕</button></div>`).join('');
  $$('.thumb .rm', wrap).forEach(b => b.onclick = () => { atts.splice(+b.dataset.i, 1); renderAttachments(gemId); });
}

// Build the favorites popover into a container; onPick(im) runs when a favorite is chosen.
function renderFavPickerInto(picker, onPick) {
  if (!picker) return;
  const favs = (state.current?.images || []).filter(i => i.favorite);
  if (!favs.length) {
    picker.innerHTML = `<div class="fav-empty">Nothing liked yet — tap ♥ on images in the Library to keep them here.</div>`;
    return;
  }
  picker.innerHTML = `<div class="fav-head">Add from liked</div>` +
    `<div class="fav-grid">${favs.map(im =>
      `<button class="fav-thumb" type="button" data-file="${im.file}" title="${escapeHtml(im.prompt || '')}"><img src="/media/${state.current.id}/images/${im.file}" loading="lazy" /></button>`).join('')}</div>`;
  $$('.fav-thumb', picker).forEach(b => b.onclick = async () => {
    const im = favs.find(x => x.file === b.dataset.file);
    if (!im) return;
    b.disabled = true;
    await onPick(im);
    picker.classList.add('hidden');
  });
}

// ── Reference picker ─────────────────────────────────────────────────────────
// Every image attached in a chat is kept server-side (deduped on its bytes), so the same
// file never has to be hunted down twice. Newest first — the ones in play are at the top.
// "Save to Assets" promotes one into the curated Assets tab, where it gets a name and @tag.
function renderRefPicker(gemId) {
  const picker = $('#refPicker');
  if (!picker) return;
  const refs = state.current?.references || [];
  if (!refs.length) {
    picker.innerHTML = `<div class="fav-empty">No references yet — every image you attach in a chat is kept here automatically, ready to re-attach.</div>`;
    return;
  }
  picker.innerHTML = `<div class="fav-head">Re-attach a reference · ${refs.length}</div>` +
    `<div class="fav-grid">${refs.map(r =>
      `<div class="ref-cell">` +
        `<button class="fav-thumb" type="button" data-id="${r.id}" title="Attach to this prompt"><img src="${escapeHtml(r.url)}" loading="lazy" /></button>` +
        `<div class="ref-cell-acts">` +
          `<button class="ref-mini" type="button" data-save="${r.id}" title="Save to the Assets tab for reuse">＋</button>` +
          `<button class="ref-mini" type="button" data-del="${r.id}" title="Forget this reference">✕</button>` +
        `</div>` +
      `</div>`).join('')}</div>`;

  // attach
  $$('.fav-thumb', picker).forEach(b => b.onclick = async () => {
    const r = refs.find(x => x.id === b.dataset.id);
    if (!r) return;
    b.disabled = true;
    state.attachments[gemId] = state.attachments[gemId] || [];
    if (state.attachments[gemId].some(a => a.url === r.url)) { toast('Already attached.'); picker.classList.add('hidden'); return; }
    try {
      const blob = await (await mediaFetch(r.url)).blob();
      state.attachments[gemId].push({ name: r.file, mimeType: r.mimeType || blob.type || 'image/jpeg', data: await fileToB64(blob), url: r.url });
      renderAttachments(gemId);
      picker.classList.add('hidden');
    } catch { toast("Couldn't load that reference.", true); b.disabled = false; }
  });

  // promote into the Assets tab
  $$('[data-save]', picker).forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const r = refs.find(x => x.id === b.dataset.save);
    if (!r) return;
    const name = prompt('Save to Assets as:');
    if (!name || !name.trim()) return;
    b.disabled = true;
    try {
      const blob = await (await mediaFetch(r.url)).blob();
      const { character } = await api(`/api/projects/${state.current.id}/characters`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), type: 'prop', asIs: true,
          images: [{ mimeType: r.mimeType || blob.type || 'image/jpeg', data: await fileToB64(blob) }] }),
      });
      state.current.characters = state.current.characters || [];
      state.current.characters.unshift(character);
      toast(`Saved "${character.name}" to Assets.`);
    } catch (err) { toast(err.message, true); }
    b.disabled = false;
  });

  // forget
  $$('[data-del]', picker).forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const rid = b.dataset.del;
    b.disabled = true;
    try {
      await api(`/api/projects/${state.current.id}/references/${rid}`, { method: 'DELETE' });
      state.current.references = (state.current.references || []).filter(x => x.id !== rid);
      renderRefPicker(gemId);
    } catch (err) { toast(err.message, true); b.disabled = false; }
  });
}

// Fetch a saved favorite image into an attachment object {name, mimeType, data, url}.
async function favoriteToAttachment(im) {
  const url = `/media/${state.current.id}/images/${im.file}`;
  const blob = await (await mediaFetch(url)).blob();
  const data = await fileToB64(blob);
  return { name: im.file, mimeType: blob.type || 'image/jpeg', data, url };
}

// Drag an image card (from NB2 results / Library) onto a tab button to attach it there.
const DROP_TABS = ['nb-frames', 'seedance', 'kling-advisor', 'nb-advisor', 'gpt-advisor', 'storyboard', 'generate', 'swap'];
async function urlToAttachment(url) {
  const blob = await (await mediaFetch(url)).blob();
  const data = await fileToB64(blob);
  return { name: url.split('/').pop() || 'image', mimeType: blob.type || 'image/jpeg', data, url };
}
async function dropImageOnTab(tab, url) {
  if (!DROP_TABS.includes(tab) || !state.current) return;
  // Seedance sorts its images into roles, so a dropped one waits in the Unsorted tray.
  if (tab === 'seedance') {
    const adding = seedance.addToInbox(url);
    switchTab('seedance');
    if (await adding) toast('Image added to Seedance — drag it into its section.');
    return;
  }
  try {
    const att = await urlToAttachment(url);
    switchTab(tab);
    if (tab === 'swap') {
      state.swap = state.swap || { base: null, char: null, prompt: '', model: 'flux' };
      const which = !state.swap.base ? 'base' : (!state.swap.char ? 'char' : 'base');
      state.swap[which] = { data: att.data, mimeType: att.mimeType, preview: url };
      renderSwap($('#wsBody'));
      toast(`Image sent to Swap (image ${which === 'base' ? '1' : '2'}).`);
      return;
    }
    if (tab === 'generate') {
      if (!state.refImages.some(r => r.url === url)) state.refImages.push(att);
      renderRefImages();
    } else {
      state.attachments = state.attachments || {};
      state.attachments[tab] = state.attachments[tab] || [];
      if (!state.attachments[tab].some(r => r.url === url)) state.attachments[tab].push(att);
      renderAttachments(tab);
    }
    const label = tab === 'generate' ? 'Nano Banana 2' : (GEM_META[tab]?.name || tab);
    toast(`Image sent to ${label}.`);
  } catch { toast('Could not add that image.', true); }
}

// Chat composer: add a favorite as a message attachment.
function renderFavPicker(gemId) {
  renderFavPickerInto($('#favPicker'), async (im) => {
    try {
      const att = await favoriteToAttachment(im);
      state.attachments[gemId] = state.attachments[gemId] || [];
      state.attachments[gemId].push(att);
      renderAttachments(gemId);
      toast('Added from liked.');
    } catch { toast('Could not add that image.', true); }
  });
}

// Generator: add a favorite as a reference image.
function renderGenFavPicker() {
  renderFavPickerInto($('#genFavPicker'), async (im) => {
    try {
      state.refImages.push(await favoriteToAttachment(im));
      renderRefImages();
      toast('Reference added from liked.');
    } catch { toast('Could not add that image.', true); }
  });
}

function renderMessages(gemId) {
  const scroll = $('#chatScroll');
  if (!scroll) return;
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  const prevTop = scroll.scrollTop;
  const msgs = state.current.chats[chatKey(gemId)] || [];
  if (msgs.length === 0) {
    const where = activeScene() === GENERAL ? '' : ` in ${escapeHtml(scenes.label(activeScene()))}`;
    scroll.innerHTML = `<div class="gen-empty">No messages yet${where}. ${GEM_META[gemId].name} is ready when you are.</div>`;
    return;
  }
  // Render messages; assistant prompts carry the most recent attached image(s) as references.
  let refImgs = [];
  scroll.innerHTML = msgs.map((m, i) => {
    if (m.role === 'user') {
      // Reset per user turn: a text-only turn carries NO reference, so an assistant reply never
      // inherits a PREVIOUS prompt's image (matches the server, which only sends the current
      // turn's images). This was the "stale / irrelevant reference gets attached" bug.
      refImgs = (m.images && m.images.length) ? m.images : [];
      return renderMsg(m, [], i);
    }
    return renderMsg(m, refImgs, i);
  }).join('');
  // Advisor & Tweaks: "Try it here" and the options it made
  $$('.try-here', scroll).forEach(b => b.onclick = () => toggleTry(b));
  $$('.cand', scroll).forEach(wireCandidates);
  // wire copy buttons + generate links
  $$('.copy-block', scroll).forEach(b => b.onclick = async () => {
    const ok = await copyTextToClipboard(decodeURIComponent(b.dataset.text));
    b.textContent = ok ? 'copied' : 'copy failed';
    setTimeout(() => b.textContent = 'copy', 1400);
  });
  $$('.gen-link', scroll).forEach(b => b.onclick = () => sendPromptToGenerator(b));
  $$('.gen-all', scroll).forEach(b => b.onclick = () => sendAllToGenerator(b));
  $$('.reuse-prompt', scroll).forEach(b => b.onclick = () => reusePromptInComposer(b));
  $$('.more-like', scroll).forEach(b => b.onclick = () => toggleMoreLike(b));
  $$('.gpt-copy', scroll).forEach(b => b.onclick = () => copyForChatGPT(b));
  $$('.msg-copy', scroll).forEach(b => b.onclick = () => copyUserBlock(b));
  $$('.ref-thumb', scroll).forEach(t => t.onclick = () => openLightbox([{ src: t.dataset.full, caption: t.title || 'Reference this output was built from' }], 0));
  $$('.up-dl', scroll).forEach(b => b.onclick = () => downloadUploadOrder(b));
  // A message's images drag like any image in the app — onto NB Frames' board, a tab, or out.
  $$('.chat-att-thumb, .ref-thumb', scroll).forEach(img => {
    img.setAttribute('draggable', 'true');
    img.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/avs-image', img.src); e.dataTransfer.effectAllowed = 'copy'; });
  });
  scroll.scrollTop = nearBottom ? scroll.scrollHeight : prevTop;
}

// Reuse a generated prompt in THIS gem's composer: drop the text into the input and
// re-attach its reference image(s), so text + images are staged ready to edit, copy, or resend.
async function reusePromptInComposer(btn) {
  const gemId = state.activeTab;
  const prompt = decodeURIComponent(btn.dataset.text || '');
  let imgs = [];
  try { imgs = JSON.parse(decodeURIComponent(btn.dataset.imgs || '%5B%5D')); } catch {}
  const ta = $('#chatInput');
  if (ta) { ta.value = prompt; ta.dispatchEvent(new Event('input')); ta.focus(); }
  // Seedance keeps its images in the brief builder, so only the text comes back.
  if (gemId === 'seedance') { toast('Prompt loaded into the follow-up box — edit it and send, or copy it.'); return; }
  // NB Frames: images sent from the reference board go back to their sections — onto an empty
  // board only; one in use stays as it is.
  let restored = 0, onBoard = 0;
  if (gemId === 'nb-frames') {
    onBoard = imgs.filter(im => im.role).length;
    restored = await refboard.restore(imgs, state.current.id);
    imgs = imgs.filter(im => !im.role);
  }
  state.attachments[gemId] = state.attachments[gemId] || [];
  let added = 0;
  for (const im of imgs) {
    const url = `/media/${state.current.id}/uploads/${im.file}`;
    if (state.attachments[gemId].some(r => r.url === url)) continue;
    try {
      const blob = await (await mediaFetch(url)).blob();
      const data = await fileToB64(blob);
      state.attachments[gemId].push({ name: im.file, mimeType: im.mimeType || blob.type || 'image/jpeg', data, url });
      added++;
    } catch { /* skip an image that can't be fetched */ }
  }
  if (added) renderAttachments(gemId);
  const board = restored ? ` ${restored} reference${restored > 1 ? 's' : ''} back on the board.`
    : onBoard ? ' The board already has references, so it was left as it is.' : '';
  toast((added
    ? `Prompt + ${added} reference image${added > 1 ? 's' : ''} loaded into the composer — ready to edit, copy, or resend.`
    : 'Prompt loaded into the composer — ready to edit, copy, or resend.') + board);
}

// "More like this": a small form under the prompt's buttons for an optional note on how to push
// it, then a new turn asking the same gem for fresh directions built on that one prompt.
function toggleMoreLike(btn) {
  const row = btn.closest('.pc-actions');
  const open = row.nextElementSibling?.classList.contains('ml-form') ? row.nextElementSibling : null;
  if (open) { open.remove(); btn.classList.remove('on'); return; }
  const form = document.createElement('div');
  form.className = 'ml-form';
  form.innerHTML = `
    <textarea class="ml-guide" dir="auto" rows="2" placeholder="Optional — how to push or tighten it (e.g. tighter framing, warmer light, more energy)…"></textarea>
    <div class="ml-row"><button class="ml-go" type="button">✦ Get more directions</button><button class="ml-cancel" type="button">Cancel</button></div>`;
  row.after(form);
  btn.classList.add('on');
  const guide = form.querySelector('.ml-guide');
  guide.focus();
  form.querySelector('.ml-cancel').onclick = () => { form.remove(); btn.classList.remove('on'); };
  const go = () => moreLikeThis(btn, guide.value.trim(), form);
  form.querySelector('.ml-go').onclick = go;
  guide.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } };
}

async function moreLikeThis(btn, guidance, form) {
  const gemId = state.activeTab;
  const prompt = decodeURIComponent(btn.dataset.text || '');
  if (!prompt) return;
  if (!state.config.hasAnthropic) { toast('Add your ANTHROPIC_API_KEY to .env first.', true); return; }
  let imgs = [];
  try { imgs = JSON.parse(decodeURIComponent(btn.dataset.imgs || '%5B%5D')); } catch {}
  const go = form.querySelector('.ml-go');
  go.disabled = true; go.innerHTML = '<span class="spinner"></span>Asking…';
  // the reference image(s) the liked prompt was written from, so the new directions stay on them —
  // each with its board role, if it had one, so "image 3" still means the same person
  const images = [];
  for (const im of imgs) {
    try {
      const blob = await (await mediaFetch(`/media/${state.current.id}/uploads/${im.file}`)).blob();
      images.push({ mimeType: im.mimeType || blob.type || 'image/jpeg', data: await fileToB64(blob), ...refRole(im) });
    } catch { /* skip one that can't be fetched */ }
  }
  form.remove();
  btn.classList.remove('on');
  const sendText = `MORE LIKE THIS — I like this prompt. Give me more directions built on it.${guidance ? `\nHow to push it: ${guidance}` : ''}\n\nTHE PROMPT:\n${prompt}`;
  await runChatTurn(gemId, { sendText, display: `✦ More like this${guidance ? ` — ${guidance}` : ''}`, images, history: [], extra: { moreLike: true } });
}

// Copy for ChatGPT (GPT Advisor): put the prompt on the clipboard AND download the turn's
// reference image(s), so the hand-off is one click — drag the images into ChatGPT, paste the
// prompt. (The browser clipboard can't carry multiple images for pasting, so images download.)
async function copyForChatGPT(btn) {
  const prompt = decodeURIComponent(btn.dataset.text || '');
  let imgs = [];
  try { imgs = JSON.parse(decodeURIComponent(btn.dataset.imgs || '%5B%5D')); } catch {}
  if (prompt) await copyTextToClipboard(prompt);
  let n = 0;
  for (const im of imgs) {
    const url = `/media/${state.current.id}/uploads/${im.file}`;
    try {
      const blob = await (await mediaFetch(url)).blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href; a.download = im.file || `reference-${n + 1}.jpg`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 15000);
      n++;
    } catch { /* skip an image that can't be fetched */ }
  }
  toast(n
    ? `Prompt copied + ${n} reference image${n > 1 ? 's' : ''} downloaded — drag them into ChatGPT, then paste the prompt.`
    : (prompt ? 'Prompt copied — this turn had no reference image to download.' : 'Nothing to copy.'));
}

// Copy a SENT (user) message's whole block: text to the clipboard, and the text + its
// reference image(s) back into this tab's composer — ready to resend, tweak, or send on.
async function copyUserBlock(btn) {
  const t = decodeURIComponent(btn.dataset.text || ''); if (t) await copyTextToClipboard(t);
  await reusePromptInComposer(btn);
}

// Where a prompt on a chat button came from: this gem, this scene's chat, that message.
function promptOrigin(btn) {
  const gem = state.activeTab, index = Number(btn.closest('.msg')?.dataset.index);
  return GEM_META[gem] ? { gem, chat: chatKey(gem), ...(Number.isInteger(index) && index >= 0 ? { index } : {}) } : null;
}

// Send a prompt to the generator, carrying its relevant reference image(s) from the chat.
function sendPromptToGenerator(btn) {
  const prompt = decodeURIComponent(btn.dataset.text || '');
  let imgs = [];
  try { imgs = JSON.parse(decodeURIComponent(btn.dataset.imgs || '%5B%5D')); } catch {}
  // "Send to NB" REPLACES the generator: drop any previously attached reference(s) up front,
  // then load only this prompt's text + its own reference image(s).
  state.refImages = [];
  state.genFrom = promptOrigin(btn);   // the recipe of what it makes names the gem chat it came from
  switchTab('generate');
  setTimeout(async () => {
    const t = $('#genPrompt');
    if (t) { t.value = prompt; t.dispatchEvent(new Event('input')); }
    const title = $('#genTitle');   // a storyboard frame's title rides along (cleared otherwise)
    if (title) title.value = decodeURIComponent(btn.dataset.title || '');
    let added = 0;
    for (const im of imgs) {
      const url = `/media/${state.current.id}/uploads/${im.file}`;
      try {
        const blob = await (await mediaFetch(url)).blob();
        const data = await fileToB64(blob);
        state.refImages.push({ name: im.file, mimeType: im.mimeType || blob.type || 'image/jpeg', data, url, ...refRole(im) });
        added++;
      } catch { /* skip an image that can't be fetched */ }
    }
    renderRefImages();
    toast(added ? `Prompt + ${added} reference image${added > 1 ? 's' : ''} sent (generator reset).` : 'Prompt sent (generator reset).');
  }, 60);
}

// A reference image's role from NB Frames' board (its label, role and name), when it has one —
// it travels with the image so Nano Banana is told "Image 3 — CHARACTER "Maya" …".
const refRole = (im) => (im?.label ? { label: im.label, ...(im.role ? { role: im.role } : {}), ...(im.refName ? { refName: im.refName } : {}) } : {});
// The small badge on a reference thumbnail: its number, and its role's icon when it has one.
const ROLE_ICON = { composition: '🧭', location: '🏙', character: '👤', prop: '🎬', look: '🎨', start: '▶', end: '⏹' };
const ROLE_NAME = { composition: 'Composition', location: 'Location', character: 'Character', prop: 'Prop', look: 'Look', start: 'Start frame', end: 'End frame' };
// The Video tab: under each prompt, the files to upload with it, numbered as the prompt tags them —
// OpenArt and Higgsfield name uploads @image1, @image2 … in the order they go in.
function uploadOrderHtml(refImgs) {
  const items = refImgs.map((im, i) => {
    const url = `/media/${state.current.id}/uploads/${im.file}`;
    const what = [ROLE_NAME[im.role], im.refName].filter(Boolean).join(' · ') || 'Reference';
    return `<li><img class="ref-thumb" src="${url}" data-full="${url}" loading="lazy" title="${escapeHtml(`@image${i + 1} — ${im.label || what}`)}" />
      <span><b>@image${i + 1}</b><small dir="auto">${escapeHtml(what)}</small></span></li>`;
  }).join('');
  return `<div class="up-order">
    <div class="up-head"><b>Upload in this order</b><button class="up-dl" type="button" data-imgs="${encodeURIComponent(JSON.stringify(refImgs))}" title="Download them numbered in this order (the copies sent with the brief)">⬇ In order</button></div>
    <ol class="up-list">${items}</ol>
  </div>`;
}
async function downloadUploadOrder(btn) {
  let imgs = [];
  try { imgs = JSON.parse(decodeURIComponent(btn.dataset.imgs || '%5B%5D')); } catch {}
  btn.disabled = true;
  let n = 0;
  for (const [i, im] of imgs.entries()) {
    try {
      const blob = await (await mediaFetch(`/media/${state.current.id}/uploads/${im.file}`)).blob();
      const what = tagSlug(im.refName) || im.role || 'reference';
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href; a.download = `${String(i + 1).padStart(2, '0')}-image${i + 1}-${what}.${/png/.test(blob.type) ? 'png' : 'jpg'}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 15000);
      n++;
      await new Promise(r => setTimeout(r, 200));   // browsers drop downloads fired back to back
    } catch { /* skip one that can't be fetched */ }
  }
  btn.disabled = false;
  toast(n ? `Downloaded ${n}, numbered in upload order.` : 'Nothing could be downloaded.', !n);
}
const refBadge = (n, im) => `<span class="ref-n" title="${escapeHtml(im?.label ? `Image ${n} — ${im.label}` : `Image ${n}`)}">${n}${ROLE_ICON[im?.role] ? ` ${ROLE_ICON[im.role]}` : ''}</span>`;

// "Send all N": first open a REVIEW popup so the user can verify / edit the reference
// image(s) the frames will generate with — then fire them all in parallel.
let _sendAll = null;
let _saPickerOpen = false;
let _saPasteWired = false;
// Paste an image (Ctrl/⌘V) directly into the open Send-all popup → add it as a reference.
function wireSendAllPaste() {
  if (_saPasteWired) return; _saPasteWired = true;
  document.addEventListener('paste', async (e) => {
    const modal = $('#sendAllModal');
    if (!_sendAll || !modal || modal.classList.contains('hidden')) return;   // only while the popup is open
    const files = filesFromPaste(e);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      try { _sendAll.refs.push({ mimeType: f.type || 'image/png', data: await fileToB64(f), thumbUrl: URL.createObjectURL(f) }); } catch {}
    }
    renderSendAllModal();
    toast(`Reference image${files.length > 1 ? 's' : ''} pasted.`);
  });
}
// Reference images already used anywhere in this project (deduped, newest-first) — pickable in the Send-all popup.
function recentProjectRefs() {
  const seen = new Set(), out = [];
  for (const img of (state.current?.images || [])) {
    for (const r of (img.refs || [])) {
      const file = r.file || (r.url ? r.url.split('/').pop() : null);
      if (!file || seen.has(file)) continue;
      seen.add(file);
      out.push({ file, mimeType: r.mimeType || 'image/jpeg', thumbUrl: r.url || `/media/${state.current.id}/uploads/${file}` });
    }
  }
  return out.slice(0, 24);
}
function sendAllToGenerator(btn) {
  let prompts = [], imgs = [], titles = [];
  try { prompts = JSON.parse(decodeURIComponent(btn.dataset.prompts || '%5B%5D')); } catch {}
  try { imgs = JSON.parse(decodeURIComponent(btn.dataset.imgs || '%5B%5D')); } catch {}
  try { titles = JSON.parse(decodeURIComponent(btn.dataset.titles || '%5B%5D')); } catch {}
  // each frame keeps its own title, so drop the empty prompts as pairs
  const frames = prompts.map((p, i) => ({ prompt: p, title: titles[i] || '' })).filter(f => f.prompt && f.prompt.trim());
  if (!frames.length) return;
  if (!state.config.hasGemini) { toast('Add your GEMINI_API_KEY to .env first.', true); return; }
  // Working reference set: the frames' own reference(s) — with their board roles — + anything the
  // user adds in the popup.
  const refs = imgs.map(im => ({ mimeType: im.mimeType || 'image/jpeg', file: im.file, thumbUrl: `/media/${state.current.id}/uploads/${im.file}`, ...refRole(im) }));
  _sendAll = { prompts: frames.map(f => f.prompt), titles: frames.map(f => f.title), refs, from: promptOrigin(btn) };
  _saPickerOpen = false;
  renderSendAllModal();
}

function renderSendAllModal() {
  if (!_sendAll) return;
  const { prompts, refs } = _sendAll;
  const nm = state.nbModel || 'nb2';
  const recentRefs = recentProjectRefs();
  let modal = $('#sendAllModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'sendAllModal'; modal.className = 'modal-overlay'; document.body.appendChild(modal); }
  const thumbs = refs.length
    ? refs.map((r, i) => `<div class="sa-ref"><img src="${r.thumbUrl}" loading="lazy" />${refs.some(x => x.label) ? refBadge(i + 1, r) : ''}<button class="sa-ref-x" data-i="${i}" title="Remove this reference">×</button></div>`).join('')
    : `<div class="sa-none">No reference attached — the ${prompts.length} frames will generate from the prompt text alone. Add one below if they should use a reference.</div>`;
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-head"><h3>Send all ${prompts.length} to Nano Banana ${nm === 'pro' ? 'Pro' : '2'}</h3><button class="modal-x" id="saCancel">✕</button></div>
      <p class="modal-sub">These ${prompts.length} frames will generate with the reference(s) below. Remove any that are wrong, add another, or paste (Ctrl/⌘V) one straight in — then generate.</p>
      <div class="sa-refs">${thumbs}</div>
      <div class="sa-addwrap">
        <button class="sa-add" id="saAddBtn" type="button">＋ Add reference</button>
        <div class="sa-picker ${_saPickerOpen ? '' : 'hidden'}" id="saPicker">
          <label class="sa-pick-upload">⬆ Upload from device<input type="file" id="saFile" accept="image/*" multiple hidden /></label>
          ${recentRefs.length
            ? `<div class="sa-pick-head">Recent references in this project</div><div class="sa-pick-grid">${recentRefs.map((r, i) => `<button class="sa-pick-thumb${_sendAll.refs.some(x => x.file === r.file) ? ' picked' : ''}" type="button" data-ri="${i}" title="Use this reference"><img src="${r.thumbUrl}" loading="lazy" /></button>`).join('')}</div>`
            : `<div class="sa-pick-empty">No recent references in this project yet — upload one above.</div>`}
        </div>
      </div>
      <div class="sa-model">
        <span class="sa-model-lbl">Model</span>
        <div class="mode-toggle" id="saModelToggle" title="NB2 = fast, ~half the cost. NB Pro = max fidelity for faces / identity / jewelry, up to 4K (~2× cost).">
          <button class="seg ${nm === 'nb2' ? 'active' : ''}" data-model="nb2" type="button">NB2 · fast</button>
          <button class="seg ${nm === 'pro' ? 'active' : ''}" data-model="pro" type="button">NB&nbsp;Pro · max fidelity</button>
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-btn ghost" id="saCancel2">Cancel</button>
        <button class="modal-btn accent" id="saGo">⚡ Generate ${prompts.length} →</button>
      </div>
    </div>`;
  modal.classList.remove('hidden');
  const close = () => { modal.classList.add('hidden'); _sendAll = null; _saPickerOpen = false; };
  wireSendAllPaste();   // paste (Ctrl/⌘V) a reference directly into the open popup
  $('#saCancel', modal).onclick = close;
  $('#saCancel2', modal).onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $$('.sa-ref-x', modal).forEach(b => b.onclick = () => { _sendAll.refs.splice(+b.dataset.i, 1); renderSendAllModal(); });
  $$('#saModelToggle .seg', modal).forEach(b => b.onclick = () => { state.nbModel = b.dataset.model; try { localStorage.setItem('avs:nbModel', state.nbModel); } catch {} renderSendAllModal(); });
  $('#saAddBtn', modal).onclick = () => { _saPickerOpen = !_saPickerOpen; $('#saPicker', modal).classList.toggle('hidden', !_saPickerOpen); };
  $$('.sa-pick-thumb', modal).forEach(b => b.onclick = () => {
    const r = recentRefs[+b.dataset.ri];
    if (r && !_sendAll.refs.some(x => x.file === r.file)) _sendAll.refs.push({ mimeType: r.mimeType, file: r.file, thumbUrl: r.thumbUrl });
    _saPickerOpen = true;
    renderSendAllModal();
  });
  $('#saFile', modal).onchange = async (e) => {
    for (const f of e.target.files) {
      try { _sendAll.refs.push({ mimeType: f.type || 'image/jpeg', data: await fileToB64(f), thumbUrl: URL.createObjectURL(f) }); } catch {}
    }
    renderSendAllModal();
  };
  $('#saGo', modal).onclick = async () => {
    const { prompts, refs, titles, from } = _sendAll;
    close();
    // Resolve every reference to base64 — freshly-uploaded ones already have data; existing
    // ones are fetched from /media.
    const refImages = [];
    for (const r of refs) {
      if (r.data) { refImages.push({ mimeType: r.mimeType, data: r.data, ...refRole(r) }); continue; }
      try {
        const blob = await (await mediaFetch(r.thumbUrl)).blob();
        refImages.push({ mimeType: r.mimeType || blob.type || 'image/jpeg', data: await fileToB64(blob), ...refRole(r) });
      } catch { /* skip a ref that can't be fetched */ }
    }
    runSendAll(prompts, refImages, titles, from);
  };
}

// Fire every prompt in parallel (one image each) and drop the results into the NB2 grid.
// titles[i], when there is one (a storyboard frame's), is stored on that prompt's image; from —
// the gem chat the prompts came from — goes into every image's recipe.
async function runSendAll(prompts, refImages, titles = [], from = null) {
  if (state.generating) { toast('A generation is already running — wait for it to finish.', true); return; }
  switchTab('generate');
  await new Promise(r => setTimeout(r, 0));   // let the generate tab paint
  const aspectRatio = $('#genAR')?.value || undefined;
  const scene = sceneParam();                  // they land in the scene they were sent from
  const grid = ensureGenGrid();
  state.generating = true;
  const t0 = Date.now();
  grid.insertAdjacentHTML('afterbegin', prompts.map(() =>
    '<div class="skeleton gen-skel"><div class="gen-load"><span class="spinner-lg"></span><span class="gen-load-label">Generating…</span><span class="gen-load-time">0s</span></div></div>'
  ).join(''));
  const genTimer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    $$('.gen-skel .gen-load-time', grid).forEach(el => el.textContent = s + 's');
  }, 1000);
  const jobs = prompts.map((prompt, i) =>
    api(`/api/projects/${state.current.id}/generate`, {
      method: 'POST', body: JSON.stringify({ prompt, count: 1, aspectRatio, refImages, model: state.nbModel, title: titles[i] || '', ...scene, ...(from ? { from } : {}) }),
    }).then(r => r.images || []).catch(() => [])
  );
  const results = (await Promise.all(jobs)).flat();
  clearInterval(genTimer);
  $$('.gen-skel', grid).forEach(s => s.remove());
  if (results.length) {
    state.current.images = [...results.map(stripUrl), ...state.current.images];
    grid.insertAdjacentHTML('afterbegin', results.map(imgCard).join(''));
    $$('.img-card', grid).slice(0, results.length).forEach(c => c.classList.add('gen-reveal'));
    wireImageCards(grid);
    toast(`${results.length} of ${prompts.length} generated`);
  } else {
    toast('All generations failed — try again.', true);
  }
  state.generating = false;
}

// index: the message's place in its chat — how "Try it here" and its options find their reply.
function renderMsg(m, refImgs = [], index = -1) {
  const tag = m.role === 'user' ? 'YOU' : GEM_META[state.activeTab]?.name?.toUpperCase() || 'CLAUDE';
  let content;
  if (m.role === 'assistant') {
    content = renderAssistant(m.content, refImgs) + (ADVISOR_TABS.includes(state.activeTab) ? candHtml(m, index, refImgs) : '');
  } else {
    let strip = '';
    if (m.images && m.images.length) {
      // images sent from NB Frames' board show their number and role, as the gem received them
      const labeled = m.images.some(im => im.label);
      strip = `<div class="chat-images-strip">${m.images.map((im, i) =>
        `<span class="chat-att"${im.label ? ` title="${escapeHtml(`Image ${i + 1} — ${im.label}`)}"` : ''}><img class="chat-att-thumb" src="/media/${state.current.id}/uploads/${im.file}" loading="lazy" />${labeled ? refBadge(i + 1, im) : ''}</span>`).join('')}</div>`;
    } else if (m.hadImages) {
      strip = '<div class="chat-images-strip"><em style="font-size:11px;color:var(--ink-faint)">+ attached image(s)</em></div>';
    }
    const copyBtn = (m.content || (m.images && m.images.length))
      ? `<button class="msg-copy" data-text="${encodeURIComponent(m.content || '')}" data-imgs="${encodeURIComponent(JSON.stringify(m.images || []))}" title="Copy this message: text to clipboard + the whole block (text and reference images) back into the composer">⧉ copy</button>`
      : '';
    content = escapeHtml(m.content) + strip + copyBtn;
  }
  return `<div class="msg ${m.role}" data-index="${index}"><div class="role-tag">${tag}</div><div class="bubble">${content}</div></div>`;
}

// Copy TEXT ONLY to the clipboard, reliably. writeText replaces the ENTIRE clipboard, so it
// also clears any image left there from an earlier copy — otherwise a paste target like
// OpenArt grabs that stale image and rejects it ("image size invalid"). Falls back to
// execCommand when the async Clipboard API is blocked, so the copy never silently no-ops
// and leaves the old image on the clipboard while the button falsely says "copied".
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the execCommand path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// Render assistant text: turn ```code``` blocks and PROMPT n labels into rich cards.
// refImgs = the relevant attached image(s) to carry to the generator with the prompt.
function renderAssistant(text, refImgs = []) {
  const imgsAttr = `data-imgs="${encodeURIComponent(JSON.stringify(refImgs || []))}"`;
  // Reference strip: show the image(s) this output was actually built from, so a wrong or
  // stale reference is visible at a glance. Click a thumb to enlarge in the lightbox.
  let refStrip = '';
  if (refImgs && refImgs.length && state.current && state.activeTab === 'seedance') refStrip = uploadOrderHtml(refImgs);
  else if (refImgs && refImgs.length && state.current) {
    const labeled = refImgs.some(im => im.label);
    refStrip = `<div class="ref-strip"><span class="ref-label">reference</span>` +
      refImgs.map((im, i) => {
        const url = `/media/${state.current.id}/uploads/${im.file}`;
        const title = im.label ? `Image ${i + 1} — ${im.label}` : 'Reference this output was built from — click to enlarge';
        return `<span class="ref-cellx"><img class="ref-thumb" src="${url}" data-full="${url}" loading="lazy" title="${escapeHtml(title)}" />${labeled ? refBadge(i + 1, im) : ''}</span>`;
      }).join('') + `</div>`;
  }
  // Split fenced code blocks first
  const parts = text.split(/```(?:[a-zA-Z]*\n)?/);
  let html = '';
  parts.forEach((seg, i) => {
    if (i % 2 === 1) {
      // code block
      const enc = encodeURIComponent(seg.trimEnd());
      html += `<pre><button class="copy-block" data-text="${enc}">copy</button>${escapeHtml(seg.trimEnd())}</pre>` +
        `<div class="pc-actions">${tryBtn(enc)}<button class="reuse-prompt" data-text="${enc}" ${imgsAttr}>↻ Reuse prompt</button>` +
        moreLikeBtn(enc, imgsAttr) +
        (state.activeTab === 'gpt-advisor' ? `<button class="gpt-copy" data-text="${enc}" ${imgsAttr} title="Copy the prompt to your clipboard and download the reference image(s) — drag them into ChatGPT, then paste the prompt">⧉ Copy for ChatGPT</button>` : '') +
        (!state.activeTab.startsWith('kling') && state.activeTab !== 'seedance' ? `<button class="gen-link" data-text="${enc}" ${imgsAttr}>⚡ Send to Nano Banana 2</button>` : '') +
        `</div>`;
    } else {
      // Kling single shot: the line right above each block names its archetype. Show it under
      // its display name, with a ? that explains the direction (see KLING_ARCHETYPES).
      const arch = state.activeTab === 'kling' && i + 1 < parts.length ? splitKlingLabel(seg) : null;
      html += arch ? formatProse(arch.before, imgsAttr) + klingLabel(arch.archetype) : formatProse(seg, imgsAttr);
    }
  });
  return refStrip + html;
}

// The Kling gem (gems/kling.txt, MODE A) labels its three variations in English. The app shows
// them by these names instead; old replies pick the new names up too, since this runs at render.
const KLING_ARCHETYPES = [
  { match: /^high[\s-]*fidelity/i, name: 'דיוק ועקביות',
    tip: 'מינימום תנועה, כדי שהפנים, הזהות והמרקם יישארו נאמנים לתמונה. הבחירה הבטוחה לתקריבים.',
    focus: 'תנועת מצלמה עדינה, נשימה ומיקרו-הבעות, אור על העור, שיער והשתקפויות בעיניים.' },
  { match: /^physics/i, name: 'דינמי',
    tip: 'תנועה פיזיקלית אמינה, עם משקל ותנופה. לאקשן: ריצה, קפיצה, משהו שנופל או נשפך.',
    focus: 'מצלמה דינמית, בד שמתנופף, התזות ורסיסים, סביבה שמגיבה, ותנועה שנגמרת במצב סופי ברור.' },
  { match: /^cinematic/i, name: 'התפתחות',
    tip: 'הסצנה מתפתחת ומספרת משהו לאורך הקליפ. הכי הרבה שינוי, ולכן גם הכי הרבה סיכון לסטות מהתמונה.',
    focus: 'רצף של תנועות מצלמה, מעבר בזמן ("מתחיל... ואז..."), שינויי תאורה, חשיפה הדרגתית, עשן, גשם וניאון.' },
];
// The gem's label line, if seg ends with one: "High Fidelity (Portrait / Static Focus)", also
// when the model numbers it ("1.", "Option 1 —") or wraps it in ** / #. Shot labels never match.
function splitKlingLabel(seg) {
  const lines = seg.replace(/\s+$/, '').split('\n');
  const label = (lines.pop() || '').replace(/[*#_`]/g, '')
    .replace(/^\s*(?:(?:option|variation|archetype)\s*)?\d+\s*[.):—–-]*\s*/i, '').trim();
  const archetype = KLING_ARCHETYPES.find(a => a.match.test(label));
  return archetype ? { before: lines.join('\n'), archetype } : null;
}
const klingLabel = (a) =>
  `<div class="kling-arch" dir="rtl"><span class="ka-name">${a.name}</span>` +
  `<span class="ka-help-wrap"><button type="button" class="ka-help" aria-label="מה עומד מאחורי ${a.name}">?</button>` +
  `<span class="ka-tip" role="tooltip"><span>${escapeHtml(a.tip)}</span><span><b>פוקוס:</b> ${escapeHtml(a.focus)}</span></span></span></div>`;

// ── Advisor & Tweaks: "Try it here" ─────────────────────────────────────────────
// A prompt runs right in its chat — Nano Banana for the Nano Banana advisor, GPT Image for the GPT
// one — on the turn's attached image(s). The options stay on the reply, beside the source, to
// flip through; only the one kept goes to the Library, and another can still be kept later.
const ADVISOR_TABS = ['nb-advisor', 'gpt-advisor'];
const tryBtn = (enc) => (ADVISOR_TABS.includes(state.activeTab)
  ? `<button class="try-here" data-text="${enc}" title="Generate it right here, beside the source — only the option you keep goes to the Library">▶ Try it here</button>` : '');
const tryEngine = () => (state.activeTab === 'gpt-advisor' ? 'GPT Image 2' : `Nano Banana ${state.nbModel === 'pro' ? 'Pro' : '2'}`);
state.tries = {};       // "key:index" → how many options are being made for that reply
state.candView = {};    // "key:index" → which option the viewer shows
state.candFlip = {};    // "key:index" → showing the source in the option's place

function toggleTry(btn) {
  const row = btn.closest('.pc-actions');
  const open = row.nextElementSibling?.classList.contains('try-form') ? row.nextElementSibling : null;
  if (open) { open.remove(); btn.classList.remove('on'); return; }
  const form = document.createElement('div');
  form.className = 'try-form';
  const n = Number(localStorage.getItem('avs:tryCount')) || 2;
  form.innerHTML = `
    <span class="try-engine">${escapeHtml(tryEngine())}</span>
    ${state.activeTab === 'nb-advisor' ? `<div class="mode-toggle try-model"><button class="seg ${state.nbModel === 'pro' ? '' : 'active'}" data-model="nb2" type="button">NB2</button><button class="seg ${state.nbModel === 'pro' ? 'active' : ''}" data-model="pro" type="button">Pro</button></div>` : ''}
    <label class="try-n-label">Options <select class="try-n">${[1, 2, 3, 4].map(k => `<option value="${k}"${k === n ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
    <button class="try-go" type="button">▶ Generate</button><button class="try-cancel" type="button">Cancel</button>`;
  row.after(form);
  btn.classList.add('on');
  $$('.try-model .seg', form).forEach(b => b.onclick = () => {
    state.nbModel = b.dataset.model;
    try { localStorage.setItem('avs:nbModel', state.nbModel); } catch {}
    $$('.try-model .seg', form).forEach(s => s.classList.toggle('active', s === b));
    form.querySelector('.try-engine').textContent = tryEngine();
  });
  form.querySelector('.try-cancel').onclick = () => { form.remove(); btn.classList.remove('on'); };
  form.querySelector('.try-go').onclick = () => {
    const count = Number(form.querySelector('.try-n').value) || 1;
    try { localStorage.setItem('avs:tryCount', String(count)); } catch {}
    form.remove(); btn.classList.remove('on');
    tryHere(btn, count);
  };
}

async function tryHere(btn, count) {
  const gemId = state.activeTab, proj = state.current, key = chatKey(gemId);
  const index = Number(btn.closest('.msg')?.dataset.index);
  const msg = proj.chats[key]?.[index];
  if (!msg) return;
  const slot = `${key}:${index}`;
  state.tries[slot] = (state.tries[slot] || 0) + count;
  const redraw = () => { if (state.current === proj && state.activeTab === gemId && chatKey(gemId) === key) renderMessages(gemId); };
  redraw();
  try {
    const r = await api(`/api/projects/${proj.id}/chat/try`, {
      method: 'POST',
      body: JSON.stringify({ gemId, ...sceneParam(), index, head: String(msg.content || '').slice(0, 80), prompt: decodeURIComponent(btn.dataset.text || ''), count, model: state.nbModel }),
    });
    // live sync may already have brought the options in with the saved chat
    const m = proj.chats[key]?.[index] || msg;
    const have = new Set((m.candidates || []).map(c => c.id));
    const fresh = r.candidates.filter(c => !have.has(c.id)).map(stripUrl);
    m.candidates = [...(m.candidates || []), ...fresh];
    state.candView[slot] = m.candidates.findIndex(c => c.id === r.candidates[0].id);   // show the first new one
    state.candFlip[slot] = false;
    if (r.errors?.length) toast(`${r.candidates.length} of ${count} came back — ${r.errors[0]}`, true);
  } catch (e) { toast(e.message, true); }
  state.tries[slot] = Math.max(0, (state.tries[slot] || 0) - count);
  redraw();
}

// The options under a reply: the source (marked) beside the option shown, a strip to flip through
// them, and Keep. A kept option is a Library image; if that image was deleted, it can be kept again.
function candHtml(m, index, refImgs) {
  const cands = m.candidates || [];
  const slot = `${chatKey(state.activeTab)}:${index}`;
  const pending = state.tries[slot] || 0;
  if (!cands.length && !pending) return '';
  const pid = state.current.id;
  const cur = Math.min(Math.max(0, state.candView[slot] ?? 0), Math.max(0, cands.length - 1));
  const c = cands[cur];
  const src = refImgs[0] ? `/media/${pid}/uploads/${refImgs[0].file}` : '';
  // kept = in the Library; until the Library has loaded, the reply's own mark is taken at its word
  const kept = (x) => !!x.savedImageId && (!state.current.imagesLoaded || (state.current.images || []).some(im => im.id === x.savedImageId));
  const flip = !!state.candFlip[slot] && src;
  return `<div class="cand" data-slot="${escapeHtml(slot)}" data-index="${index}">
    <div class="cand-head"><b>Options${cands.length ? ` · ${cur + 1} of ${cands.length}` : ''}</b><span>Compare with the source and keep the best — only what you keep goes to the Library.</span></div>
    ${c ? `<div class="cand-view${src ? '' : ' no-src'}">
      ${src ? `<figure class="cand-src"><img src="${src}" alt="" /><figcaption>SOURCE</figcaption></figure>` : ''}
      <figure class="cand-main${flip ? ' flipped' : ''}"><img src="${flip ? src : `/media/${pid}/images/${c.file}`}" alt="" draggable="true" />
        <figcaption>${flip ? 'SOURCE (flipped)' : `Option ${cur + 1}${kept(c) ? ' · ✓ kept' : ''}`}</figcaption>
        ${cands.length > 1 ? '<button class="cand-nav prev" type="button" title="Previous option (←)">‹</button><button class="cand-nav next" type="button" title="Next option (→)">›</button>' : ''}
      </figure>
    </div>` : ''}
    <div class="cand-strip">${cands.map((x, i) => `<button class="cand-thumb${i === cur ? ' on' : ''}${kept(x) ? ' kept' : ''}" data-i="${i}" type="button" title="Option ${i + 1}${kept(x) ? ' — kept' : ''}"><img src="/media/${pid}/images/${x.file}" loading="lazy" alt="" /><span>${i + 1}${kept(x) ? ' ✓' : ''}</span></button>`).join('')}
      ${Array.from({ length: pending }, () => '<span class="cand-thumb cand-skel"><span class="spinner"></span></span>').join('')}</div>
    ${c ? `<div class="cand-acts">
      <button class="cand-keep" type="button"${kept(c) ? ' disabled' : ''}>${kept(c) ? '✓ Kept in the Library' : '✓ Keep this one'}</button>
      ${src ? `<button class="cand-flip${flip ? ' on' : ''}" type="button" title="Show the source in the option's place, to see exactly what changed">⇄ ${flip ? 'Back to the option' : 'Flip to the source'}</button>` : ''}
      <button class="cand-full" type="button" title="Full size — ← → flips between the source and every option">⤢ Full size</button>
      <span class="cand-meta">${escapeHtml(modelLabel(c.model))}${c.tune?.v ? ` · Tune v${c.tune.v}` : ''}</span>
    </div>` : ''}
  </div>`;
}

function wireCandidates(box) {
  const slot = box.dataset.slot, index = Number(box.dataset.index);
  const gemId = state.activeTab, key = chatKey(gemId);
  const m = state.current.chats[key]?.[index];
  if (!m) return;
  const cands = m.candidates || [];
  const show = (i) => { state.candView[slot] = (i + cands.length) % cands.length; state.candFlip[slot] = false; renderMessages(gemId); };
  const cur = () => Math.min(Math.max(0, state.candView[slot] ?? 0), Math.max(0, cands.length - 1));
  $$('.cand-thumb[data-i]', box).forEach(b => b.onclick = () => show(+b.dataset.i));
  box.querySelector('.cand-nav.prev')?.addEventListener('click', () => show(cur() - 1));
  box.querySelector('.cand-nav.next')?.addEventListener('click', () => show(cur() + 1));
  box.querySelector('.cand-flip')?.addEventListener('click', () => { state.candFlip[slot] = !state.candFlip[slot]; renderMessages(gemId); });
  box.querySelector('.cand-full')?.addEventListener('click', () => {
    const src = box.querySelector('.cand-src img')?.src;
    const list = [...(src ? [{ src, caption: 'SOURCE — the image attached in this turn' }] : []),
      ...cands.map((c, i) => ({ src: `/media/${state.current.id}/images/${c.file}`, caption: `Option ${i + 1} of ${cands.length}${c.savedImageId ? ' — kept' : ''}` }))];
    openLightbox(list, cur() + (src ? 1 : 0));
  });
  box.querySelector('.cand-main img')?.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/avs-image', e.target.src); e.dataTransfer.effectAllowed = 'copy'; });
  box.querySelector('.cand-keep')?.addEventListener('click', (e) => keepCandidate(e.currentTarget, m, index, cands[cur()]));
  // ← → flip through the options while the pointer is over them
  box.tabIndex = 0;
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(cur() - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); show(cur() + 1); }
  });
}

async function keepCandidate(btn, m, index, c) {
  if (!c) return;
  const gemId = state.activeTab, key = chatKey(gemId), proj = state.current;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Keeping…';
  try {
    const again = !!c.savedImageId;   // kept before, but its Library image was deleted since
    const { image } = await api(`/api/projects/${proj.id}/chat/keep`, {
      method: 'POST',
      body: JSON.stringify({ gemId, ...sceneParam(), index, head: String(m.content || '').slice(0, 80), candidateId: c.id, ...(again ? { again: true } : {}) }),
    });
    c.savedImageId = image.id;
    if (!(proj.images || []).some(im => im.id === image.id)) proj.images = [stripUrl(image), ...(proj.images || [])];
    toast(`Kept — option ${(m.candidates || []).indexOf(c) + 1} is in the Library${hasScenes() ? `, in ${scenes.label(activeScene())}` : ''}.`);
  } catch (e) { toast(e.message, true); }
  if (state.current === proj && state.activeTab === gemId) renderMessages(gemId);
}

// "More like this" sits on every prompt the gems return (see toggleMoreLike).
const moreLikeBtn = (enc, imgsAttr) =>
  `<button class="more-like" data-text="${enc}" ${imgsAttr} title="Liked it? Get more directions built on this prompt — and, if you like, say how to push it">✦ More like this</button>`;

// For NB Frames the prompts come as "PROMPT 1 — name" plain paragraphs (no fences), and a script
// storyboard as "FRAME 1 — title" ones. Detect those and wrap each into a copyable card with a
// generate button; the head line is the card's title, and travels with the image it generates.
function formatProse(seg, imgsAttr = '') {
  if (!seg.trim()) return '';
  const promptSplit = seg.split(/(?=(?:PROMPT|FRAME)\s*\d+\s*[—\-:])/g);
  if (promptSplit.length > 1) {
    const prompts = [], titles = [];
    const cards = promptSplit.map(chunk => {
      const m = chunk.match(/^\**(?:PROMPT|FRAME)\s*\d+\s*[—\-:].*$/m);
      if (!m) return chunk.replace(/[\s*]/g, '') ? inlineFmt(chunk) : '';   // skip stray "**"/blank chunks
      const headLine = m[0];
      const title = headLine.replace(/\*+/g, '').replace(/^PROMPT\s*/i, 'Prompt ').replace(/^FRAME\s*/i, 'Frame ').trim();
      const bodyText = chunk.replace(headLine, '').trim().replace(/^\*+|\*+$/g, '').trim();
      prompts.push(bodyText);
      titles.push(title);
      const enc = encodeURIComponent(bodyText);
      return `<div class="prompt-card"><div class="pc-head">${escapeHtml(title)}</div>` +
        `<pre style="margin:8px 14px"><button class="copy-block" data-text="${enc}">copy</button>${escapeHtml(bodyText)}</pre>` +
        `<div class="pc-actions">${tryBtn(enc)}<button class="reuse-prompt" data-text="${enc}" ${imgsAttr}>↻ Reuse prompt</button>` +
        moreLikeBtn(enc, imgsAttr) +
        (state.activeTab === 'gpt-advisor' ? `<button class="gpt-copy" data-text="${enc}" ${imgsAttr} title="Copy the prompt to your clipboard and download the reference image(s) — drag them into ChatGPT, then paste the prompt">⧉ Copy for ChatGPT</button>` : '') +
        `<button class="gen-link" data-text="${enc}" data-title="${encodeURIComponent(title)}" ${imgsAttr}>⚡ Send to Nano Banana 2</button></div></div>`;
    }).join('');
    // One click → generate ALL prompts at once (each prompt → one image), fired in parallel.
    const sendAll = prompts.length > 1
      ? `<div class="pc-sendall"><button class="gen-all" data-prompts="${encodeURIComponent(JSON.stringify(prompts))}" data-titles="${encodeURIComponent(JSON.stringify(titles))}" ${imgsAttr}>⚡ Send all ${prompts.length} to Nano Banana 2 →</button></div>`
      : '';
    return sendAll + cards;
  }
  return inlineFmt(seg);
}
function inlineFmt(t) {
  return escapeHtml(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^(.+)$/, '<p>$1</p>');
}

async function sendChat(gemId) {
  const ta = $('#chatInput');
  const text = ta.value.trim();
  const atts = state.attachments[gemId] || [];
  // NB Frames: the reference board's images go first, numbered, each with its role; images
  // attached in the composer follow them.
  const board = gemId === 'nb-frames' ? refboard.payload(atts.length) : null;
  const boardImgs = board?.images || [];
  if (!text && atts.length === 0 && !boardImgs.length) return;
  if (!state.config.hasAnthropic) { toast('Add your ANTHROPIC_API_KEY to .env first.', true); return; }

  const sendBtn = $('#sendBtn');
  sendBtn.disabled = true; sendBtn.innerHTML = '<span class="spinner"></span>';

  // Build history, scoped to the CURRENT brief so old references/prompts don't bleed in. (It's
  // also only ever this scene's chat — chatKey.)
  // - Attaching new image(s) starts a fresh brief → send no prior history.
  // - The board resends its references with every message; while they haven't changed, the
  //   conversation goes on from the message that first sent them (keepHistory).
  // - A text-only follow-up keeps history only back to the most recent image-bearing turn.
  const key = chatKey(gemId);
  const priorAll = state.current.chats?.[key] || [];  // everything before this turn
  let prior, keepHistory = false, freshBoard = false;
  if (atts.length > 0) {
    prior = [];
    freshBoard = boardImgs.length > 0;
  } else if (boardImgs.length) {
    const s = refboard.session();
    const from = s && s.key === board.key && s.chat === key && priorAll[s.from]?.role === 'user' ? s.from : -1;
    if (from >= 0) { prior = priorAll.slice(from).map(m => ({ role: m.role, content: m.content })); keepHistory = prior.length > 0; }
    else { prior = []; freshBoard = true; }
  } else {
    let start = 0;
    for (let i = priorAll.length - 1; i >= 0; i--) {
      const m = priorAll[i];
      if (m.role === 'user' && ((m.images && m.images.length) || m.hadImages)) { start = i; break; }
    }
    prior = priorAll.slice(start).map(m => ({ role: m.role, content: m.content }));
  }
  const images = [...boardImgs, ...atts.map(a => ({ mimeType: a.mimeType, data: a.data }))];
  const startAt = priorAll.length, slot = sceneSlot();
  ta.value = ''; ta.style.height = 'auto';
  if (state.drafts) delete state.drafts[`${gemId}:chatInput`];   // sent → clear this tab's draft

  // A Seedance follow-up carries the brief's mode, so the revised prompt keeps its shot format.
  const extra = gemId === 'seedance' ? seedance.followupExtra() : {};
  if (keepHistory) extra.keepHistory = true;
  // Kling V2V with the source clip attached: the gem is told which images are its frames, and when.
  const manifest = gemId === 'kling-advisor' ? clipManifest(atts) : '';
  const clipName = manifest ? atts.find(a => a.clip).clip.name : '';
  let sendText = text, display;
  if (board?.manifest) {
    // the chat keeps the message as typed; the gem also gets the board's list of images and roles
    sendText = `${board.manifest}\n\n${text || 'Write the frame from these references.'}`;
    display = text || '🧩 Prompts from the references';
  } else if (manifest) {
    sendText = `${manifest}\n\n${text}`;
    display = `🎬 ${clipName} — ${text || '(read the clip)'}`;
  }
  const ok = await runChatTurn(gemId, { sendText, display, images, history: prior, extra });
  if (ok) {
    atts.length = 0;   // this message's attachments (the user may have changed scene meanwhile)
    if (freshBoard) refboard.markSent(board.key, startAt, key, slot);
    if (state.activeTab === gemId) renderAttachments(gemId);
  }
  sendBtn.disabled = false; sendBtn.textContent = 'Send';
}

// One gem turn: show the message at once, post it, then append the reply — or take the message
// back out if the call fails. Shared by the chat composer, the Seedance brief builder, "More like
// this" and the script storyboard. Holds on to the project it started in, and only redraws if the
// user is still looking at it. `display` is the short form the chat shows and keeps (a script,
// say, is sent whole but kept as one line).
async function runChatTurn(gemId, { sendText, display, images = [], history = [], extra = {} }) {
  const proj = state.current;
  // The turn belongs to the scene it was sent in, even if the user moves on before the reply.
  const scene = sceneParam(), key = chatKey(gemId);
  const redraw = () => { if (state.current === proj && state.activeTab === gemId && chatKey(gemId) === key) renderMessages(gemId); };
  // optimistic user msg (keep a reference so we can fill in saved image refs from the response)
  const userMsg = { role: 'user', content: display || sendText || '(image)', hadImages: images.length > 0, at: Date.now() };
  proj.chats = proj.chats || {};
  proj.chats[key] = proj.chats[key] || [];   // guard: new gem or scene (no Firestore doc yet)
  proj.chats[key].push(userMsg);
  redraw();
  try {
    const { text: reply, images: savedImgs } = await api(`/api/projects/${proj.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ gemId, userText: sendText, images, history, klingMode: state.klingMode, seedanceVersion: state.seedanceVersion,
        ...(display ? { historyText: display } : {}), ...scene, ...extra }),
    });
    if (savedImgs && savedImgs.length) userMsg.images = savedImgs;  // so "Send to Nano Banana" can carry them
    // live sync may have swapped in the saved chat meanwhile — then the reply is already there
    const chat = proj.chats[key] = proj.chats[key] || [];
    if (chat.includes(userMsg)) chat.push({ role: 'assistant', content: reply, at: Date.now() });
    redraw();
    return true;
  } catch (e) {
    toast(e.message, true);
    const chat = proj.chats[key] || [];
    const i = chat.indexOf(userMsg);
    if (i >= 0) chat.splice(i, 1);   // take the optimistic message back out
    redraw();
    return false;
  }
}

// ── GENERATE panel (Nano Banana 2) ──────────────────────────────────────────────
let _genPasteWired = false;
// Paste an image ANYWHERE on the Nano Banana 2 tab (not only in the prompt box) → add as a reference.
function wireGenPaste() {
  if (_genPasteWired) return; _genPasteWired = true;
  document.addEventListener('paste', async (e) => {
    if (state.activeTab !== 'generate') return;
    const files = filesFromPaste(e);
    if (!files.length) return;   // text-only paste → let it land in the prompt box
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    const gp = $('#genPrompt');
    if (text && gp) insertAtCursor(gp, text);   // pasted text + reference image(s) together
    for (const f of files) {
      const data = await fileToB64(f);
      state.refImages.push({ name: f.name || 'pasted.png', mimeType: f.type, data, url: URL.createObjectURL(f) });
    }
    renderRefImages();
    toast(`Reference image${files.length > 1 ? 's' : ''} pasted.`);
  });
}
function renderGenerate(body) {
  const nm = state.nbModel || 'nb2';
  const panel = document.createElement('div');
  panel.className = 'gen-panel';
  panel.innerHTML = `
    <div class="gen-left">
      <div class="gen-head">
        <h3>Nano Banana</h3>
        <div class="mode-toggle" id="nbModelToggle" title="NB2 = fast, ~half the cost. NB Pro = max fidelity, best text, up to 4K (~2× cost). Switch to Pro if NB2 isn't nailing the result.">
          <button class="seg ${nm === 'nb2' ? 'active' : ''}" data-model="nb2" type="button">NB2</button>
          <button class="seg ${nm === 'pro' ? 'active' : ''}" data-model="pro" type="button">NB Pro</button>
        </div>
      </div>
      <div>
        <span class="field-label">Prompt — paste from NB Frames or write your own</span>
        <textarea id="genPrompt" data-draft placeholder="Paste a prompt here…"></textarea>
        <input id="genTitle" class="gen-title" data-draft dir="auto" placeholder="Title — optional, shown on the image (e.g. Frame 3 — The reveal)" />
      </div>
      <div>
        <span class="field-label">Reference image(s) — optional · attach, paste, or pull from liked (identity / product / scene)</span>
        <div class="ref-row" id="refRow">
          <button class="ref-add" id="refAdd" title="Attach an image">＋</button>
          <button class="ref-add fav-open" id="genFavBtn" title="Add from liked">♥</button>
          <input type="file" id="refInput" accept="image/*" multiple hidden />
        </div>
        <div class="fav-picker inline hidden" id="genFavPicker"></div>
      </div>
      <div class="gen-controls">
        <div>
          <span class="field-label">Aspect ratio</span>
          <select id="genAR">
            <option value="">model default</option>
            <option value="1:1">1:1 square</option>
            <option value="4:5">4:5 portrait</option>
            <option value="3:4">3:4 portrait</option>
            <option value="2:3">2:3 portrait</option>
            <option value="9:16">9:16 vertical</option>
            <option value="5:4">5:4 landscape</option>
            <option value="4:3">4:3 landscape</option>
            <option value="3:2">3:2 landscape</option>
            <option value="16:9">16:9 wide</option>
            <option value="21:9">21:9 cinema</option>
          </select>
        </div>
        <div>
          <span class="field-label">Variations</span>
          <select id="genCount">
            <option value="1" selected>1 image</option>
            <option value="2">2 images</option>
            <option value="3">3 images</option>
            <option value="4">4 images</option>
          </select>
        </div>
      </div>
      <button class="generate-btn" id="genBtn">Generate</button>
      <div class="gen-hint">Each variation is an independent generation, so you get genuinely different takes. Output size is <b>${state.config.nb2Size}</b> (set in .env). Images auto-save to this project's library.</div>
    </div>
    <div class="gen-right">
      <div class="section-head"><h3 id="genResultsHead">${escapeHtml(genResultsTitle())}</h3></div>
      <div id="genResults"><div class="gen-empty">Generated images will appear here.</div></div>
    </div>`;
  body.appendChild(panel);

  renderRefImages();
  // Aspect-ratio selector remembers the last choice (persists across generations & sessions),
  // so you set it once instead of resetting to "model default" (which lets the model pick 16:9).
  const arSel = $('#genAR');
  if (arSel) {
    arSel.value = state.genAR || '';
    arSel.onchange = () => { state.genAR = arSel.value; try { localStorage.setItem('avs:genAR', state.genAR); } catch {} };
  }
  $('#refAdd').onclick = () => $('#refInput').click();
  $('#refInput').onchange = async (e) => {
    for (const f of e.target.files) {
      const data = await fileToB64(f);
      state.refImages.push({ name: f.name, mimeType: f.type, data, url: URL.createObjectURL(f) });
    }
    renderRefImages(); e.target.value = '';
  };
  $('#genFavBtn').onclick = (e) => {
    e.stopPropagation();
    const picker = $('#genFavPicker');
    const opening = picker.classList.contains('hidden');
    picker.classList.toggle('hidden');
    if (opening) renderGenFavPicker();
  };
  const gp = $('#genPrompt');
  gp.oninput = () => { gp.style.height = 'auto'; gp.style.height = Math.max(gp.scrollHeight, 200) + 'px'; if (!gp.value.trim()) state.genFrom = null; };   // cleared by hand: a new recipe, no chat behind it
  wireGenPaste();   // paste an image anywhere on the tab (not only in the prompt box) → reference
  $('#genBtn').onclick = doGenerate;
  $$('#nbModelToggle .seg').forEach(b => b.onclick = () => {
    state.nbModel = b.dataset.model;
    try { localStorage.setItem('avs:nbModel', state.nbModel); } catch {}
    $$('#nbModelToggle .seg').forEach(s => s.classList.toggle('active', s.dataset.model === state.nbModel));
  });
  paintGenResults();   // show all of this project's existing renders (newest first)
}

// "Results", or "Results · 2 · Night chase" once the project has scenes — the grid shows the open one's.
const genResultsTitle = () => (hasScenes() ? `Results · ${scenes.label(activeScene())}` : 'Results');

// References that came from NB Frames' board are numbered and show their role: the prompt points
// at them by number ("Maya from image 3"), so removing one renumbers the ones after it.
function renderRefImages() {
  const row = $('#refRow');
  if (!row) return;
  $$('.thumb', row).forEach(t => t.remove());
  const add = $('#refAdd');
  const labeled = state.refImages.some(a => a.label);
  state.refImages.forEach((a, i) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.innerHTML = `<img src="${a.url}" />${labeled ? refBadge(i + 1, a) : ''}<button class="rm" data-i="${i}">✕</button>`;
    t.querySelector('.rm').onclick = () => {
      state.refImages.splice(i, 1);
      renderRefImages();
      if (labeled && i < state.refImages.length) toast('The images after it moved up a number — the prompt may point at them by number.');
    };
    row.insertBefore(t, add);
  });
}

// ── CHARACTERS tab ─────────────────────────────────────────────────────────────
// Build a reusable, identity-locked reference sheet from a few actor photos, then attach
// it to NB Frames. Kept in its own `characters` collection — never in the Library.
// ── Assets tab (internal id stays 'characters' for back-compat) ───────────────
// Per-type form copy. An asset record without a `type` is a legacy character.
const ASSET_UI = {
  character: { label: '👤 Character', btn: 'Generate reference sheet', ing: 'Building reference…', namePh: 'Maya, Detective Cole',
    hint: 'Upload a few clear photos of the person. We generate one clean multi-view reference sheet — a close-up plus front, three-quarter, and rear views — so NB&nbsp;Frames and Seedance keep the same person in every shot. <b>A single close-up drifts; the sheet holds.</b>',
    photos: 'Photos of the person — identity · a few angles / expressions work best', notesPh: 'Optional — wardrobe in words, age, a beard, glasses… (blank = keep them exactly as the photos)' },
  mascot: { label: '🏆 Mascot', btn: 'Generate mascot sheet', ing: 'Building sheet…', namePh: 'BDI Trophy',
    hint: 'A stylized / animated character that is NOT a real human — a trophy with a face, a product mascot, a creature. Sheet = big face-forward hero + front, three-quarter, and rear full views, rendered in the project\'s animation style (never photoreal product photography). Attach the style frame or a crop of the character; if the reference shows several characters, name which one in the notes.',
    photos: 'Design references of the mascot — the style frame or crops · the design source', notesPh: 'e.g. the tall weathered-gold BDI CODE trophy with the monocle — realistic 3D animated feature style like the reference; logos engraved on the cup stay exact…' },
  vehicle: { label: '🚗 Vehicle', btn: 'Generate vehicle sheet', ing: 'Building sheet…', namePh: 'Hero Car',
    hint: 'Three-panel turnaround on a clean studio canvas — front three-quarter, side profile, rear three-quarter — so the exact same car holds in every shot. Attach design photos to lock a real design, or leave them empty and describe the car to invent one (fictional branding, de-badged).',
    photos: 'Design photos of the vehicle — optional · the exact design source', notesPh: 'e.g. matte black electric coupe, white side panels, racing-red accent stripe, black 5-spoke wheels…' },
  product: { label: '📦 Product', btn: 'Generate product sheet', ing: 'Building sheet…', namePh: 'Charm Bracelet',
    hint: 'Three panels — front hero, back, and a macro of the signature detail — the identical product in each, true materials and colors. Attach photos of the real product to lock it exactly.',
    photos: 'Photos of the product — optional · the exact design source', notesPh: 'e.g. the sterling-silver charm bracelet — heart clasp, pavé details, worn patina…' },
  prop: { label: '🎬 Prop', btn: 'Generate prop sheet', ing: 'Building sheet…', namePh: 'Framed Champion Photo',
    hint: 'Three panels — front, back, defining detail — so the prop stays identical across shots.',
    photos: 'Photos of the prop — optional', notesPh: 'e.g. a framed vintage champion-driver photo in a worn brass frame…' },
  location: { label: '🏙 Location', btn: 'Generate location plate', ing: 'Building plate…', namePh: 'Showroom',
    hint: 'One wide establishing plate that locks the geography — every later shot matches this master. Attach photos of a real place to match it, or describe the place to invent it.',
    photos: 'Photos of the place — optional', notesPh: 'e.g. a premium glass-walled car showroom at dusk, polished concrete, warm interior glow…' },
  look: { label: '🎨 Look', btn: 'Save look frame', ing: 'Saving…', namePh: 'Film Look',
    hint: 'The project look frame — the color-science reference you attach to EVERY Seedance generation so the whole film grades identically. Attach your graded frame and it is stored <b>exactly as-is</b> (no generation, free). No frame yet? Describe the grade and we generate one.',
    photos: 'The look frame — attached image is stored untouched', notesPh: 'e.g. Kodak 500T film grain, organic color, soft contrast, warm tungsten interiors, cool dusk exteriors…' },
  frame: { label: '🖼 Frame', btn: 'Save frame', ing: 'Saving…', namePh: 'Opening shot — approved',
    hint: 'A finished still for this project — an approved shot, a keyframe, a first frame for Seedance. Stored <b>exactly as-is</b> (no generation, free).',
    photos: 'The frame — stored untouched', notesPh: 'Optional — e.g. client-approved v3, opening of the film…' },
};
// The Assets folder's filters: each groups the asset types that play the same part.
const ASSET_FILTERS = [['all', 'All'], ['character', '👤 Characters'], ['location', '🏙 Locations'], ['look', '🎨 Looks'], ['prop', '🎬 Props'], ['frame', '🖼 Frames']];
const assetFilterOf = (type) => ({ character: 'character', mascot: 'character', location: 'location', look: 'look', frame: 'frame' }[type || 'character'] || 'prop');
// Letters in any script count, so a Hebrew name keeps a Hebrew @tag instead of a blank one.
const tagSlug = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 32);

function renderCharacters(body) {
  state.charUploads = state.charUploads || [];
  state.charWardrobe = state.charWardrobe || [];
  state.assetForm = state.assetForm || { name: '', tag: '', tagTouched: false, notes: '' };
  const type = state.assetType || 'character';
  const ui = ASSET_UI[type];
  const f = state.assetForm;
  // The Assets folder: the project's final materials, ready for the next generations. Building a
  // sheet folds away once there's something in the folder.
  const builderOpen = state.assetBuilderOpen ?? !(state.current.characters || []).length;
  const panel = document.createElement('div');
  panel.className = 'chars-panel';
  panel.innerHTML = `
    <div class="assets-head">
      <div>
        <h3>Assets <span class="assets-count" id="assetsCount"></span></h3>
        <p class="chars-hint">The project's final materials — sheets, looks, locations, approved frames — ready for the next generations. Drop images here, save them from the Library with 📁, or build a sheet. Use any of them with the buttons on its card, or drag it onto a tab.</p>
      </div>
      <div class="assets-actions">
        <button class="mini-btn${builderOpen ? ' on' : ''}" id="assetBuildBtn" type="button">＋ Build a sheet</button>
        <button class="mini-btn" id="assetUploadBtn" type="button" title="Add images from your computer, kept exactly as they are">⬆ Upload</button>
        <button class="mini-btn" id="assetFromLibBtn" type="button" title="Pick from this project's generated images">＋ From Library</button>
        <button class="mini-btn" id="importAssetsBtn" type="button" title="Copy assets you already built in another project">⇄ Import</button>
        <input type="file" id="assetUploadInput" accept="image/*" multiple hidden />
      </div>
    </div>
    <div class="assets-tools">
      <input class="assets-search" id="assetSearch" type="search" dir="auto" placeholder="Search assets…" value="${escapeHtml(state.assetQuery || '')}" />
      <div class="mode-toggle" id="assetFilter">${ASSET_FILTERS.map(([k, l]) =>
        `<button class="seg ${k === (state.assetFilter || 'all') ? 'active' : ''}" data-f="${k}" type="button">${l}</button>`).join('')}</div>
    </div>
    <div class="import-picker hidden" id="importPicker"></div>
    <div class="import-picker hidden" id="assetLibPicker"></div>
    <div class="chars-new${builderOpen ? '' : ' hidden'}" id="assetBuilder">
      <div class="section-head"><h3>Build a sheet</h3></div>
      <div class="mode-toggle asset-types" id="assetTypes">${Object.entries(ASSET_UI).map(([k, v]) =>
        `<button class="seg ${k === type ? 'active' : ''}" data-type="${k}" type="button">${v.label}</button>`).join('')}</div>
      <p class="chars-hint">${ui.hint}</p>
      <div class="asset-name-row">
        <input class="char-text" id="charName" placeholder="Name (e.g. ${escapeHtml(ui.namePh)})" value="${escapeHtml(f.name)}" />
        <input class="char-text asset-tag" id="assetTag" placeholder="@tag_for_prompts" value="${escapeHtml(f.tag ? '@' + f.tag : '')}" title="The @tag Seedance prompts use for this asset — auto-built from the name, edit to override" />
      </div>
      <textarea class="char-text" id="charNotes" rows="2" placeholder="${escapeHtml(ui.notesPh)}">${escapeHtml(f.notes)}</textarea>
      <span class="field-label">${ui.photos}</span>
      <div class="ref-row" id="charRefRow">
        <button class="ref-add" id="charAdd" title="Add photos">＋</button>
        <input type="file" id="charInput" accept="image/*" multiple hidden />
      </div>
      ${type !== 'look' && type !== 'frame' ? `<label class="asset-asis"><input type="checkbox" id="assetAsIs"${f.asIs ? ' checked' : ''} /> <span>Use my image <b>exactly as-is</b> — no generation (free); the uploaded image becomes the reference, pixel-identical (first image if several)</span></label>` : ''}
      ${type === 'character' ? `
      <span class="field-label">Wardrobe / outfit references — optional · face &amp; look come from the photos above, only the clothes come from these</span>
      <div class="ref-row" id="charWardrobeRow">
        <button class="ref-add" id="charWardrobeAdd" title="Add wardrobe / outfit photos">＋</button>
        <input type="file" id="charWardrobeInput" accept="image/*" multiple hidden />
      </div>` : ''}
      <button class="generate-btn" id="charGenBtn">${f.asIs && type !== 'look' && type !== 'frame' ? 'Save image as asset' : ui.btn}</button>
      <div class="gen-hint">${type === 'frame' ? 'Stored untouched (free).' : type === 'look' ? 'An attached frame is stored untouched (free); generated frames render on Nano Banana Pro at 2K.' : 'Generated sheets render on Nano Banana Pro at 2K; "as-is" stores your upload untouched (free). Stored with this project — separate from your Library and Nano Banana outputs.'}</div>
    </div>
    <div class="chars-gallery" id="charsGallery"></div>
    <div class="kept-refs" id="keptRefs"></div>`;
  body.appendChild(panel);
  // Type switch — keep typed fields and uploads, swap the form copy.
  $$('#assetTypes .seg', panel).forEach(b => b.onclick = () => {
    if (b.dataset.type === state.assetType) return;
    state.assetType = b.dataset.type;
    body.innerHTML = '';
    renderCharacters(body);
  });
  // Field state — name auto-builds the @tag until the tag is edited by hand.
  const nameEl = $('#charName'), tagEl = $('#assetTag'), notesEl = $('#charNotes');
  nameEl.oninput = () => { f.name = nameEl.value; if (!f.tagTouched) { f.tag = tagSlug(f.name); tagEl.value = f.tag ? '@' + f.tag : ''; } };
  tagEl.oninput = () => { f.tagTouched = true; f.tag = tagSlug(tagEl.value); };
  tagEl.onblur = () => { tagEl.value = f.tag ? '@' + f.tag : ''; if (!f.tag) f.tagTouched = false; };
  notesEl.oninput = () => { f.notes = notesEl.value; };
  const asIsEl = $('#assetAsIs');
  if (asIsEl) asIsEl.onchange = () => {
    f.asIs = asIsEl.checked;
    const gb = $('#charGenBtn'); if (gb) gb.textContent = f.asIs ? 'Save image as asset' : ui.btn;
  };
  $('#charAdd').onclick = () => $('#charInput').click();
  $('#charInput').onchange = async (e) => {
    for (const file of e.target.files) {
      try { const data = await fileToB64(file); state.charUploads.push({ name: file.name, mimeType: file.type, data, url: URL.createObjectURL(file) }); } catch {}
    }
    renderCharUploads(); e.target.value = '';
  };
  if (type === 'character') {
    $('#charWardrobeAdd').onclick = () => $('#charWardrobeInput').click();
    $('#charWardrobeInput').onchange = async (e) => {
      for (const file of e.target.files) {
        try { const data = await fileToB64(file); state.charWardrobe.push({ name: file.name, mimeType: file.type, data, url: URL.createObjectURL(file) }); } catch {}
      }
      renderCharWardrobe(); e.target.value = '';
    };
  }
  $('#charGenBtn').onclick = doCreateCharacter;
  $('#importAssetsBtn').onclick = () => {
    const picker = $('#importPicker');
    const opening = picker.classList.contains('hidden');
    picker.classList.toggle('hidden');
    if (opening) renderImportPicker();
  };
  // the folder's own controls
  $('#assetBuildBtn').onclick = (e) => {
    const open = $('#assetBuilder').classList.toggle('hidden') === false;   // toggle() reports whether it's now hidden
    state.assetBuilderOpen = open;
    e.currentTarget.classList.toggle('on', open);
  };
  const upload = $('#assetUploadInput');
  $('#assetUploadBtn').onclick = () => upload.click();
  upload.onchange = () => { const files = [...upload.files]; upload.value = ''; if (files.length) saveToAssets(files.map(file => ({ file }))); };
  $('#assetFromLibBtn').onclick = () => {
    const picker = $('#assetLibPicker');
    const opening = picker.classList.contains('hidden');
    picker.classList.toggle('hidden');
    if (opening) renderAssetLibPicker();
  };
  $('#assetSearch').oninput = (e) => { state.assetQuery = e.target.value; renderCharsGallery(); };
  $$('#assetFilter .seg', panel).forEach(b => b.onclick = () => {
    state.assetFilter = b.dataset.f;
    $$('#assetFilter .seg', panel).forEach(s => s.classList.toggle('active', s === b));
    renderCharsGallery();
  });
  // Images dropped anywhere on the folder are saved into it; dropped on the open builder, they're its photos.
  const fromApp = (e) => [...(e.dataTransfer?.types || [])].includes('text/avs-image');
  panel.addEventListener('dragover', (e) => { if (dragHasFiles(e) || fromApp(e)) { e.preventDefault(); panel.classList.add('drag-over'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag-over'); });
  panel.addEventListener('drop', async (e) => {
    if (!dragHasFiles(e) && !fromApp(e)) return;
    e.preventDefault();
    panel.classList.remove('drag-over');
    const url = e.dataTransfer.getData('text/avs-image');   // one of the app's own images (its file rides along too)
    const files = [...(e.dataTransfer.files || [])].filter(f => (f.type || '').startsWith('image/'));
    if (e.target.closest('#assetBuilder')) {
      try {
        if (url) state.charUploads.push(await urlToAttachment(url));
        else for (const f of files) state.charUploads.push({ name: f.name, mimeType: f.type, data: await fileToB64(f), url: URL.createObjectURL(f) });
      } catch { toast('Could not add that image.', true); }
      renderCharUploads();
      return;
    }
    if (url) saveToAssets([{ url }]);
    else if (files.length) saveToAssets(files.map(file => ({ file })));
    else toast('Only image files can be added.', true);
  });
  renderCharUploads();
  renderCharWardrobe();
  renderCharsGallery();
}

// Assets built in one project used to be stranded there — this lists every OTHER project's
// assets so they can be copied in instead of rebuilt from scratch.
async function renderImportPicker() {
  const picker = $('#importPicker');
  if (!picker) return;
  picker.innerHTML = `<div class="fav-head">Loading assets from your other projects…</div>`;
  let projects = [];
  try { ({ projects } = await api('/api/assets/index')); }
  catch (e) { picker.innerHTML = `<div class="fav-empty">Couldn't load: ${escapeHtml(e.message)}</div>`; return; }
  const others = projects.filter(p => p.id !== state.current.id);
  if (!others.length) { picker.innerHTML = `<div class="fav-empty">No other project has assets yet.</div>`; return; }

  picker.innerHTML = others.map(p => `
    <div class="import-proj">
      <div class="fav-head">${escapeHtml(p.name)} · ${p.assets.length}</div>
      <div class="kept-grid">${p.assets.map(a => `
        <label class="kept-cell import-cell" title="${escapeHtml(a.name)}">
          <input type="checkbox" data-from="${p.id}" value="${a.id}" />
          <span class="kept-thumb"><img src="/media/${p.id}/images/${escapeHtml(a.file)}" loading="lazy" /></span>
          <span class="import-name">${escapeHtml(a.name)}</span>
        </label>`).join('')}</div>
    </div>`).join('') +
    `<div class="import-actions"><button class="mini-btn" id="importGo" type="button">Import selected</button></div>`;

  $('#importGo').onclick = async (e) => {
    const picked = $$('input[type=checkbox]:checked', picker);
    if (!picked.length) { toast('Tick the assets you want first.', true); return; }
    // group by source project — one request each
    const byProj = {};
    picked.forEach(c => { (byProj[c.dataset.from] = byProj[c.dataset.from] || []).push(c.value); });
    e.target.disabled = true; e.target.innerHTML = '<span class="spinner"></span>Importing…';
    let n = 0;
    try {
      for (const [fromPid, ids] of Object.entries(byProj)) {
        const { imported } = await api(`/api/projects/${state.current.id}/assets/import`, {
          method: 'POST', body: JSON.stringify({ fromPid, ids }),
        });
        state.current.characters = [...imported, ...(state.current.characters || [])];
        n += imported.length;
      }
      renderCharsGallery();
      picker.classList.add('hidden');
      toast(`Imported ${n} asset${n === 1 ? '' : 's'}.`);
    } catch (err) { toast(err.message, true); }
    e.target.disabled = false; e.target.textContent = 'Import selected';
  };
}

function renderCharUploads() {
  const row = $('#charRefRow');
  if (!row) return;
  $$('.thumb', row).forEach(t => t.remove());
  const add = $('#charAdd');
  (state.charUploads || []).forEach((a, i) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.innerHTML = `<img src="${a.url}" /><button class="rm" data-i="${i}">✕</button>`;
    t.querySelector('.rm').onclick = () => { state.charUploads.splice(i, 1); renderCharUploads(); };
    row.insertBefore(t, add);
  });
}

function renderCharWardrobe() {
  const row = $('#charWardrobeRow');
  if (!row) return;
  $$('.thumb', row).forEach(t => t.remove());
  const add = $('#charWardrobeAdd');
  (state.charWardrobe || []).forEach((a, i) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.innerHTML = `<img src="${a.url}" /><button class="rm" data-i="${i}">✕</button>`;
    t.querySelector('.rm').onclick = () => { state.charWardrobe.splice(i, 1); renderCharWardrobe(); };
    row.insertBefore(t, add);
  });
}

// Kept references shown beneath the built assets: every image ever attached in a chat,
// deduped. These are raw source material, not generated reference sheets — so they live in
// their own section rather than being mixed into the built assets above.
function renderKeptRefs() {
  const wrap = $('#keptRefs');
  if (!wrap) return;
  const refs = state.current?.references || [];
  if (!refs.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `<div class="section-head"><h3>Kept references · ${refs.length}</h3></div>` +
    `<p class="chars-hint">Every image attached in a chat is kept here automatically, deduped — re-attach one from any prompt with the 🕘 button, or build it into a named asset above.</p>` +
    `<div class="kept-grid">${refs.map(r =>
      `<div class="kept-cell">
        <a class="kept-thumb" href="${escapeHtml(r.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(r.url)}" loading="lazy" /></a>
        <div class="kept-acts">
          <button class="ref-mini" type="button" data-nb="${r.id}" title="Attach to NB Frames">＋</button>
          <button class="ref-mini" type="button" data-forget="${r.id}" title="Forget this reference">✕</button>
        </div>
      </div>`).join('')}</div>`;

  $$('[data-nb]', wrap).forEach(b => b.onclick = async () => {
    const r = refs.find(x => x.id === b.dataset.nb);
    if (!r) return;
    b.disabled = true;
    try {
      const blob = await (await mediaFetch(r.url)).blob();
      state.attachments['nb-frames'] = state.attachments['nb-frames'] || [];
      if (!state.attachments['nb-frames'].some(a => a.url === r.url)) {
        state.attachments['nb-frames'].push({ name: r.file, mimeType: r.mimeType || blob.type || 'image/jpeg', data: await fileToB64(blob), url: r.url });
      }
      toast('Attached to NB Frames.');
    } catch { toast("Couldn't load that reference.", true); }
    b.disabled = false;
  });
  $$('[data-forget]', wrap).forEach(b => b.onclick = async () => {
    const rid = b.dataset.forget;
    b.disabled = true;
    try {
      await api(`/api/projects/${state.current.id}/references/${rid}`, { method: 'DELETE' });
      state.current.references = (state.current.references || []).filter(x => x.id !== rid);
      renderKeptRefs();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  });
}

function renderCharsGallery() {
  renderKeptRefs();
  const gallery = $('#charsGallery');
  if (!gallery) return;
  const all = state.current.characters || [];
  const q = (state.assetQuery || '').trim().toLowerCase();
  const filter = state.assetFilter || 'all';
  const chars = all.filter(c => (filter === 'all' || assetFilterOf(c.type) === filter)
    && (!q || `${c.name} ${assetTag(c)} ${c.notes || ''}`.toLowerCase().includes(q)));
  const count = $('#assetsCount');
  if (count) count.textContent = chars.length === all.length ? `${all.length}` : `${chars.length} of ${all.length}`;
  if (!chars.length) {
    gallery.innerHTML = `<div class="gen-empty">${all.length ? 'Nothing here matches — try another filter or search.'
      : 'The folder is empty. Drop images here, save them from the Library with 📁, or build a sheet — then use them in Seedance, NB Frames or Nano Banana.'}</div>`;
    return;
  }
  gallery.innerHTML = chars.map(c => {
    const type = c.type || 'character';
    const tag = assetTag(c);
    const refUrl = `/media/${state.current.id}/images/${c.reference.file}`;
    const srcs = [...(c.sourceImages || []), ...(c.wardrobeImages || [])].map(s => `<img class="char-src" src="/media/${state.current.id}/uploads/${s.file}" loading="lazy" />`).join('');
    return `<div class="char-card" data-id="${c.id}">
      <div class="char-ref"><img src="${refUrl}" loading="lazy" draggable="true" title="Click to enlarge · drag onto a tab to use it there, or out of the app" /></div>
      <div class="char-meta">
        <div class="char-name"><span dir="auto">${escapeHtml(c.name)}</span> <span class="asset-chip" dir="auto">@${escapeHtml(tag)}</span><span class="asset-chip type">${escapeHtml(ASSET_UI[type] ? ASSET_UI[type].label : type)}</span></div>
        ${c.notes ? `<div class="char-notes" dir="auto">${escapeHtml(c.notes)}</div>` : ''}
        ${srcs ? `<div class="char-srcs" title="Source photos">${srcs}</div>` : ''}
        <div class="char-actions">
          <button class="mini-btn char-seed" data-id="${c.id}" title="Put it in the Video brief, in its section">⚡ Video</button>
          <button class="mini-btn char-use" data-id="${c.id}" title="Put it on NB Frames' reference board, in its section (a look or frame is attached to the message)">＋ NB Frames</button>
          <button class="mini-btn char-gen" data-id="${c.id}" title="Use it as a reference image in the Nano Banana generator">→ Nano Banana</button>
          <button class="mini-btn char-edit" data-id="${c.id}" title="Rename, retag or retype it">✎</button>
          <a class="mini-btn" href="${refUrl}" download="${escapeHtml(tag)}.png" title="Download">⬇</a>
          <button class="mini-btn char-del" data-id="${c.id}">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
  const byId = (id) => chars.find(c => c.id === id);
  $$('.char-seed', gallery).forEach(b => b.onclick = () => useAssetInSeedance(byId(b.dataset.id)));
  $$('.char-use', gallery).forEach(b => b.onclick = () => useCharacterInFrames(byId(b.dataset.id)));
  $$('.char-gen', gallery).forEach(b => b.onclick = () => useAssetInGenerator(byId(b.dataset.id)));
  $$('.char-edit', gallery).forEach(b => b.onclick = () => editAsset(byId(b.dataset.id)));
  $$('.char-del', gallery).forEach(b => b.onclick = () => deleteCharacter(b.dataset.id));
  // An asset's image drags like any image in the app: onto a tab to attach it, or out of the app.
  $$('.char-ref img', gallery).forEach((img, i) => {
    img.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/avs-image', img.src); e.dataTransfer.effectAllowed = 'copy'; });
    img.onclick = () => openLightbox(chars.map(c => ({ src: `/media/${state.current.id}/images/${c.reference.file}`, caption: `${c.name} · @${assetTag(c)}` })), i);
  });
}

// Save images into the Assets folder, kept exactly as they are. One image gets a name and a type;
// several share a type and take their names from their files (rename any of them later with ✎).
// items: [{ url } — one of the app's images | { file } — from the computer; name optional].
function saveToAssets(items) {
  if (!state.current || !items?.length) return;
  let modal = $('#saveAssetModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'saveAssetModal'; modal.className = 'modal-overlay'; document.body.appendChild(modal); }
  const previews = items.map(it => it.url || URL.createObjectURL(it.file));
  const single = items.length === 1;
  const frames = (state.current.characters || []).filter(c => c.type === 'frame').length;
  const guess = (it) => (it.name || (it.file ? it.file.name.replace(/\.[^.]+$/, '') : '')).trim();
  const types = ['frame', 'character', 'location', 'look', 'prop', 'product', 'vehicle', 'mascot'];
  modal.innerHTML = `
    <form class="modal-card" id="staForm">
      <div class="modal-head"><h3>Save to Assets</h3><button class="modal-x" type="button" id="staX">✕</button></div>
      <div class="sta-thumbs">${previews.map(u => `<img src="${escapeHtml(u)}" alt="" />`).join('')}</div>
      ${single
        ? `<label class="np-field"><span class="field-label">Name</span><input id="staName" dir="auto" autocomplete="off" value="${escapeHtml(guess(items[0]) || `Frame ${frames + 1}`)}" /></label>`
        : `<p class="modal-sub">${items.length} images — each keeps its file name; rename any of them in Assets afterwards.</p>`}
      <label class="np-field"><span class="field-label">Type</span><select id="staType">${types.map(t => `<option value="${t}">${ASSET_UI[t].label}</option>`).join('')}</select></label>
      <div class="modal-actions">
        <button class="modal-btn ghost" type="button" id="staCancel">Cancel</button>
        <button class="modal-btn accent" type="submit" id="staGo">📁 Save to Assets</button>
      </div>
    </form>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('#staX', modal).onclick = close;
  $('#staCancel', modal).onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  modal.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  $('#staForm', modal).onsubmit = async (e) => {
    e.preventDefault();
    const type = $('#staType', modal).value;
    const go = $('#staGo', modal);
    go.disabled = true; go.innerHTML = '<span class="spinner"></span>Saving…';
    let saved = 0;
    for (const [i, it] of items.entries()) {
      const name = single ? $('#staName', modal).value.trim() : guess(it);
      try {
        const blob = it.file || await (await mediaFetch(it.url)).blob();
        const { character } = await api(`/api/projects/${state.current.id}/characters`, {
          method: 'POST',
          body: JSON.stringify({ name: name || `${ASSET_UI[type].label.replace(/^\S+\s/, '')} ${frames + i + 1}`, type, asIs: true,
            images: [{ mimeType: blob.type || 'image/png', data: await rawFileToB64(blob) }] }),
        });
        state.current.characters = [character, ...(state.current.characters || [])];
        saved++;
      } catch (err) { toast(err.message || 'Could not save that image.', true); }
    }
    close();
    if (saved) toast(`Saved ${saved} to Assets.`);
    if (state.activeTab === 'characters') renderCharsGallery();
  };
  $(single ? '#staName' : '#staType', modal).focus();
}

// Rename, retag, retype or annotate an asset — its image stays as it is.
function editAsset(c) {
  if (!c) return;
  let modal = $('#editAssetModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'editAssetModal'; modal.className = 'modal-overlay'; document.body.appendChild(modal); }
  modal.innerHTML = `
    <form class="modal-card" id="eaForm">
      <div class="modal-head"><h3>Edit asset</h3><button class="modal-x" type="button" id="eaX">✕</button></div>
      <label class="np-field"><span class="field-label">Name</span><input id="eaName" dir="auto" autocomplete="off" value="${escapeHtml(c.name)}" /></label>
      <label class="np-field"><span class="field-label">@tag — how prompts point at it</span><input id="eaTag" dir="auto" autocomplete="off" value="${escapeHtml(assetTag(c))}" /></label>
      <label class="np-field"><span class="field-label">Type</span><select id="eaType">${Object.keys(ASSET_UI).map(t => `<option value="${t}"${(c.type || 'character') === t ? ' selected' : ''}>${ASSET_UI[t].label}</option>`).join('')}</select></label>
      <label class="np-field"><span class="field-label">Notes</span><input id="eaNotes" dir="auto" autocomplete="off" value="${escapeHtml(c.notes || '')}" /></label>
      <div class="modal-actions">
        <button class="modal-btn ghost" type="button" id="eaCancel">Cancel</button>
        <button class="modal-btn accent" type="submit" id="eaGo">Save</button>
      </div>
    </form>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $('#eaX', modal).onclick = close;
  $('#eaCancel', modal).onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  modal.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  $('#eaForm', modal).onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: $('#eaName', modal).value.trim(), tag: tagSlug($('#eaTag', modal).value), type: $('#eaType', modal).value, notes: $('#eaNotes', modal).value.trim() };
    if (!body.name) { toast('An asset needs a name.', true); return; }
    try {
      const { character } = await api(`/api/projects/${state.current.id}/characters/${c.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      state.current.characters = (state.current.characters || []).map(x => x.id === c.id ? character : x);
      close();
      renderCharsGallery();
      toast(`Saved ${character.name}.`);
    } catch (err) { toast(err.message, true); }
  };
  $('#eaName', modal).focus();
}

// Use an asset as a reference image in the Nano Banana generator.
async function useAssetInGenerator(c) {
  if (!c) return;
  const url = `/media/${state.current.id}/images/${c.reference.file}`;
  try {
    const att = await urlToAttachment(url);
    switchTab('generate');
    if (!state.refImages.some(r => r.url === url)) state.refImages.push({ ...att, name: c.name });
    renderRefImages();
    toast(`${c.name} added to Nano Banana as a reference.`);
  } catch { toast('Could not add that asset.', true); }
}

// "＋ From Library" on the Assets page: this project's images, filtered to the ones that matter
// most (liked, approved); a click saves one into the folder.
function renderAssetLibPicker() {
  const picker = $('#assetLibPicker');
  if (!picker) return;
  const f = state.assetLibFilter || 'approved';
  const all = state.current.images || [];
  const list = f === 'liked' ? all.filter(i => i.favorite) : f === 'approved' ? all.filter(i => i.approved) : all;
  const tab = (k, l, n) => `<button class="seg ${f === k ? 'active' : ''}" data-lf="${k}" type="button">${l} · ${n}</button>`;
  picker.innerHTML = `
    <div class="alp-head">
      <span class="fav-head">Add from the Library — click an image to save it here</span>
      <div class="mode-toggle">${tab('approved', '✓ Approved', all.filter(i => i.approved).length)}${tab('liked', '♥ Liked', all.filter(i => i.favorite).length)}${tab('all', 'All', all.length)}</div>
    </div>
    ${list.length ? `<div class="kept-grid">${list.map(im => `<button class="kept-cell alp-pick" type="button" data-id="${im.id}" title="${escapeHtml(im.title || im.prompt || '')}"><span class="kept-thumb"><img src="/media/${state.current.id}/images/${im.file}" loading="lazy" /></span></button>`).join('')}</div>`
      : `<div class="fav-empty">${{ approved: 'Nothing approved yet — mark images ✓ in the Library.', liked: 'Nothing liked yet — mark images ♥ in the Library.' }[f] || 'No images in this project yet.'}</div>`}`;
  $$('[data-lf]', picker).forEach(b => b.onclick = () => { state.assetLibFilter = b.dataset.lf; renderAssetLibPicker(); });
  $$('.alp-pick', picker).forEach(b => b.onclick = () => {
    const im = all.find(x => x.id === b.dataset.id);
    if (im) saveToAssets([{ url: `/media/${state.current.id}/images/${im.file}`, name: im.title || '' }]);
  });
}

async function doCreateCharacter() {
  const type = state.assetType || 'character';
  const ui = ASSET_UI[type];
  const f = state.assetForm || {};
  const name = (f.name || '').trim();
  const notes = (f.notes || '').trim();
  const tag = tagSlug(f.tag) || tagSlug(name);
  const asIs = type === 'frame' || (type !== 'look' && !!f.asIs);   // a frame is always kept as-is
  if (!name) { toast('Give the asset a name first.', true); return; }
  if (asIs && !(state.charUploads || []).length) { toast('Attach the image to store as the reference.', true); return; }
  if (type === 'character' && !asIs && !(state.charUploads || []).length) { toast('Add at least one photo of the person.', true); return; }
  if (type === 'look' && !(state.charUploads || []).length && !notes) { toast('Attach the look frame — or describe the grade so one can be generated.', true); return; }
  if (type === 'frame' && !(state.charUploads || []).length) { toast('Attach the frame to keep.', true); return; }
  const btn = $('#charGenBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${asIs ? 'Saving…' : ui.ing}`; }
  const gallery = $('#charsGallery');
  if (gallery && !gallery.querySelector('.char-card')) gallery.innerHTML = '';
  if (gallery) gallery.insertAdjacentHTML('afterbegin', '<div class="char-card char-skel"><div class="skeleton"></div></div>');
  try {
    const images = state.charUploads.map(u => ({ mimeType: u.mimeType, data: u.data }));
    const wardrobeImages = type === 'character' ? (state.charWardrobe || []).map(u => ({ mimeType: u.mimeType, data: u.data })) : [];
    const { character } = await api(`/api/projects/${state.current.id}/characters`, {
      method: 'POST', body: JSON.stringify({ name, notes, images, wardrobeImages, type, tag, asIs }),
    });
    state.current.characters = state.current.characters || [];
    state.current.characters.unshift(character);
    state.charUploads = [];
    state.charWardrobe = [];
    // Mutate the form object in place — the input handlers hold a closure over THIS object,
    // so replacing it would leave them writing into an orphan (name typed after a create
    // was invisible to the next create until a refresh).
    Object.assign(f, { name: '', tag: '', tagTouched: false, notes: '', asIs: false });
    if ($('#charName')) $('#charName').value = '';
    if ($('#assetTag')) $('#assetTag').value = '';
    if ($('#charNotes')) $('#charNotes').value = '';
    if ($('#assetAsIs')) $('#assetAsIs').checked = false;
    renderCharUploads();
    renderCharWardrobe();
    toast(asIs
      ? `${character.name} stored untouched — ⚡ attach it to Seedance from the card.`
      : type === 'look' && images.length
        ? `${character.name} stored as the project look — ⚡ attach it to every Seedance generation.`
        : `${character.name} is ready — ⚡ attach it to Seedance (or NB Frames) from the card.`);
  } catch (e) {
    toast(e.message || 'Could not build the asset.', true);
  } finally {
    const b = $('#charGenBtn');
    if (b) { b.disabled = false; b.innerHTML = ui.btn; }
    renderCharsGallery();
  }
}

// Put an asset's reference sheet into the Video brief, in the section its type belongs to
// (a character gets its own block, named after it), then open the tab on its assets step.
async function useAssetInSeedance(char) {
  if (!char) return;
  const { status, section, switched } = await seedance.addAsset(char);
  switchTab('seedance');
  if (status === 'added') toast(`${char.name} added to ${section}${switched ? ' — the brief is back on References' : ''}. Add the rest, then write the prompt.`);
  else if (status === 'exists') toast(`${char.name} is already in the brief, under ${section}.`);
}

async function useCharacterInFrames(char) {
  if (!char) return;
  // A character, location or prop goes onto NB Frames' reference board, in its section; a look or
  // a finished frame has no section there, so it's attached to the message as before.
  const placed = await refboard.addAsset(char);
  if (placed) {
    switchTab('nb-frames');
    if (placed.status === 'added') toast(`${char.name} is on the NB Frames board, under ${placed.section} — describe the scene and send.`);
    else if (placed.status === 'exists') toast(`${char.name} is already on the board, under ${placed.section}.`);
    return;
  }
  try {
    const url = `/media/${state.current.id}/images/${char.reference.file}`;
    const blob = await (await mediaFetch(url)).blob();
    const data = await fileToB64(blob);
    switchTab('nb-frames');
    $$('#wsTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'nb-frames'));
    state.attachments = state.attachments || {};
    state.attachments['nb-frames'] = state.attachments['nb-frames'] || [];
    if (!state.attachments['nb-frames'].some(r => r.url === url))
      state.attachments['nb-frames'].push({ name: `${char.name} (reference)`, mimeType: blob.type || 'image/png', data, url });
    renderAttachments('nb-frames');
    toast(`${char.name}'s reference is attached to NB Frames — describe the scene and send.`);
  } catch { toast('Could not attach the reference.', true); }
}

async function deleteCharacter(cid) {
  const c = (state.current.characters || []).find(x => x.id === cid);
  if (!c) return;
  if (!confirm(`Delete "${c.name}"? This removes its reference sheet.`)) return;
  try {
    await api(`/api/projects/${state.current.id}/characters/${cid}`, { method: 'DELETE' });
    state.current.characters = (state.current.characters || []).filter(x => x.id !== cid);
    renderCharsGallery();
    toast('Character deleted.');
  } catch (e) { toast(e.message || 'Could not delete.', true); }
}

async function doGenerate() {
  const prompt = $('#genPrompt').value.trim();
  if (!prompt) { toast('Paste or write a prompt first.', true); return; }
  if (!state.config.hasGemini) { toast('Add your GEMINI_API_KEY to .env first.', true); return; }
  const count = +$('#genCount').value;
  const aspectRatio = $('#genAR').value || undefined;
  const refImages = state.refImages.map(r => ({ mimeType: r.mimeType, data: r.data, ...refRole(r) }));

  const btn = $('#genBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Generating…';
  state.generating = true;

  // Accumulate: prepend a live "generating" spot per image — never wipe prior renders.
  const grid = ensureGenGrid();
  const t0 = Date.now();
  grid.insertAdjacentHTML('afterbegin', Array.from({ length: count }, () =>
    '<div class="skeleton gen-skel"><div class="gen-load"><span class="spinner-lg"></span><span class="gen-load-label">Generating…</span><span class="gen-load-time">0s</span></div></div>'
  ).join(''));
  const genTimer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    $$('.gen-skel .gen-load-time', grid).forEach(el => el.textContent = s + 's');
  }, 1000);

  try {
    const { images, errors } = await api(`/api/projects/${state.current.id}/generate`, {
      method: 'POST', body: JSON.stringify({ prompt, count, aspectRatio, refImages, model: state.nbModel, title: $('#genTitle')?.value.trim() || '', ...sceneParam(), ...(state.genFrom ? { from: state.genFrom } : {}) }),
    });
    state.current.images = [...images.map(stripUrl), ...state.current.images];
    $$('.gen-skel', grid).forEach(s => s.remove());
    grid.insertAdjacentHTML('afterbegin', images.map(imgCard).join(''));   // newest on top, older kept below
    $$('.img-card', grid).slice(0, images.length).forEach(c => c.classList.add('gen-reveal'));   // reveal the fresh renders
    wireImageCards(grid);
    if (errors && errors.length) toast(`${images.length} generated · ${errors.length} failed`, true);
    else toast(`${images.length} image${images.length > 1 ? 's' : ''} generated`);
  } catch (e) {
    $$('.gen-skel', grid).forEach(s => s.remove());
    toast(e.message, true);
  } finally {
    clearInterval(genTimer);
    state.generating = false;
    btn.disabled = false; btn.textContent = 'Generate';
  }
}
const stripUrl = (im) => { const { url, ...rest } = im; return rest; };

// Ensure the results grid exists (replacing the empty placeholder) and return it.
function ensureGenGrid() {
  const results = $('#genResults');
  let grid = $('#genGrid');
  if (!grid) { results.innerHTML = '<div class="results-grid" id="genGrid"></div>'; grid = $('#genGrid'); }
  return grid;
}

// Paint the results grid with this project's existing renders (newest first) when the tab opens,
// so nothing disappears between sessions or generations.
function paintGenResults() {
  const results = $('#genResults');
  if (!results) return;
  // the open scene's images (all of them when the project has no scenes)
  const list = (state.current.images || []).filter(inScene).map(im => ({ ...im, url: `/media/${state.current.id}/images/${im.file}` }));
  if (!list.length) {
    results.innerHTML = `<div class="gen-empty">${activeScene() === GENERAL ? 'Generated images appear here and stay — every render is kept (also in the Library).'
      : `Nothing made in ${escapeHtml(scenes.label(activeScene()))} yet — what you generate here is kept in this scene (and in the Library).`}</div>`;
    return;
  }
  results.innerHTML = `<div class="results-grid" id="genGrid">${list.map(imgCard).join('')}</div>`;
  wireImageCards(results);
}

// ── image card (shared by generate + library + swap) ────────────────────────────
// Two separate marks: ♥ Like — we like it, keep it (the stored `favorite` flag) — and ✓ Approved,
// signed off by the client. Each has its own Library filter.
function imgCard(im) {
  const title = im.title ? `<div class="card-title" dir="auto" title="${escapeHtml(im.title)}">${escapeHtml(im.title)}</div>` : '';
  // Once the project has scenes, every card names its scene — click it to move the image.
  const scene = hasScenes() ? `<button class="card-scene" type="button" dir="auto" title="Scene — click to move it to another one">${escapeHtml(scenes.label(imageScene(im, state.current.scenes)))}</button>` : '';
  return `<div class="img-card${im.favorite ? ' favorited' : ''}${im.approved ? ' approved' : ''}" data-id="${im.id}">
    <div class="imgwrap"><img src="${im.url}" loading="lazy" data-prompt="${encodeURIComponent(im.prompt || '')}" data-title="${encodeURIComponent(im.title || '')}" /><div class="fav-badge" title="Unlike">♥</div><div class="approved-badge" title="Approved by the client">✓ Approved</div>${scene}</div>
    ${title}
    <div class="card-foot">
      <button class="when recipe-open" type="button" title="Its recipe — prompt, references, model, settings, the Tune it was made with — and re-use it">${timeAgo(im.createdAt)} · ⓘ</button>
      <div class="card-actions">
        <button class="icon-btn fav ${im.favorite ? 'on' : ''}" title="Like — keep this one">♥</button>
        <button class="icon-btn appr ${im.approved ? 'on' : ''}" title="Approved by the client">✓</button>
        <button class="icon-btn to-assets" title="Save to the project's Assets">📁</button>
        <a class="icon-btn" title="Download" href="${im.url}" download>⬇</a>
        <button class="icon-btn del" title="Delete">🗑</button>
      </div>
    </div>
  </div>`;
}
function wireImageCards(scope) {
  $$('.img-card', scope).forEach(card => {
    const imgId = card.dataset.id;
    const imgEl = card.querySelector('img');
    if (imgEl) {
      // The browser's own image drag carries the file itself, so the same drag works onto a tab
      // here (text/avs-image) and out of the app — into ChatGPT, OpenArt, Kling, or a folder.
      imgEl.setAttribute('draggable', 'true');
      imgEl.title = 'Drag onto a tab to use it as a reference — or out of the app, into ChatGPT, OpenArt, Kling or a folder';
      imgEl.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/avs-image', imgEl.src);
        e.dataTransfer.effectAllowed = 'copy';
      });
    }
    card.querySelector('.imgwrap').onclick = () => {
      // build the navigable set from every card currently in this grid (live order)
      const container = card.closest('.results-grid') || scope;
      const imgs = $$('.img-card img', container);
      const list = imgs.map(im => ({ src: im.src,
        caption: [decodeURIComponent(im.dataset.title || ''), decodeURIComponent(im.dataset.prompt || '')].filter(Boolean).join(' — ') }));
      const idx = imgs.indexOf(card.querySelector('img'));
      openLightbox(list, idx < 0 ? 0 : idx);
    };
    // Flip one mark (favorite = Like, or approved) on the server, then on the card.
    const setMark = async (field, on) => {
      try { await api(`/api/projects/${state.current.id}/images/${imgId}`, { method: 'PATCH', body: JSON.stringify({ [field]: on }) }); }
      catch (err) { toast(err.message || 'Could not update the image.', true); return; }
      card.querySelector(field === 'favorite' ? '.fav' : '.appr')?.classList.toggle('on', on);
      card.classList.toggle(field === 'favorite' ? 'favorited' : 'approved', on);   // the on-image badge
      const rec = state.current.images.find(x => x.id === imgId); if (rec) rec[field] = on;
      const view = field === 'favorite' ? 'liked' : 'approved';
      if (!on && libFilter === view && card.closest('.library-panel')) {   // drop out of that filtered view
        card.remove();
        if (!$('#libGrid .img-card')) drawLibGrid(state.current.images.map(im => ({ ...im, url: `/media/${state.current.id}/images/${im.file}` })));
      }
    };
    card.querySelector('.fav').onclick = (e) => { e.stopPropagation(); setMark('favorite', !e.currentTarget.classList.contains('on')); };
    card.querySelector('.appr').onclick = (e) => { e.stopPropagation(); setMark('approved', !e.currentTarget.classList.contains('on')); };
    const favBadge = card.querySelector('.fav-badge');
    if (favBadge) favBadge.onclick = (e) => { e.stopPropagation(); setMark('favorite', false); };   // tap the badge to unlike
    card.querySelector('.to-assets').onclick = (e) => {
      e.stopPropagation();
      const rec = state.current.images.find(x => x.id === imgId);
      saveToAssets([{ url: imgEl.src, name: rec?.title || '' }]);
    };
    const sceneBtn = card.querySelector('.card-scene');
    if (sceneBtn) sceneBtn.onclick = (e) => { e.stopPropagation(); openSceneMenu(sceneBtn, imgId); };
    card.querySelector('.recipe-open').onclick = (e) => { e.stopPropagation(); openRecipe(imgId); };
    card.querySelector('.del').onclick = async () => {
      if (!confirm('Delete this image?')) return;
      await api(`/api/projects/${state.current.id}/images/${imgId}`, { method: 'DELETE' });
      state.current.images = state.current.images.filter(x => x.id !== imgId);
      card.remove();
    };
  });
}

// ── Recipes ─────────────────────────────────────────────────────────────────────
// Every image keeps how it was made: its prompt and references, the model and settings, and —
// when its prompt came from a gem — which gem, which version of the project's Tune, and the chat.
// The ⓘ on a card opens it; "Re-use" puts it all back in the tool that made it, to edit and run.
const MODEL_NAMES = { 'gemini-3.1-flash-image': 'Nano Banana 2', 'gemini-3-pro-image': 'Nano Banana Pro', 'gpt-image-2': 'GPT Image 2', 'gpt-image-1': 'GPT Image', 'flux-kontext-max': 'Flux Kontext', upload: 'Uploaded' };
const modelLabel = (m) => MODEL_NAMES[m] || m || '—';
const TOOL_NAMES = { generate: 'Nano Banana', try: 'Try it here — Advisor & Tweaks', swap: 'Swap / Edit', upload: 'Uploaded to the Library' };
const imageTool = (im) => im.recipe?.tool || (im.model === 'upload' ? 'upload' : /flux|gpt-image/.test(im.model || '') ? 'swap' : 'generate');
const tuneText = (t) => (!t ? '' : t.pre ? 'its Tune (from before versions were kept)' : t.v ? `Tune v${t.v}` : 'no project Tune — the gem as written');
// "nb-frames" / "sc…~nb-frames" → { gem, scene }
const splitChatKey = (key) => { const i = String(key || '').indexOf('~'); return i < 0 ? { scene: GENERAL, gem: key } : { scene: key.slice(0, i), gem: key.slice(i + 1) }; };

function openRecipe(imgId) {
  const im = (state.current?.images || []).find(x => x.id === imgId);
  if (!im) return;
  const r = im.recipe || {}, tool = imageTool(im), pid = state.current.id;
  const from = r.from || null, gem = from?.gem || r.tune?.gem || '';
  const typed = tool === 'swap' && r.userPrompt !== undefined ? r.userPrompt : null;
  const refs = (im.refs || []).map((x, i) => `<figure class="rc-ref"><img src="${escapeHtml(x.url || `/media/${pid}/uploads/${x.file}`)}" alt="" loading="lazy" /><figcaption>${i + 1}${x.label ? ` — ${escapeHtml(x.label.length > 60 ? `${x.label.slice(0, 58)}…` : x.label)}` : ''}</figcaption></figure>`).join('');
  const row = (k, v) => (v ? `<div class="rc-row"><span>${k}</span><b dir="auto">${v}</b></div>` : '');
  let modal = $('#recipeModal');
  if (!modal) { modal = document.createElement('div'); modal.id = 'recipeModal'; modal.className = 'modal-overlay'; document.body.appendChild(modal); }
  modal.innerHTML = `
    <div class="modal-card recipe-card">
      <div class="modal-head"><h3>Recipe${im.title ? ` · <span dir="auto">${escapeHtml(im.title)}</span>` : ''}</h3><button class="modal-x" type="button" data-close>✕</button></div>
      <div class="rc-top">
        <img class="rc-img" src="/media/${pid}/images/${im.file}" alt="" />
        <div class="rc-facts">
          ${row('Made with', escapeHtml(TOOL_NAMES[tool] || tool))}
          ${row('Model', escapeHtml([modelLabel(im.model), im.size, im.aspectRatio].filter(Boolean).join(' · ')))}
          ${row('Settings', escapeHtml([r.count > 1 ? `${r.count} variations in the run` : '', r.engine ? `engine ${r.engine === 'flux' ? 'Flux Kontext' : 'GPT Image'}` : '', r.ab ? `A/B, variant ${r.variant || '?'}` : ''].filter(Boolean).join(' · ')))}
          ${row('Prompt from', gem ? escapeHtml(`${GEM_META[gem]?.name || gem}${gem === 'gpt-advisor' ? ' (GPT)' : ''} · ${tuneText(r.tune)}`) : (tool === 'generate' ? 'typed in the generator' : ''))}
          ${row('Scene', hasScenes() ? escapeHtml(scenes.label(imageScene(im, state.current.scenes))) : '')}
          ${row('Made', escapeHtml(new Date(im.createdAt).toLocaleString()))}
          <div class="rc-links">
            ${r.tune?.v ? `<button class="mini-btn" type="button" data-tune>View Tune v${r.tune.v}</button>` : ''}
            ${from?.chat ? '<button class="mini-btn" type="button" data-chat>Open the chat it came from</button>' : ''}
          </div>
        </div>
      </div>
      <pre class="rc-tune hidden"></pre>
      ${typed !== null ? `<span class="field-label">What was typed</span><pre class="rc-prompt" dir="auto">${escapeHtml(typed || '(no prompt — a two-image swap)')}</pre>
        <details class="rc-more"><summary>The full instruction the engine got</summary><pre class="rc-prompt" dir="auto">${escapeHtml(im.prompt || '')}</pre></details>`
        : `<span class="field-label">Prompt</span><pre class="rc-prompt" dir="auto">${escapeHtml(im.prompt || '—')}</pre>`}
      ${refs ? `<span class="field-label">References · in the order they were sent</span><div class="rc-refs">${refs}</div>` : ''}
      <div class="modal-actions">
        <button class="modal-btn ghost" type="button" data-copy>Copy prompt</button>
        ${tool !== 'upload' ? '<button class="modal-btn accent" type="button" data-reuse>↻ Re-use &amp; edit</button>' : ''}
      </div>
    </div>`;
  modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');
  $$('[data-close]', modal).forEach(b => { b.onclick = close; });
  modal.onclick = (e) => { if (e.target === modal) close(); };
  modal.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  $('[data-copy]', modal).onclick = async () => { const ok = await copyTextToClipboard(typed ?? im.prompt ?? ''); toast(ok ? 'Prompt copied.' : 'Copy failed.', !ok); };
  const reuse = $('[data-reuse]', modal);
  if (reuse) reuse.onclick = () => { close(); reuseRecipe(im); };
  const tuneBtn = $('[data-tune]', modal);
  if (tuneBtn) tuneBtn.onclick = async () => {
    const box = $('.rc-tune', modal);
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    try {
      const t = await api(`/api/projects/${pid}/tunes/${encodeURIComponent(r.tune.gem)}/${r.tune.v}`);
      box.textContent = `${GEM_META[t.gemId]?.name || t.gemId} · Tune v${t.v} · saved ${new Date(t.at).toLocaleString()}\n\n${t.text || '(empty — the gem as written)'}`;
      box.classList.remove('hidden');
    } catch (e) { toast(e.message, true); }
  };
  const chatBtn = $('[data-chat]', modal);
  if (chatBtn) chatBtn.onclick = () => { close(); openChatAt(from.chat, from.index); };
}

// Open a gem's chat — in its scene — at one message.
function openChatAt(key, index) {
  const { scene, gem } = splitChatKey(key);
  if (!GEM_META[gem]) { toast('That chat isn\'t a tab any more.', true); return; }
  if (scene !== GENERAL && !(state.current.scenes || []).some(s => s.id === scene)) { toast('That chat\'s scene was deleted.', true); return; }
  if ((state.sceneId || GENERAL) !== scene) setScene(scene);
  if (ADVISOR_TABS.includes(gem)) { try { localStorage.setItem('avs:advisorEngine', gem === 'gpt-advisor' ? 'gpt' : 'nb'); } catch {} }
  switchTab(gem);
  setTimeout(() => {
    const el = Number.isInteger(index) ? $(`#chatScroll .msg[data-index="${index}"]`) : null;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('msg-flash');
    setTimeout(() => el.classList.remove('msg-flash'), 1800);
  }, 80);
}

// Re-use: everything that made the image goes back into the tool that made it, ready to edit and
// run again — the Nano Banana generator (its prompt, references with their roles, ratio, model
// and title) or Swap / Edit (its images and what was typed).
async function reuseRecipe(im) {
  const r = im.recipe || {}, tool = imageTool(im), pid = state.current.id;
  const fetchRef = async (x) => {
    const url = x.url || `/media/${pid}/uploads/${x.file}`;
    const blob = await (await mediaFetch(url)).blob();
    return { url, mimeType: x.mimeType || blob.type || 'image/jpeg', data: await fileToB64(blob) };
  };
  try {
    if (tool === 'swap' || (tool === 'try' && /gpt-image|flux/.test(im.model || ''))) {
      const [base, char] = await Promise.all((im.refs || []).slice(0, 2).map(fetchRef));
      state.swap = { base: base ? { data: base.data, mimeType: base.mimeType, preview: base.url } : null, char: char ? { data: char.data, mimeType: char.mimeType, preview: char.url } : null,
        prompt: tool === 'swap' ? (r.userPrompt ?? '') : (im.prompt || ''), model: /flux/.test(im.model || '') ? 'flux' : 'gptimage', ab: !!r.ab };
      switchTab('swap');
      toast('Its images and prompt are back in Swap / Edit — change what you like and run it.');
      return;
    }
    const refs = [];
    for (const x of im.refs || []) { try { refs.push({ ...(await fetchRef(x)), name: x.file, ...refRole(x) }); } catch { /* one that can't be fetched is skipped */ } }
    state.refImages = refs;
    state.genFrom = r.from || null;
    if (im.model === 'gemini-3-pro-image') state.nbModel = 'pro';
    else if (im.model === 'gemini-3.1-flash-image') state.nbModel = 'nb2';
    if (im.aspectRatio) { state.genAR = im.aspectRatio; try { localStorage.setItem('avs:genAR', state.genAR); } catch {} }
    switchTab('generate');
    const t = $('#genPrompt'); if (t) { t.value = im.prompt || ''; t.dispatchEvent(new Event('input')); }
    const title = $('#genTitle'); if (title) title.value = im.title || '';
    toast(`Its prompt${refs.length ? `, ${refs.length} reference${refs.length > 1 ? 's' : ''}` : ''} and settings are back in Nano Banana — edit and generate.`);
  } catch (e) { toast(e.message || 'Couldn\'t load its recipe.', true); }
}

let lightbox = { list: [], idx: 0 };
function openLightbox(list, idx) {
  lightbox = { list: Array.isArray(list) ? list : [], idx: idx || 0 };
  showLightbox();
  $('#lightbox').classList.remove('hidden');
}
function showLightbox() {
  const { list, idx } = lightbox;
  if (!list.length) return;
  const item = list[idx] || list[0];
  $('#lightboxImg').src = item.src;
  $('#lightboxCaption').textContent = item.caption || '';
  const multi = list.length > 1;
  const cnt = $('#lightboxCount'); if (cnt) cnt.textContent = multi ? `${idx + 1} / ${list.length}` : '';
  const prev = $('#lightboxPrev'), next = $('#lightboxNext');
  if (prev) prev.classList.toggle('hidden', !multi);
  if (next) next.classList.toggle('hidden', !multi);
}
function lightboxNav(delta) {
  const n = lightbox.list.length;
  if (n < 2) return;
  lightbox.idx = (lightbox.idx + delta + n) % n;   // wrap around
  showLightbox();
}

// ── LIBRARY panel ────────────────────────────────────────────────────────────
// It shows the open scene's images; "All scenes" shows the whole project, each card naming its
// scene. The All / Liked / Approved filter works on top of either.
let libFilter = 'all';
let libAllScenes = (() => { try { return localStorage.getItem('avs:libScope') === 'all'; } catch { return false; } })();
function renderLibScope() {
  const el = $('#libScope');
  if (!el) return;
  el.innerHTML = hasScenes() ? `<div class="mode-toggle lib-scope" title="This scene's images, or the whole project's">
      <button class="seg ${libAllScenes ? '' : 'active'}" data-scope="scene" type="button" dir="auto">${escapeHtml(scenes.label(activeScene()))}</button>
      <button class="seg ${libAllScenes ? 'active' : ''}" data-scope="all" type="button">All scenes</button></div>` : '';
  $$('[data-scope]', el).forEach(b => b.onclick = () => {
    libAllScenes = b.dataset.scope === 'all';
    try { localStorage.setItem('avs:libScope', libAllScenes ? 'all' : 'scene'); } catch {}
    renderLibScope();
    drawLibGrid(libImages());
  });
}
async function renderLibrary(body) {
  const pid = state.current.id, scene = state.sceneId;
  const images = await api(`/api/projects/${pid}/images`);
  // the user moved on meanwhile (another project, tab or scene) — that view is theirs now
  if (state.current?.id !== pid || state.activeTab !== 'library' || state.sceneId !== scene) return;
  state.current.images = images.map(stripUrl);
  state.current.imagesLoaded = true;
  // Replace the Library that's there (a filter change or an upload redraws it): with the old panel
  // still on the page, the grid and its count went into the old one and were lost with it.
  body.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'library-panel';
  panel.innerHTML = `
    <div class="lib-head">
      <h3>Library <span id="libCount" style="font-family:var(--mono);font-size:12px;color:var(--ink-faint)"></span></h3>
      <div class="lib-actions">
        <div id="libScope"></div>
        <button class="mini-btn lib-upload" id="libUploadBtn" title="Upload images into this project — e.g. a swap you downloaded from ChatGPT">⬆ Upload</button>
        <div class="lib-filter">
          <button class="mini-btn ${libFilter === 'all' ? 'on' : ''}" data-f="all">All</button>
          <button class="mini-btn ${libFilter === 'liked' ? 'on' : ''}" data-f="liked" title="Images we liked and are keeping">♥ Liked</button>
          <button class="mini-btn ${libFilter === 'approved' ? 'on' : ''}" data-f="approved" title="Images the client approved">✓ Approved</button>
        </div>
      </div>
    </div>
    <input type="file" id="libFileInput" accept="image/*" multiple hidden />
    <div id="libGrid"></div>`;
  body.appendChild(panel);
  $$('.lib-filter .mini-btn', panel).forEach(b => b.onclick = () => { libFilter = b.dataset.f; renderLibrary($('#wsBody')); });
  const fileInput = $('#libFileInput', panel);
  $('#libUploadBtn', panel).onclick = () => fileInput.click();
  fileInput.onchange = (e) => { uploadToLibrary(e.target.files); e.target.value = ''; };
  // Drag OS image files (or a ChatGPT download) straight onto the library. A drag of one of the
  // app's own images carries its file too — that's not an upload, so it's let through.
  const uploadDrag = (e) => dragHasFiles(e) && ![...(e.dataTransfer.types || [])].includes('text/avs-image');
  panel.addEventListener('dragover', (e) => { if (uploadDrag(e)) { e.preventDefault(); panel.classList.add('drag-over'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag-over'); });
  panel.addEventListener('drop', (e) => { if (!uploadDrag(e)) return; e.preventDefault(); panel.classList.remove('drag-over'); uploadToLibrary(e.dataTransfer.files); });
  wireLibPaste();
  renderLibScope();
  drawLibGrid(images);
}
// Upload finished images (e.g. ChatGPT downloads) into the current project's Library — full-res, as-is.
async function uploadToLibrary(files) {
  const imgs = [...(files || [])].filter(f => (f.type || '').startsWith('image/'));
  if (!imgs.length) { toast('Only image files can be uploaded.', true); return; }
  toast(`Uploading ${imgs.length} image${imgs.length > 1 ? 's' : ''}…`);
  try {
    const images = [];
    for (const f of imgs) images.push({ mimeType: f.type || 'image/png', data: await rawFileToB64(f) });
    const { images: saved } = await api(`/api/projects/${state.current.id}/images/upload`, { method: 'POST', body: JSON.stringify({ images, ...sceneParam() }) });
    if (saved?.length) {
      toast(`Added ${saved.length} to the Library ✓`);
      if (state.activeTab === 'library') await renderLibrary($('#wsBody'));
    }
  } catch (e) { toast(e.message || 'Upload failed.', true); }
}
let _libPasteWired = false;
function wireLibPaste() {
  if (_libPasteWired) return; _libPasteWired = true;
  document.addEventListener('paste', (e) => {
    if (state.activeTab !== 'library') return;
    const files = filesFromPaste(e);
    if (files.length) { e.preventDefault(); uploadToLibrary(files); }
  });
}
function drawLibGrid(images) {
  const grid = $('#libGrid');
  if (!grid) return;
  const scoped = hasScenes() && !libAllScenes;   // just the open scene's images
  const pool = scoped ? images.filter(inScene) : images;
  const count = $('#libCount');
  if (count) count.textContent = `${pool.length} image${pool.length === 1 ? '' : 's'}`;
  const list = libFilter === 'liked' ? pool.filter(i => i.favorite) : libFilter === 'approved' ? pool.filter(i => i.approved) : pool;
  const where = scoped ? ` in ${escapeHtml(scenes.label(activeScene()))}` : '';
  const empty = { liked: `Nothing liked${where} yet — tap ♥ on any image to keep it here.`, approved: `Nothing approved${where} yet — tap ✓ on an image once the client signs off on it.` }[libFilter]
    || (scoped ? `No images${where} yet — what you make in Nano Banana or Swap while this scene is open lands here. "All scenes" shows the whole project.` : 'No images yet. Generate some in the Nano Banana 2 tab.');
  if (list.length === 0) { grid.innerHTML = `<div class="gen-empty">${empty}</div>`; return; }
  grid.innerHTML = `<div class="results-grid${hasScenes() && libAllScenes ? ' all-scenes' : ''}">${list.map(imgCard).join('')}</div>`;
  wireImageCards(grid);
}

// ── util ────────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Sign-in (Google, allowlisted) ─────────────────────────────────────────────
// Resolves when access is confirmed, so boot() runs only for an allowed account.
// In open (local) mode the server reports authEnabled:false and this returns at once.
async function initAuth() {
  let cfg;
  try { cfg = await (await fetch('/api/auth-config')).json(); }
  catch { return; } // server unreachable — let boot() surface the real error
  if (!cfg.authEnabled || !cfg.firebase) return; // open mode — no sign-in needed

  const overlay = $('#authOverlay'), btn = $('#googleSignInBtn');
  const status = $('#authStatus'), outBtn = $('#authSignOut');
  const setStatus = (m) => { if (status) status.textContent = m || ''; };
  overlay?.classList.remove('hidden');
  setStatus('Loading…');

  // Firebase SDK from CDN (ESM) — no build step.
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
  const { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
          setPersistence, browserLocalPersistence } =
    await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
  const { getFirestore, collection, doc, onSnapshot } =
    await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
  const _app = initializeApp(cfg.firebase);
  _firebaseAuth = getAuth(_app);
  _fs = getFirestore(_app);
  _fsApi = { collection, doc, onSnapshot };
  await setPersistence(_firebaseAuth, browserLocalPersistence).catch(() => {});
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  btn?.addEventListener('click', async () => {
    setStatus('Opening Google…'); btn.classList.add('hidden');
    try { await signInWithPopup(_firebaseAuth, provider); }
    catch (e) {
      btn.classList.remove('hidden');
      setStatus(e?.code === 'auth/popup-closed-by-user' ? '' : 'Sign-in failed — please try again.');
    }
  });
  outBtn?.addEventListener('click', () => signOut(_firebaseAuth));

  return new Promise((resolve) => {
    let done = false;
    onAuthStateChanged(_firebaseAuth, async (user) => {
      if (!user) { // signed out — show the button
        outBtn?.classList.add('hidden'); btn?.classList.remove('hidden'); setStatus('');
        return;
      }
      btn?.classList.add('hidden'); setStatus('Checking access…');
      // Confirm the account is on the allowlist by hitting a protected route.
      let err = null;
      try { await api('/api/projects'); } catch (e) { err = e; }
      if (!err) {
        overlay?.classList.add('hidden');
        if (!done) { done = true; resolve(); }
      } else {
        const msg = (err && err.message) ? err.message : String(err);
        // Show the REAL reason instead of always blaming the allowlist: "not on the allowlist"
        // is a 403 (ALLOWED_EMAILS); anything else (token/session 401, server 500) is different.
        setStatus(/allowlist/i.test(msg)
          ? `${user.email} isn't on the allowlist (fix ALLOWED_EMAILS on the server).`
          : `Signed in as ${user.email}, but access failed — ${msg}`);
        outBtn?.classList.remove('hidden');
      }
    });
  });
}

initAuth()
  .then(() => boot())
  .catch(e => { console.error(e); document.body.innerHTML = `<div style="padding:40px;font-family:monospace;color:#e2685f">Failed to start: ${e.message}</div>`; });
