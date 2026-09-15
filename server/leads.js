// ── Leads seam: inquiries from the /commercials landing page, worked in the CRM ──
// The landing page's form is the studio's primary conversion action, so a lead can
// never be dropped on the floor. Records go to the Firestore 'leads' collection when
// Firestore is configured (same credentials as everything else), and to a local JSON
// file otherwise, so the form and the CRM work identically on localhost with no cloud.
//
// Local file lives at projects-data/_leads/leads.json. The leading underscore keeps it
// out of the project list (listProjects skips directories with no project.json) and
// .gitignore's `projects-data/*/` rule keeps real client details out of the repo.
//
// Interface:
//   add(fields, meta)      -> a lead from the public form (validates; throws err.status = 400)
//   addNote(id, brief)     -> the lead once the thank-you step fills its brief, else null
//   list({ limit })        -> newest first
//   create(fields, by)     -> a lead added by hand in the CRM (WhatsApp, referral, email)
//   update(id, patch, by)  -> CRM edits: stage, owner, value, follow-up, contact details (null if missing)
//   comment(id, text, by)  -> appends a note to the lead's activity (null if missing)
//   remove(id)             -> deletes a lead (spam, duplicates); false if missing
//   allow(ip)              -> false once an IP has posted too often (cheap public-endpoint guard)
import fsp from 'fs/promises';
import path from 'path';
import { getAdminApp } from './firebase.js';

// Generous caps: long enough for a real brief, short enough that nobody can post a
// novel into the database through a public endpoint.
const LIMITS = { name: 120, company: 160, email: 200, phone: 40, interest: 80, budget: 80, brief: 5000, page: 200, referrer: 600, campaign: 200, owner: 60, note: 4000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CAMPAIGN_KEYS = /^(utm_[a-z_]{1,20}|gclid|fbclid|msclkid)$/i;
// How long after a lead is created its brief can still be filled in from the
// thank-you step. Long enough for someone to finish typing, short enough that a
// stale id is worthless.
const NOTE_WINDOW_MS = 60 * 60 * 1000;
// A lead's activity log is kept in its own document; this keeps a very chatty lead
// comfortably under Firestore's 1 MiB per-document ceiling.
const MAX_TIMELINE = 500;

// The CRM pipeline, in the order the stage pills show it.
export const STAGES = ['new', 'contacted', 'call', 'proposal', 'won', 'lost'];
const SOURCES = ['form', 'whatsapp', 'referral', 'email', 'other'];
// Lead ids are server-made (`<base36 time>-<6 chars>`); nothing else reaches a document path.
export const validId = (id) => /^[a-z0-9-]{3,60}$/.test(String(id || ''));

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Pipeline fields every lead carries, whichever door it came in by.
const crmDefaults = (now) => ({ status: 'new', owner: '', value: null, followUpAt: null, timeline: [], updatedAt: now });

// Shape whatever the public form posted into the record we actually store.
function normalize(body = {}, meta = {}) {
  // Honeypot: a real person never fills the off-screen "website" field. Bots fill
  // everything. Reject quietly with the same shape as a validation error.
  if (str(body.website, 200)) throw badRequest('Rejected.');

  const name = str(body.name, LIMITS.name);
  const company = str(body.company, LIMITS.company);
  const email = str(body.email, LIMITS.email).toLowerCase();
  if (!name) throw badRequest('Please include your name.');
  if (!company) throw badRequest('Please include your company.');
  if (!EMAIL_RE.test(email)) throw badRequest('Please include a valid work email.');

  // Campaign parameters travel with the lead so paid traffic stays attributable.
  const campaign = {};
  for (const [k, v] of Object.entries(body)) {
    if (CAMPAIGN_KEYS.test(k)) campaign[k.toLowerCase()] = str(v, LIMITS.campaign);
  }

  const now = Date.now();
  return {
    id: newId(),
    name, company, email, phone: '',
    interest: str(body.interest, LIMITS.interest),
    budget: str(body.budget, LIMITS.budget),
    brief: str(body.brief, LIMITS.brief),
    page: str(body.page, LIMITS.page),
    referrer: str(body.referrer, LIMITS.referrer),
    campaign,
    ip: str(meta.ip, 60),
    userAgent: str(meta.userAgent, 400),
    source: 'form',
    createdAt: now,
    ...crmDefaults(now),
  };
}

// What the CRM may change. Everything the form recorded about the visit itself (page,
// referrer, campaign, ip) is the record of how they found us and stays as it came in.
function pickPatch(p = {}) {
  const out = {};
  if ('status' in p) {
    if (!STAGES.includes(p.status)) throw badRequest('Unknown stage.');
    out.status = p.status;
  }
  if ('owner' in p) out.owner = str(p.owner, LIMITS.owner);
  if ('value' in p) {
    if (p.value === null || p.value === '') out.value = null;
    else {
      const v = Number(p.value);
      if (!Number.isFinite(v) || v < 0) throw badRequest('Deal value must be a positive number.');
      out.value = Math.round(v);
    }
  }
  if ('followUpAt' in p) {
    if (p.followUpAt === null || p.followUpAt === '') out.followUpAt = null;
    else {
      const t = Number(p.followUpAt);
      if (!Number.isFinite(t) || t <= 0) throw badRequest('That follow-up date isn’t valid.');
      out.followUpAt = t;
    }
  }
  for (const k of ['name', 'company', 'phone', 'interest', 'budget', 'brief']) {
    if (k in p) out[k] = str(p[k], LIMITS[k]);
  }
  if ('email' in p) {
    const e = str(p.email, LIMITS.email).toLowerCase();
    if (e && !EMAIL_RE.test(e)) throw badRequest('That email doesn’t look right.');
    out.email = e;
  }
  if ('source' in p) {
    if (!SOURCES.includes(p.source)) throw badRequest('Unknown source.');
    out.source = p.source;
  }
  if ('name' in out && !out.name) throw badRequest('A lead needs a name.');
  return out;
}

// A lead typed into the CRM by hand: no form, so the only hard rule is a name and
// some way back to them.
function normalizeManual(body = {}, by) {
  const fields = pickPatch({ source: 'other', ...body });
  if (!fields.name) throw badRequest('A lead needs a name.');
  if (!fields.email && !fields.phone) throw badRequest('Add an email or a phone number, so there’s a way back to them.');
  const now = Date.now();
  return {
    id: newId(),
    name: '', company: '', email: '', phone: '', interest: '', budget: '', brief: '',
    page: '', referrer: '', campaign: {}, ip: '', userAgent: '',
    createdAt: now,
    ...crmDefaults(now),
    ...fields,
    timeline: [{ kind: 'created', by, at: now }],
  };
}

const log = (lead, entry) => [...(lead.timeline || []), entry].slice(-MAX_TIMELINE);

function applyUpdate(lead, fields, by) {
  const now = Date.now();
  let timeline = lead.timeline || [];
  const from = lead.status || 'new';
  if (fields.status && fields.status !== from) timeline = log({ timeline }, { kind: 'status', from, to: fields.status, by, at: now });
  if ('owner' in fields && fields.owner !== (lead.owner || '')) timeline = log({ timeline }, { kind: 'owner', to: fields.owner, by, at: now });
  return { ...lead, ...fields, timeline, updatedAt: now };
}

// ── rate limit ────────────────────────────────────────────────────────────────
// In-memory, per-IP, deliberately simple: this is a low-volume form on a single
// instance, and the only thing worth stopping is a bot hammering the endpoint.
const hits = new Map(); // ip -> [timestamps]
const WINDOW_MS = 10 * 60 * 1000;
const MAX_IN_WINDOW = 6;
function allow(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();   // bound the map; losing the history is harmless
  return recent.length <= MAX_IN_WINDOW;
}

// ── stores ────────────────────────────────────────────────────────────────────
// Each backend provides four primitives; every operation above is built on them.
//   put(lead)       store a new lead
//   mutate(id, fn)  read-modify-write one lead atomically; fn returns the next lead,
//                   or null to leave it untouched. Resolves to the stored lead or null.
//   del(id)         true if something was deleted
//   all(limit)      newest first

function createLocalStore(dataDir) {
  const dir = path.join(dataDir, '_leads');
  const file = path.join(dir, 'leads.json');
  let tail = Promise.resolve();   // one queue for every write, so two requests can't clobber each other

  async function read() {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return []; }
  }
  async function write(all) {
    await fsp.mkdir(dir, { recursive: true });
    // Atomic write: a crash mid-write can never truncate the whole lead history.
    await fsp.writeFile(`${file}.tmp`, JSON.stringify(all, null, 2));
    await fsp.rename(`${file}.tmp`, file);
  }
  function serial(fn) {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  }

  return {
    backend: 'local',
    put: (lead) => serial(async () => {
      const all = await read();
      all.unshift(lead);
      await write(all);
      return lead;
    }),
    mutate: (id, fn) => serial(async () => {
      const all = await read();
      const i = all.findIndex((l) => l.id === id);
      if (i < 0) return null;
      const next = fn(all[i]);
      if (!next) return null;
      all[i] = next;
      await write(all);
      return next;
    }),
    del: (id) => serial(async () => {
      const all = await read();
      const rest = all.filter((l) => l.id !== id);
      if (rest.length === all.length) return false;
      await write(rest);
      return true;
    }),
    all: async (limit) => (await read()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit),
  };
}

function createFirestoreStore() {
  let _col = null;
  async function col() {
    if (_col) return _col;
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(await getAdminApp());
    try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* already configured */ }
    _col = db.collection('leads');
    return _col;
  }

  return {
    backend: 'firestore',
    put: async (lead) => {
      await (await col()).doc(lead.id).set(lead);
      return lead;
    },
    // A transaction, because two people can work the same lead at the same moment.
    mutate: async (id, fn) => {
      const c = await col();
      const ref = c.doc(id);
      return c.firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const next = fn(snap.data());
        if (!next) return null;
        tx.set(ref, next);
        return next;
      });
    },
    del: async (id) => {
      const ref = (await col()).doc(id);
      if (!(await ref.get()).exists) return false;
      await ref.delete();
      return true;
    },
    all: async (limit) => {
      const snap = await (await col()).orderBy('createdAt', 'desc').limit(limit).get();
      return snap.docs.map((d) => d.data());
    },
  };
}

export function createLeads(dataDir, { backend = process.env.DATA_BACKEND || 'local' } = {}) {
  const store = backend === 'firestore' ? createFirestoreStore() : createLocalStore(dataDir);
  return {
    backend: store.backend,
    allow,
    add: async (fields, meta) => store.put(normalize(fields, meta)),
    // A brief arrives after the lead is already stored, from the thank-you step, so it
    // only ever fills an empty field, once, and only shortly after the lead was made.
    addNote: async (id, brief) => store.mutate(id, (lead) => (
      lead.brief || Date.now() - (lead.createdAt || 0) > NOTE_WINDOW_MS ? null : { ...lead, brief: str(brief, LIMITS.brief) }
    )),
    list: async ({ limit = 200 } = {}) => store.all(limit),
    create: async (fields, by) => store.put(normalizeManual(fields, by)),
    update: async (id, patch, by) => {
      const fields = pickPatch(patch);
      return store.mutate(id, (lead) => applyUpdate(lead, fields, by));
    },
    comment: async (id, text, by) => {
      const t = str(text, LIMITS.note);
      if (!t) throw badRequest('Nothing to add.');
      return store.mutate(id, (lead) => {
        const now = Date.now();
        return { ...lead, timeline: log(lead, { kind: 'note', text: t, by, at: now }), updatedAt: now };
      });
    },
    remove: async (id) => store.del(id),
  };
}
