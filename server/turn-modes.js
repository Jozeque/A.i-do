// ── Modes the app sets for a single chat turn ───────────────────────────────────
// Like the Kling and Seedance toggles, these ride in the system prompt so they win over the
// gem's default output rules for that one turn:
//   - "More like this" (any gem): the user liked one prompt and wants more directions from it.
//   - Storyboard from a script: the whole script in, exactly N titled frames out.

export const MORE_LIKE_THIS = `--- MORE LIKE THIS (set by the app — this turn only) ---
The user liked the prompt quoted in their message and wants more directions from it. Return fresh alternatives that keep what makes it work — its subject, references, look and structure — and explore distinct new directions in the same spirit (framing, moment, light, energy, composition), each one a step apart from the others. Follow the user's guidance on how to push or tighten it when they give any. Use your normal output format; where that format holds a single prompt, give three alternatives instead, each complete in its own fenced block, with any notes your format adds written once at the end.`;

// How many frames a script storyboard may ask for: enough for a full spot, few enough to read.
export const STORYBOARD_MAX_FRAMES = 30;

export function storyboardScriptDirection(frames) {
  const n = Math.round(Number(frames));
  if (!Number.isFinite(n) || n < 1) return '';
  const count = Math.min(STORYBOARD_MAX_FRAMES, n);
  return `\n\n--- STORYBOARD FROM SCRIPT (set by the app — this OVERRIDES the output format above) ---
The user attached a script and wants a storyboard of exactly ${count} frame${count === 1 ? '' : 's'}. Read the whole script first, then choose the ${count} moment${count === 1 ? '' : 's'} that best tell its story — the establishing beat, the turning points, the key actions and reactions, the ending — in script order and spread across the whole script, not bunched at its start. Draw each as one panel in the project's storyboard style, keeping every character, wardrobe, location and screen direction consistent from frame to frame.
Output exactly ${count} frame${count === 1 ? '' : 's'} and nothing else, each written as:
FRAME k — <a short title for the beat, 2 to 6 words>
<the finished panel prompt, one paragraph>
Number them 1 to ${count}, separate frames with a blank line, and use no code blocks, preamble or notes. The titles are in English; any quoted dialogue or on-screen text stays verbatim.`;
}
