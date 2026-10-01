// ── Reference roles ──────────────────────────────────────────────────────────
// NB Frames' reference board sorts the images it sends by role — the composition, the location,
// a named character, a named prop. Each image carries its role as a label, and the label travels
// with it: into the gem's message ("Image 2 — LOCATION reference …:"), into the chat history, and
// on to Nano Banana when a prompt is sent there — the same number and the same role all the way.
// NB Frames' board roles, plus the Video tab's: its look, and the start and end frames.
export const REF_ROLES = ['composition', 'location', 'character', 'prop', 'look', 'start', 'end'];
export const cleanRefLabel = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);

// What a saved chat image keeps of its role (nothing for an ordinary attachment).
export function refMeta(img) {
  const label = cleanRefLabel(img?.label);
  if (!label) return {};
  const role = REF_ROLES.includes(img?.role) ? img.role : '';
  const refName = String(img?.refName ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { label, ...(role ? { role } : {}), ...(refName ? { refName } : {}) };
}

// The text in front of reference image i (0-based) of n: its number, and its role when it has
// one. A lone image without a role needs no number.
export function refCaption(i, n, label) {
  const l = cleanRefLabel(label);
  if (l) return `Image ${i + 1} — ${l}:`;
  return n > 1 ? `Image ${i + 1}:` : '';
}
