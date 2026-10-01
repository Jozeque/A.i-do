// ── Seedance tab: the brief's mode, length and aspect ratio ─────────────────────
// The tab sends its brief mode (director/DOP or creative), the film-length slider and the
// aspect pick as request fields. They're pinned in the system prompt, the same way the
// version toggle is, so they win over anything the free text says. Each field is checked
// on its own; a missing or unknown one simply adds nothing.
export const SEEDANCE_MODES = ['director', 'creative'];
export const SEEDANCE_ASPECTS = ['16:9', '9:16', '21:9', '1:1', '4:3', '3:4'];

const DIRECTOR = `--- ACTIVE BRIEF MODE: DIRECTOR / DOP (set by the app toggle — this OVERRIDES the default shot rules) ---
The user is the director and DOP and has written the SHOT LIST: numbered shots, each with its time range and, where given, its shot size, lens and camera move. Treat it as the locked edit:
- Keep EXACTLY those shots, in that order, with those durations — never add, drop, merge, split or reorder a shot, and never change a stated size, lens or camera move unless the user asks for it in a later message.
- Enrich only what the user left open: blocking, performance, light, atmosphere, sound, and how each cut lands. A shot with no stated camera move still gets a motivated one — camera movement stays mandatory.
- In this mode the PROMPT block walks the shots in order, with their timing, inside one flowing block: open each with its label and time range — "Shot 1 (0–3s): wide, 24mm, slow push-in — …" then "Cut to Shot 2 (3–7s): …". This overrides the base rule against numbered shots and timestamps.
- TECHNICAL declares "Exactly N shots and N−1 cuts" (a one-shot list is a continuous single take) and the total length.`;

const CREATIVE = `--- ACTIVE BRIEF MODE: CREATIVE (set by the app toggle) ---
The user wrote a creative brief — what the scene is and what we see — not a shot list. You are the director and DOP: design the coverage yourself — the number of shots, each one's size, lens, camera move and timing — so the clip tells the brief within the target length. Pace the cuts to the length and the mood: a short clip carries few shots, a long 2.5 clip can take the staged structure. The base rules for the PROMPT block apply.`;

export function seedanceBriefDirection({ mode, length, aspect, version } = {}) {
  const out = [];
  if (mode === 'director') out.push(DIRECTOR);
  else if (mode === 'creative') out.push(CREATIVE);
  const secs = Number(length);
  if (length != null && length !== '' && Number.isFinite(secs) && secs > 0) {
    const max = version === '2.0' ? 15 : 30;
    const len = Math.min(max, Math.max(1, Math.round(secs * 2) / 2));
    out.push(`TARGET LENGTH: ${len}s (set by the app's length slider — this OVERRIDES any duration in the user's wording). State it in TECHNICAL and the settings line; the shots must add up to exactly ${len}s.`);
  }
  if (SEEDANCE_ASPECTS.includes(aspect)) out.push(`ASPECT RATIO: ${aspect} (set by the app) — state it in TECHNICAL and the settings line.`);
  return out.length ? `\n\n${out.join('\n\n')}` : '';
}
