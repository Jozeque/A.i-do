// ── AI Video Studio — frontend ────────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Auth: when Google sign-in is on, every request carries the current user's Firebase
// ID token. _firebaseAuth is set by initAuth(); it stays null in open (local) mode,
// so authHeader() is a no-op and nothing changes for local development.
let _firebaseAuth = null;
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
const fileToB64 = (file) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result.split(',')[1]);
  fr.onerror = rej;
  fr.readAsDataURL(file);
});
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

const GEM_META = {
  'nb-frames': { name: 'NB Frames', blurb: 'Attach a reference image + describe the scene. Returns <b>3</b> cinematic Nano Banana 2 prompts.' },
  'kling': { name: 'Kling Prompter', blurb: 'Attach your still + describe the motion. Returns <b>3</b> Kling 3.0 video prompts (fidelity / physics / cinematic).' },
  'kling-advisor': { name: 'Kling Advisor', blurb: 'Describe your source clip + the change you want. Returns the best Kling 3.0 Omni <b>video-to-video</b> prompt (restyle / relight / transform) with why &amp; what to watch.' },
  'nb-advisor': { name: 'NB Advisor', blurb: 'Attach image(s) + say what to change. Returns the best Nano Banana 2 edit prompt with a quick rationale.' },
};

// Suggestion lists for the NB Frames per-project cinematography builder (datalists; free text still allowed).
const BUILDER_OPTS = {
  look: ['High-gloss beauty', 'Clinical-luxe', 'Editorial documentary', 'Moody cinematic', 'Product hero', 'Warm lifestyle', 'Cultural editorial'],
  lighting: ['Clamshell beauty (soft 5600K)', 'Soft window / natural', 'Golden-hour warmth', 'Hard chiaroscuro', 'High-key bright & even', 'Overcast soft'],
  lens: ['Short telephoto ~70–135mm, shallow DOF, creamy bokeh', 'Normal ~40–60mm, natural perspective', 'Wide ~24–35mm, environmental depth', 'Macro register for detail', 'Cinema look (e.g. Alexa + fast primes), modular focal range'],
  palette: ['Vibrant high-key', 'Muted pastel', 'Teal & orange', 'Warm earthy', 'Desaturated editorial', 'Clean clinical whites'],
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
      <span class="field-label">Cinematography fields — these compile into the direction layered on the base NB Frames gem (for this project only). Analyze fills them; edit any by hand. Describe each as an adaptable range or family (e.g. a focal-length range, not one exact lens) so the look stays modular across different shots and frame sizes.</span>
      <div class="builder-grid">
        <label class="bf">Campaign / subject<input id="bf_campaign" placeholder="e.g. Clalit Smile dental campaign" /></label>
        <label class="bf">Look &amp; vibe<input id="bf_look" list="dl_look" placeholder="e.g. Clinical-luxe" /></label>
        <label class="bf">Lighting style<input id="bf_lighting" list="dl_lighting" placeholder="e.g. High-key bright &amp; even" /></label>
        <label class="bf">Lens &amp; camera<input id="bf_lens" list="dl_lens" placeholder="e.g. short-telephoto ~70–135mm, shallow DOF (a range, not one lens)" /></label>
        <label class="bf">Color &amp; palette<input id="bf_palette" list="dl_palette" placeholder="e.g. Clean clinical whites" /></label>
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
      ${dl('dl_look', BUILDER_OPTS.look)}${dl('dl_lighting', BUILDER_OPTS.lighting)}${dl('dl_lens', BUILDER_OPTS.lens)}${dl('dl_palette', BUILDER_OPTS.palette)}${dl('dl_wardrobe', BUILDER_OPTS.wardrobe)}`;
  }

  return `
    <span class="field-label">Project-specific direction — extends the base ${meta.name} gem for this project only (vibe, constraints, style).</span>
    <textarea id="gemOverride" placeholder="e.g. moody neon-noir motion, heavy rain physics, slow deliberate camera moves…"></textarea>
    ${saveRow}
    ${baseView}`;
}

// Loads gem base + project direction into the editor and wires Save (builder for nb-frames, freetext otherwise).
async function loadGemEditor(gemId) {
  const { base, override, builder } = await api(`/api/projects/${state.current.id}/gems/${gemId}`);
  const bv = $('#gemBaseView'); if (bv) bv.textContent = base || '(empty)';

  if (gemId === 'nb-frames') {
    const b = builder || {};
    const fieldIds = ['campaign', 'look', 'lighting', 'lens', 'palette', 'environment', 'aspectRatio', 'wardrobe', 'extra'];
    const styleIds = ['look', 'lighting', 'lens', 'palette', 'environment', 'aspectRatio', 'wardrobe', 'extra'];
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
  activeTab: 'nb-frames',
  attachments: {},      // per-gem: array of {name, mimeType, data, url}
  refImages: [],        // for generate panel
  klingMode: localStorage.getItem('avs:klingMode') || 'single',  // 'single' (3 variations) | 'multi' (multi-shot)
  nbModel: localStorage.getItem('avs:nbModel') || 'nb2',         // 'nb2' (flash) | 'pro' (Nano Banana Pro)
  genAR: localStorage.getItem('avs:genAR') ?? '16:9',            // generator aspect ratio — defaults to 16:9, remembers last pick
};

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
  if (pick) openProject(pick);
}
function renderKeyStatus() {
  const c = state.config;
  $('#keyStatus').innerHTML =
    `Claude key ${c.hasAnthropic ? '<b>ok</b>' : '<span class="bad">missing</span>'}<br>` +
    `Gemini key ${c.hasGemini ? '<b>ok</b>' : '<span class="bad">missing</span>'}`;
}

function wireGlobal() {
  $('#newProjectBtn').onclick = newProject;
  $('#newProjectBtn2').onclick = newProject;
  $('#showcaseBtn').onclick = openShowcase;
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
  $$('#wsTabs .tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  // close any open favorites popover when clicking outside it / its toggle button
  document.addEventListener('click', (e) => {
    if (e.target.closest('.fav-picker') || e.target.closest('.fav-open')) return;
    $$('.fav-picker').forEach(p => p.classList.add('hidden'));
  });
}

// ── projects ────────────────────────────────────────────────────────────────
async function loadProjects() {
  state.projects = await api('/api/projects');
  const list = $('#projectList');
  list.innerHTML = '';
  state.projects.forEach(p => {
    const el = document.createElement('div');
    el.className = 'project-item' + (state.current?.id === p.id ? ' active' : '');
    el.innerHTML = `<span class="pname">${escapeHtml(p.name)}</span><span class="pdel" title="Delete">🗑</span>`;
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
    list.appendChild(el);
  });
}

async function newProject() {
  const name = prompt('Project name', 'New Production');
  if (name === null) return;
  const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
  await loadProjects();
  openProject(p.id);
}

async function openProject(pid) {
  state.current = await api(`/api/projects/${pid}`);
  try { localStorage.setItem('avs:lastProject', pid); } catch {}
  state.attachments = {};
  state.refImages = [];
  $('#emptyState').classList.add('hidden');
  $('#showcaseView').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  $('#projectNameInput').value = state.current.name;
  $('#wsMeta').textContent = `created ${new Date(state.current.createdAt).toLocaleDateString()}`;
  await loadProjects();
  switchTab(state.activeTab);
}
function showEmpty() {
  $('#workspace').classList.add('hidden');
  $('#showcaseView').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
}

// ── Showcase (global): upload portfolio videos that power the public landing page ──
async function openShowcase() {
  $('#emptyState').classList.add('hidden');
  $('#workspace').classList.add('hidden');
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

// ── tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  state.activeTab = tab;
  $$('#wsTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const body = $('#wsBody');
  body.innerHTML = '';
  if (tab === 'generate') renderGenerate(body);
  else if (tab === 'library') renderLibrary(body);
  else renderChat(body, tab);
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
  const panel = document.createElement('div');
  panel.className = 'chat-panel';
  panel.innerHTML = `
    <div class="chat-intro">
      <div class="ci-text"><b>${meta.name}.</b> ${meta.blurb}</div>
      <div class="chat-actions">
        ${klingToggle}
        <button class="mini-btn" id="gemEditToggle">⚙ Tune gem</button>
        <button class="mini-btn" id="clearChat">Clear</button>
      </div>
    </div>
    <div class="gem-editor hidden" id="gemEditor">
      <div class="gem-body">${gemEditorBody(gemId, meta)}</div>
    </div>
    <div class="chat-scroll" id="chatScroll"></div>
    <div class="composer">
      <div class="fav-picker hidden" id="favPicker"></div>
      <div class="composer-attach" id="composerAttach"></div>
      <div class="composer-row">
        <button class="attach-btn" id="attachBtn" title="Attach or paste an image">📎</button>
        <button class="attach-btn fav-open" id="favBtn" title="Add from this project's favorites">★</button>
        <input type="file" id="fileInput" accept="image/*" multiple hidden />
        <textarea id="chatInput" rows="1" placeholder="${chatPlaceholder(gemId)}"></textarea>
        <button class="send-btn" id="sendBtn">Send</button>
      </div>
    </div>`;
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
  $('#clearChat').onclick = async () => {
    await api(`/api/projects/${state.current.id}/chat/clear`, { method: 'POST', body: JSON.stringify({ gemId }) });
    state.current.chats[gemId] = [];
    renderMessages(gemId);
  };

  // attachments
  state.attachments[gemId] = state.attachments[gemId] || [];
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
    if (opening) renderFavPicker(gemId);
  };

  // drag & drop image files from the OS straight into the chat
  panel.addEventListener('dragover', (e) => { if (dragHasFiles(e)) { e.preventDefault(); panel.classList.add('drag-over'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag-over'); });
  panel.addEventListener('drop', async (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    panel.classList.remove('drag-over');
    const files = [...(e.dataTransfer.files || [])].filter(f => (f.type || '').startsWith('image/'));
    if (!files.length) { toast('Only image files can be dropped here.', true); return; }
    for (const f of files) {
      const data = await fileToB64(f);
      state.attachments[gemId].push({ name: f.name, mimeType: f.type, data, url: URL.createObjectURL(f) });
    }
    renderAttachments(gemId);
    toast(`${files.length} image${files.length > 1 ? 's' : ''} added.`);
  });

  // textarea autosize + enter to send
  const ta = $('#chatInput');
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; };
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(gemId); } };
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
  $('#sendBtn').onclick = () => sendChat(gemId);

  renderMessages(gemId);
  renderAttachments(gemId);
}

function chatPlaceholder(gemId) {
  return {
    'nb-frames': 'Describe the scene & action (the reference image carries identity)…',
    'kling': 'Describe the motion you want from the attached still…',
    'kling-advisor': 'Describe your source clip + how to restyle / transform it…',
    'nb-advisor': 'What do you want to change in the attached image?',
  }[gemId];
}

function renderAttachments(gemId) {
  const wrap = $('#composerAttach');
  if (!wrap) return;
  const atts = state.attachments[gemId] || [];
  wrap.innerHTML = atts.map((a, i) =>
    `<div class="thumb"><img src="${a.url}" /><button class="rm" data-i="${i}">✕</button></div>`).join('');
  $$('.thumb .rm', wrap).forEach(b => b.onclick = () => { atts.splice(+b.dataset.i, 1); renderAttachments(gemId); });
}

// Build the favorites popover into a container; onPick(im) runs when a favorite is chosen.
function renderFavPickerInto(picker, onPick) {
  if (!picker) return;
  const favs = (state.current?.images || []).filter(i => i.favorite);
  if (!favs.length) {
    picker.innerHTML = `<div class="fav-empty">No favorites yet — tap ★ on images in the Library to pin them here.</div>`;
    return;
  }
  picker.innerHTML = `<div class="fav-head">Add from favorites</div>` +
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

// Fetch a saved favorite image into an attachment object {name, mimeType, data, url}.
async function favoriteToAttachment(im) {
  const url = `/media/${state.current.id}/images/${im.file}`;
  const blob = await (await mediaFetch(url)).blob();
  const data = await fileToB64(blob);
  return { name: im.file, mimeType: blob.type || 'image/jpeg', data, url };
}

// Chat composer: add a favorite as a message attachment.
function renderFavPicker(gemId) {
  renderFavPickerInto($('#favPicker'), async (im) => {
    try {
      const att = await favoriteToAttachment(im);
      state.attachments[gemId] = state.attachments[gemId] || [];
      state.attachments[gemId].push(att);
      renderAttachments(gemId);
      toast('Added from favorites.');
    } catch { toast('Could not add that image.', true); }
  });
}

// Generator: add a favorite as a reference image.
function renderGenFavPicker() {
  renderFavPickerInto($('#genFavPicker'), async (im) => {
    try {
      state.refImages.push(await favoriteToAttachment(im));
      renderRefImages();
      toast('Reference added from favorites.');
    } catch { toast('Could not add that image.', true); }
  });
}

function renderMessages(gemId) {
  const scroll = $('#chatScroll');
  if (!scroll) return;
  const msgs = state.current.chats[gemId] || [];
  if (msgs.length === 0) {
    scroll.innerHTML = `<div class="gen-empty">No messages yet. ${GEM_META[gemId].name} is ready when you are.</div>`;
    return;
  }
  // Render messages; assistant prompts carry the most recent attached image(s) as references.
  let refImgs = [];
  scroll.innerHTML = msgs.map(m => {
    if (m.role === 'user') {
      if (m.images && m.images.length) refImgs = m.images;
      return renderMsg(m, []);
    }
    return renderMsg(m, refImgs);
  }).join('');
  // wire copy buttons + generate links
  $$('.copy-block', scroll).forEach(b => b.onclick = () => {
    navigator.clipboard.writeText(decodeURIComponent(b.dataset.text));
    b.textContent = 'copied'; setTimeout(() => b.textContent = 'copy', 1400);
  });
  $$('.gen-link', scroll).forEach(b => b.onclick = () => sendPromptToGenerator(b));
  $$('.reuse-prompt', scroll).forEach(b => b.onclick = () => reusePromptInComposer(b));
  scroll.scrollTop = scroll.scrollHeight;
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
  toast(added
    ? `Prompt + ${added} reference image${added > 1 ? 's' : ''} loaded into the composer — ready to edit, copy, or resend.`
    : 'Prompt loaded into the composer — ready to edit, copy, or resend.');
}

// Send a prompt to the generator, carrying its relevant reference image(s) from the chat.
function sendPromptToGenerator(btn) {
  const prompt = decodeURIComponent(btn.dataset.text || '');
  let imgs = [];
  try { imgs = JSON.parse(decodeURIComponent(btn.dataset.imgs || '%5B%5D')); } catch {}
  // "Send to NB" REPLACES the generator: drop any previously attached reference(s) up front,
  // then load only this prompt's text + its own reference image(s).
  state.refImages = [];
  switchTab('generate');
  setTimeout(async () => {
    const t = $('#genPrompt');
    if (t) { t.value = prompt; t.dispatchEvent(new Event('input')); }
    let added = 0;
    for (const im of imgs) {
      const url = `/media/${state.current.id}/uploads/${im.file}`;
      try {
        const blob = await (await mediaFetch(url)).blob();
        const data = await fileToB64(blob);
        state.refImages.push({ name: im.file, mimeType: im.mimeType || blob.type || 'image/jpeg', data, url });
        added++;
      } catch { /* skip an image that can't be fetched */ }
    }
    renderRefImages();
    toast(added ? `Prompt + ${added} reference image${added > 1 ? 's' : ''} sent (generator reset).` : 'Prompt sent (generator reset).');
  }, 60);
}

function renderMsg(m, refImgs = []) {
  const tag = m.role === 'user' ? 'YOU' : GEM_META[state.activeTab]?.name?.toUpperCase() || 'CLAUDE';
  let content;
  if (m.role === 'assistant') {
    content = renderAssistant(m.content, refImgs);
  } else {
    let strip = '';
    if (m.images && m.images.length) {
      strip = `<div class="chat-images-strip">${m.images.map(im =>
        `<img class="chat-att-thumb" src="/media/${state.current.id}/uploads/${im.file}" loading="lazy" />`).join('')}</div>`;
    } else if (m.hadImages) {
      strip = '<div class="chat-images-strip"><em style="font-size:11px;color:var(--ink-faint)">+ attached image(s)</em></div>';
    }
    content = escapeHtml(m.content) + strip;
  }
  return `<div class="msg ${m.role}"><div class="role-tag">${tag}</div><div class="bubble">${content}</div></div>`;
}

// Render assistant text: turn ```code``` blocks and PROMPT n labels into rich cards.
// refImgs = the relevant attached image(s) to carry to the generator with the prompt.
function renderAssistant(text, refImgs = []) {
  const imgsAttr = `data-imgs="${encodeURIComponent(JSON.stringify(refImgs || []))}"`;
  // Split fenced code blocks first
  const parts = text.split(/```(?:[a-zA-Z]*\n)?/);
  let html = '';
  parts.forEach((seg, i) => {
    if (i % 2 === 1) {
      // code block
      const enc = encodeURIComponent(seg.trimEnd());
      html += `<pre><button class="copy-block" data-text="${enc}">copy</button>${escapeHtml(seg.trimEnd())}</pre>` +
        `<div class="pc-actions"><button class="reuse-prompt" data-text="${enc}" ${imgsAttr}>↻ Reuse prompt</button>` +
        (!state.activeTab.startsWith('kling') ? `<button class="gen-link" data-text="${enc}" ${imgsAttr}>⚡ Send to Nano Banana 2</button>` : '') +
        `</div>`;
    } else {
      html += formatProse(seg, imgsAttr);
    }
  });
  return html;
}

// For NB Frames the prompts come as "PROMPT 1 — name" plain paragraphs (no fences).
// Detect those and wrap each into a copyable card with a generate button.
function formatProse(seg, imgsAttr = '') {
  if (!seg.trim()) return '';
  const promptSplit = seg.split(/(?=PROMPT\s*\d\s*[—\-:])/g);
  if (promptSplit.length > 1) {
    return promptSplit.map(chunk => {
      const m = chunk.match(/^\**PROMPT\s*\d\s*[—\-:].*$/m);
      if (!m) return chunk.replace(/[\s*]/g, '') ? inlineFmt(chunk) : '';   // skip stray "**"/blank chunks
      const headLine = m[0];
      const bodyText = chunk.replace(headLine, '').trim().replace(/^\*+|\*+$/g, '').trim();
      const enc = encodeURIComponent(bodyText);
      return `<div class="prompt-card"><div class="pc-head">${escapeHtml(headLine.replace(/\*+/g, '').replace(/^PROMPT\s*/i, 'Prompt '))}</div>` +
        `<pre style="margin:8px 14px"><button class="copy-block" data-text="${enc}">copy</button>${escapeHtml(bodyText)}</pre>` +
        `<div class="pc-actions"><button class="reuse-prompt" data-text="${enc}" ${imgsAttr}>↻ Reuse prompt</button>` +
        `<button class="gen-link" data-text="${enc}" ${imgsAttr}>⚡ Send to Nano Banana 2</button></div></div>`;
    }).join('');
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
  if (!text && atts.length === 0) return;
  if (!state.config.hasAnthropic) { toast('Add your ANTHROPIC_API_KEY to .env first.', true); return; }

  const sendBtn = $('#sendBtn');
  sendBtn.disabled = true; sendBtn.innerHTML = '<span class="spinner"></span>';

  // optimistic user msg (keep a reference so we can fill in saved image refs from the response)
  const userMsg = { role: 'user', content: text || '(image)', hadImages: atts.length > 0, at: Date.now() };
  state.current.chats[gemId].push(userMsg);
  renderMessages(gemId);
  ta.value = ''; ta.style.height = 'auto';

  // Build history, scoped to the CURRENT scene so old references/prompts don't bleed in.
  // - Attaching new image(s) starts a fresh scene → send no prior history.
  // - A text-only follow-up keeps history only back to the most recent image-bearing turn.
  const priorAll = state.current.chats[gemId].slice(0, -1);  // everything before this turn
  let prior;
  if (atts.length > 0) {
    prior = [];
  } else {
    let start = 0;
    for (let i = priorAll.length - 1; i >= 0; i--) {
      const m = priorAll[i];
      if (m.role === 'user' && ((m.images && m.images.length) || m.hadImages)) { start = i; break; }
    }
    prior = priorAll.slice(start).map(m => ({ role: m.role, content: m.content }));
  }
  const images = atts.map(a => ({ mimeType: a.mimeType, data: a.data }));

  try {
    const { text: reply, images: savedImgs } = await api(`/api/projects/${state.current.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ gemId, userText: text, images, history: prior, klingMode: state.klingMode }),
    });
    if (savedImgs && savedImgs.length) userMsg.images = savedImgs;  // so "Send to Nano Banana" can carry them
    state.current.chats[gemId].push({ role: 'assistant', content: reply, at: Date.now() });
    state.attachments[gemId] = [];
    renderMessages(gemId);
    renderAttachments(gemId);
  } catch (e) {
    toast(e.message, true);
    state.current.chats[gemId].pop(); // remove optimistic on failure
    renderMessages(gemId);
  } finally {
    sendBtn.disabled = false; sendBtn.textContent = 'Send';
  }
}

// ── GENERATE panel (Nano Banana 2) ──────────────────────────────────────────────
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
        <textarea id="genPrompt" placeholder="Paste a prompt here…"></textarea>
      </div>
      <div>
        <span class="field-label">Reference image(s) — optional · attach, paste, or pull from favorites (identity / product / scene)</span>
        <div class="ref-row" id="refRow">
          <button class="ref-add" id="refAdd" title="Attach an image">＋</button>
          <button class="ref-add fav-open" id="genFavBtn" title="Add from favorites">★</button>
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
            <option value="9:16">9:16 vertical</option>
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
      <div class="section-head"><h3>Results</h3></div>
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
  gp.oninput = () => { gp.style.height = 'auto'; gp.style.height = Math.max(gp.scrollHeight, 200) + 'px'; };
  gp.addEventListener('paste', async (e) => {
    const files = filesFromPaste(e);
    if (!files.length) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    if (text) insertAtCursor(gp, text);              // prompt text + reference image(s) together
    for (const f of files) {
      const data = await fileToB64(f);
      state.refImages.push({ name: f.name || 'pasted.png', mimeType: f.type, data, url: URL.createObjectURL(f) });
    }
    renderRefImages();
    toast('Pasted prompt + reference image.');
  });
  $('#genBtn').onclick = doGenerate;
  $$('#nbModelToggle .seg').forEach(b => b.onclick = () => {
    state.nbModel = b.dataset.model;
    try { localStorage.setItem('avs:nbModel', state.nbModel); } catch {}
    $$('#nbModelToggle .seg').forEach(s => s.classList.toggle('active', s.dataset.model === state.nbModel));
  });
  paintGenResults();   // show all of this project's existing renders (newest first)
}

function renderRefImages() {
  const row = $('#refRow');
  if (!row) return;
  $$('.thumb', row).forEach(t => t.remove());
  const add = $('#refAdd');
  state.refImages.forEach((a, i) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.innerHTML = `<img src="${a.url}" /><button class="rm" data-i="${i}">✕</button>`;
    t.querySelector('.rm').onclick = () => { state.refImages.splice(i, 1); renderRefImages(); };
    row.insertBefore(t, add);
  });
}

async function doGenerate() {
  const prompt = $('#genPrompt').value.trim();
  if (!prompt) { toast('Paste or write a prompt first.', true); return; }
  if (!state.config.hasGemini) { toast('Add your GEMINI_API_KEY to .env first.', true); return; }
  const count = +$('#genCount').value;
  const aspectRatio = $('#genAR').value || undefined;
  const refImages = state.refImages.map(r => ({ mimeType: r.mimeType, data: r.data }));

  const btn = $('#genBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Generating…';

  // Accumulate: prepend skeletons to the existing results grid — never wipe prior renders.
  const grid = ensureGenGrid();
  grid.insertAdjacentHTML('afterbegin', Array.from({ length: count }, () => '<div class="skeleton gen-skel"></div>').join(''));

  try {
    const { images, errors } = await api(`/api/projects/${state.current.id}/generate`, {
      method: 'POST', body: JSON.stringify({ prompt, count, aspectRatio, refImages, model: state.nbModel }),
    });
    state.current.images = [...images.map(stripUrl), ...state.current.images];
    $$('.gen-skel', grid).forEach(s => s.remove());
    grid.insertAdjacentHTML('afterbegin', images.map(imgCard).join(''));   // newest on top, older kept below
    wireImageCards(grid);
    if (errors && errors.length) toast(`${images.length} generated · ${errors.length} failed`, true);
    else toast(`${images.length} image${images.length > 1 ? 's' : ''} generated`);
  } catch (e) {
    $$('.gen-skel', grid).forEach(s => s.remove());
    toast(e.message, true);
  } finally {
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
  const list = (state.current.images || []).map(im => ({ ...im, url: `/media/${state.current.id}/images/${im.file}` }));
  if (!list.length) { results.innerHTML = `<div class="gen-empty">Generated images appear here and stay — every render is kept (also in the Library).</div>`; return; }
  results.innerHTML = `<div class="results-grid" id="genGrid">${list.map(imgCard).join('')}</div>`;
  wireImageCards(results);
}

// ── image card (shared by generate + library) ───────────────────────────────────
function imgCard(im) {
  return `<div class="img-card" data-id="${im.id}">
    <div class="imgwrap"><img src="${im.url}" loading="lazy" data-prompt="${encodeURIComponent(im.prompt)}" /></div>
    <div class="card-foot">
      <span class="when">${timeAgo(im.createdAt)}</span>
      <div class="card-actions">
        <button class="icon-btn fav ${im.favorite ? 'on' : ''}" title="Favorite">★</button>
        <a class="icon-btn" title="Download" href="${im.url}" download>⬇</a>
        <button class="icon-btn del" title="Delete">🗑</button>
      </div>
    </div>
  </div>`;
}
function wireImageCards(scope) {
  $$('.img-card', scope).forEach(card => {
    const imgId = card.dataset.id;
    card.querySelector('.imgwrap').onclick = () => {
      // build the navigable set from every card currently in this grid (live order)
      const container = card.closest('.results-grid') || scope;
      const imgs = $$('.img-card img', container);
      const list = imgs.map(im => ({ src: im.src, caption: decodeURIComponent(im.dataset.prompt || '') }));
      const idx = imgs.indexOf(card.querySelector('img'));
      openLightbox(list, idx < 0 ? 0 : idx);
    };
    card.querySelector('.fav').onclick = async (e) => {
      const on = !e.currentTarget.classList.contains('on');
      await api(`/api/projects/${state.current.id}/images/${imgId}`, { method: 'PATCH', body: JSON.stringify({ favorite: on }) });
      e.currentTarget.classList.toggle('on', on);
      const rec = state.current.images.find(x => x.id === imgId); if (rec) rec.favorite = on;
    };
    card.querySelector('.del').onclick = async () => {
      if (!confirm('Delete this image?')) return;
      await api(`/api/projects/${state.current.id}/images/${imgId}`, { method: 'DELETE' });
      state.current.images = state.current.images.filter(x => x.id !== imgId);
      card.remove();
    };
  });
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
let libFilter = 'all';
async function renderLibrary(body) {
  const images = await api(`/api/projects/${state.current.id}/images`);
  state.current.images = images.map(stripUrl);
  const panel = document.createElement('div');
  panel.className = 'library-panel';
  panel.innerHTML = `
    <div class="lib-head">
      <h3>Library <span style="font-family:var(--mono);font-size:12px;color:var(--ink-faint)">${images.length} images</span></h3>
      <div class="lib-filter">
        <button class="mini-btn ${libFilter === 'all' ? 'on' : ''}" data-f="all">All</button>
        <button class="mini-btn ${libFilter === 'fav' ? 'on' : ''}" data-f="fav">★ Favorites</button>
      </div>
    </div>
    <div id="libGrid"></div>`;
  body.appendChild(panel);
  $$('.lib-filter .mini-btn', panel).forEach(b => b.onclick = () => { libFilter = b.dataset.f; renderLibrary($('#wsBody')); $('#wsBody').firstChild?.remove(); });
  drawLibGrid(images);
}
function drawLibGrid(images) {
  const grid = $('#libGrid');
  const list = libFilter === 'fav' ? images.filter(i => i.favorite) : images;
  if (list.length === 0) { grid.innerHTML = `<div class="gen-empty">${libFilter === 'fav' ? 'No favorites yet — tap ★ on any image.' : 'No images yet. Generate some in the Nano Banana 2 tab.'}</div>`; return; }
  grid.innerHTML = `<div class="results-grid">${list.map(imgCard).join('')}</div>`;
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
  _firebaseAuth = getAuth(initializeApp(cfg.firebase));
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
      let ok = false;
      try { await api('/api/projects'); ok = true; } catch { ok = false; }
      if (ok) {
        overlay?.classList.add('hidden');
        if (!done) { done = true; resolve(); }
      } else {
        setStatus(`${user.email} isn't on the allowlist for this studio.`);
        outBtn?.classList.remove('hidden');
      }
    });
  });
}

initAuth()
  .then(() => boot())
  .catch(e => { console.error(e); document.body.innerHTML = `<div style="padding:40px;font-family:monospace;color:#e2685f">Failed to start: ${e.message}</div>`; });
