# Kling (Kuaishou) — AI video

_Verified 2026-07-09. Sources at bottom._

Used for turning frames / references into motion. **The app does NOT call Kling's API yet** —
today it only writes Kling *prompts* (the Kling + Kling Advisor gems) that you paste into
Kling's own UI or OpenArt. API-driven generation is roadmap Phase 2, via **fal.ai**.

## Versions (2026)
- **Kling 2.6** (released 2025-12-03) and **Kling 3.0 (VIDEO 3.0)** are current. **O3 (3.0 Omni)** = multi-shot storyboarding + native audio.
- Each ships in **Standard** (faster / cheaper) and **Pro** (higher quality, longer inference) tiers.

## What it does
- **Image-to-video** — upload a frame + prompt → animated clip.
- **Video-to-video** — replicate motion from a reference video (this is what the `shots for v2v` clips are for).
- **Motion brush** (animate specific areas), **first / last-frame** control (chain clips into longer scenes).
- **Elements** — combine up to **4 reference images** for character consistency across scenes.
- **Native audio + lip-sync** (3.0).

## Limits
- Up to **1080p @ 48 fps**, **10 s** max clip (15 s on 3.0). Latest models output native **4K** (generated, not upscaled).
- **Input video for v2v: each side ≤ 2160 px** — 4K (3840×2160) is rejected. It also needs **square pixels (SAR 1:1)**, or a 2160-wide clip reports as 2162 and is rejected. Fix in [playbook.md → Video prep for v2v](playbook.md).

## Character reference behaviour
- Kling "Elements" preserves a character's **face/identity**, not necessarily the **wardrobe** from a single input frame. If a specific outfit matters, feed it explicitly (dedicated wardrobe reference) rather than assuming it carries from one frame.

## Access / billing
- Kling **membership credits and the Kling API bill separately** — a paid Kling web plan does NOT include API calls.
- **OpenArt has no public API.** For programmatic Kling, use the **fal.ai** aggregator.
- fal.ai Kling pricing (per second of output): **Standard ≈ $0.084/s**, **Pro ≈ $0.112/s** (audio off). Kling **3.0 Pro**: $0.112/s (no audio) → **$0.168/s** (audio) → **$0.196/s** (voice control). Roughly 3× cheaper than Sora 2, ~10× cheaper than Veo 3.1 per second.

Sources: [kling.ai](https://kling.ai/), [fal.ai — Kling 3.0](https://fal.ai/kling-3), [fal.ai pricing](https://fal.ai/pricing), 2026 Kling guides.
