# AI Video Studio

A local control room for your AI video production workflow. Three Claude-powered "gems" (prompt generators) plus a built-in Nano Banana 2 image generator, with per-project file management — all running on your own machine.

```
Project
 ├── NB Frames      → reference image + scene  →  3 cinematic Nano Banana 2 prompts
 ├── Kling          → still + desired motion   →  3 Kling 3.0 video prompts
 ├── NB Advisor     → image(s) + "change this" →  best NB2 edit prompt + rationale
 ├── Nano Banana 2  → paste a prompt           →  3 generated images (auto-saved)
 └── Library        → manage / favorite / download every render
```

The three gems run on **Claude Haiku 4.5** — the cheapest current Claude model ($1 / $5 per million tokens), which is more than enough for text prompt-writing. Image generation uses **Nano Banana 2** (`gemini-3.1-flash-image`, GA) — Google's newest image model, near-Pro quality at roughly half the cost. Per-project gem "direction" — including a guided **cinematography builder** on NB Frames — lets you tune the look and vibe for each campaign without touching the base instructions.

---

## Setup (one time)

You need [Node.js](https://nodejs.org) 18+ installed.

1. **Install dependencies** — open a terminal in this folder and run:
   ```bash
   npm install
   ```

2. **Add your API keys** — copy the example env file and fill it in:
   ```bash
   cp .env.example .env
   ```
   Then open `.env` and paste your two keys:
   - `ANTHROPIC_API_KEY` — from https://console.anthropic.com/settings/keys (powers the gems)
   - `GEMINI_API_KEY` — from https://aistudio.google.com/apikey (powers Nano Banana 2)

   You can run with just one key if you only need part of the app. Missing keys disable only the features that need them; the rest works.

---

## Run

```bash
npm start
```

Then open **http://localhost:4505** in your browser. (On Windows you can also double-click `start.bat`. On macOS/Linux, `./start.sh`.)

### Desktop launcher (Windows)

For an app-like experience, double-click **`AI Video Studio.vbs`** (or the **AI Video Studio** shortcut on your Desktop). It starts the server in the background and opens a chromeless app window (Edge/Chrome). If the server is already running it just opens the window. To shut the background server down, run **`Stop AI Video Studio.bat`** — it stops only this app's process (matched by its `--avs-launcher` marker), leaving any other Node apps untouched.

---

## How it works

**Projects** live in `projects-data/<project-id>/`. Each one holds its own chat history, gem direction, and an `images/` folder with every render. To back up or move a project, just copy its folder. To wipe one, delete it in the UI (or remove the folder).

**Gems** are plain-text instruction files in `gems/`:
- `nb-frames.txt` — the cinematic Nano Banana 2 frame architect (always returns 3 prompts)
- `kling.txt` — the Kling 3.0 motion prompter (3 archetypes: fidelity / physics / cinematic)
- `nb-advisor.txt` — the everyday NB2 editing advisor

Edit these files to change the base behavior for **all** projects. To tweak just one project, use the **⚙ Tune gem** panel inside that project — it appends project-specific direction (campaign vibe, aspect ratio, clinical-vs-warm tone, etc.) on top of the base gem.

**Sending prompts to the generator** — in the NB Frames or NB Advisor chat, every prompt card has a **⚡ Send to Nano Banana 2** button that drops it straight into the generator tab.

**Reference images** — attach them in the chat (the gem reads them) and/or in the generator's "Reference image(s)" slot (Nano Banana 2 uses them to lock identity/product/scene).

---

## Cost notes

- Gem messages: fractions of a cent each on Haiku 4.5.
- Images (Nano Banana 2 at 1K): roughly $0.06–0.07 each (about half the price of Nano Banana Pro, which is ~$0.134 at 1K/2K and ~$0.24 at 4K). Change `NB2_IMAGE_SIZE` in `.env` to `2K` or `4K` to trade cost for resolution. Generating 3 variations ≈ $0.20 at 1K.
- Nothing runs unless you press a button — there are no background calls.

---

## Working on this with Claude in the terminal

This folder is a normal Node project. Open it with Claude Code and you can iterate on the gems, the UI, or add features (e.g. a Kling API integration, batch generation, or export-to-CSV). Key files:

```
server/index.js     all API routes (projects, chat, generate, library)
gems/*.txt          the three system prompts
public/app.js       all frontend logic
public/styles.css   the studio theme
public/index.html   the shell
.env                your keys + model config
```

---

## Changing models

In `.env`:
- `CLAUDE_MODEL` — `claude-haiku-4-5` (default, cheapest). Bump to `claude-sonnet-4-6` if you want richer prose from the gems at higher cost.
- `NB2_MODEL` — `gemini-3.1-flash-image` (Nano Banana 2, default). For max fidelity / native 4K / best text rendering, use `gemini-3-pro-image` (Nano Banana Pro, ~2× cost). `gemini-2.5-flash-image` is the older, cheapest 1K-only option.
- `NB2_IMAGE_SIZE` — `1K` | `2K` | `4K`.
