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
  'nb-advisor': ['nb-advisor.txt'], 'gpt-advisor': ['gpt-advisor.txt'], 'character-builder': ['character-builder.txt'],
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
// Swap / Edit engines (per image): Flux Kontext [max] via fal.ai (~$0.08); GPT Image 2 via OpenAI
// (gpt-image-2 high ≈ $0.21/edit + reference inputs); legacy gpt-image-1 ≈ $0.06. Estimates; keep
// in sync with docs/pricing.md.
const SWAP_PRICE = { flux: 0.08, gptimage: 0.06, gptimage2: 0.22 };
// Fixed recurring subscriptions tracked in Expenses (NOT API usage). `since` = first month billed
// (YYYY-MM). Added to every month from `since` to the current month so the monthly split includes them.
const SUBSCRIPTIONS = [{ name: 'ChatGPT Plus', monthly: 20, since: '2026-07' }];
// One-off costs tied to a SINGLE month — not recurring, not per-image API usage (e.g. a prepaid
// API credit top-up bought that month). `month` = YYYY-MM; added once, to that month only. To log
// another top-up later, just add a line here.
const ADJUSTMENTS = [{ label: 'Extra credits', amount: 105, month: '2026-07' }];
const isSwapModel = (model) => /flux|gpt-image/.test(model || '');
const imageCost = (model, size) => {
  const m = model || '';
  if (m.includes('flux')) return SWAP_PRICE.flux;
  if (m.includes('gpt-image-2')) return SWAP_PRICE.gptimage2;
  if (m.includes('gpt-image')) return SWAP_PRICE.gptimage;
  const t = NB[m] || NB['gemini-3.1-flash-image'];
  return t[size] ?? t['1K'] ?? 0.067;
};

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
  const mk = () => ({ claude: 0, nb: 0, swap: 0, sub: 0, credits: 0, claudeCalls: 0, nbImages: 0, swapImages: 0 });
  const total = mk();
  const addM = (ts, f) => { const k = mKey(ts); let b = months.get(k); if (!b) { b = mk(); b.key = k; b.label = mLabel(k); b.sort = k; months.set(k, b); } f(b); };
  const addW = (ts, f) => { const w = weekStartTs(ts); let b = weeks.get(w); if (!b) { b = mk(); b.key = String(w); b.label = wLabel(w); b.sort = w; weeks.set(w, b); } f(b); };
  const spend = (ts, d) => { addM(ts, b => { for (const k in d) b[k] += d[k]; }); addW(ts, b => { for (const k in d) b[k] += d[k]; }); for (const k in d) total[k] += d[k]; };

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
          spend(msg.at || p.createdAt || Date.now(), { claude: (inT * rate.in + outT * rate.out) / 1e6, claudeCalls: 1 });
          hist += puText + outT; puText = 0; puImgs = 0;
        }
      }
    }
    // Images — priced by each record's model: Nano Banana (Gemini) vs Swap/Edit (Flux, GPT Image).
    for (const img of p.images || []) {
      if (img.model === 'upload') continue;   // imported (made elsewhere, e.g. ChatGPT) — no API cost to attribute
      const cost = imageCost(img.model, img.size), ts = img.createdAt || p.createdAt || Date.now();
      spend(ts, isSwapModel(img.model) ? { swap: cost, swapImages: 1 } : { nb: cost, nbImages: 1 });
    }
    // Characters — one NB Pro (2K) image + one character-builder Claude call each
    for (const ch of p.characters || []) {
      const cIn = (sysTok['character-builder'] ?? 800) + 2 * IMG_IN_TOK + tok(ch.notes || '');
      spend(ch.createdAt || p.createdAt || Date.now(), { claude: (cIn * rate.in + 400 * rate.out) / 1e6, claudeCalls: 1, nb: imageCost('gemini-3-pro-image', ch.size || '2K'), nbImages: 1 });
    }
  }
  // Fixed monthly subscriptions — not API calls; add to each month from `since` to now.
  const nowKey = mKey(Date.now());
  for (const sb of SUBSCRIPTIONS) {
    let [y, m] = sb.since.split('-').map(Number);
    const [cy, cm] = nowKey.split('-').map(Number);
    while (y < cy || (y === cy && m <= cm)) {
      addM(new Date(y, m - 1, 15).getTime(), b => { b.sub += sb.monthly; });
      total.sub += sb.monthly;
      if (++m > 12) { m = 1; y++; }
    }
  }
  // One-off adjustments (credit top-ups, etc.) — add once to their month only (like subs, not weeks).
  for (const a of ADJUSTMENTS) {
    const [y, m] = a.month.split('-').map(Number);
    addM(new Date(y, m - 1, 15).getTime(), b => { b.credits += a.amount; });
    total.credits += a.amount;
  }
  const round = (b) => ({ key: b.key, label: b.label, claude: +b.claude.toFixed(4), nb: +b.nb.toFixed(4), swap: +b.swap.toFixed(4), sub: +b.sub.toFixed(4), credits: +(b.credits || 0).toFixed(4), total: +(b.claude + b.nb + b.swap + b.sub + (b.credits || 0)).toFixed(4), claudeCalls: b.claudeCalls, nbImages: b.nbImages, swapImages: b.swapImages });
  return {
    total: round({ ...total, key: 'all', label: 'All-time' }),
    months: [...months.values()].sort((a, b) => (a.sort < b.sort ? 1 : -1)).map(round),
    weeks: [...weeks.values()].sort((a, b) => b.sort - a.sort).slice(0, 10).map(round),
    model: claudeModel,
    computedAt: Date.now(),
  };
}
