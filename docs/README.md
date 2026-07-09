# AI Video Studio — Tool Docs

Quick-reference sheets for the models and tools this studio uses, so answers don't rely on
drifting training memory. Every fact here is dated and sourced.

**How to use:** When a question comes up about a tool's capability, limit, price, or the best
way to prompt it — check the matching file first. If a fact is older than ~2 months, re-verify
(these tools change monthly).

## Files
- **[nano-banana.md](nano-banana.md)** — Nano Banana 2 (Flash) vs Pro: when to use each, resolutions, reference handling.
- **[kling.md](kling.md)** — Kling video (image-to-video, video-to-video): versions, limits, input prep, fal.ai access.
- **[pricing.md](pricing.md)** — exact per-image / per-token / per-second rates (kept in sync with the Expenses tracker).
- **[playbook.md](playbook.md)** — our own hard-won learnings: what actually works for swaps, composites, characters, video prep, model choice.

## What the app actually uses (as of 2026-07)
| Role | Model | Where |
|---|---|---|
| Frame / image generation | `gemini-3.1-flash-image` (NB2) @ 1K · `gemini-3-pro-image` (NB Pro) | Nano Banana 2 tab |
| Prompt writing (all gems) | `claude-haiku-4-5` | every chat tab |
| Kling motion prompts | Claude gem → paste into Kling / OpenArt | Kling tab (prompt-only, no API yet) |

Kling video *generation* is roadmap Phase 2 (via fal.ai). Today the app only **writes** Kling prompts.

_Last updated: 2026-07-09._
