import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { createStorage } from './storage.js';
import { createDataStore } from './data.js';
import { requireAuth, authEnabled, allowedEmails, webConfig } from './auth.js';
import { createShowcase } from './showcase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'projects-data');
const GEMS_DIR = path.join(ROOT, 'gems');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LANDING_DIR = path.join(ROOT, 'landing');

const PORT = process.env.PORT || 4505;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const NB2_MODEL = process.env.NB2_MODEL || 'gemini-3.1-flash-image';
const NB2_IMAGE_SIZE = process.env.NB2_IMAGE_SIZE || '1K';

// Allowlisted Nano Banana models the generator toggle can pick (key from the UI → real model id).
const NB_MODELS = {
  nb2: 'gemini-3.1-flash-image',   // Nano Banana 2 — fast, ~half the cost
  pro: 'gemini-3-pro-image',       // Nano Banana Pro — max fidelity / best text / up to 4K
};

// Plain-language aspect-ratio cues reinforced in the prompt text (helps adherence, esp. with reference images).
const AR_WORDS = {
  '1:1': 'square', '4:5': 'vertical portrait', '3:4': 'vertical portrait', '2:3': 'vertical portrait',
  '3:2': 'horizontal landscape', '4:3': 'horizontal landscape', '5:4': 'horizontal',
  '9:16': 'tall vertical', '16:9': 'widescreen landscape', '21:9': 'ultra-wide cinematic',
};

fs.mkdirSync(DATA_DIR, { recursive: true });

// Media storage seam — local disk today; swappable to Google Drive in Phase 1.
const storage = createStorage(DATA_DIR);

// Project metadata seam — local JSON today; swappable to a database in Phase 1.
const data = createDataStore(DATA_DIR);

// Showcase seam — Firestore 'showcase' collection + the storage seam for video files.
const showcase = createShowcase(storage);

// ── API clients (lazily validated) ──────────────────────────────────────────
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const genai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

// ── Gem system prompts (read fresh so you can edit them live) ────────────────
const GEM_FILES = {
  'nb-frames': 'nb-frames.txt',
  'kling': 'kling.txt',
  'kling-advisor': 'kling-advisor.txt',
  'nb-advisor': 'nb-advisor.txt',
};
async function readGem(gemId) {
  const file = GEM_FILES[gemId];
  if (!file) throw new Error('Unknown gem: ' + gemId);
  return fsp.readFile(path.join(GEMS_DIR, file), 'utf8');
}

// Shared expert cinematography knowledge (light · lens · depth · focus), auto-injected
// into the NB Frames gem AND the reference analyzer so both read and specify craft
// accurately. Read fresh each call so edits to the file go live without a restart.
const CINE_KIT_FILE = 'cinematography-kit.txt';
async function readCineKit() {
  try { return (await fsp.readFile(path.join(GEMS_DIR, CINE_KIT_FILE), 'utf8')).trim(); }
  catch { return ''; }
}
// Effective NB Frames system text = base gem + the cinematography kit (craft ground-truth).
// Other gems are returned unchanged.
async function readGemWithKit(gemId) {
  const base = await readGem(gemId);
  if (gemId !== 'nb-frames') return base;
  const kit = await readCineKit();
  return kit ? `${base}\n\n${kit}` : base;
}

// ── Per-project cinematography builder for NB Frames ─────────────────────────
// Structured fields the user fills per project; compiled into the gem override
// text that is appended to the base NB Frames gem at chat time.
function compileNbFramesDirection(b) {
  if (!b || typeof b !== 'object') return '';
  const v = (x) => (x && String(x).trim()) ? String(x).trim() : '';
  const campaign = v(b.campaign), look = v(b.look), lighting = v(b.lighting),
        lens = v(b.lens), palette = v(b.palette), environment = v(b.environment),
        aspectRatio = v(b.aspectRatio), wardrobe = v(b.wardrobe), extra = v(b.extra);
  // Nothing filled → no project direction; the gem runs on its general base alone.
  if (!(campaign || look || lighting || lens || palette || environment || aspectRatio || wardrobe || extra)) return '';

  // Compile the structured fields into prose DIRECTION (not a terse key:value list) that
  // reads as proper system instructions layered onto the base gem. The base gem already
  // carries the full Nano-Banana-doc prompting methodology; this only sets the LOOK — as a
  // family of RANGES (never the fixed settings of one reference frame), so it stays modular
  // across the different shots, subjects, and frame sizes the user will ask for later.
  const out = [];
  out.push('PROJECT LOOK DIRECTION — apply this to every frame generated for this project.');
  out.push('');
  out.push(
    "Treat this as the project's LOOK SYSTEM: a family of ranges, not the fixed settings of any one reference frame. " +
    'Match the overall look — lens character, camera feel, lighting approach, and color science — in every frame, but ' +
    'choose the specific lens/focal length, framing, and depth of field that serve each individual shot and its aspect ratio. ' +
    'Never weld one focal length or frame size onto every frame; within these ranges, pick the value that fits the brief in front of you.'
  );
  out.push('');
  if (campaign)    out.push(`Project / campaign: ${campaign}.`);
  if (look)        out.push(`Overall look & vibe: ${look}. Carry this feeling through composition, styling, grade, and mood across all three prompts.`);
  if (lighting)    out.push(`Lighting approach: ${lighting}. Motivate it from sources within the scene and keep it consistent across the set.`);
  if (lens)        out.push(`Lens & camera character: work within ${lens}. Name one specific focal length per prompt that sits inside this range, matched to that shot's framing and depth.`);
  if (palette)     out.push(`Color & palette: ${palette}. Hold this grade across every frame.`);
  if (environment) out.push(`Environment bias: ${environment}. Populate the surroundings with architecture, objects, textiles, light, and authentic atmosphere, and add people only when the brief calls for them.`);
  if (aspectRatio) out.push(`Default aspect ratio: render in ${aspectRatio} unless the brief specifies otherwise — the look itself does not depend on the frame shape.`);
  if (wardrobe)    out.push(`Wardrobe & styling: ${wardrobe}.`);
  if (extra)       out.push(`Additional direction: ${extra}`);

  return out.join('\n');
}

// ── tiny helpers ─────────────────────────────────────────────────────────────
const id = () => crypto.randomBytes(8).toString('hex');
const slug = (s) => (s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';

// Project/image/upload paths now live in the seams (server/data.js, server/storage.js).

// Uploads & generated images are persisted via the storage seam (server/storage.js):
//   storage.saveUpload(pid, base64, mimeType) · storage.saveImage(pid, imgId, buffer, mimeType)

// Thin adapters over the data seam (see server/data.js) — call sites stay unchanged.
const loadProject = (pid) => data.getProject(pid);
const saveProject = (p) => data.saveProject(p);
// Serialized read-modify-write per project: the mutator gets a FRESH read inside a per-pid
// lock, and the result is written before the lock frees — so concurrent requests can't
// clobber each other (the race that was dropping generated images from the library).
const updateProject = (pid, mutator) => data.update(pid, mutator);

// ── express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '60mb' }));

// Path-traversal guard: project ids are server-generated slugs ([a-z0-9-]). Reject anything
// else before it can reach path.join(DATA_DIR, pid) for read/write/recursive-delete.
app.param('pid', (req, res, next, pid) => {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(pid) || pid.includes('..')) {
    return res.status(400).json({ error: 'Invalid project id.' });
  }
  next();
});

// ── Access control ────────────────────────────────────────────────────────────
// Preferred: Firebase "Sign in with Google", allowlisted to specific emails (auth.js).
// When configured, the app SHELL stays open (so the sign-in screen can load) while
// every /api + /media request must carry a valid allowlisted Firebase token.
// Fallback (interim, if Firebase isn't set yet): the old shared-password Basic gate.
// Neither set → fully open, for local dev.
const APP_PASSWORD = process.env.APP_PASSWORD;
const APP_USER = process.env.APP_USER || 'studio';
if (authEnabled()) {
  app.use('/api', requireAuth({ open: ['/health', '/auth-config', 'GET /showcase'] }));
  // /media is intentionally NOT Bearer-gated: images load via <img src>, which can't
  // send an Authorization header. Filenames are unguessable and the credit-burning
  // surface (/api) is fully locked. Proper media privacy (signed URLs via the server
  // proxy) arrives with the Google Drive storage step.
  console.log(`  🔐 Google sign-in ON — allowlist: ${allowedEmails().join(', ')}`);
} else if (APP_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/api/health') return next();
    const hdr = req.headers.authorization || '';
    if (hdr.startsWith('Basic ')) {
      const [u, p] = Buffer.from(hdr.slice(6), 'base64').toString().split(':');
      if (u === APP_USER && p === APP_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="AI Video Studio"');
    return res.status(401).send('Authentication required.');
  });
  console.log('  🔒 Shared-password protection ON (APP_PASSWORD set)');
}

// Never cache the app shell (index.html / app.js / styles.css) so UI updates always load.
app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));
// Public A.I-Duo landing page (marketing + portfolio) — served at /landing, no login.
app.use('/landing', express.static(LANDING_DIR));
// serve saved media. Local backend: static from disk. Drive backend: proxy the file's
// bytes from Drive by id (so <img>/<video src> just works, no token needed in the URL).
if (storage.backend === 'drive') {
  app.get('/media/:pid/:bucket/:file', async (req, res) => {
    try {
      const { stream, mimeType } = await storage.readFile(req.params.file);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
      stream.pipe(res);
    } catch { res.status(404).end(); }
  });
} else {
  app.use('/media', express.static(DATA_DIR));
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
// Larger limit for showcase video uploads (the in-app portfolio uploader).
const uploadVideo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// ── health / config ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    claudeModel: CLAUDE_MODEL,
    nb2Model: NB2_MODEL,
    nb2Size: NB2_IMAGE_SIZE,
    hasAnthropic: !!anthropic,
    hasGemini: !!genai,
    authEnabled: authEnabled(),
    // Diagnostic: which backends are active + which env vars are present (booleans only,
    // never values) — so a misconfigured deploy can be pinpointed without guessing.
    storage: storage.backend,
    data: data.backend,
    env: {
      STORAGE_BACKEND: process.env.STORAGE_BACKEND || '(unset)',
      DATA_BACKEND: process.env.DATA_BACKEND || '(unset)',
      GOOGLE_OAUTH_CLIENT_ID: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      GOOGLE_OAUTH_REFRESH_TOKEN: !!process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      FIREBASE_SERVICE_ACCOUNT_or_FILE: !!(process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS),
    },
  });
});

// Public — the browser fetches this before booting to learn whether Google sign-in
// is required and, if so, the (non-secret) Firebase web config to initialise it.
app.get('/api/auth-config', (req, res) => {
  res.json({ authEnabled: authEnabled(), firebase: authEnabled() ? webConfig() : null });
});

// ── SHOWCASE — landing-page portfolio videos ──────────────────────────────────
// GET is PUBLIC (the landing page reads it); POST/DELETE are gated (in-app admin).
app.get('/api/showcase', async (req, res) => {
  try { res.json(await showcase.list({ publishedOnly: true })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/showcase', uploadVideo.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file uploaded.' });
    const sid = `${slug(req.body?.title || 'video')}-${id().slice(0, 6)}`;
    const item = await showcase.add({
      id: sid,
      title: req.body?.title || '',
      caption: req.body?.caption || '',
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      createdAt: Date.now(),
    });
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/showcase/:sid', async (req, res) => {
  try { await showcase.remove(req.params.sid); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROJECTS ──────────────────────────────────────────────────────────────────
app.get('/api/projects', async (req, res) => {
  try {
    res.json(await data.listProjects());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const name = (req.body?.name || '').trim() || 'Untitled Project';
    const pid = `${slug(name)}-${id().slice(0, 6)}`;
    const now = Date.now();
    const project = {
      id: pid,
      name,
      createdAt: now,
      updatedAt: now,
      // per-project gem overrides (start from defaults; editable in UI)
      gemOverrides: { 'nb-frames': '', 'kling': '', 'kling-advisor': '', 'nb-advisor': '' },
      // structured builder inputs (NB Frames) that compile into gemOverrides
      gemBuilders: { 'nb-frames': {} },
      chats: { 'nb-frames': [], 'kling': [], 'kling-advisor': [], 'nb-advisor': [] },
      images: [], // {id, prompt, file, createdAt, favorite, note}
    };
    await saveProject(project);
    res.json(project);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:pid', async (req, res) => {
  try { res.json(await loadProject(req.params.pid)); }
  catch (e) { res.status(404).json({ error: 'Project not found' }); }
});

app.patch('/api/projects/:pid', async (req, res) => {
  try {
    const p = await updateProject(req.params.pid, (p) => {
      if (typeof req.body.name === 'string') p.name = req.body.name.trim() || p.name;
      if (req.body.gemOverrides) p.gemOverrides = { ...p.gemOverrides, ...req.body.gemOverrides };
      if (req.body.gemBuilders) {
        p.gemBuilders = { ...(p.gemBuilders || {}), ...req.body.gemBuilders };
        // NB Frames direction is derived from its structured builder
        if (req.body.gemBuilders['nb-frames']) {
          p.gemOverrides = p.gemOverrides || {};
          p.gemOverrides['nb-frames'] = compileNbFramesDirection(p.gemBuilders['nb-frames']);
        }
      }
      p.updatedAt = Date.now();
    });
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:pid', async (req, res) => {
  try {
    await data.deleteProject(req.params.pid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── return effective gem prompt (default + project override) ───────────────────
app.get('/api/projects/:pid/gems/:gemId', async (req, res) => {
  try {
    const base = await readGemWithKit(req.params.gemId);
    const p = await loadProject(req.params.pid);
    const override = p.gemOverrides?.[req.params.gemId] || '';
    const builder = p.gemBuilders?.[req.params.gemId] || null;
    res.json({ base, override, builder });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analyze reference image(s) → fill the NB Frames cinematography builder ──────
// body: { images: [{ mimeType, data(base64) }] }
app.post('/api/projects/:pid/gems/nb-frames/analyze', async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set. Add it to your .env file.' });
  try {
    const { images = [] } = req.body;
    if (!images.length) return res.status(400).json({ error: 'Attach at least one reference image to analyze.' });
    const p = await loadProject(req.params.pid);

    const kit = await readCineKit();
    const system = `${kit ? kit + '\n\n' : ''}You are a cinematography analyst. Examine the attached reference image(s) and extract their VISUAL STYLE as a REUSABLE LOOK — structured data an AI image generator can apply to MANY future images. Focus on style and craft, NOT the identity of any specific person.

MOST IMPORTANT — capture the transferable CINEMATOGRAPHY, not this one frame's scene. The user reuses this look across many different shots, subjects, scenes, TIMES OF DAY, and aspect ratios. So extract what makes the image beautiful as CRAFT — its color science, contrast and grade, how light is shaped and sculpts the subject, lens character, texture, finish, and composition tendencies — and describe each as a FAMILY or RANGE (its DNA), never the single locked value of this one frame. CRITICALLY, do NOT bake in the reference's circumstantial facts — its time of day, its light SOURCE, its specific LOCATION, or the subject's exact OUTFIT. If the reference was shot in daylight, that does NOT make this a daylight project: describe the lighting's character so it can be re-created at night, golden hour, or indoors, adapting the source to whatever the user later briefs. For LENSES, give a lens CHARACTER and a focal-length RANGE (e.g. "short-telephoto family, ~70–135mm-equivalent"), never one fixed focal length. The look must stay modular to the user's brief while preserving the reference's overall cinematography.

Return STRICT JSON only — no markdown, no commentary outside the JSON object — with exactly these string keys:
{"look":"","lighting":"","lens":"","palette":"","environment":"","aspectRatio":"","wardrobe":"","extra":""}
Guidance per key (describe the RANGE / FAMILY, not a single locked value):
- look: 2-6 word overall look/vibe (e.g. "High-gloss beauty", "Moody cinematic noir").
- lighting: the lighting CRAFT as a SCENE-ADAPTIVE approach — its quality (soft↔hard), contrast character, color saturation, how it shapes and separates the subject, and catchlight character — described so it can be re-created under ANY scene or time of day (the model adapts the actual source: sun, golden hour, window, night practicals, motivated "magic" light). Capture what makes the light beautiful, NOT the reference's time of day or source — do not weld in "daylight"/"sunlight"/"night" or a daylight-only Kelvin (e.g. "Bold, luminous key with strong directional shaping, punchy contrast holding clean rich shadows, bright catchlights — adaptable to any scene's light sources").
- lens: lens CHARACTER plus a focal-length RANGE, the depth-of-field/bokeh feel, and any distortion — NEVER a single focal length (e.g. "Short-telephoto family, ~70–135mm-equivalent, shallow-to-moderate depth of field, creamy background bokeh, no distortion").
- palette: the GRADE and colour science as a transferable family — the colour RELATIONSHIPS (warm/cool balance, complementary or analogous scheme), saturation level, contrast, and film-like treatment (separation, highlight roll-off) — NOT the specific objects' colours in this one frame (avoid "green grapes, magenta labels"; instead "high-saturation jewel-tone scheme, warm subject against cooler surroundings, filmic roll-off").
- environment: by DEFAULT say the environment follows the brief, and capture only the transferable rendering approach — how backgrounds are graded, shaped, and handled for depth (bokeh / depth of field) — NOT the reference's specific location or time of day. Only record a concrete setting if the project is genuinely tied to one place. Don't lock the reference's exact scene (NOT "suburban garden with picket fence"; instead "environment follows the brief, backgrounds rendered in the look's palette as a soft shallow-DOF bokeh wash").
- aspectRatio: ALWAYS return "". Do NOT infer an aspect ratio from the reference's crop — the reference's frame shape is circumstantial, and aspect ratio is a per-shot choice the user sets at generation time. The look must never carry a frame shape.
- wardrobe: the styling APPROACH/aesthetic, not the one specific outfit from the reference — wardrobe follows each brief's subject (e.g. "styled within the [look] aesthetic"). Describe as style, not identity. Use "" if no subject.
- extra: 1-3 sentences of additional cinematography notes (composition tendencies, texture, grain, finish, mood) as transferable craft guidance, not frame-specific facts.
Describe only what you can actually see; do not invent. Keep values concise.`;

    const userContent = images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.data },
    }));
    userContent.push({ type: 'text', text: 'Analyze the cinematography / visual style of the attached reference image(s) and return only the JSON object.' });

    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userContent }],
    });
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

    let parsed;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : text);
    } catch {
      return res.status(502).json({ error: 'Could not parse the analysis as JSON. Raw output: ' + text.slice(0, 300) });
    }

    // Persist the first reference as the project's saved look reference.
    let styleRef = null;
    if (images[0]) styleRef = await storage.saveUpload(p.id, images[0].data, images[0].mimeType);

    const FIELDS = ['look', 'lighting', 'lens', 'palette', 'environment', 'aspectRatio', 'wardrobe', 'extra'];
    const builder = {};
    for (const k of FIELDS) builder[k] = typeof parsed[k] === 'string' ? parsed[k].trim() : '';
    if (styleRef) builder.styleRef = { ...styleRef, url: `/media/${p.id}/uploads/${styleRef.file}` };

    res.json({ builder });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── CHAT with a gem (Claude) ───────────────────────────────────────────────────
// body: { gemId, messages:[{role, content|parts}], images?: [{mimeType, data(base64)}] }
app.post('/api/projects/:pid/chat', async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set. Add it to your .env file.' });
  try {
    const { gemId, userText, images = [], history = [], klingMode } = req.body;
    const base = await readGemWithKit(gemId);
    const p = await loadProject(req.params.pid);
    const override = (p.gemOverrides?.[gemId] || '').trim();
    let system = override ? `${base}\n\n--- PROJECT-SPECIFIC DIRECTION (overrides/extends the above) ---\n${override}` : base;

    // Kling: the app's mode toggle forces single (Mode A) vs multi-shot (Mode B),
    // so the user doesn't have to phrase it in the prompt.
    if (gemId === 'kling') {
      system += klingMode === 'multi'
        ? '\n\n--- ACTIVE MODE: MULTI-SHOT (set by the app toggle — this OVERRIDES the user\'s wording) ---\nProduce MODE B (a multi-shot sequence) for this message no matter how it is phrased. Take the number of shots from the user\'s message; if the user states no number, default to a 3-shot sequence. Do not produce the three single-shot archetype variations.'
        : '\n\n--- ACTIVE MODE: SINGLE SHOT (set by the app toggle — this OVERRIDES the user\'s wording) ---\nProduce MODE A (exactly three archetype variations of ONE single shot) for this message. Even if the user mentions multiple shots, a sequence, a storyboard, or a specific number of shots, IGNORE that and still return the three single-shot archetype variations. Never output a numbered "Shot 1 / Shot 2" sequence in this mode.';
    }

    // Build the Anthropic message array from prior history + the new user turn.
    // If this turn includes image(s), treat it as a fresh brief and IGNORE prior history —
    // an earlier scene/reference must never bleed into prompts for a newly attached image.
    const messages = (images.length > 0 ? [] : history).map(m => ({ role: m.role, content: m.content }));
    const userContent = [];
    for (const img of images) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.data },
      });
    }
    // For Kling, append the toggle's mode tag to THIS turn's text (most salient place,
    // so it wins over any conflicting wording). Only userText is persisted, not the tag.
    let turnText = userText || '';
    if (gemId === 'kling') {
      turnText += klingMode === 'multi'
        ? '\n\n[OUTPUT MODE = MULTI-SHOT: return one prompt per shot as a numbered "Shot 1 … Shot N" sequence. Take N from this message; if no number is given, use 3. Do not return the 3 archetype variations.]'
        : '\n\n[OUTPUT MODE = SINGLE SHOT: return exactly 3 archetype variations of ONE shot. Ignore any request for multiple shots, a sequence, or a shot count — never output a "Shot 1 / Shot 2" sequence.]';
    }
    userContent.push({ type: 'text', text: turnText });
    messages.push({ role: 'user', content: userContent });

    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      // NB Frames returns 3 prompts × 4 dense DOP-grade paragraphs; 2048 truncated the
      // later prompts down to fewer paragraphs. Give it room for the full structure.
      max_tokens: 4096,
      system,
      messages,
    });
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

    // persist any attached images to disk so they survive reloads
    const savedImgs = [];
    for (const img of images) {
      savedImgs.push(await storage.saveUpload(p.id, img.data, img.mimeType));
    }

    // persist chat via the serialized, fresh-read updater so a concurrent generate/chat
    // on this project can't clobber it
    await updateProject(req.params.pid, (proj) => {
      proj.chats[gemId] = proj.chats[gemId] || [];
      proj.chats[gemId].push({ role: 'user', content: userText || '(image)', hadImages: images.length > 0, images: savedImgs, at: Date.now() });
      proj.chats[gemId].push({ role: 'assistant', content: text, at: Date.now() });
      proj.updatedAt = Date.now();
    });

    res.json({ text, images: savedImgs });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post('/api/projects/:pid/chat/clear', async (req, res) => {
  try {
    const { gemId } = req.body;
    await updateProject(req.params.pid, (p) => {
      if (gemId && p.chats[gemId]) p.chats[gemId] = [];
      p.updatedAt = Date.now();
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── NANO BANANA 2 — generate N images from one prompt ──────────────────────────
// body: { prompt, count=3, aspectRatio?, refImages?: [{mimeType, data}] }
app.post('/api/projects/:pid/generate', async (req, res) => {
  if (!genai) return res.status(400).json({ error: 'GEMINI_API_KEY is not set. Add it to your .env file.' });
  try {
    const { prompt, count = 1, aspectRatio, refImages = [] } = req.body;
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is empty.' });
    // Resolve the model from the UI toggle (allowlisted); fall back to the .env default.
    const model = NB_MODELS[req.body.model] || NB2_MODEL;
    const p = await loadProject(req.params.pid);

    const contents = [];
    const savedRefs = [];
    for (const r of refImages) {
      contents.push({ inlineData: { mimeType: r.mimeType || 'image/jpeg', data: r.data } });
      savedRefs.push(await storage.saveUpload(p.id, r.data, r.mimeType));
    }
    // Reinforce the target aspect ratio in the prompt text. With a reference image the model
    // otherwise tends to copy the reference's shape and ignore the requested ratio.
    let promptText = prompt;
    if (aspectRatio) {
      promptText += `\n\nFrame the final image as a ${AR_WORDS[aspectRatio] || aspectRatio} (${aspectRatio}) composition.`;
      if (refImages.length) promptText += ` Recompose to fill the full ${aspectRatio} frame; do not keep the reference image's aspect ratio.`;
    }
    contents.push({ text: promptText });

    const imageConfig = { imageSize: NB2_IMAGE_SIZE };
    if (aspectRatio) imageConfig.aspectRatio = aspectRatio;

    // Fire N independent generations so each is a distinct variation.
    const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 4);
    const jobs = Array.from({ length: n }, () =>
      genai.models.generateContent({
        model,
        contents,
        config: { responseModalities: ['IMAGE'], imageConfig },
      })
    );

    const settled = await Promise.allSettled(jobs);
    const saved = [];
    const recs = [];
    const errors = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled') { errors.push(s.reason?.message || String(s.reason)); continue; }
      const cand = s.value?.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const imgPart = parts.find(pt => pt.inlineData);
      if (!imgPart) {
        // Surface WHY no image came back — most often Gemini's safety filter blocked it
        // (e.g. depictions of children), which otherwise reads as a generic failure.
        const block = s.value?.promptFeedback?.blockReason;
        const finish = cand?.finishReason;
        const textPart = parts.find(pt => pt.text)?.text;
        errors.push(
          block ? `blocked by Gemini safety filter (${block})`
          : (finish && !['STOP', 'MAX_TOKENS'].includes(finish)) ? `no image (finishReason: ${finish}${/SAFETY|PROHIBIT|RECITATION|IMAGE|BLOCK/i.test(finish) ? ' — content-policy block' : ''})`
          : textPart ? `model returned text instead of an image: "${textPart.slice(0, 160)}"`
          : 'no image returned (empty response)'
        );
        continue;
      }
      const imgId = id();
      const buf = Buffer.from(imgPart.inlineData.data, 'base64');
      const { file: fname } = await storage.saveImage(p.id, imgId, buf, imgPart.inlineData.mimeType);
      const rec = {
        id: imgId, prompt, file: fname, createdAt: Date.now(), favorite: false, note: '',
        aspectRatio: aspectRatio || null, size: NB2_IMAGE_SIZE, model,
        refs: savedRefs.map(r => ({ ...r, url: `/media/${p.id}/uploads/${r.file}` })),
      };
      recs.push(rec);
      saved.push({ ...rec, url: `/media/${p.id}/images/${fname}` });
    }
    if (saved.length === 0) {
      const why = [...new Set(errors)].join(' · ');
      return res.status(502).json({ error: why ? `No images generated — ${why}` : 'No images generated.', details: errors });
    }
    // Append the new image records via the serialized, fresh-read updater so a concurrent
    // generate/chat on this project can't overwrite them (the bug that dropped images).
    await updateProject(req.params.pid, (proj) => {
      proj.images = proj.images || [];
      for (const rec of recs) proj.images.unshift(rec);
      proj.updatedAt = Date.now();
    });
    res.json({ images: saved, errors });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── image library management ───────────────────────────────────────────────────
app.get('/api/projects/:pid/images', async (req, res) => {
  try {
    const p = await loadProject(req.params.pid);
    res.json(p.images.map(im => ({ ...im, url: `/media/${p.id}/images/${im.file}` })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/projects/:pid/images/:imgId', async (req, res) => {
  try {
    let result = null;
    await updateProject(req.params.pid, (p) => {
      const im = p.images.find(x => x.id === req.params.imgId);
      if (!im) return;
      if (typeof req.body.favorite === 'boolean') im.favorite = req.body.favorite;
      if (typeof req.body.note === 'string') im.note = req.body.note;
      p.updatedAt = Date.now();
      result = { ...im, url: `/media/${req.params.pid}/images/${im.file}` };
    });
    if (!result) return res.status(404).json({ error: 'Image not found' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:pid/images/:imgId', async (req, res) => {
  try {
    let removed = null;
    await updateProject(req.params.pid, (p) => {
      const idx = p.images.findIndex(x => x.id === req.params.imgId);
      if (idx === -1) return;
      [removed] = p.images.splice(idx, 1);
      p.updatedAt = Date.now();
    });
    if (!removed) return res.status(404).json({ error: 'Image not found' });
    await storage.deleteImage(req.params.pid, removed.file);   // delete the file after the index update is committed
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  AI Video Studio running →  http://localhost:${PORT}\n`);
  if (!anthropic) console.log('  ⚠  ANTHROPIC_API_KEY missing — text gems disabled until set in .env');
  if (!genai) console.log('  ⚠  GEMINI_API_KEY missing — Nano Banana 2 disabled until set in .env');
  console.log(`  Claude model: ${CLAUDE_MODEL}   |   NB2 model: ${NB2_MODEL} @ ${NB2_IMAGE_SIZE}`);
  console.log(`  Data: ${data.backend}   |   Media storage: ${storage.backend}\n`);
});
