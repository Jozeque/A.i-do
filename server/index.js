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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'projects-data');
const GEMS_DIR = path.join(ROOT, 'gems');
const PUBLIC_DIR = path.join(ROOT, 'public');

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
  'nb-advisor': 'nb-advisor.txt',
};
async function readGem(gemId) {
  const file = GEM_FILES[gemId];
  if (!file) throw new Error('Unknown gem: ' + gemId);
  return fsp.readFile(path.join(GEMS_DIR, file), 'utf8');
}

// ── Per-project cinematography builder for NB Frames ─────────────────────────
// Structured fields the user fills per project; compiled into the gem override
// text that is appended to the base NB Frames gem at chat time.
function compileNbFramesDirection(b) {
  if (!b || typeof b !== 'object') return '';
  const lines = [];
  const add = (label, v) => { if (v && String(v).trim()) lines.push(`${label}: ${String(v).trim()}`); };
  add('PROJECT / CAMPAIGN', b.campaign);
  add('LOOK & VIBE', b.look);
  add('LIGHTING STYLE', b.lighting);
  add('LENS & CAMERA', b.lens);
  add('COLOR & PALETTE', b.palette);
  add('ENVIRONMENT BIAS', b.environment);
  if (b.aspectRatio && String(b.aspectRatio).trim()) {
    lines.push(`DEFAULT ASPECT RATIO: render in ${String(b.aspectRatio).trim()} unless the brief specifies otherwise`);
  }
  add('WARDROBE & STYLING', b.wardrobe);
  add('ADDITIONAL DIRECTION', b.extra);
  return lines.join('\n');
}

// ── tiny helpers ─────────────────────────────────────────────────────────────
const id = () => crypto.randomBytes(8).toString('hex');
const slug = (s) => (s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';

function projDir(pid) { return path.join(DATA_DIR, pid); }
function projMetaPath(pid) { return path.join(projDir(pid), 'project.json'); }
function imagesDir(pid) { return path.join(projDir(pid), 'images'); }
function uploadsDir(pid) { return path.join(projDir(pid), 'uploads'); }

// Persist a base64 image (chat attachment or generation reference) to the
// project's uploads/ folder so nothing that flows through the app is lost.
async function saveUpload(pid, b64, mimeType) {
  await fsp.mkdir(uploadsDir(pid), { recursive: true });
  const mt = mimeType || 'image/jpeg';
  const ext = mt.includes('png') ? 'png' : mt.includes('webp') ? 'webp' : mt.includes('gif') ? 'gif' : 'jpg';
  const fname = `${id()}.${ext}`;
  await fsp.writeFile(path.join(uploadsDir(pid), fname), Buffer.from(b64, 'base64'));
  return { file: fname, mimeType: mt };
}

async function loadProject(pid) {
  const raw = await fsp.readFile(projMetaPath(pid), 'utf8');
  return JSON.parse(raw);
}
async function saveProject(p) {
  await fsp.mkdir(projDir(p.id), { recursive: true });
  await fsp.writeFile(projMetaPath(p.id), JSON.stringify(p, null, 2));
}

// ── express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '60mb' }));
// Never cache the app shell (index.html / app.js / styles.css) so UI updates always load.
app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));
// serve saved images (these are immutable by filename — fine to cache)
app.use('/media', express.static(DATA_DIR));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// ── health / config ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    claudeModel: CLAUDE_MODEL,
    nb2Model: NB2_MODEL,
    nb2Size: NB2_IMAGE_SIZE,
    hasAnthropic: !!anthropic,
    hasGemini: !!genai,
  });
});

// ── PROJECTS ──────────────────────────────────────────────────────────────────
app.get('/api/projects', async (req, res) => {
  try {
    const entries = await fsp.readdir(DATA_DIR, { withFileTypes: true });
    const projects = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const p = await loadProject(e.name);
        const imageCount = (p.images || []).length;
        const chatCount = Object.values(p.chats || {}).reduce((n, arr) => n + (arr?.length || 0), 0);
        projects.push({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, imageCount, chatCount });
      } catch { /* skip */ }
    }
    projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json(projects);
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
      gemOverrides: { 'nb-frames': '', 'kling': '', 'nb-advisor': '' },
      // structured builder inputs (NB Frames) that compile into gemOverrides
      gemBuilders: { 'nb-frames': {} },
      chats: { 'nb-frames': [], 'kling': [], 'nb-advisor': [] },
      images: [], // {id, prompt, file, createdAt, favorite, note}
    };
    await fsp.mkdir(imagesDir(pid), { recursive: true });
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
    const p = await loadProject(req.params.pid);
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
    await saveProject(p);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:pid', async (req, res) => {
  try {
    await fsp.rm(projDir(req.params.pid), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── return effective gem prompt (default + project override) ───────────────────
app.get('/api/projects/:pid/gems/:gemId', async (req, res) => {
  try {
    const base = await readGem(req.params.gemId);
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

    const system = `You are a cinematography analyst. Examine the attached reference image(s) and extract their VISUAL STYLE as structured data, so an AI image generator can produce NEW images in the same look. Focus on style and craft, NOT the identity of any specific person. Return STRICT JSON only — no markdown, no commentary outside the JSON object — with exactly these string keys:
{"look":"","lighting":"","lens":"","palette":"","environment":"","aspectRatio":"","wardrobe":"","extra":""}
Guidance per key:
- look: 2-6 word overall look/vibe (e.g. "High-gloss beauty", "Moody cinematic noir").
- lighting: direction, quality, color temperature, contrast (e.g. "Soft clamshell key, ~5600K, low contrast, bright catchlights").
- lens: implied focal length feel, depth of field, bokeh, any distortion (e.g. "85mm-equivalent, shallow depth of field, creamy background bokeh").
- palette: dominant colors and grade (e.g. "Warm skin tones against a desaturated pastel background, filmic highlight roll-off").
- environment: the setting/background character (e.g. "Bright airy studio with a soft seamless backdrop").
- aspectRatio: choose the closest value from EXACTLY this list based on the image shape: "1:1","4:5","3:4","9:16","16:9","21:9". If unsure, use "".
- wardrobe: notable wardrobe/styling cues if a subject is present, described as style not identity (or "").
- extra: 1-3 sentences of additional cinematography notes (composition, texture, grain, finish, mood) not captured above.
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
    if (images[0]) styleRef = await saveUpload(p.id, images[0].data, images[0].mimeType);

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
    const base = await readGem(gemId);
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
      savedImgs.push(await saveUpload(p.id, img.data, img.mimeType));
    }

    // persist chat (including saved attachment references)
    p.chats[gemId] = p.chats[gemId] || [];
    p.chats[gemId].push({ role: 'user', content: userText || '(image)', hadImages: images.length > 0, images: savedImgs, at: Date.now() });
    p.chats[gemId].push({ role: 'assistant', content: text, at: Date.now() });
    p.updatedAt = Date.now();
    await saveProject(p);

    res.json({ text, images: savedImgs });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post('/api/projects/:pid/chat/clear', async (req, res) => {
  try {
    const p = await loadProject(req.params.pid);
    const { gemId } = req.body;
    if (gemId && p.chats[gemId]) p.chats[gemId] = [];
    p.updatedAt = Date.now();
    await saveProject(p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── NANO BANANA 2 — generate N images from one prompt ──────────────────────────
// body: { prompt, count=3, aspectRatio?, refImages?: [{mimeType, data}] }
app.post('/api/projects/:pid/generate', async (req, res) => {
  if (!genai) return res.status(400).json({ error: 'GEMINI_API_KEY is not set. Add it to your .env file.' });
  try {
    const { prompt, count = 3, aspectRatio, refImages = [] } = req.body;
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is empty.' });
    // Resolve the model from the UI toggle (allowlisted); fall back to the .env default.
    const model = NB_MODELS[req.body.model] || NB2_MODEL;
    const p = await loadProject(req.params.pid);
    await fsp.mkdir(imagesDir(p.id), { recursive: true });

    const contents = [];
    const savedRefs = [];
    for (const r of refImages) {
      contents.push({ inlineData: { mimeType: r.mimeType || 'image/jpeg', data: r.data } });
      savedRefs.push(await saveUpload(p.id, r.data, r.mimeType));
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
    const n = Math.min(Math.max(parseInt(count, 10) || 3, 1), 4);
    const jobs = Array.from({ length: n }, () =>
      genai.models.generateContent({
        model,
        contents,
        config: { responseModalities: ['IMAGE'], imageConfig },
      })
    );

    const settled = await Promise.allSettled(jobs);
    const saved = [];
    const errors = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled') { errors.push(s.reason?.message || String(s.reason)); continue; }
      const parts = s.value?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find(pt => pt.inlineData);
      if (!imgPart) { errors.push('No image returned in one generation.'); continue; }
      const buf = Buffer.from(imgPart.inlineData.data, 'base64');
      const ext = (imgPart.inlineData.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
      const imgId = id();
      const fname = `${imgId}.${ext}`;
      await fsp.writeFile(path.join(imagesDir(p.id), fname), buf);
      const rec = {
        id: imgId, prompt, file: fname, createdAt: Date.now(), favorite: false, note: '',
        aspectRatio: aspectRatio || null, size: NB2_IMAGE_SIZE, model,
        refs: savedRefs.map(r => ({ ...r, url: `/media/${p.id}/uploads/${r.file}` })),
      };
      p.images.unshift(rec);
      saved.push({ ...rec, url: `/media/${p.id}/images/${fname}` });
    }
    p.updatedAt = Date.now();
    await saveProject(p);

    if (saved.length === 0) return res.status(502).json({ error: 'No images generated.', details: errors });
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
    const p = await loadProject(req.params.pid);
    const im = p.images.find(x => x.id === req.params.imgId);
    if (!im) return res.status(404).json({ error: 'Image not found' });
    if (typeof req.body.favorite === 'boolean') im.favorite = req.body.favorite;
    if (typeof req.body.note === 'string') im.note = req.body.note;
    p.updatedAt = Date.now();
    await saveProject(p);
    res.json({ ...im, url: `/media/${p.id}/images/${im.file}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:pid/images/:imgId', async (req, res) => {
  try {
    const p = await loadProject(req.params.pid);
    const idx = p.images.findIndex(x => x.id === req.params.imgId);
    if (idx === -1) return res.status(404).json({ error: 'Image not found' });
    const [im] = p.images.splice(idx, 1);
    await fsp.rm(path.join(imagesDir(p.id), im.file), { force: true });
    p.updatedAt = Date.now();
    await saveProject(p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  AI Video Studio running →  http://localhost:${PORT}\n`);
  if (!anthropic) console.log('  ⚠  ANTHROPIC_API_KEY missing — text gems disabled until set in .env');
  if (!genai) console.log('  ⚠  GEMINI_API_KEY missing — Nano Banana 2 disabled until set in .env');
  console.log(`  Claude model: ${CLAUDE_MODEL}   |   NB2 model: ${NB2_MODEL} @ ${NB2_IMAGE_SIZE}\n`);
});
