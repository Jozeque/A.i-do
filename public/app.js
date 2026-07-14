// ── AI Video Studio — frontend ────────────────────────────────────────────────
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

const GEM_META = {
  'nb-frames': { name: 'NB Frames', blurb: 'Attach a reference image + describe the scene. Returns <b>3</b> cinematic Nano Banana 2 prompts.' },
  'kling': { name: 'Kling Prompter', blurb: 'Attach your still + describe the motion. Returns <b>3</b> Kling 3.0 video prompts (fidelity / physics / cinematic).' },
  'kling-advisor': { name: 'Kling Advisor', blurb: 'Describe your source clip + the change you want. Returns the best Kling 3.0 Omni <b>video-to-video</b> prompt (restyle / relight / transform) with why &amp; what to watch.' },
  'nb-advisor': { name: 'NB Advisor', blurb: 'Attach image(s) + say what to change. Returns the best Nano Banana 2 edit prompt with a quick rationale.' },
  'gpt-advisor': { name: 'GPT Advisor', blurb: 'Say what you want — a swap, an edit, or a new image — and attach reference(s). Returns the best <b>GPT Image 2 (ChatGPT)</b> prompt, tuned to keep your frame\'s look &amp; color.' },
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
  activeTab: (['nb-frames','characters','kling','kling-advisor','nb-advisor','gpt-advisor','swap','generate','library'].includes(localStorage.getItem('avs:lastTab')) ? localStorage.getItem('avs:lastTab') : 'nb-frames'),
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
  startProjectListSync();          // live sidebar (projects added/renamed/deleted by either user)
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
  $('#expensesBtn').onclick = openExpenses;
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
  $$('#wsTabs .tab').forEach(t => {
    t.onclick = () => switchTab(t.dataset.tab);
    // Drag an image (from NB2 results / Library) onto a tab to attach it there.
    t.addEventListener('dragover', (e) => {
      if (DROP_TABS.includes(t.dataset.tab) && Array.from(e.dataTransfer.types || []).includes('text/avs-image')) {
        e.preventDefault(); t.classList.add('tab-drop');
      }
    });
    t.addEventListener('dragleave', () => t.classList.remove('tab-drop'));
    t.addEventListener('drop', (e) => {
      t.classList.remove('tab-drop');
      const url = e.dataTransfer.getData('text/avs-image');
      if (!url) return;
      e.preventDefault();
      dropImageOnTab(t.dataset.tab, url);
    });
  });
  // close any open favorites popover when clicking outside it / its toggle button
  document.addEventListener('click', (e) => {
    if (e.target.closest('.fav-picker') || e.target.closest('.fav-open')) return;
    $$('.fav-picker').forEach(p => p.classList.add('hidden'));
  });
}

// ── projects ────────────────────────────────────────────────────────────────
async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjectList();
}
function renderProjectList() {
  const list = $('#projectList');
  if (!list) return;
  list.innerHTML = '';
  (state.projects || []).forEach(p => {
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
    snap.forEach(d => { const p = d.data(); if (p && p.id) projects.push({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, imageCount: p.imageCount || 0, chatCount: p.chatCount || 0 }); });
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
  }, (e) => console.warn('[sync] meta:', e?.message || e)));

  // chat messages per gem — the "see each other's prompts" bit
  _projUnsubs.push(onSnapshot(collection(_fs, 'projects', pid, 'chats'), (snap) => {
    if (!mine()) return;
    snap.docChanges().forEach(ch => {
      const gemId = ch.doc.id;
      state.current.chats[gemId] = ch.doc.data().messages || [];
      if (state.activeTab === gemId && $('#chatScroll')) renderMessages(gemId);
    });
  }, (e) => console.warn('[sync] chats:', e?.message || e)));

  // generated images (Nano Banana 2 + Library) — redraw from state, never re-fetch
  _projUnsubs.push(onSnapshot(collection(_fs, 'projects', pid, 'images'), (snap) => {
    if (!mine()) return;
    state.current.images = snap.docs.map(d => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (state.activeTab === 'generate' && !state.generating) paintGenResults();
    else if (state.activeTab === 'library' && $('#libGrid')) {
      const imgs = state.current.images.map(im => ({ ...im, url: `/media/${state.current.id}/images/${im.file}` }));
      const c = $('.lib-head h3 span'); if (c) c.textContent = `${imgs.length} images`;
      drawLibGrid(imgs);
    }
  }, (e) => console.warn('[sync] images:', e?.message || e)));

  // characters
  _projUnsubs.push(onSnapshot(collection(_fs, 'projects', pid, 'characters'), (snap) => {
    if (!mine()) return;
    state.current.characters = snap.docs.map(d => d.data()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (state.activeTab === 'characters') renderCharsGallery();
  }, (e) => console.warn('[sync] characters:', e?.message || e)));
}

async function newProject() {
  const name = prompt('Project name', 'New Production');
  if (name === null) return;
  const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
  await loadProjects();
  openProject(p.id);
}

async function openProject(pid) {
  state.current = await api(`/api/projects/${pid}?light=1`);   // fast open; images load lazily below
  state.current.images = state.current.images || [];
  try { localStorage.setItem('avs:lastProject', pid); } catch {}
  state.attachments = {};
  state.drafts = {};
  state.refImages = [];
  $('#emptyState').classList.add('hidden');
  $('#showcaseView').classList.add('hidden');
  $('#expensesView').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  $('#projectNameInput').value = state.current.name;
  $('#wsMeta').textContent = `created ${new Date(state.current.createdAt).toLocaleDateString()}`;
  await loadProjects();
  switchTab(state.activeTab);
  syncProject(pid);                // live-stream this project's chats / images / characters
  // Load the (potentially large) image library in the BACKGROUND so the switch is instant.
  // The Library tab fetches its own; this keeps state.current.images ready for Generate + drag.
  api(`/api/projects/${pid}/images`).then(imgs => {
    if (state.current?.id !== pid) return;             // user switched away meanwhile
    state.current.images = imgs.map(stripUrl);
    // Generate shows recent renders from state.current.images; Library self-fetches, so leave it.
    if (state.activeTab === 'generate' && !state.generating) switchTab(state.activeTab);
  }).catch(() => {});
}
function showEmpty() {
  $('#workspace').classList.add('hidden');
  $('#showcaseView').classList.add('hidden');
  $('#expensesView').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
}

// ── Showcase (global): upload portfolio videos that power the public landing page ──
async function openShowcase() {
  $('#emptyState').classList.add('hidden');
  $('#workspace').classList.add('hidden');
  $('#expensesView').classList.add('hidden');
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
  const split = state.expSplit || 2;   // number = equal ways; '1:2' = ⅓ · ⅔ split
  const splitOpts = [{ v: '2', label: '2 · 50/50' }, { v: '1:2', label: '⅓ · ⅔' }, { v: '3', label: '3' }, { v: '4', label: '4' }, { v: '5', label: '5' }];
  const row = (b) => `<tr>
    <td>${escapeHtml(b.label)}</td>
    <td class="exp-num">${money(b.nb)}<span class="exp-sub">${b.nbImages} img</span></td>
    <td class="exp-num">${money(b.swap || 0)}<span class="exp-sub">${b.swapImages || 0} swap</span></td>
    <td class="exp-num">${money(b.claude)}<span class="exp-sub">${b.claudeCalls} calls</span></td>
    <td class="exp-num">${b.sub ? money(b.sub) : '—'}</td>
    <td class="exp-num exp-tot">${money(b.total)}</td></tr>`;
  const claudePct = u.total.total ? Math.round((u.total.claude / u.total.total) * 100) : 0;
  view.innerHTML = `
    <div class="exp-head">
      <h1>Expenses</h1>
      <p>Running cost across all projects — Nano Banana + Swap/Edit + Claude API usage, plus fixed subscriptions (ChatGPT Plus). Split by month for settling up with partners.</p>
    </div>
    <div class="exp-cards">
      <div class="exp-card exp-hero">
        <div class="exp-card-label">All-time total</div>
        <div class="exp-card-num">${money(u.total.total)}</div>
        <div class="exp-split">Split <select id="expSplit">${splitOpts.map(o => `<option value="${o.v}"${String(split) === o.v ? ' selected' : ''}>${o.label}</option>`).join('')}</select> → ${split === '1:2' ? `⅓ <b>${money(u.total.total / 3)}</b> · ⅔ <b>${money(u.total.total * 2 / 3)}</b>` : `<b>${money(u.total.total / (parseInt(split, 10) || 2))}</b> each`}</div>
      </div>
      <div class="exp-card"><div class="exp-card-label">Nano Banana · Google</div><div class="exp-card-num">${money(u.total.nb)}</div><div class="exp-card-sub">${u.total.nbImages} images · exact</div></div>
      <div class="exp-card"><div class="exp-card-label">Swap / Edit · fal + OpenAI</div><div class="exp-card-num">${money(u.total.swap || 0)}</div><div class="exp-card-sub">${u.total.swapImages || 0} renders · est.</div></div>
      <div class="exp-card"><div class="exp-card-label">Claude · Anthropic</div><div class="exp-card-num">${money(u.total.claude)}</div><div class="exp-card-sub">${u.total.claudeCalls} prompts · est.</div></div>
      <div class="exp-card"><div class="exp-card-label">Subscriptions</div><div class="exp-card-num">${money(u.total.sub || 0)}</div><div class="exp-card-sub">ChatGPT Plus · $20/mo</div></div>
    </div>
    <h2 class="exp-h2">By month</h2>
    <table class="exp-table"><thead><tr><th>Month</th><th>Nano Banana</th><th>Swap/Edit</th><th>Claude</th><th>Subs</th><th>Total</th></tr></thead>
      <tbody>${u.months.map(row).join('') || '<tr><td colspan="6" class="exp-empty">No usage yet.</td></tr>'}</tbody></table>
    <h2 class="exp-h2">Recent weeks</h2>
    <table class="exp-table"><thead><tr><th>Week</th><th>Nano Banana</th><th>Swap/Edit</th><th>Claude</th><th>Subs</th><th>Total</th></tr></thead>
      <tbody>${u.weeks.map(row).join('') || '<tr><td colspan="6" class="exp-empty">—</td></tr>'}</tbody></table>
    <p class="exp-note"><b>Nano Banana is exact</b> — billed per image by model + resolution. <b>Claude and Swap/Edit are estimated</b> (Claude from message sizes ±~15%; Swap ≈ $0.08 Flux / $0.21 GPT Image 2 per render). <b>Subscriptions</b> (ChatGPT Plus $20/mo) are fixed monthly costs added to each month since July 2026 — shown in months, not weeks. For invoices, check the Anthropic, Google AI Studio, fal.ai, and OpenAI dashboards.${u.cached ? ' · cached' : ''}</p>`;
  const sel = view.querySelector('#expSplit');
  if (sel) sel.onchange = () => { state.expSplit = sel.value.includes(':') ? sel.value : parseInt(sel.value, 10); renderExpenses(view, u); };
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
  saveDrafts();                                  // keep the outgoing tab's unsent text inputs
  state.activeTab = tab;
  try { localStorage.setItem('avs:lastTab', tab); } catch {}
  $$('#wsTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
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
      method: 'POST', body: JSON.stringify({ prompt: s.prompt, images, model: s.model, ab }),
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
        <textarea id="chatInput" data-draft rows="1" placeholder="${chatPlaceholder(gemId)}"></textarea>
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
  state.current.chats = state.current.chats || {};
  state.current.chats[gemId] = state.current.chats[gemId] || [];   // a brand-new gem has no chat doc yet
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
    'gpt-advisor': 'Describe the swap / edit / image you want (attach the frame + any reference)…',
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

// Drag an image card (from NB2 results / Library) onto a tab button to attach it there.
const DROP_TABS = ['nb-frames', 'kling', 'kling-advisor', 'nb-advisor', 'gpt-advisor', 'generate', 'swap'];
async function urlToAttachment(url) {
  const blob = await (await mediaFetch(url)).blob();
  const data = await fileToB64(blob);
  return { name: url.split('/').pop() || 'image', mimeType: blob.type || 'image/jpeg', data, url };
}
async function dropImageOnTab(tab, url) {
  if (!DROP_TABS.includes(tab) || !state.current) return;
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
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  const prevTop = scroll.scrollTop;
  const msgs = state.current.chats[gemId] || [];
  if (msgs.length === 0) {
    scroll.innerHTML = `<div class="gen-empty">No messages yet. ${GEM_META[gemId].name} is ready when you are.</div>`;
    return;
  }
  // Render messages; assistant prompts carry the most recent attached image(s) as references.
  let refImgs = [];
  scroll.innerHTML = msgs.map(m => {
    if (m.role === 'user') {
      // Reset per user turn: a text-only turn carries NO reference, so an assistant reply never
      // inherits a PREVIOUS prompt's image (matches the server, which only sends the current
      // turn's images). This was the "stale / irrelevant reference gets attached" bug.
      refImgs = (m.images && m.images.length) ? m.images : [];
      return renderMsg(m, []);
    }
    return renderMsg(m, refImgs);
  }).join('');
  // wire copy buttons + generate links
  $$('.copy-block', scroll).forEach(b => b.onclick = async () => {
    const ok = await copyTextToClipboard(decodeURIComponent(b.dataset.text));
    b.textContent = ok ? 'copied' : 'copy failed';
    setTimeout(() => b.textContent = 'copy', 1400);
  });
  $$('.gen-link', scroll).forEach(b => b.onclick = () => sendPromptToGenerator(b));
  $$('.gen-all', scroll).forEach(b => b.onclick = () => sendAllToGenerator(b));
  $$('.reuse-prompt', scroll).forEach(b => b.onclick = () => reusePromptInComposer(b));
  $$('.msg-copy', scroll).forEach(b => b.onclick = () => copyUserBlock(b));
  $$('.ref-thumb', scroll).forEach(t => t.onclick = () => openLightbox([{ src: t.dataset.full, caption: 'Reference this output was built from' }], 0));
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

// Copy a SENT (user) message's whole block: text to the clipboard, and the text + its
// reference image(s) back into this tab's composer — ready to resend, tweak, or send on.
async function copyUserBlock(btn) {
  const t = decodeURIComponent(btn.dataset.text || ''); if (t) await copyTextToClipboard(t);
  await reusePromptInComposer(btn);
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
  let prompts = [], imgs = [];
  try { prompts = JSON.parse(decodeURIComponent(btn.dataset.prompts || '%5B%5D')); } catch {}
  try { imgs = JSON.parse(decodeURIComponent(btn.dataset.imgs || '%5B%5D')); } catch {}
  prompts = prompts.filter(p => p && p.trim());
  if (!prompts.length) return;
  if (!state.config.hasGemini) { toast('Add your GEMINI_API_KEY to .env first.', true); return; }
  // Working reference set: the frames' own reference(s) + anything the user adds in the popup.
  const refs = imgs.map(im => ({ mimeType: im.mimeType || 'image/jpeg', file: im.file, thumbUrl: `/media/${state.current.id}/uploads/${im.file}` }));
  _sendAll = { prompts, refs };
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
    ? refs.map((r, i) => `<div class="sa-ref"><img src="${r.thumbUrl}" loading="lazy" /><button class="sa-ref-x" data-i="${i}" title="Remove this reference">×</button></div>`).join('')
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
    const { prompts, refs } = _sendAll;
    close();
    // Resolve every reference to base64 — freshly-uploaded ones already have data; existing
    // ones are fetched from /media.
    const refImages = [];
    for (const r of refs) {
      if (r.data) { refImages.push({ mimeType: r.mimeType, data: r.data }); continue; }
      try {
        const blob = await (await mediaFetch(r.thumbUrl)).blob();
        refImages.push({ mimeType: r.mimeType || blob.type || 'image/jpeg', data: await fileToB64(blob) });
      } catch { /* skip a ref that can't be fetched */ }
    }
    runSendAll(prompts, refImages);
  };
}

// Fire every prompt in parallel (one image each) and drop the results into the NB2 grid.
async function runSendAll(prompts, refImages) {
  if (state.generating) { toast('A generation is already running — wait for it to finish.', true); return; }
  switchTab('generate');
  await new Promise(r => setTimeout(r, 0));   // let the generate tab paint
  const aspectRatio = $('#genAR')?.value || undefined;
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
  const jobs = prompts.map(prompt =>
    api(`/api/projects/${state.current.id}/generate`, {
      method: 'POST', body: JSON.stringify({ prompt, count: 1, aspectRatio, refImages, model: state.nbModel }),
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
    const copyBtn = (m.content || (m.images && m.images.length))
      ? `<button class="msg-copy" data-text="${encodeURIComponent(m.content || '')}" data-imgs="${encodeURIComponent(JSON.stringify(m.images || []))}" title="Copy this message: text to clipboard + the whole block (text and reference images) back into the composer">⧉ copy</button>`
      : '';
    content = escapeHtml(m.content) + strip + copyBtn;
  }
  return `<div class="msg ${m.role}"><div class="role-tag">${tag}</div><div class="bubble">${content}</div></div>`;
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
  if (refImgs && refImgs.length && state.current) {
    refStrip = `<div class="ref-strip"><span class="ref-label">reference</span>` +
      refImgs.map(im => {
        const url = `/media/${state.current.id}/uploads/${im.file}`;
        return `<img class="ref-thumb" src="${url}" data-full="${url}" loading="lazy" title="Reference this output was built from — click to enlarge" />`;
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
        `<div class="pc-actions"><button class="reuse-prompt" data-text="${enc}" ${imgsAttr}>↻ Reuse prompt</button>` +
        (!state.activeTab.startsWith('kling') ? `<button class="gen-link" data-text="${enc}" ${imgsAttr}>⚡ Send to Nano Banana 2</button>` : '') +
        `</div>`;
    } else {
      html += formatProse(seg, imgsAttr);
    }
  });
  return refStrip + html;
}

// For NB Frames the prompts come as "PROMPT 1 — name" plain paragraphs (no fences).
// Detect those and wrap each into a copyable card with a generate button.
function formatProse(seg, imgsAttr = '') {
  if (!seg.trim()) return '';
  const promptSplit = seg.split(/(?=PROMPT\s*\d\s*[—\-:])/g);
  if (promptSplit.length > 1) {
    const prompts = [];
    const cards = promptSplit.map(chunk => {
      const m = chunk.match(/^\**PROMPT\s*\d\s*[—\-:].*$/m);
      if (!m) return chunk.replace(/[\s*]/g, '') ? inlineFmt(chunk) : '';   // skip stray "**"/blank chunks
      const headLine = m[0];
      const bodyText = chunk.replace(headLine, '').trim().replace(/^\*+|\*+$/g, '').trim();
      prompts.push(bodyText);
      const enc = encodeURIComponent(bodyText);
      return `<div class="prompt-card"><div class="pc-head">${escapeHtml(headLine.replace(/\*+/g, '').replace(/^PROMPT\s*/i, 'Prompt '))}</div>` +
        `<pre style="margin:8px 14px"><button class="copy-block" data-text="${enc}">copy</button>${escapeHtml(bodyText)}</pre>` +
        `<div class="pc-actions"><button class="reuse-prompt" data-text="${enc}" ${imgsAttr}>↻ Reuse prompt</button>` +
        `<button class="gen-link" data-text="${enc}" ${imgsAttr}>⚡ Send to Nano Banana 2</button></div></div>`;
    }).join('');
    // One click → generate ALL prompts at once (each prompt → one image), fired in parallel.
    const sendAll = prompts.length > 1
      ? `<div class="pc-sendall"><button class="gen-all" data-prompts="${encodeURIComponent(JSON.stringify(prompts))}" ${imgsAttr}>⚡ Send all ${prompts.length} to Nano Banana 2 →</button></div>`
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
  if (!text && atts.length === 0) return;
  if (!state.config.hasAnthropic) { toast('Add your ANTHROPIC_API_KEY to .env first.', true); return; }

  const sendBtn = $('#sendBtn');
  sendBtn.disabled = true; sendBtn.innerHTML = '<span class="spinner"></span>';

  // optimistic user msg (keep a reference so we can fill in saved image refs from the response)
  const userMsg = { role: 'user', content: text || '(image)', hadImages: atts.length > 0, at: Date.now() };
  state.current.chats = state.current.chats || {};
  state.current.chats[gemId] = state.current.chats[gemId] || [];   // guard: new gem (no Firestore doc yet)
  state.current.chats[gemId].push(userMsg);
  renderMessages(gemId);
  ta.value = ''; ta.style.height = 'auto';
  if (state.drafts) delete state.drafts[`${gemId}:chatInput`];   // sent → clear this tab's draft

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
  wireGenPaste();   // paste an image anywhere on the tab (not only in the prompt box) → reference
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

// ── CHARACTERS tab ─────────────────────────────────────────────────────────────
// Build a reusable, identity-locked reference sheet from a few actor photos, then attach
// it to NB Frames. Kept in its own `characters` collection — never in the Library.
function renderCharacters(body) {
  state.charUploads = state.charUploads || [];
  state.charWardrobe = state.charWardrobe || [];
  const panel = document.createElement('div');
  panel.className = 'chars-panel';
  panel.innerHTML = `
    <div class="chars-new">
      <div class="section-head"><h3>New character</h3></div>
      <p class="chars-hint">Upload a few clear photos of the person. We generate one clean multi-view reference sheet — a close-up plus front, three-quarter, and profile views — so NB&nbsp;Frames can place them in any scene with the same face. <b>A single close-up drifts; the sheet holds.</b></p>
      <input class="char-text" id="charName" data-draft placeholder="Name (e.g. Maya, Detective Cole)" />
      <textarea class="char-text" id="charNotes" data-draft rows="2" placeholder="Optional — wardrobe in words, age, a beard, glasses… (blank = keep them exactly as the photos)"></textarea>
      <span class="field-label">Photos of the person — identity · a few angles / expressions work best</span>
      <div class="ref-row" id="charRefRow">
        <button class="ref-add" id="charAdd" title="Add photos of the person">＋</button>
        <input type="file" id="charInput" accept="image/*" multiple hidden />
      </div>
      <span class="field-label">Wardrobe / outfit references — optional · face &amp; look come from the photos above, only the clothes come from these</span>
      <div class="ref-row" id="charWardrobeRow">
        <button class="ref-add" id="charWardrobeAdd" title="Add wardrobe / outfit photos">＋</button>
        <input type="file" id="charWardrobeInput" accept="image/*" multiple hidden />
      </div>
      <button class="generate-btn" id="charGenBtn">Generate reference sheet</button>
      <div class="gen-hint">Rendered on Nano Banana Pro at 2K. Stored with this project — separate from your Library and Nano Banana outputs.</div>
    </div>
    <div class="chars-gallery" id="charsGallery"></div>`;
  body.appendChild(panel);
  $('#charAdd').onclick = () => $('#charInput').click();
  $('#charInput').onchange = async (e) => {
    for (const f of e.target.files) {
      try { const data = await fileToB64(f); state.charUploads.push({ name: f.name, mimeType: f.type, data, url: URL.createObjectURL(f) }); } catch {}
    }
    renderCharUploads(); e.target.value = '';
  };
  $('#charWardrobeAdd').onclick = () => $('#charWardrobeInput').click();
  $('#charWardrobeInput').onchange = async (e) => {
    for (const f of e.target.files) {
      try { const data = await fileToB64(f); state.charWardrobe.push({ name: f.name, mimeType: f.type, data, url: URL.createObjectURL(f) }); } catch {}
    }
    renderCharWardrobe(); e.target.value = '';
  };
  $('#charGenBtn').onclick = doCreateCharacter;
  renderCharUploads();
  renderCharWardrobe();
  renderCharsGallery();
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

function renderCharsGallery() {
  const gallery = $('#charsGallery');
  if (!gallery) return;
  const chars = state.current.characters || [];
  if (!chars.length) {
    gallery.innerHTML = `<div class="gen-empty">No characters yet. Build one above, then attach it to NB Frames to keep the same face across every scene.</div>`;
    return;
  }
  gallery.innerHTML = chars.map(c => {
    const refUrl = `/media/${state.current.id}/images/${c.reference.file}`;
    const srcs = [...(c.sourceImages || []), ...(c.wardrobeImages || [])].map(s => `<img class="char-src" src="/media/${state.current.id}/uploads/${s.file}" loading="lazy" />`).join('');
    return `<div class="char-card" data-id="${c.id}">
      <a class="char-ref" href="${refUrl}" target="_blank" rel="noopener"><img src="${refUrl}" loading="lazy" /></a>
      <div class="char-meta">
        <div class="char-name">${escapeHtml(c.name)}</div>
        ${c.notes ? `<div class="char-notes">${escapeHtml(c.notes)}</div>` : ''}
        ${srcs ? `<div class="char-srcs" title="Source photos">${srcs}</div>` : ''}
        <div class="char-actions">
          <button class="mini-btn char-use" data-id="${c.id}">＋ Use in NB Frames</button>
          <a class="mini-btn" href="${refUrl}" download="${escapeHtml(c.name)}-reference.png">⬇</a>
          <button class="mini-btn char-del" data-id="${c.id}">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
  $$('.char-use', gallery).forEach(b => b.onclick = () => useCharacterInFrames(chars.find(c => c.id === b.dataset.id)));
  $$('.char-del', gallery).forEach(b => b.onclick = () => deleteCharacter(b.dataset.id));
}

async function doCreateCharacter() {
  const name = ($('#charName')?.value || '').trim();
  const notes = ($('#charNotes')?.value || '').trim();
  if (!name) { toast('Give the character a name first.', true); return; }
  if (!(state.charUploads || []).length) { toast('Add at least one photo of the person.', true); return; }
  const btn = $('#charGenBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Building reference…'; }
  const gallery = $('#charsGallery');
  if (gallery && !gallery.querySelector('.char-card')) gallery.innerHTML = '';
  if (gallery) gallery.insertAdjacentHTML('afterbegin', '<div class="char-card char-skel"><div class="skeleton"></div></div>');
  try {
    const images = state.charUploads.map(u => ({ mimeType: u.mimeType, data: u.data }));
    const wardrobeImages = (state.charWardrobe || []).map(u => ({ mimeType: u.mimeType, data: u.data }));
    const { character } = await api(`/api/projects/${state.current.id}/characters`, {
      method: 'POST', body: JSON.stringify({ name, notes, images, wardrobeImages }),
    });
    state.current.characters = state.current.characters || [];
    state.current.characters.unshift(character);
    state.charUploads = [];
    state.charWardrobe = [];
    if ($('#charName')) $('#charName').value = '';
    if ($('#charNotes')) $('#charNotes').value = '';
    renderCharUploads();
    renderCharWardrobe();
    toast(`${character.name} is ready — attach the reference to NB Frames from the card.`);
  } catch (e) {
    toast(e.message || 'Could not build the character.', true);
  } finally {
    const b = $('#charGenBtn');
    if (b) { b.disabled = false; b.innerHTML = 'Generate reference sheet'; }
    renderCharsGallery();
  }
}

async function useCharacterInFrames(char) {
  if (!char) return;
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
  const refImages = state.refImages.map(r => ({ mimeType: r.mimeType, data: r.data }));

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
      method: 'POST', body: JSON.stringify({ prompt, count, aspectRatio, refImages, model: state.nbModel }),
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
    const imgEl = card.querySelector('img');
    if (imgEl) {
      imgEl.setAttribute('draggable', 'true');
      imgEl.title = 'Drag onto a tab (NB Frames, Kling…) to use as a reference';
      imgEl.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/avs-image', imgEl.src);
        e.dataTransfer.effectAllowed = 'copy';
      });
    }
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
      <div class="lib-actions">
        <button class="mini-btn lib-upload" id="libUploadBtn" title="Upload images into this project — e.g. a swap you downloaded from ChatGPT">⬆ Upload</button>
        <div class="lib-filter">
          <button class="mini-btn ${libFilter === 'all' ? 'on' : ''}" data-f="all">All</button>
          <button class="mini-btn ${libFilter === 'fav' ? 'on' : ''}" data-f="fav">★ Favorites</button>
        </div>
      </div>
    </div>
    <input type="file" id="libFileInput" accept="image/*" multiple hidden />
    <div id="libGrid"></div>`;
  body.appendChild(panel);
  $$('.lib-filter .mini-btn', panel).forEach(b => b.onclick = () => { libFilter = b.dataset.f; renderLibrary($('#wsBody')); $('#wsBody').firstChild?.remove(); });
  const fileInput = $('#libFileInput', panel);
  $('#libUploadBtn', panel).onclick = () => fileInput.click();
  fileInput.onchange = (e) => { uploadToLibrary(e.target.files); e.target.value = ''; };
  // Drag OS image files (or a ChatGPT download) straight onto the library.
  panel.addEventListener('dragover', (e) => { if (dragHasFiles(e)) { e.preventDefault(); panel.classList.add('drag-over'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag-over'); });
  panel.addEventListener('drop', (e) => { if (!dragHasFiles(e)) return; e.preventDefault(); panel.classList.remove('drag-over'); uploadToLibrary(e.dataTransfer.files); });
  wireLibPaste();
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
    const { images: saved } = await api(`/api/projects/${state.current.id}/images/upload`, { method: 'POST', body: JSON.stringify({ images }) });
    if (saved?.length) {
      toast(`Added ${saved.length} to the Library ✓`);
      if (state.activeTab === 'library') { const wb = $('#wsBody'); await renderLibrary(wb); wb.firstChild?.remove(); }
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
