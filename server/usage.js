// ── Expense tracker ──────────────────────────────────────────────────────────
// Computes Claude + Nano Banana spend from EXISTING project data, bucketed by month
// and week. There is no separate cost log: Nano Banana cost is exact (each image
// record stores its model + size), and Claude cost is estimated from message sizes
// using the same replay the chat route does (history is text-only; an image turn
// drops history). So both past and future usage are covered with zero extra writes.
//
// Rates (per Google/Anthropic public pricing, mid-2026):
//   Claude Haiku 4.5 — $1.00 / 1M input, $5.00 / 1M output
//   NB2  gemini-3.1-flash-image — per image: 1K $0.067, 2K $0.101, 4K $0.151
//   Pro  gemini-3-pro-image     — per image: 1K-2K $0.134, 4K $0.24
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const GEMS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gems');

const CLAUDE = { // per 1M tokens
  'claude-haiku-4-5': { in: 1.00, out: 5.00 },
  _default: { in: 1.00, out: 5.00 },
};
const NB = { // per generated image, by model + size
  'gemini-3.1-flash-image': { '512': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 },
  'gemini-3-pro-image': { '512': 0.039, '1K': 0.134, '2K': 0.134, '4K': 0.24 },
};
const IMG_IN_TOK = 1500; // ~Claude vision tokens per attached image
const tok = (s) => Math.round((s || '').length / 4);

const GEM_FILES = {
  'nb-frames': ['nb-frames.txt', 'cinematography-kit.txt'],
  'kling': ['kling.txt'], 'kling-advisor': ['kling-advisor.txt'],
  'nb-advisor': ['nb-advisor.txt'], 'character-builder': ['character-builder.txt'],
};
let _sysTok = null;
async function gemSysTokens() {
  if (_sysTok) return _sysTok;
  const out = {};
  for (const [g, files] of Object.entries(GEM_FILES)) {
    let c = 0;
    for (const f of files) { try { c += (await fsp.readFile(path.join(GEMS_DIR, f), 'utf8')).length; } catch { /* gem missing */ } }
    out[g] = Math.round(c / 4);
  }
  return (_sysTok = out);
}
const nbPerImage = (model, size) => { const t = NB[model] || NB['gemini-3.1-flash-image']; return t[size] ?? t['1K'] ?? 0.067; };

const mKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const mLabel = (k) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }); };
const weekStartTs = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
const wLabel = (ts) => {
  const s = new Date(ts), e = new Date(ts + 6 * 864e5), mo = (x) => x.toLocaleString('en-US', { month: 'short' });
  return s.getMonth() === e.getMonth() ? `${mo(s)} ${s.getDate()}–${e.getDate()}` : `${mo(s)} ${s.getDate()} – ${mo(e)} ${e.getDate()}`;
};

export async function computeUsage(data, claudeModel) {
  const sysTok = await gemSysTokens();
  const rate = CLAUDE[claudeModel] || CLAUDE._default;
  const months = new Map(), weeks = new Map();
  const mk = () => ({ claude: 0, nb: 0, claudeCalls: 0, nbImages: 0 });
  const total = mk();
  const addM = (ts, f) => { const k = mKey(ts); let b = months.get(k); if (!b) { b = mk(); b.key = k; b.label = mLabel(k); b.sort = k; months.set(k, b); } f(b); };
  const addW = (ts, f) => { const w = weekStartTs(ts); let b = weeks.get(w); if (!b) { b = mk(); b.key = String(w); b.label = wLabel(w); b.sort = w; weeks.set(w, b); } f(b); };
  const spend = (ts, claude, nb, calls, imgs) => { addM(ts, b => { b.claude += claude; b.nb += nb; b.claudeCalls += calls; b.nbImages += imgs; }); addW(ts, b => { b.claude += claude; b.nb += nb; b.claudeCalls += calls; b.nbImages += imgs; }); total.claude += claude; total.nb += nb; total.claudeCalls += calls; total.nbImages += imgs; };

  const list = await data.listProjects();
  for (const meta of list) {
    let p; try { p = await data.getProject(meta.id); } catch { continue; }
    // Claude — replay each chat, one cost per assistant reply, dated by the reply's timestamp
    for (const [gemId, chat] of Object.entries(p.chats || {})) {
      const sys = (sysTok[gemId] ?? 500) + tok(p.gemOverrides?.[gemId] || '');
      let hist = 0, puText = 0, puImgs = 0;
      for (const msg of chat || []) {
        if (msg.role === 'user') { puText = tok(msg.content); puImgs = (msg.images && msg.images.length) ? msg.images.length : (msg.hadImages ? 1 : 0); }
        else if (msg.role === 'assistant') {
          const inT = puImgs > 0 ? sys + puText + puImgs * IMG_IN_TOK : sys + hist + puText; // image turn drops history
          const outT = tok(msg.content);
          spend(msg.at || p.createdAt || Date.now(), (inT * rate.in + outT * rate.out) / 1e6, 0, 1, 0);
          hist += puText + outT; puText = 0; puImgs = 0;
        }
      }
    }
    // Nano Banana — exact, from each image record's model + size
    for (const img of p.images || []) spend(img.createdAt || p.createdAt || Date.now(), 0, nbPerImage(img.model, img.size), 0, 1);
    // Characters — one NB Pro (2K) image + one character-builder Claude call each
    for (const ch of p.characters || []) {
      const cIn = (sysTok['character-builder'] ?? 800) + 2 * IMG_IN_TOK + tok(ch.notes || '');
      spend(ch.createdAt || p.createdAt || Date.now(), (cIn * rate.in + 400 * rate.out) / 1e6, nbPerImage('gemini-3-pro-image', ch.size || '2K'), 1, 1);
    }
  }
  const round = (b) => ({ key: b.key, label: b.label, claude: +b.claude.toFixed(4), nb: +b.nb.toFixed(4), total: +(b.claude + b.nb).toFixed(4), claudeCalls: b.claudeCalls, nbImages: b.nbImages });
  return {
    total: round({ ...total, key: 'all', label: 'All-time' }),
    months: [...months.values()].sort((a, b) => (a.sort < b.sort ? 1 : -1)).map(round),
    weeks: [...weeks.values()].sort((a, b) => b.sort - a.sort).slice(0, 10).map(round),
    model: claudeModel,
    computedAt: Date.now(),
  };
}
