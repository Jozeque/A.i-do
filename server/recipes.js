// ── Recipes ──────────────────────────────────────────────────────────────────
// Every image keeps how it was made, so a good result can be found again and built on: its prompt
// and references (already on the record), the model and settings, and — when its prompt came from
// a gem — which gem, which version of the project's Tune for it, and the chat it came from.
// A gem's Tune is versioned: each save that changes it is a new version, kept in full
// (projects/{pid}/tunes/{gemId}@{v}), so a recipe's "Tune v3" can still be read after v4.

// The gems whose Tune changed between two gemOverrides maps.
export function changedTunes(before = {}, after = {}) {
  const gems = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...gems].filter(g => String(before?.[g] || '').trim() !== String(after?.[g] || '').trim());
}

// The Tune a gem has right now, for a recipe: v N; v 0 when the project has no Tune for it (the
// gem as written); pre when it has one that was set before versions were kept.
export function tuneRef(meta, gemId) {
  if (!gemId) return null;
  const text = String(meta?.gemOverrides?.[gemId] || '').trim();
  if (!text) return { gem: gemId, v: 0 };
  const v = Number(meta?.tuneVersions?.[gemId]) || 0;
  return v ? { gem: gemId, v } : { gem: gemId, v: 0, pre: true };
}

// The chat message a request means: the one at `index` when it's an assistant reply that starts
// the way the client says — else the first reply that does (the chat may have shifted since).
export function findReply(msgs, index, head) {
  const h = String(head || '').slice(0, 80);
  const fits = (m) => m?.role === 'assistant' && String(m.content || '').startsWith(h);
  if (Number.isInteger(index) && fits(msgs[index])) return index;
  return h ? msgs.findIndex(fits) : -1;
}

// Where a generation's prompt came from, as the client reports it — kept only in a known shape.
export function cleanFrom(from) {
  if (!from || typeof from !== 'object') return null;
  const gem = typeof from.gem === 'string' && /^[a-z-]{2,24}$/.test(from.gem) ? from.gem : '';
  const chat = typeof from.chat === 'string' && /^[a-z0-9~-]{2,80}$/.test(from.chat) ? from.chat : '';
  const index = Number.isInteger(from.index) && from.index >= 0 ? from.index : null;
  if (!gem && !chat) return null;
  return { ...(gem ? { gem } : {}), ...(chat ? { chat } : {}), ...(index !== null ? { index } : {}) };
}

export const TRY_MAX = 4;   // options per "Try it here"
