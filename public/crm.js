// ── CRM: every inquiry from shyow.io/commercials, worked as a pipeline ──────────
// Leads arrive from the public form (POST /api/lead) or get added here by hand (a
// WhatsApp message, a referral). While signed in, the list is a live Firestore
// listener, the same way projects sync, so a new lead shows up on every open screen
// the moment it's sent. Without one (local mode, or an account the Firestore rules
// don't cover) it reads GET /api/leads instead. Every write goes through the server.
const STAGES = [['new', 'New'], ['contacted', 'Contacted'], ['call', 'Call booked'], ['proposal', 'Proposal sent'], ['won', 'Won'], ['lost', 'Lost']];
const OPEN_STAGES = new Set(['new', 'contacted', 'call', 'proposal']);
const OWNERS = ['Yossi', 'Liran', 'Itzik'];
const SOURCES = [['form', 'Website form'], ['whatsapp', 'WhatsApp'], ['referral', 'Referral'], ['email', 'Email'], ['other', 'Other']];
const INTERESTS = ['One project', 'Ongoing production', 'Not sure yet'];   // the website form's own options
const PEOPLE = { 'yossi.bozo112@gmail.com': 'Yossi', 'liran.segal@gmail.com': 'Liran', 'shyow.studio@gmail.com': 'Studio' };
const DAY = 86400000;

const statusOf = (l) => (STAGES.some(([s]) => s === l.status) ? l.status : 'new');
const stageLabel = (id) => (STAGES.find(([s]) => s === id) || STAGES[0])[1];
const sourceLabel = (id) => (SOURCES.find(([s]) => s === id) || SOURCES[0])[1];   // leads from before the CRM came from the form
const person = (by) => PEOPLE[by] || (!by || by === 'studio' ? 'Studio' : String(by).split('@')[0]);
const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const byNewest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);

function ago(t) {
  const m = (Date.now() - t) / 60000;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.floor(m)}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  if (m < 10080) return `${Math.floor(m / 1440)}d ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
const when = (t) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function dateInput(t) {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };
const isDue = (l) => !!l.followUpAt && OPEN_STAGES.has(statusOf(l)) && l.followUpAt <= endOfToday();
// wa.me needs the international number; a local 0-prefixed number is taken as Israeli.
function waLink(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '972' + d.slice(1);
  return d.length >= 8 ? `https://wa.me/${d}` : '';
}

export function createCrm({ $, api, escapeHtml: esc, toast, firestore }) {
  const st = {
    leads: [], loaded: false, live: false, failed: false, unsub: null, error: '',
    stage: 'all', q: '', sel: null, editing: false, drafts: {},
  };
  const isOpen = () => !!$('#crmView') && !$('#crmView').classList.contains('hidden');
  const options = (pairs, current) =>
    pairs.map(([v, label]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`).join('');

  // ── data ──
  function start() {
    const { fs, fsApi } = firestore();
    if (fs && fsApi && !st.unsub && !st.failed) {
      st.unsub = fsApi.onSnapshot(fsApi.collection(fs, 'leads'), (snap) => {
        st.live = true; st.loaded = true; st.error = '';
        st.leads = snap.docs.map((d) => d.data()).sort(byNewest);
        changed();
      }, (err) => {
        // The Firestore rules don't cover this account (or aren't published): read via the server.
        console.warn('[sync] leads:', err?.message || err);
        st.unsub = null; st.live = false; st.failed = true;
        refresh();
      });
      return;
    }
    refresh();
  }

  async function refresh() {
    try { st.leads = (await api('/api/leads?limit=500')).sort(byNewest); st.loaded = true; st.error = ''; }
    catch (e) { st.error = e.message || String(e); }
    changed();
  }

  // A saved lead comes back from the server: show it at once, whatever the listener does.
  function upsert(lead) {
    const i = st.leads.findIndex((l) => l.id === lead.id);
    if (i >= 0) st.leads[i] = lead; else st.leads.push(lead);
    st.leads.sort(byNewest);
    changed(true);
  }

  // force: repaint the detail pane even mid-edit (it's this screen's own save)
  function changed(force = false) {
    const fresh = st.leads.filter((l) => statusOf(l) === 'new').length;
    const badge = $('#crmBadge');
    if (badge) { badge.textContent = String(fresh); badge.classList.toggle('hidden', !fresh); }
    if (!isOpen()) return;
    paintStats(); paintStages(); paintList();
    // A live update from the other screen must not wipe what's being typed here.
    const active = document.activeElement;
    const busy = st.editing || (active && $('#crmDetail')?.contains(active) && active.id !== 'crmNote');
    if (force || !busy) paintDetail();
  }

  // ── view ──
  function open() {
    const view = $('#crmView');
    view.classList.remove('hidden');
    view.innerHTML = `
      <div class="crm-head">
        <div class="crm-title">
          <h1>CRM</h1>
          <p>Every inquiry from <a href="https://shyow.io/commercials" target="_blank" rel="noopener">shyow.io/commercials</a> and <a href="https://shyow.io/pandora" target="_blank" rel="noopener">shyow.io/pandora</a> lands here the moment it’s sent. Add WhatsApp and referral leads by hand.</p>
        </div>
        <div class="crm-tools">
          <input type="search" class="crm-search" id="crmSearch" placeholder="Search name, company, email…" />
          <button class="new-project-btn" id="crmAdd">＋ Add lead</button>
        </div>
      </div>
      <div class="crm-stats" id="crmStats"></div>
      <div class="crm-stages" id="crmStages"></div>
      <div class="crm-body"><div class="crm-list" id="crmList"></div><div class="crm-detail" id="crmDetail"></div></div>`;
    const search = $('#crmSearch');
    search.value = st.q;
    search.addEventListener('input', () => { st.q = search.value; paintList(); });
    $('#crmAdd').addEventListener('click', openAdd);
    if (!st.live) refresh();
    changed(true);
  }

  function visible() {
    const q = st.q.trim().toLowerCase();
    return st.leads.filter((l) =>
      (st.stage === 'all' || (st.stage === 'due' ? isDue(l) : statusOf(l) === st.stage)) &&
      (!q || [l.name, l.company, l.email, l.phone, l.brief].some((v) => String(v || '').toLowerCase().includes(q))));
  }
  function setStage(s) { st.stage = s; paintStages(); paintList(); }

  function paintStats() {
    const open = st.leads.filter((l) => OPEN_STAGES.has(statusOf(l)));
    const won = st.leads.filter((l) => statusOf(l) === 'won');
    const sum = (ls) => ls.reduce((s, l) => s + (Number(l.value) || 0), 0);
    const week = st.leads.filter((l) => Date.now() - (l.createdAt || 0) < 7 * DAY).length;
    const due = st.leads.filter(isDue).length;
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    $('#crmStats').innerHTML = `
      <div class="crm-stat"><span>Open pipeline</span><b>${money(sum(open))}</b><em>${plural(open.length, 'open lead')}</em></div>
      <div class="crm-stat"><span>Won</span><b>${money(sum(won))}</b><em>${plural(won.length, 'deal')}</em></div>
      <div class="crm-stat"><span>New this week</span><b>${week}</b><em>last 7 days</em></div>
      <button class="crm-stat${due ? ' is-due' : ''}" data-stage="due"><span>Follow-ups due</span><b>${due}</b><em>${due ? 'today or overdue' : 'nothing waiting'}</em></button>`;
    $('#crmStats [data-stage="due"]').onclick = () => setStage(st.stage === 'due' ? 'all' : 'due');
  }

  function paintStages() {
    const counts = {};
    st.leads.forEach((l) => { counts[statusOf(l)] = (counts[statusOf(l)] || 0) + 1; });
    const pills = [['all', 'All', st.leads.length], ...STAGES.map(([id, label]) => [id, label, counts[id] || 0])];
    if (st.stage === 'due') pills.push(['due', 'Follow-ups due', st.leads.filter(isDue).length]);
    const el = $('#crmStages');
    el.innerHTML = pills.map(([id, label, n]) => `<button class="crm-pill st-${id}${st.stage === id ? ' on' : ''}" data-stage="${id}">${label}<span>${n}</span></button>`).join('');
    el.querySelectorAll('[data-stage]').forEach((b) => { b.onclick = () => setStage(b.dataset.stage); });
  }

  function paintList() {
    const el = $('#crmList');
    if (!el) return;
    const list = visible();
    if (!st.sel || !st.leads.some((l) => l.id === st.sel)) { st.sel = list[0]?.id || null; st.editing = false; }
    if (!st.loaded) {
      el.innerHTML = `<div class="crm-empty">${st.error ? `Couldn’t load leads: ${esc(st.error)}` : 'Loading leads…'}</div>`;
      return;
    }
    if (!list.length) {
      el.innerHTML = `<div class="crm-empty">${st.leads.length ? 'No leads match.' : 'No leads yet. The first inquiry from the website will land here.'}</div>`;
      return;
    }
    el.innerHTML = list.map((l) => {
      const s = statusOf(l);
      const sub = [l.company, l.interest].filter(Boolean).join(' · ') || sourceLabel(l.source);
      return `<button class="crm-row${l.id === st.sel ? ' on' : ''}" data-id="${esc(l.id)}">
        <span class="crm-dot st-${s}"></span>
        <span class="crm-row-main"><b>${esc(l.name || 'Unnamed')}</b><span>${esc(sub)}</span></span>
        <span class="crm-row-side"><span class="crm-chip st-${s}">${stageLabel(s)}</span><span class="crm-age">${isDue(l) ? '<i class="crm-due">follow up</i>' : esc(ago(l.createdAt))}</span></span>
      </button>`;
    }).join('');
    el.querySelectorAll('.crm-row').forEach((row) => {
      row.onclick = () => { st.sel = row.dataset.id; st.editing = false; paintList(); paintDetail(); };
    });
  }

  function timeline(l) {
    const ev = [...(l.timeline || [])];
    if (!ev.some((e) => e.kind === 'created')) ev.push({ kind: 'arrived', at: l.createdAt });
    return ev.sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  function eventHtml(e) {
    const meta = `<div class="crm-ev-meta">${e.by ? `${esc(person(e.by))} · ` : ''}${esc(when(e.at))}</div>`;
    if (e.kind === 'note') return `<li class="crm-ev note">${meta}<div class="crm-ev-text">${esc(e.text)}</div></li>`;
    if (e.kind === 'status') return `<li class="crm-ev">${meta}Moved from <b>${stageLabel(e.from)}</b> to <b>${stageLabel(e.to)}</b></li>`;
    if (e.kind === 'owner') return `<li class="crm-ev">${meta}${e.to ? `Assigned to <b>${esc(e.to)}</b>` : 'Unassigned'}</li>`;
    if (e.kind === 'created') return `<li class="crm-ev">${meta}Added by hand</li>`;
    return `<li class="crm-ev">${meta}Came in through the website form</li>`;
  }

  function editForm(l) {
    const interests = [['', 'Not specified'], ...INTERESTS.map((i) => [i, i])];
    if (l.interest && !INTERESTS.includes(l.interest)) interests.push([l.interest, l.interest]);
    return `<form class="crm-edit" id="crmEditForm">
      <label>Name<input name="name" value="${esc(l.name || '')}" required /></label>
      <label>Company<input name="company" value="${esc(l.company || '')}" /></label>
      <label>Email<input name="email" type="email" value="${esc(l.email || '')}" /></label>
      <label>Phone<input name="phone" value="${esc(l.phone || '')}" placeholder="+972 5X XXX XXXX" /></label>
      <label>Looking for<select name="interest">${options(interests, l.interest || '')}</select></label>
      <label>Budget<input name="budget" value="${esc(l.budget || '')}" /></label>
      <label>Source<select name="source">${options(SOURCES, l.source || 'form')}</select></label>
      <label class="wide">Brief<textarea name="brief" rows="4">${esc(l.brief || '')}</textarea></label>
      <div class="wide crm-edit-actions"><button class="crm-act primary" type="submit">Save details</button></div>
    </form>`;
  }

  function paintDetail() {
    const el = $('#crmDetail');
    if (!el) return;
    const l = st.leads.find((x) => x.id === st.sel);
    if (!l) {
      el.innerHTML = `<div class="crm-empty">${st.leads.length ? 'Pick a lead to see it here.' : 'Nothing to show yet.'}</div>`;
      return;
    }
    const hadNoteFocus = document.activeElement?.id === 'crmNote';
    const s = statusOf(l);
    const campaign = Object.entries(l.campaign || {}).map(([k, v]) => `${k}=${v}`).join(' · ');
    const info = [
      ['Email', l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ''],
      ['Phone', esc(l.phone || '')],
      ['Looking for', esc(l.interest || '')],
      ['Budget', esc(l.budget || '')],
      ['Source', esc(sourceLabel(l.source))],
      ['Page', esc(l.page || '')],
      ['Campaign', esc(campaign)],
      ['Referrer', esc(l.referrer || '')],
    ].filter(([, v]) => v);
    const owners = [['', 'Unassigned'], ...OWNERS.map((o) => [o, o])];
    if (l.owner && !OWNERS.includes(l.owner)) owners.push([l.owner, l.owner]);
    const wa = waLink(l.phone);
    el.innerHTML = `
      <div class="crm-d-head">
        <div><h2>${esc(l.name || 'Unnamed')}</h2><div class="crm-d-sub">${esc([l.company, sourceLabel(l.source), when(l.createdAt)].filter(Boolean).join(' · '))}</div></div>
        <button class="crm-icon" id="crmDel" title="Delete this lead">🗑</button>
      </div>
      <div class="crm-actions">
        ${l.email ? `<a class="crm-act primary" href="mailto:${esc(l.email)}?subject=${encodeURIComponent('Your Shyow inquiry')}">✉ Reply by email</a>` : ''}
        ${wa ? `<a class="crm-act${l.email ? '' : ' primary'}" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        ${l.email ? '<button class="crm-act" id="crmCopy">Copy email</button>' : ''}
        <button class="crm-act" id="crmEdit">${st.editing ? 'Cancel' : 'Edit details'}</button>
      </div>
      <div class="crm-fields">
        <label>Stage<select id="crmStatus">${options(STAGES, s)}</select></label>
        <label>Owner<select id="crmOwner">${options(owners, l.owner || '')}</select></label>
        <label>Deal value (USD)<input type="number" id="crmValue" min="0" step="500" placeholder="0" value="${Number.isFinite(l.value) ? l.value : ''}" /></label>
        <label>Follow up<input type="date" id="crmFollow" value="${dateInput(l.followUpAt)}" /></label>
      </div>
      ${st.editing ? editForm(l) : `<dl class="crm-info">${info.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`}
      ${l.brief && !st.editing ? `<div class="crm-block"><h3>Brief</h3><p class="crm-brief">${esc(l.brief)}</p></div>` : ''}
      <div class="crm-block">
        <h3>Activity</h3>
        <form class="crm-note" id="crmNoteForm">
          <textarea id="crmNote" rows="2" placeholder="Add a note: a call, a next step, anything worth remembering…">${esc(st.drafts[l.id] || '')}</textarea>
          <button class="crm-act primary" type="submit">Add note</button>
        </form>
        <ul class="crm-timeline">${timeline(l).map(eventHtml).join('')}</ul>
      </div>`;
    wireDetail(l);
    if (hadNoteFocus) {
      const t = $('#crmNote');
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
  }

  function wireDetail(l) {
    const save = async (patch) => {
      try { upsert(await api(`/api/leads/${l.id}`, { method: 'PATCH', body: JSON.stringify(patch) })); }
      catch (e) { toast(`Couldn’t save: ${e.message}`, true); paintDetail(); }
    };
    $('#crmStatus').onchange = (e) => save({ status: e.target.value });
    $('#crmOwner').onchange = (e) => save({ owner: e.target.value });
    $('#crmValue').onchange = (e) => save({ value: e.target.value === '' ? null : Number(e.target.value) });
    $('#crmFollow').onchange = (e) => save({ followUpAt: e.target.value ? new Date(`${e.target.value}T09:00`).getTime() : null });
    $('#crmEdit').onclick = () => { st.editing = !st.editing; paintDetail(); };
    const copy = $('#crmCopy');
    if (copy) copy.onclick = () => navigator.clipboard.writeText(l.email).then(() => toast('Email copied'), () => toast('Couldn’t copy', true));
    $('#crmDel').onclick = async () => {
      if (!confirm(`Delete ${l.name || 'this lead'}? This can’t be undone.`)) return;
      try {
        await api(`/api/leads/${l.id}`, { method: 'DELETE' });
        st.leads = st.leads.filter((x) => x.id !== l.id);
        st.sel = null;
        changed(true);
      } catch (e) { toast(`Couldn’t delete: ${e.message}`, true); }
    };

    const note = $('#crmNote'), noteForm = $('#crmNoteForm');
    note.oninput = () => { st.drafts[l.id] = note.value; };
    // Enter adds the note; Shift+Enter starts a new line.
    note.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); noteForm.requestSubmit(); } };
    noteForm.onsubmit = async (e) => {
      e.preventDefault();
      const text = note.value.trim();
      if (!text) return;
      const btn = noteForm.querySelector('button');
      btn.disabled = true;
      try {
        const lead = await api(`/api/leads/${l.id}/notes`, { method: 'POST', body: JSON.stringify({ text }) });
        delete st.drafts[l.id];
        upsert(lead);
      } catch (err) { toast(`Couldn’t add the note: ${err.message}`, true); btn.disabled = false; }
    };

    const form = $('#crmEditForm');
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const lead = await api(`/api/leads/${l.id}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        st.editing = false;
        upsert(lead);
      } catch (err) { toast(`Couldn’t save: ${err.message}`, true); }
    };
  }

  // ── add by hand ──
  function openAdd() {
    const wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    const owners = [['', 'Unassigned'], ...OWNERS.map((o) => [o, o])];
    const interests = [['', 'Not specified'], ...INTERESTS.map((i) => [i, i])];
    wrap.innerHTML = `
      <form class="modal-card crm-add">
        <div class="modal-head"><h3>Add a lead</h3><button type="button" class="modal-x" data-close>✕</button></div>
        <p class="modal-sub">For inquiries that didn’t come through the website: a WhatsApp message, a referral, an email.</p>
        <div class="crm-edit">
          <label>Name<input name="name" required /></label>
          <label>Company<input name="company" /></label>
          <label>Email<input name="email" type="email" /></label>
          <label>Phone<input name="phone" placeholder="+972 5X XXX XXXX" /></label>
          <label>Source<select name="source">${options(SOURCES.filter(([id]) => id !== 'form'), 'whatsapp')}</select></label>
          <label>Looking for<select name="interest">${options(interests, '')}</select></label>
          <label>Owner<select name="owner">${options(owners, '')}</select></label>
          <label>Deal value (USD)<input name="value" type="number" min="0" step="500" placeholder="0" /></label>
          <label class="wide">Brief<textarea name="brief" rows="3" placeholder="What they’re after, in their words"></textarea></label>
        </div>
        <div class="crm-add-err"></div>
        <div class="modal-actions"><button type="button" class="modal-btn ghost" data-close>Cancel</button><button type="submit" class="modal-btn accent">Add lead</button></div>
      </form>`;
    document.body.appendChild(wrap);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    const form = wrap.querySelector('form');
    form.querySelector('[name="name"]').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form).entries());
      if (body.value === '') delete body.value;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const lead = await api('/api/leads', { method: 'POST', body: JSON.stringify(body) });
        close();
        st.sel = lead.id; st.stage = 'all'; st.q = '';
        const search = $('#crmSearch');
        if (search) search.value = '';
        upsert(lead);
        toast('Lead added');
      } catch (err) {
        form.querySelector('.crm-add-err').textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  return { start, open };
}
