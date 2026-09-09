// ── Leads seam: inquiries from the /commercials landing page ─────────────────
// The landing page's form is the studio's primary conversion action, so a lead can
// never be dropped on the floor. Records go to the Firestore 'leads' collection when
// Firestore is configured (same credentials as everything else), and to a local JSON
// file otherwise, so the form works identically on localhost with no cloud set up.
//
// Local file lives at projects-data/_leads/leads.json. The leading underscore keeps it
// out of the project list (listProjects skips directories with no project.json) and
// .gitignore's `projects-data/*/` rule keeps real client details out of the repo.
//
// Interface:
//   add(fields, meta) -> the stored lead  (validates; throws err.status = 400 on bad input)
//   list({ limit })   -> newest first
//   allow(ip)         -> false once an IP has posted too often (cheap public-endpoint guard)
import fsp from 'fs/promises';
import path from 'path';
import { getAdminApp } from './firebase.js';

// Generous caps: long enough for a real brief, short enough that nobody can post a
// novel into the database through a public endpoint.
const LIMITS = { name: 120, company: 160, email: 200, interest: 80, budget: 80, brief: 5000, page: 200, referrer: 600, campaign: 200 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CAMPAIGN_KEYS = /^(utm_[a-z_]{1,20}|gclid|fbclid|msclkid)$/i;
// How long after a lead is created its brief can still be filled in from the
// thank-you step. Long enough for someone to finish typing, short enough that a
// stale id is worthless.
const NOTE_WINDOW_MS = 60 * 60 * 1000;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Shape whatever the form posted into the record we actually store.
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

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name, company, email,
    interest: str(body.interest, LIMITS.interest),
    budget: str(body.budget, LIMITS.budget),
    brief: str(body.brief, LIMITS.brief),
    page: str(body.page, LIMITS.page),
    referrer: str(body.referrer, LIMITS.referrer),
    campaign,
    ip: str(meta.ip, 60),
    userAgent: str(meta.userAgent, 400),
    createdAt: Date.now(),
    status: 'new',
  };
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

// ── local JSON backend ────────────────────────────────────────────────────────
function createLocalLeads(dataDir) {
  const dir = path.join(dataDir, '_leads');
  const file = path.join(dir, 'leads.json');
  let tail = Promise.resolve();   // serialise writes so two submissions can't clobber each other

  async function read() {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return []; }
  }

  async function add(fields, meta) {
    const lead = normalize(fields, meta);
    const run = tail.then(async () => {
      const all = await read();
      all.unshift(lead);
      await fsp.mkdir(dir, { recursive: true });
      // Atomic write: a crash mid-write can never truncate the whole lead history.
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(all, null, 2));
      await fsp.rename(`${file}.tmp`, file);
      return lead;
    });
    tail = run.catch(() => {});
    return run;
  }

  async function list({ limit = 200 } = {}) {
    return (await read()).slice(0, limit);
  }

  // A brief arrives after the lead is already stored, from the thank-you step, so it
  // only ever fills an empty field, once, and only shortly after the lead was made.
  async function addNote(id, brief) {
    const run = tail.then(async () => {
      const all = await read();
      const i = all.findIndex((l) => l.id === id);
      if (i < 0 || all[i].brief || Date.now() - (all[i].createdAt || 0) > NOTE_WINDOW_MS) return false;
      all[i] = { ...all[i], brief: str(brief, LIMITS.brief) };
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(all, null, 2));
      await fsp.rename(`${file}.tmp`, file);
      return true;
    });
    tail = run.catch(() => false);
    return run;
  }

  return { backend: 'local', add, addNote, list, allow };
}

// ── Firestore backend ─────────────────────────────────────────────────────────
function createFirestoreLeads() {
  let _col = null;
  async function col() {
    if (_col) return _col;
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(await getAdminApp());
    try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* already configured */ }
    _col = db.collection('leads');
    return _col;
  }

  async function add(fields, meta) {
    const lead = normalize(fields, meta);
    await (await col()).doc(lead.id).set(lead);
    return lead;
  }

  async function list({ limit = 200 } = {}) {
    const snap = await (await col()).orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data());
  }

  async function addNote(id, brief) {
    const ref = (await col()).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return false;
    const lead = snap.data();
    if (lead.brief || Date.now() - (lead.createdAt || 0) > NOTE_WINDOW_MS) return false;
    await ref.set({ brief: str(brief, LIMITS.brief) }, { merge: true });
    return true;
  }

  return { backend: 'firestore', add, addNote, list, allow };
}

export function createLeads(dataDir, { backend = process.env.DATA_BACKEND || 'local' } = {}) {
  return backend === 'firestore' ? createFirestoreLeads() : createLocalLeads(dataDir);
}
