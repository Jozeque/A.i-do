// ── Video tab: the brief's model, mode, length and aspect ratio ──────────────────
// The tab sends its model (Seedance 2.0 / 2.5 or Kling 3.0), its generation mode (references,
// or a start and an end frame), its brief mode (director/DOP or creative), the length slider and
// the aspect pick as request fields. They're pinned in the system prompt so they win over anything
// the free text says. Each field is checked on its own; a missing or unknown one adds nothing.
export const SEEDANCE_MODES = ['director', 'creative'];
export const SEEDANCE_ASPECTS = ['16:9', '9:16', '21:9', '1:1', '4:3', '3:4'];
export const KLING_ASPECTS = ['16:9', '9:16', '1:1'];
// The models the tab writes for (docs/seedance.md, docs/kling.md): the clip length, the shortest
// shot, how many shots fit one clip and how many reference images go with it.
export const VIDEO_MODELS = {
  'seedance-2.5': { family: 'seedance', version: '2.5', label: 'Seedance 2.5', minLen: 4, maxLen: 30, maxImages: 30 },
  'seedance-2.0': { family: 'seedance', version: '2.0', label: 'Seedance 2.0', minLen: 4, maxLen: 15, maxImages: 9 },
  'kling-3.0': { family: 'kling', label: 'Kling 3.0', minLen: 3, maxLen: 15, maxImages: 4, minShot: 3, maxShots: 6 },
};
export const cleanVideoModel = (v) => (Object.hasOwn(VIDEO_MODELS, v) ? v : '');
export const VIDEO_GENS = ['refs', 'frames'];

const DIRECTOR = `--- ACTIVE BRIEF MODE: DIRECTOR / DOP (set by the app toggle — this OVERRIDES the default shot rules) ---
The user is the director and DOP and has written the SHOT LIST: numbered shots, each with its time range and, where given, its shot size, lens and camera move. Treat it as the locked edit:
- Keep EXACTLY those shots, in that order, with those durations — never add, drop, merge, split or reorder a shot, and never change a stated size, lens or camera move unless the user asks for it in a later message.
- Enrich only what the user left open: blocking, performance, light, atmosphere, sound, and how each cut lands. A shot with no stated camera move still gets a motivated one — camera movement stays mandatory.
- In this mode the PROMPT block walks the shots in order, with their timing, inside one flowing block: open each with its label and time range — "Shot 1 (0–3s): wide, 24mm, slow push-in — …" then "Cut to Shot 2 (3–7s): …". This overrides the base rule against numbered shots and timestamps.
- TECHNICAL declares "Exactly N shots and N−1 cuts" (a one-shot list is a continuous single take) and the total length.`;

const CREATIVE = `--- ACTIVE BRIEF MODE: CREATIVE (set by the app toggle) ---
The user wrote a creative brief — what the scene is and what we see — not a shot list. You are the director and DOP: design the coverage yourself — the number of shots, each one's size, lens, camera move and timing — so the clip tells the brief within the target length. Pace the cuts to the length and the mood: a short clip carries few shots, a long 2.5 clip can take the staged structure. The base rules for the PROMPT block apply.`;

// Start & end frames on Seedance: the two frames are tagged references, declared as the first and
// last frame — the same prompt also works with OpenArt's Start / End frame slots.
const SEEDANCE_FRAMES = `--- ACTIVE GENERATION MODE: START & END FRAMES (set by the app — this OVERRIDES the reference rules and the brief modes above) ---
The user loaded exactly two frames: @image1 is the START frame and @image2 is the END frame. Write a first-and-last-frame generation:
- The clip opens EXACTLY on @image1 and lands EXACTLY on @image2 — the same composition, people, wardrobe, place, light and grade as each frame. Nothing in either frame is redesigned; everything that differs between them is what the clip must travel through.
- The PROMPT describes only that journey: the action, the camera path, how light, space and bodies change, timed across the length — one continuous take with no cuts (a cut would break the frame lock). Open the PROMPT by saying that @image1 is the first frame and @image2 is the last frame.
- REFERENCE DEFINITIONS has exactly two lines: "@image1 : START FRAME — the clip opens exactly on this frame; its composition, identity and look are locked. Reference." and "@image2 : END FRAME — the clip ends exactly on this frame. Reference."
- TECHNICAL says "Continuous single take, no cuts." and the aspect ratio is the start frame's (OpenArt locks it to the first frame).
- The manifest reads: "Upload order: 1. Start frame → @image1 · 2. End frame → @image2" — and, on its own line, "Or load them in OpenArt's Start / End frame slots: image1 → Start, image2 → End."`;

export function seedanceBriefDirection({ mode, length, aspect, version, gen } = {}) {
  const out = [];
  if (gen === 'frames') out.push(SEEDANCE_FRAMES);
  else if (mode === 'director') out.push(DIRECTOR);
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

// ── Kling 3.0 from the same brief ───────────────────────────────────────────────
// The Kling gem (gems/kling.txt) knows Kling's motion grammar, its multi-shot rules and the 512-
// character shot field; this pins the app's brief on top of it: one paste-ready result bound to
// @image tags (OpenArt and Higgsfield number uploads that way), never the three variations.
const KLING_REFS = `--- THE APP'S VIDEO BRIEF — KLING 3.0 (set by the app — this OVERRIDES the MODE A / MODE B choice, the REFERENCE ROLES section and the Elements wording above) ---
The user built a structured brief for Kling 3.0 on OpenArt / Higgsfield. The message opens with a role-labelled list of reference images in upload order — @image1 is always the LOOK & CINEMATOGRAPHY frame, then the location, the characters and the props — and the user uploads them in exactly that order, so @image1 , @image2 … are the tags (at most 4 images per Kling generation). Bind every image by its tag, and only for its role:
- LOOK & CINEMATOGRAPHY (@image1) → style, lens character, light and grade ONLY — translate it into one compact, concrete visual clause and repeat it in every shot; nothing in it appears on screen.
- LOCATION → the place and its geography, not its people.
- CHARACTER → identity and wardrobe; several images under one character are views of the same person. Name each character with one concrete descriptor and reuse it verbatim.
- PROP → the exact object, unchanged in every shot.
- Anything listed under ALSO IN THE SCENE has no image — write it in words.
Put a space after every tag ("@image2 ," never "@image2,").
OUTPUT — in this order, nothing else:
1. One plain-text line: "Upload order: 1. <name> → @image1 · 2. <name> → @image2 · …" for every image.
2. The prompt(s):`;

const KLING_DIRECTOR = `   DIRECTOR / DOP (the user's shot list is the locked edit — keep EXACTLY those shots, in that order, with those durations, sizes, lenses and moves): with two or more shots use the MODE B output — the "Sequence:" line, then for each shot its plain label line "Shot K — <size + intent> (~Xs)" and its own code block, every block at most 512 characters including the mandatory suffix. A one-shot list is ONE code block (no 512 cap).`;
const KLING_CREATIVE = `   CREATIVE (you design the coverage): one continuous shot → ONE code block; several beats → the MODE B output (Sequence line, then "Shot K — … (~Xs)" labels, each shot its own code block of at most 512 characters with the suffix), at most 6 shots of at least 3s each, adding up to the length.`;
const KLING_TAIL = `3. One plain-text line: "Kling settings: Kling 3.0 · <length>s · <aspect>".
Never the three archetype variations, never a negative prompt; every code block ends with the mandatory suffix.`;

const KLING_FRAMES = `--- THE APP'S VIDEO BRIEF — KLING 3.0, START & END FRAMES (set by the app — this OVERRIDES MODE A / MODE B and the REFERENCE ROLES section above) ---
The user loaded two frames for Kling's first-and-last-frame generation: @image1 is the START frame, @image2 is the END frame. The clip opens exactly on @image1 and ends exactly on @image2 — never redesign what either frame shows; the prompt is the journey between them: the camera path, the action, how light and space change, with a clear end state that IS @image2. One continuous shot — Kling can't combine multi-shot with start and end frames.
OUTPUT — in this order, nothing else:
1. One plain-text line: "Upload order: 1. Start frame → @image1 · 2. End frame → @image2 — or Kling's Start / End frame slots: image1 → Start, image2 → End."
2. ONE code block: the image-to-video prompt (~30-60 words), opening with the camera move, naming @image1 and @image2 by their tags (a space after each tag), ending with the mandatory suffix.
3. One plain-text line: "Kling settings: Kling 3.0 · <length>s · <aspect> (the start frame's)".
Never the three archetype variations, never a negative prompt.`;

export function klingBriefDirection({ mode, length, aspect, gen } = {}) {
  const out = [];
  if (gen === 'frames') out.push(KLING_FRAMES);
  else out.push([KLING_REFS, mode === 'director' ? KLING_DIRECTOR : KLING_CREATIVE, KLING_TAIL].join('\n'));
  const secs = Number(length);
  if (length != null && length !== '' && Number.isFinite(secs) && secs > 0) {
    const len = Math.min(15, Math.max(3, Math.round(secs * 2) / 2));
    out.push(`TARGET LENGTH: ${len}s (set by the app's length slider — this OVERRIDES any duration in the user's wording). The shots add up to exactly ${len}s; state it in the settings line.`);
  }
  if (KLING_ASPECTS.includes(aspect)) out.push(`ASPECT RATIO: ${aspect} (set by the app) — state it in the settings line.`);
  return `\n\n${out.join('\n\n')}`;
}
