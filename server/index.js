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
import { computeUsage } from './usage.js';
import { requireAuth, authEnabled, allowedEmails, webConfig } from './auth.js';
import { createShowcase } from './showcase.js';
import { Jimp } from 'jimp';   // resize swap outputs to the input image's exact pixel dimensions

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'projects-data');
const GEMS_DIR = path.join(ROOT, 'gems');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LANDING_DIR = path.join(ROOT, 'landing');

const PORT = process.env.PORT || 4505;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
// The reference look-analysis is a rare, high-value, judgment-heavy call (subtle camera body /
// lens series / grade reads a weaker model can whiff on). Run it on a stronger DOP-grade model —
// once per project tune, so the extra cost is negligible. Verified: on a warm Cooke look, Sonnet 5
// reads "ARRI Alexa + Cooke" reliably where Haiku occasionally slips and Opus over-writes past the
// token cap. Override with ANALYZE_MODEL if needed.
const ANALYZE_MODEL = process.env.ANALYZE_MODEL || 'claude-sonnet-5';
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

// fal.ai — Flux Kontext for faithful character/subject swaps. Nano Banana is generative and
// re-renders too much; Kontext is an in-context editor that preserves image 1 far better.
// Raw HTTP (no SDK dep). Set FAL_KEY in .env / Render to enable the Swap tab.
const FAL_KEY = process.env.FAL_KEY || '';
// OpenAI GPT Image (ChatGPT's editor) — a fallback swap/edit engine for the edge cases where
// Flux struggles. Optional; set OPENAI_API_KEY to enable it as a model option in the Swap tab.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// ── Gem system prompts (read fresh so you can edit them live) ────────────────
const GEM_FILES = {
  'nb-frames': 'nb-frames.txt',
  'kling': 'kling.txt',
  'kling-advisor': 'kling-advisor.txt',
  'nb-advisor': 'nb-advisor.txt',
  'gpt-advisor': 'gpt-advisor.txt',
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
//
// Standing block prepended to EVERY compiled direction so every tuned project inherits the same
// subject-fidelity + scope discipline automatically (the generalized version of what was hand-written
// into the PANDORA-ACTION extra). This is what keeps outputs loyal to the reference and free of
// unrequested subjects, independent of — and above — the look fields.
const FIDELITY_SCOPE_BLOCK = `SUBJECT FIDELITY & SCOPE — the top priority for this project, above the look direction below. (For a surgical face swap or composite edit, ignore this whole block, exactly as the base gem says — a transplant must stay minimal so the model does not re-render the frame.)

WHO IS IN THE SHOT — read this first. Include only the people the brief names or the attached reference image(s) actually show. If the reference is an empty location, an establishing plate, or a product with no person in it — and the brief does not ask for one — render a SCENE-ONLY frame: just the environment in the project look, with NO invented subject, and do not mention one. Never insert the subject into a shot where they are not attached or requested, and never pad the frame with unrequested people. The identity and realism locks below apply ONLY to frames that actually contain the subject.

IDENTITY LOCK — when a real referenced subject is in the shot. Bind them to the attached reference image(s): keep their face, bone structure, skin tone, eye colour, hair, and any signature jewelry, accessories, or wardrobe the reference shows IDENTICAL — piece for piece, same design and placement — and never redesign, restyle, rearrange, add, remove, or beautify a feature or a piece. Say it plainly, e.g. "keep the subject's face and everything they are wearing exactly as in the reference images — do not redesign or restyle anything."

PRESERVATION, NOT INVENTION — the anti-drift rule. Keep the subject's REAL skin exactly as the reference shows it: the real pores, texture, fine lines, uneven tone, marks and flaws — never smoothed, airbrushed, retouched, or idealised, so they read as a photographed human, not a polished CG render. But this is PRESERVATION: carry that texture over FROM the reference; do NOT spell out generic pore, subsurface-scattering, or catchlight detail as things to render — cataloguing the face that way makes the model re-invent its OWN version of the subject. Hold the line: KEEP the real skin and flaws from the reference — yes; DESCRIBE how to draw the face from scratch — no.

Spend the prompt's detail only on what is genuinely NEW — the scene, environment, pose, action, gesture, and framing. The look, grade, lighting, and grain notes below set the IMAGE and the scene, never a licence to re-render the subject's face or skin. Run identity-critical frames on Nano Banana Pro at 2K, not NB2.`;

function compileNbFramesDirection(b) {
  if (!b || typeof b !== 'object') return '';
  const v = (x) => (x && String(x).trim()) ? String(x).trim() : '';
  const medium = v(b.medium), campaign = v(b.campaign), look = v(b.look), lighting = v(b.lighting),
        lens = v(b.lens), palette = v(b.palette), grain = v(b.grain), environment = v(b.environment),
        aspectRatio = v(b.aspectRatio), wardrobe = v(b.wardrobe), extra = v(b.extra);
  // Nothing filled → no project direction; the gem runs on its general base alone.
  if (!(medium || campaign || look || lighting || lens || palette || grain || environment || aspectRatio || wardrobe || extra)) return '';
  // A non-photographic medium (illustration / painting / render / animation) — the camera+lens
  // and photoreal rules do NOT apply; the frames render in that artistic style instead.
  const illustrated = medium && /illustrat|storyboard|sketch|drawing|paint|render|anime|cartoon|comic|graphic.?novel|watercolou?r|gouache|vector|\bcel\b|animation|hand.?drawn|\bink\b|pencil|charcoal|collage/i.test(medium) && !/photo|film still|photograph/i.test(medium);

  // Compile the structured fields into prose DIRECTION (not a terse key:value list) that
  // reads as proper system instructions layered onto the base gem. The base gem already
  // carries the full Nano-Banana-doc prompting methodology; this only sets the LOOK — as a
  // family of RANGES (never the fixed settings of one reference frame), so it stays modular
  // across the different shots, subjects, and frame sizes the user will ask for later.
  const out = [];
  out.push(FIDELITY_SCOPE_BLOCK);
  out.push('');
  out.push('PROJECT LOOK DIRECTION — apply this to every frame generated for this project.');
  out.push('');
  out.push(
    "Treat this as the project's LOOK SYSTEM: a family of ranges, not the fixed settings of any one reference frame. " +
    'Match the overall look — lens character, camera feel, lighting approach, and color science — in every frame, but ' +
    'choose the specific lens/focal length, framing, and depth of field that serve each individual shot and its aspect ratio. ' +
    'Never weld one focal length or frame size onto every frame; within these ranges, pick the value that fits the brief in front of you.'
  );
  out.push('');
  out.push('This look applies to fresh generations and preserve-the-reference edits only. For a surgical FACE SWAP or head/body composite, IGNORE this entire block — add no camera, lens, grade, grain, or look instruction; a transplant must stay minimal so the model does not re-render the frame.');
  out.push('');
  if (medium && illustrated) {
    out.push(`RENDERING MEDIUM — CRITICAL: every frame is a ${medium}, NOT a photograph. Render it in that exact artistic style — its medium, linework, shading, and surface texture — and do NOT make it photorealistic, and do NOT name or imply a camera body, lens, focal length, Kelvin colour temperature, or photographic film grain (a ${medium} has none of those). The output's medium always matches this.`);
    out.push('');
  } else if (medium) {
    out.push(`Rendering medium: ${medium} — a photorealistic capture; render it with a real camera, lens, and grade as usual.`);
    out.push('');
  }
  if (campaign)    out.push(`Project / campaign: ${campaign}.`);
  if (look)        out.push(`Overall look & vibe: ${look}. Carry this feeling through composition, styling, grade, and mood across all three prompts.`);
  if (lighting)    out.push(`Lighting approach: ${lighting}. Motivate it from sources within the scene and keep it consistent across the set.`);
  if (lens && !illustrated) out.push(`Camera & lens: ${lens}. Shoot every frame on this exact camera body and lens series and NAME them in the prompt — they are the constant look DNA and never change; only the focal length varies, so pick one specific focal length inside the stated range that fits each shot's framing and depth.`);
  else if (lens && illustrated) out.push(`Rendering technique: ${lens}. Apply this exact illustration/rendering technique in every frame — it is the constant style DNA; never turn it into a photograph or name a camera or lens.`);
  if (palette)     out.push(`Color & palette: ${palette}. Hold this grade across every frame.`);
  if (grain)       out.push(`Grain & capture texture: ${grain}. Carry this exact grain and finish in every frame — it is part of the reference's look, matched from the attached reference, never cleaner or grainier than what the reference shows.`);
  if (environment) out.push(`Environment bias: ${environment}. Populate the surroundings with architecture, objects, textiles, light, and authentic atmosphere, and add people only when the brief calls for them.`);
  if (aspectRatio) out.push(`Target aspect ratio: ${aspectRatio}. The app applies this at render time, so keep every prompt shape-agnostic — do NOT write the ratio, frame shape, or orientation into the prompt (per the base rules).`);
  if (wardrobe)    out.push(`Wardrobe & styling: ${wardrobe}.`);
  if (extra)       out.push(`Additional direction: ${extra}`);

  return out.join('\n');
}

// ── tiny helpers ─────────────────────────────────────────────────────────────
const id = () => crypto.randomBytes(8).toString('hex');

// Anthropic + Gemini reject an image whose DECLARED media type doesn't match its bytes.
// Clients can mislabel (e.g. a JPEG tagged image/png), so sniff the real type from the
// base64 magic bytes and trust that over the declared mimeType.
function sniffImageMime(b64, fallback = 'image/jpeg') {
  try {
    const b = Buffer.from(String(b64 || '').slice(0, 32), 'base64');
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  } catch { /* fall through */ }
  return fallback || 'image/jpeg';
}
// Read pixel dimensions straight from an image buffer's header (JPEG/PNG/GIF/WebP) — no deps.
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };            // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }; // GIF
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf.toString('ascii', 8, 12) === 'WEBP') {          // WebP
    const fmt = buf.toString('ascii', 12, 16);
    try {
      if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') { const n = buf.readUInt32LE(21); return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff) }; }
      if (fmt === 'VP8X') return { w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
    } catch { return null; }
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {                                                                        // JPEG
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xFF) { o++; continue; }
      let m = buf[o + 1];
      while (m === 0xFF && o + 2 < buf.length) { o++; m = buf[o + 1]; }
      if (m === 0xDA || m === 0xD9) break;
      if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { o += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}
// Snap real dimensions to Flux Kontext's nearest supported aspect ratio (log-distance = perceptual).
const FLUX_AR = [['21:9', 21 / 9], ['16:9', 16 / 9], ['3:2', 1.5], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 3 / 4], ['2:3', 2 / 3], ['9:16', 9 / 16], ['9:21', 9 / 21]];
function nearestFluxAR(w, h) {
  const r = w / h; let best = '1:1', d = Infinity;
  for (const [label, val] of FLUX_AR) { const dd = Math.abs(Math.log(r / val)); if (dd < d) { d = dd; best = label; } }
  return best;
}
// GPT Image edit output size closest to the input's orientation (it otherwise defaults to square).
const gptSizeFor = (w, h) => { const r = w / h; return r > 1.15 ? '1536x1024' : (r < 0.87 ? '1024x1536' : '1024x1024'); };
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

// ── Marketing domain vs. the app ───────────────────────────────────────────────
// The public landing page is the ROOT of the marketing domain (shyow.io / www); the
// platform (app shell) is served on every OTHER host — app.shyow.io, the onrender URL,
// and localhost. Override the landing-host list with LANDING_HOSTS if the domain changes.
const LANDING_HOSTS = (process.env.LANDING_HOSTS || 'shyow.io,www.shyow.io')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isLandingHost = (req) => LANDING_HOSTS.includes((req.hostname || '').toLowerCase());
// On the marketing domain the root serves the landing page instead of the app shell.
app.get('/', (req, res, next) => (isLandingHost(req) ? res.sendFile(path.join(LANDING_DIR, 'index.html')) : next()));

// Never cache the app shell (index.html / app.js / styles.css) so UI updates always load.
app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));
// Public A.I-Duo landing page (marketing + portfolio) — served at /landing, no login.
app.use('/landing', express.static(LANDING_DIR));
// serve saved media. Local backend: static from disk. Drive backend: proxy the file's
// bytes from Drive by id (so <img>/<video src> just works, no token needed in the URL).
if (storage.backend === 'drive') {
  // Bounded in-memory cache for SMALL media (images) so repeat loads skip the Drive
  // round-trip. Files over CACHE_ITEM_MAX (e.g. videos) always stream and are never
  // buffered, so RAM stays safe; total is capped with simple LRU eviction.
  const mediaCache = new Map(); // fileId -> { buf, mimeType }
  let cacheBytes = 0;
  const CACHE_ITEM_MAX = 2.5 * 1024 * 1024;  // 2.5 MB per file
  const CACHE_TOTAL_MAX = 64 * 1024 * 1024;  // 64 MB total

  app.get('/media/:pid/:bucket/:file', async (req, res) => {
    const id = req.params.file;
    const hit = mediaCache.get(id);
    if (hit) {
      mediaCache.delete(id); mediaCache.set(id, hit); // bump LRU
      res.setHeader('Content-Type', hit.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.end(hit.buf);
    }
    try {
      const { stream, mimeType } = await storage.readFile(id);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      // Buffer alongside streaming so a small file can be cached without a 2nd fetch;
      // once it exceeds the per-item limit, drop the buffer and just keep streaming.
      let chunks = [], size = 0, cacheable = true;
      stream.on('data', (c) => {
        if (!cacheable) return;
        size += c.length;
        if (size > CACHE_ITEM_MAX) { cacheable = false; chunks = null; }
        else chunks.push(c);
      });
      stream.on('end', () => {
        if (cacheable && chunks) {
          const buf = Buffer.concat(chunks);
          mediaCache.set(id, { buf, mimeType }); cacheBytes += buf.length;
          while (cacheBytes > CACHE_TOTAL_MAX && mediaCache.size) {
            const [k, v] = mediaCache.entries().next().value;
            mediaCache.delete(k); cacheBytes -= v.buf.length;
          }
        }
      });
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
    hasFal: !!FAL_KEY,
    hasOpenai: !!OPENAI_API_KEY,
    authEnabled: authEnabled(),
    storage: storage.backend,
    data: data.backend,
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
  // ?light=1 skips the images subcollection (loaded lazily by the client) — fast project open.
  try { res.json(await (req.query.light ? data.getProjectLight(req.params.pid) : loadProject(req.params.pid))); }
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
    const system = `${kit ? kit + '\n\n' : ''}You are a visual-style analyst. Examine the attached reference image(s) and extract their VISUAL STYLE as a REUSABLE LOOK — structured data an AI image generator can apply to MANY future images. Focus on style and craft, NOT the identity of any specific person.

STEP 1 — IDENTIFY THE MEDIUM FIRST, because it changes how you describe everything. Is this a PHOTOGRAPH / cinematic film still (a real camera captured it), or a NON-photographic illustrated style — a storyboard or marker sketch, a line / ink / pencil / charcoal drawing, a digital or traditional painting, watercolour or gouache, a 3D / CGI render, cel or 2D animation, anime, comic / graphic-novel art, vector / flat design, or collage? An illustration was NEVER shot on a camera, so for one you must NOT invent a camera body, lens, focal length, Kelvin colour temperature, or photographic film grain — you describe its artistic medium and technique instead. Put this in the "medium" field and let it govern every other field.

Distinguish 2D from 3D carefully — this is the most common mistake: a hand-drawn or digital 2D image (illustration, storyboard, sketch, painting, comic, anime, marker / ink / pencil art) is FLAT — built from pen or brush strokes, outlines, and painted shapes, its shading DRAWN on (flat fills, cel blocks, cross-hatching, or painterly gradients), never lit in 3D. A 3D / CGI render has actual built geometry with volumetric lighting, ray-traced reflections, cast shadows with real depth, and rendered materials — it looks LIT and "built", not "drawn". If you see visible strokes, linework, outlines, flat or cel shading, or a painterly hand, it is a 2D ILLUSTRATION or PAINTING — do NOT call it "3D". Reserve "3D / CGI render" for genuine rendered geometry with real light behaviour; when unsure between 2D styles, prefer "illustration" or "digital painting".

MOST IMPORTANT — capture the transferable CINEMATOGRAPHY, not this one frame's scene. The user reuses this look across many different shots, subjects, scenes, TIMES OF DAY, and aspect ratios. So extract what makes the image beautiful as CRAFT — its color science, contrast and grade, how light is shaped and sculpts the subject, lens character, texture, finish, and composition tendencies — and describe each as a FAMILY or RANGE (its DNA), never the single locked value of this one frame. CRITICALLY, do NOT bake in the reference's circumstantial facts — its time of day, its light SOURCE, its specific LOCATION, or the subject's exact OUTFIT. If the reference was shot in daylight, that does NOT make this a daylight project: describe the lighting's character so it can be re-created at night, golden hour, or indoors, adapting the source to whatever the user later briefs. FOR A PHOTOGRAPH, you MUST name the specific real-world CAMERA BODY and LENS SERIES whose optical and colour character produce this look (e.g. "ARRI Alexa Mini LF with Cooke S4/i primes", "Sony Venice 2 with Zeiss Supremes", "RED V-Raptor with Zeiss Master Primes" — choose the one that genuinely matches, never a reflex default), paired with a focal-length RANGE (e.g. "~70–135mm-equivalent"): that rig is the CONSTANT look DNA, the focal length the per-shot variable. FOR A NON-PHOTOGRAPHIC image, do the OPPOSITE — never name a camera or lens; describe the ARTISTIC style faithfully — the medium and technique, the linework (weight, looseness, cross-hatching), the shading/rendering (flat, cel, painterly, soft-gradient, hatched), the colour handling, and the surface / paper / canvas / digital texture. The look must stay modular to the user's brief while preserving the reference's overall cinematography.

Return STRICT JSON only — no markdown, no commentary outside the JSON object — with exactly these string keys:
{"medium":"","look":"","lighting":"","lens":"","palette":"","grain":"","environment":"","aspectRatio":"","wardrobe":"","extra":""}
Guidance per key (describe the RANGE / FAMILY, not a single locked value):
- medium: what KIND of image this is and its rendering style — "Photograph / cinematic film still", or the specific non-photographic style ("Storyboard marker illustration", "Loose ink line drawing", "Painterly digital illustration", "Cel-shaded 3D render", "Watercolour", "Anime / cel animation", "Comic / graphic-novel art"). This governs all other fields.
- look: 2-6 word overall look/vibe — for a photo the cinematography look ("High-gloss beauty", "Moody cinematic noir"); for an illustration the art style ("Loose storyboard marker sketch", "Bold graphic-novel ink").
- lighting: the lighting CRAFT as a SCENE-ADAPTIVE approach — its quality (soft↔hard), contrast character, color saturation, how it shapes and separates the subject, and catchlight character — described so it can be re-created under ANY scene or time of day (the model adapts the actual source: sun, golden hour, window, night practicals, motivated "magic" light). Capture what makes the light beautiful, NOT the reference's time of day or source — do not weld in "daylight"/"sunlight"/"night" or a daylight-only Kelvin (e.g. "Bold, luminous key with strong directional shaping, punchy contrast holding clean rich shadows, bright catchlights — adaptable to any scene's light sources").
- lens: FOR A PHOTOGRAPH ONLY — commit to the specific real-world CAMERA BODY and LENS SERIES that best matches THIS image, then the focal-length RANGE, depth-of-field/bokeh feel, and any distortion/anamorphic character; NEVER a single focal length, NEVER reflexively default to one rig — DISCRIMINATE from what you actually see: warm, softer-contrast rendering with gentle highlight roll-off and creamy round bokeh points to Cooke S4/i or Panchro; clean, clinical, high-micro-contrast sharpness points to Zeiss Master Prime/Supreme or Leica Summilux-C; oval bokeh with horizontal flares and a squeezed frame is anamorphic (Cooke Anamorphic/i, Panavision C/E-series); huge gentle latitude with especially natural skin points to Sony Venice 2; crisp, punchy, ultra-detailed rendering points to RED V-Raptor; visible halation, grain, or gate-weave points to a 35mm or 16mm film body (e.g. "Sony Venice 2 with Zeiss Supreme primes — clean gentle latitude and natural skin; ~40–65mm-equivalent; smooth round bokeh, no distortion"). FOR A NON-PHOTOGRAPHIC image — do NOT name a camera or lens; set this to "n/a — [the rendering technique, e.g. loose marker linework with flat fills / soft painterly brushwork]".
- palette: the GRADE and colour science as a transferable family — the colour RELATIONSHIPS (warm/cool balance, complementary or analogous scheme), saturation level, contrast, and film-like treatment (separation, highlight roll-off) — NOT the specific objects' colours in this one frame (avoid "green grapes, magenta labels"; instead "high-saturation jewel-tone scheme, warm subject against cooler surroundings, filmic roll-off").
- grain: the CAPTURE or SURFACE texture and finish, read precisely and stated to MATCH exactly — a big reason the user attached the reference. For a PHOTOGRAPH: the grain / noise / halation (clean near-grainless digital ↔ fine natural film grain ↔ heavier coarse grain, plus any gate weave or highlight bloom; e.g. "fine natural 35mm film grain with gentle highlight halation"). For an ILLUSTRATION: the surface texture instead (paper tooth, canvas weave, visible marker or brush strokes, pencil tooth, clean vector edges, digital-brush texture). Never default to clean — match exactly what the reference shows, neither cleaner nor grainier.
- environment: by DEFAULT say the environment follows the brief, and capture only the transferable rendering approach — how backgrounds are graded, shaped, and handled for depth (bokeh / depth of field) — NOT the reference's specific location or time of day. Only record a concrete setting if the project is genuinely tied to one place. Don't lock the reference's exact scene (NOT "suburban garden with picket fence"; instead "environment follows the brief, backgrounds rendered in the look's palette as a soft shallow-DOF bokeh wash").
- aspectRatio: ALWAYS return "". Do NOT infer an aspect ratio from the reference's crop — the reference's frame shape is circumstantial, and aspect ratio is a per-shot choice the user sets at generation time. The look must never carry a frame shape.
- wardrobe: the styling APPROACH/aesthetic, not the one specific outfit from the reference — wardrobe follows each brief's subject (e.g. "tailored, minimal, muted-tone editorial styling"). Describe as style, not identity. Use "" if no subject.
- extra: 1-3 sentences of additional cinematography notes (composition tendencies, texture, grain, finish, mood) as transferable craft guidance, not frame-specific facts.
Describe only what you can actually see; do not invent. Keep values concise.`;

    const userContent = images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: sniffImageMime(img.data, img.mimeType), data: img.data },
    }));
    userContent.push({ type: 'text', text: 'Identify the medium, then analyze the visual style of the attached reference image(s), and return only the JSON object.' });

    const resp = await anthropic.messages.create({
      model: ANALYZE_MODEL,
      max_tokens: 2048,
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

    const FIELDS = ['medium', 'look', 'lighting', 'lens', 'palette', 'grain', 'environment', 'aspectRatio', 'wardrobe', 'extra'];
    const builder = {};
    for (const k of FIELDS) builder[k] = typeof parsed[k] === 'string' ? parsed[k].trim() : '';
    if (styleRef) builder.styleRef = { ...styleRef, url: `/media/${p.id}/uploads/${styleRef.file}` };

    res.json({ builder });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── Expenses (global): running Claude + Nano Banana cost, by month & week ──────
// Computed on read from existing data (NB exact per image, Claude estimated), cached
// briefly so opening the tab doesn't re-scan every project on each open.
let _usageCache = { at: 0, data: null };
app.get('/api/usage', async (req, res) => {
  try {
    const now = Date.now();
    // Cache 30 min — computeUsage reads EVERY project's subcollections (thousands of Firestore
    // reads), so a short TTL burns the free-tier daily read quota fast. Expenses move slowly;
    // add ?fresh=1 to force a recompute.
    if (!req.query.fresh && _usageCache.data && now - _usageCache.at < 30 * 60 * 1000) return res.json({ ..._usageCache.data, cached: true });
    const out = await computeUsage(data, CLAUDE_MODEL);
    _usageCache = { at: now, data: out };
    res.json(out);
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
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
    // Label each attached image ("Image 1:", "Image 2:", …) so the gem knows which one the
    // user means by "image 1" / "image 2" — essential for swaps/composites where direction
    // matters — instead of leaving it to infer from order.
    images.forEach((img, i) => {
      if (images.length > 1) userContent.push({ type: 'text', text: `Image ${i + 1}:` });
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: sniffImageMime(img.data, img.mimeType), data: img.data },
      });
    });
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
      // Cache the large (~8k-token) gem system prompt so it isn't re-processed and re-billed
      // on every message in a session (5-min TTL) — cuts time-to-first-token and cost.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

    // persist any attached images to disk so they survive reloads
    const savedImgs = [];
    for (const img of images) {
      savedImgs.push(await storage.saveUpload(p.id, img.data, img.mimeType));
    }

    // Append via a targeted chat-doc write (reads only THIS gem's chat doc, not the whole
    // project) — the old updateProject re-read every image doc twice per message.
    await data.appendChat(req.params.pid, gemId, [
      { role: 'user', content: userText || '(image)', hadImages: images.length > 0, images: savedImgs, at: Date.now() },
      { role: 'assistant', content: text, at: Date.now() },
    ]);

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
    const p = { id: req.params.pid };   // just the id — never read the whole project (all images) to generate

    const contents = [];
    const savedRefs = [];
    // Label each reference explicitly ("Image 1:", "Image 2:", …) so Nano Banana knows which
    // is which — critical for edits/swaps where the prompt says "the face from image 2" and
    // the direction matters (otherwise it has to guess the order).
    for (let i = 0; i < refImages.length; i++) {
      const r = refImages[i];
      if (refImages.length > 1) contents.push({ text: `Image ${i + 1}:` });
      contents.push({ inlineData: { mimeType: sniffImageMime(r.data, r.mimeType), data: r.data } });
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
    // Write each new image as its OWN Firestore doc (no full-project read/diff). Appending via
    // updateProject re-read the ENTIRE image library twice per call, so parallel "Send all"
    // generations fired thousands of reads at once and tripped the quota. Separate docs also
    // can't clobber each other, so the old write-lock isn't needed here.
    for (const rec of recs) await data.addImage(req.params.pid, rec);
    res.json({ images: saved, errors });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Upload finished images straight into a project's Library (e.g. a swap downloaded from ChatGPT).
// Not a generation — model:'upload' so the Expenses tracker skips it (no API cost). Stored full-res, as-is.
// body: { images:[{mimeType,data}], note? }
app.post('/api/projects/:pid/images/upload', async (req, res) => {
  try {
    const { images = [], note = '' } = req.body;
    if (!images.length) return res.status(400).json({ error: 'No image to upload.' });
    const pid = req.params.pid;
    const saved = [];
    for (const im of images) {
      if (!im?.data) continue;
      const mime = sniffImageMime(im.data, im.mimeType);
      const buf = Buffer.from(im.data, 'base64');
      const dim = imageSize(buf);
      const imgId = id();
      const { file: fname } = await storage.saveImage(pid, imgId, buf, mime);
      const rec = { id: imgId, prompt: note || 'Uploaded image', file: fname, createdAt: Date.now(), favorite: false, note: note || '', model: 'upload', size: dim ? `${dim.w}x${dim.h}` : null, refs: [] };
      await data.addImage(pid, rec);
      saved.push({ ...rec, url: `/media/${pid}/images/${fname}` });
    }
    if (!saved.length) return res.status(400).json({ error: 'No valid image data.' });
    res.json({ images: saved });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── SWAP / EDIT — faithful in-context editing that keeps image 1, unlike generative NB. ──
// Engines: GPT Image (OpenAI, DEFAULT — best at targeted "swap only this person" edits) and
// Flux Kontext (fal.ai). 2 images = full-character swap; 1 image + prompt = an edit. The user's
// own prompt always leads; the server wraps it with a preservation "enhancement".
// A/B (ab=true, GPT Image + swap): runs TWO enhancement strategies on the same prompt+images and
// returns both, so we can compare which wrapper produces better swaps.
// body: { prompt?, images:[{mimeType,data}], model?: 'gptimage'|'flux', ab?: bool }
app.post('/api/projects/:pid/swap', async (req, res) => {
  try {
    const { prompt, images = [], model = 'gptimage', ab = false } = req.body;
    if (!images.length) return res.status(400).json({ error: 'Attach at least image 1 (the base to edit).' });
    const pid = req.params.pid;
    const isSwap = images.length >= 2;
    const up = (prompt || '').trim();               // the user's own prompt — always the core
    if (!up && !isSwap) return res.status(400).json({ error: 'For a single-image adjustment, describe the change you want in the prompt.' });

    // Behind-the-scenes enhancement wrappers around the user's prompt (`up`). GPT Image follows
    // detailed instructions well, so A = concise / B = explicit are worth A/B-testing.
    const ENH = {
      gptA: `${up} — keep everyone else and the rest of the scene exactly as in the original: same faces, poses, positions, background, framing, and lighting. Photorealistic and seamless.`,
      gptB: `Edit the first image. ${up}. Bring that replacement person entirely from the second image — copy their face, hair, body, and full outfit and match their likeness exactly. Everyone and everything else in the first image must stay identical: the other people's faces, poses and positions, the background, props, camera framing, and lighting. Blend the new person in with matching light, perspective, scale, and grain so the result reads as one real, untouched photograph.`,
      // Flux Kontext wants SHORT, subject-described edits + a brief keep clause (BFL guide).
      flux: `${up}. Keep the other people, the composition, framing, background and lighting exactly the same.`,
    };

    // Image 1's true pixel size — every output is forced to match it exactly.
    const dim = imageSize(Buffer.from(images[0].data, 'base64'));

    // Engine calls return { buf, mime } and throw on failure (caught below).
    const runGpt = async (instruction) => {
      if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set. Add it to use GPT Image.');
      const form = new FormData();
      form.append('model', 'gpt-image-2');          // ChatGPT Images 2.0 — the model the web uses
      form.append('prompt', instruction);
      form.append('quality', 'high');
      form.append('size', 'auto');                  // gpt-image-2 natively matches the input's aspect
      images.forEach((im, i) => form.append('image[]', new Blob([Buffer.from(im.data, 'base64')], { type: sniffImageMime(im.data, im.mimeType) }), `image${i}.png`));
      const r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form });
      const out = await r.json().catch(() => ({}));
      const b64 = out?.data?.[0]?.b64_json;
      if (!r.ok || !b64) throw new Error(`GPT Image failed: ${out?.error?.message || JSON.stringify(out).slice(0, 200)}`);
      return { buf: Buffer.from(b64, 'base64'), mime: 'image/png' };
    };
    const runFlux = async (instruction) => {
      if (!FAL_KEY) throw new Error('FAL_KEY is not set. Add your fal.ai API key to enable Flux Kontext.');
      const image_urls = images.map(im => `data:${sniffImageMime(im.data, im.mimeType)};base64,${im.data}`);
      const body = { prompt: instruction, image_urls, safety_tolerance: '5' };
      if (dim) body.aspect_ratio = nearestFluxAR(dim.w, dim.h);   // hold image 1's shape
      const r = await fetch('https://fal.run/fal-ai/flux-pro/kontext/max/multi', {
        method: 'POST', headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.images?.length) throw new Error(`Flux Kontext failed: ${out.detail || out.error || JSON.stringify(out).slice(0, 200)}`);
      const first = out.images[0];
      return { buf: Buffer.from(await (await fetch(first.url)).arrayBuffer()), mime: first.content_type || 'image/jpeg' };
    };
    // Force the output to image 1's exact pixel dimensions.
    const fitExact = async ({ buf, mime }) => {
      if (!dim) return { buf, mime };
      try {
        const jimg = await Jimp.read(buf);
        if (jimg.width !== dim.w || jimg.height !== dim.h) {
          jimg.resize({ w: dim.w, h: dim.h });
          const outMime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
          return { buf: await jimg.getBuffer(outMime, outMime === 'image/jpeg' ? { quality: 92 } : undefined), mime: outMime };
        }
      } catch { /* keep the engine's own output if the resize fails */ }
      return { buf, mime };
    };
    const saveResult = async ({ buf, mime }, instruction, usedModel, note) => {
      const imgId = id();
      const { file: fname } = await storage.saveImage(pid, imgId, buf, mime);
      const rec = { id: imgId, prompt: instruction, file: fname, createdAt: Date.now(), favorite: false, note: note || '', model: usedModel, size: null, refs: [] };
      await data.addImage(pid, rec);
      return { ...rec, url: `/media/${pid}/images/${fname}` };
    };

    // A/B — two GPT Image enhancement strategies on the same prompt + images (swap only).
    if (model === 'gptimage' && ab && isSwap) {
      const [ra, rb] = await Promise.all([runGpt(ENH.gptA).then(fitExact), runGpt(ENH.gptB).then(fitExact)]);
      const a = await saveResult(ra, ENH.gptA, 'gpt-image-2', 'A/B · A (concise)');
      const b = await saveResult(rb, ENH.gptB, 'gpt-image-2', 'A/B · B (explicit)');
      return res.json({ images: [{ ...a, variant: 'A' }, { ...b, variant: 'B' }], ab: true });
    }

    // Single run.
    let instruction, usedModel, run;
    if (model === 'gptimage') {
      usedModel = 'gpt-image-2'; run = runGpt;
      instruction = isSwap ? ENH.gptB : `${up}. Keep everything else in the image exactly the same.`;
    } else {
      usedModel = 'flux-kontext-max'; run = runFlux;
      instruction = isSwap ? (up ? ENH.flux : 'Replace the person with the full character — face, body and clothing — from the other image. Keep the other people, the composition, framing, background and lighting exactly the same.') : `${up}. Keep everything else in the image exactly the same.`;
    }
    const saved = await saveResult(await fitExact(await run(instruction)), instruction, usedModel, '');
    res.json({ image: saved });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ── CHARACTERS — build a reusable, identity-locked reference sheet from actor photos ──
// The character-builder gem (Claude, vision) writes ONE Nano Banana prompt; Nano Banana Pro
// renders a single clean multi-view reference sheet (2K, landscape) with the uploaded photos
// as the identity source. Stored in its OWN `characters` collection — never mixed into the
// Library / Nano Banana outputs. Optional wardrobeImages are a CLOTHING-only role (face &
// look from `images`, garments from these). body: { name, notes?, images:[…], wardrobeImages?:[…] }
app.post('/api/projects/:pid/characters', async (req, res) => {
  if (!anthropic) return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set. Add it to your .env file.' });
  if (!genai) return res.status(400).json({ error: 'GEMINI_API_KEY is not set. Add it to your .env file.' });
  try {
    const { name, notes = '', images = [], wardrobeImages = [] } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Give the character a name.' });
    if (!images.length) return res.status(400).json({ error: 'Attach at least one clear photo of the person.' });
    const p = await loadProject(req.params.pid);

    // 1) The character-builder gem (Claude, vision) writes ONE Nano Banana prompt for the sheet.
    const gem = await fsp.readFile(path.join(GEMS_DIR, 'character-builder.txt'), 'utf8');
    const toImg = (img) => ({ type: 'image', source: { type: 'base64', media_type: sniffImageMime(img.data, img.mimeType), data: img.data } });
    const content = [{ type: 'text', text: `Photos of the person "${name.trim()}" — the identity source:` }, ...images.map(toImg)];
    if (wardrobeImages.length) {
      content.push({ type: 'text', text: 'Wardrobe / outfit reference(s) — the CLOTHING source only; take only the garments from these, never their body, face, or pose:' });
      content.push(...wardrobeImages.map(toImg));
    }
    content.push({ type: 'text', text: `Build a character reference sheet for "${name.trim()}".`
      + (wardrobeImages.length ? ' Dress them in the wardrobe shown in the wardrobe reference(s).' : '')
      + (notes.trim() ? `\nNotes / adjustments: ${notes.trim()}` : '') });
    const brief = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 1024, system: gem,
      messages: [{ role: 'user', content }],
    });
    const nbPrompt = brief.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!nbPrompt) return res.status(502).json({ error: 'The character builder returned no prompt — try clearer photos.' });

    // 2) Nano Banana Pro renders the reference sheet at 2K, landscape, with the source photos
    //    as the identity reference. 2K matters — a multi-view sheet spreads resolution across
    //    several figures, so 1K left each face too small to capture the likeness.
    const AR = '16:9';
    const toInline = (img) => ({ inlineData: { mimeType: sniffImageMime(img.data, img.mimeType), data: img.data } });
    // Label the two image roles so Nano Banana Pro binds identity vs wardrobe correctly —
    // unlabelled, it guesses from order and wardrobe faces/bodies can leak into the identity.
    const contents = [{ text: 'Identity reference photos (the person — copy face, bone structure, skin, hair, and build from these):' }, ...images.map(toInline)];
    if (wardrobeImages.length) {
      contents.push({ text: 'Wardrobe reference(s) (CLOTHING ONLY — take just the garments, never the body, face, or pose):' });
      contents.push(...wardrobeImages.map(toInline));
    }
    contents.push({ text: `${nbPrompt}\n\nCompose the sheet as a ${AR_WORDS[AR]} (${AR}) landscape image; recompose to fill the full frame rather than copying any reference photo's shape.` });
    let result;
    try {
      result = await genai.models.generateContent({
        model: NB_MODELS.pro, contents,
        config: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K', aspectRatio: AR } },
      });
    } catch (e) { return res.status(502).json({ error: `Nano Banana failed: ${e?.message || String(e)}` }); }
    const cand = result?.candidates?.[0];
    const parts = cand?.content?.parts || [];
    const imgPart = parts.find(pt => pt.inlineData);
    if (!imgPart) {
      const block = result?.promptFeedback?.blockReason;
      const finish = cand?.finishReason;
      const textPart = parts.find(pt => pt.text)?.text;
      const why = block ? `blocked by Gemini safety filter (${block})`
        : (finish && !['STOP', 'MAX_TOKENS'].includes(finish)) ? `no image (finishReason: ${finish})`
        : textPart ? `model returned text instead of an image: "${textPart.slice(0, 160)}"`
        : 'no image returned (empty response)';
      return res.status(502).json({ error: `No reference generated — ${why}` });
    }

    // 3) Persist the reference sheet (images bucket) + the source + wardrobe photos (kept with the character).
    const charId = id(), refId = id();
    const { file: refFile } = await storage.saveImage(p.id, refId, Buffer.from(imgPart.inlineData.data, 'base64'), imgPart.inlineData.mimeType);
    const saveAll = async (arr) => { const out = []; for (const img of arr) { const s = await storage.saveUpload(p.id, img.data, img.mimeType); out.push({ file: s.file, mimeType: s.mimeType }); } return out; };
    const sourceImages = await saveAll(images);
    const wardrobeSaved = await saveAll(wardrobeImages);
    const character = {
      id: charId, name: name.trim(), notes: notes.trim(), prompt: nbPrompt,
      reference: { id: refId, file: refFile, mimeType: imgPart.inlineData.mimeType || 'image/png', aspectRatio: AR },
      sourceImages, wardrobeImages: wardrobeSaved, createdAt: Date.now(),
    };
    await updateProject(req.params.pid, (proj) => {
      proj.characters = proj.characters || [];
      proj.characters.unshift(character);
      proj.updatedAt = Date.now();
    });
    res.json({ character });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// Delete a character + best-effort remove its reference + source files.
app.delete('/api/projects/:pid/characters/:charId', async (req, res) => {
  try {
    let removed = null;
    await updateProject(req.params.pid, (proj) => {
      const list = proj.characters || [];
      const i = list.findIndex(c => c.id === req.params.charId);
      if (i >= 0) { removed = list[i]; list.splice(i, 1); proj.updatedAt = Date.now(); }
    });
    if (removed) {
      const files = [removed.reference?.file, ...(removed.sourceImages || []).map(s => s.file)].filter(Boolean);
      for (const f of files) { try { await storage.deleteImage(req.params.pid, f); } catch { /* best-effort */ } }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
});

// ── image library management ───────────────────────────────────────────────────
app.get('/api/projects/:pid/images', async (req, res) => {
  try {
    const pid = req.params.pid;
    const images = await data.getImages(pid);   // reads ONLY the images subcollection
    res.json(images.map(im => ({ ...im, url: `/media/${pid}/images/${im.file}` })));
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
app.get('*', (req, res) => res.sendFile(path.join(isLandingHost(req) ? LANDING_DIR : PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  AI Video Studio running →  http://localhost:${PORT}\n`);
  if (!anthropic) console.log('  ⚠  ANTHROPIC_API_KEY missing — text gems disabled until set in .env');
  if (!genai) console.log('  ⚠  GEMINI_API_KEY missing — Nano Banana 2 disabled until set in .env');
  console.log(`  Claude model: ${CLAUDE_MODEL}   |   NB2 model: ${NB2_MODEL} @ ${NB2_IMAGE_SIZE}`);
  console.log(`  Data: ${data.backend}   |   Media storage: ${storage.backend}\n`);
  storage.warmUp?.(); // pre-warm the Drive client so the first media request isn't cold
});
