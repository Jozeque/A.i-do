# AI Video Studio — Workflow & Automation Spec (Backlog)

_Date: 2026-06-16 · Status: **BACKLOG / SPEC ONLY — not part of the current build.**_

> The current build is the cloud + 2-user + Drive upgrade in `ROADMAP.md` (Phases 0–2). Everything in
> this doc is the **next wave** — the "make the workflow automated and easier" ideas — captured now so
> we build Phase 1's data model in a way that makes them cheap to add later. Nothing here ships until
> we agree to start it.

---

## 1. The goal

Kill the copy-paste shuffle between tabs. Today, getting from an idea to image variations means manually
ferrying text and images across NB Advisor → NB Frames → the Generator. The aim is a **connected
pipeline**: each tool can hand its output to the next in **one click**, references travel automatically,
and the iteration-heavy steps are fast.

Yossi's seed idea (verbatim intent): _"advise with NB Advisor → one click sends the result to NB Frames
→ one click straight to the Generator for a few variations — instead of copy-pasting between tabs."_

---

## 2. The canonical pipeline

```
        ┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
 brief─►│ NB Advisor  │────►│  NB Frames  │────►│  Generator   │────►│ Kling handoff   │──► Video
        │ (edit/      │ send│ (3 cinematic│ send│ (N image     │ send│ (prompt+image   │    library
        │  direction) │  to │  prompts)   │  to │  variations) │  to │  → Kling UI)    │    (Drive)
        └─────────────┘     └─────────────┘     └──────────────┘     └─────────────────┘
              ▲                                        │
              └───────────── "iterate" ◄───────────────┘   (any image can loop back to Advisor/Frames/Kling)
```

Every node produces an artifact (advice, prompt, image, video) that the next node can consume. The
automation layer is just **"Send to →" actions + a pipeline runner** on top of that graph.

---

## 3. Feature backlog (prioritized)

### P1 — "Send to" chaining (Yossi's core idea)
- **`Send to →` on every output.** Each gem result and each image gets a contextual menu:
  - NB Advisor result → **Send to NB Frames** (prefills the brief/direction) · **Send to Generator** (use the edit prompt directly).
  - NB Frames prompt (each of the 3) → **Send to Generator** (one click → N variations) · **Send to Kling**.
  - Generated image → **Send to NB Advisor** (iterate) · **Send to Kling** (animate) · **Send to NB Frames** (re-style).
- **Reference carry-through.** The source/reference image rides along the chain automatically — no
  re-attaching at each step. (The app already half-does this Generator-side; generalize it.)
- **"Generate all 3" from NB Frames.** One click turns the three prompts into 3 × N image variations
  in a single contender grid, instead of running each prompt by hand.

### P2 — Faster iteration & reuse
- **Compare / cull grid.** A focused view to eyeball a batch and keep/kill fast (★ / ✕ / send-to),
  built for high-throughput selection — the bottleneck in an iteration-heavy workflow.
- **Presets / templates.** Save a project's gem builder + model/aspect settings as a reusable preset;
  new projects start from a template instead of blank.
- **Bulk library actions.** Multi-select images → favorite / delete / export / send-to in one go.
- **Per-step defaults.** Remember count, aspect ratio, and model tier per gem so each step is one click.

### P3 — Full automation & power-user flow
- **Auto-pilot macro.** Run the whole chain (Advisor → Frames → Generate N) from a single brief with
  sensible defaults; show each intermediate result; let the user step in at any node.
- **Lineage / versioning.** Record every hop so each artifact knows its parents (brief→advice→prompt→
  image→video). Enables "fork from here," "what prompt made this image," and a visual history.
- **Keyboard-driven iteration.** Hotkeys for send / generate / favorite / next to blitz through batches.
- **Long-job notifications.** When async work finishes (e.g. a future API video render), notify in-app.

---

## 4. How Phase 1 sets this up (build-now implications)

We don't build automation now, but Phase 1's **data model should be lineage-ready** so P1/P3 are cheap
later. Concretely, when we move metadata into Postgres (Phase 1):
- Give every artifact a stable id and an optional **`parent_id` + `source` (gem/step)** field, so a
  "Send to" action just creates a child record pointing at its parent. That single decision unlocks
  most of P1 and all of P3's lineage with no rework.
- Keep prompts as first-class records (not just chat text), so "Send to Generator" references a prompt
  id rather than re-parsing text.
- The `storage` and `videoProvider` seams from `ROADMAP.md` already make the Generator/Kling ends of
  the pipeline swappable.

---

## 5. Explicitly OUT of scope for the current build
- No "Send to" chaining, batch-generate, compare grid, presets, auto-pilot, lineage UI, or hotkeys yet.
- Current build = cloud hosting + 2-user Google login + Drive storage + Postgres metadata + the Phase 2
  video library/handoff, per `ROADMAP.md`.
- We revisit this doc and pick a P1 slice **after** Phase 1 is live.
