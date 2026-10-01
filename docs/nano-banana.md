# Nano Banana (Google Gemini image models)

_Verified 2026-07-09. Sources at bottom._

Two models in one family (Gemini image). The app calls them directly via the Gemini API.

| | Nano Banana 2 (NB2) | Nano Banana Pro |
|---|---|---|
| Model ID | `gemini-3.1-flash-image` | `gemini-3-pro-image` |
| Speed / cost | Fast, cheap | Slower, pricier |
| Best at | Quick edits, swaps, tweaks, iteration | Complex composites, lighting, legible text, hero shots |
| Resolutions | 1K / 2K / 4K | 1K (1024²) / 2K (2048²) / 4K (4096²) |
| Reference images | multi (fewer, simpler) | up to ~14 object refs · up to 5 people consistent (some API surfaces cap at 2/request) |
| Extras | — | Google Search grounding, stronger text rendering |

> Model IDs note: the old `-preview` IDs were retired mid-2026; the app uses the non-preview IDs above.

## When to use which — the real rule (learned, not marketing)
- **NB Pro reasons harder → it takes LIBERTIES.** It re-composes what it "thinks" looks best, which means it will **flip / re-orient / re-pose a subject** (e.g. turn a chair to face camera). Excellent for lighting, scale, and blending; risky when you need faithful preservation.
- **NB2 (Flash) is more LITERAL** → it keeps a subject's structure and orientation as-is.
- So: **faithful subject preservation → NB2. Sophisticated blend/lighting → Pro, but lock orientation** ("do not flip, mirror, rotate, or re-orient the subject; match image 2 exactly; only placement, scale, and lighting change").
- Iterate cheap/fast on NB2; finish a hero shot on Pro only if the blend needs it.

## Resolution matters
- Detail, texture, close-ups, and composites only pay off at **2K or 4K**. At 1K a re-frame or comp looks soft.
- The app currently renders at **1K** (`NB2_IMAGE_SIZE=1K` in `.env`) for both models — a resolution picker is planned.

## Reference-image handling (app)
- The app prefixes each attachment with `Image 1:` / `Image 2:` so the model knows which is which — critical for swaps and composites where direction matters. **Attach in the order your prompt refers to them** (for a swap: base first, face source second).
- **NB Frames' reference board** (`public/refboard.js`, the column beside its chat) sorts references by role — composition, location, one block per character, one per prop — and sends them first, in that order. Each carries its role as a label (`Image 3 — CHARACTER 1 "Maya" — this person's identity and wardrobe:`), to the gem and again to Nano Banana when a prompt is sent there; a composition reference is labelled even when it's the only image, or the model would take it for the image to edit. While the board doesn't change, follow-up messages keep the conversation (`keepHistory`).
- **Advisor & Tweaks → ▶ Try it here** runs a prompt inside its chat (Nano Banana for the NB advisor, GPT Image 2 for the GPT one) on the turn's attached image, in the source's shape. The options stay on the reply, beside the marked source; only the one kept becomes a Library image. Options never kept are still priced in Expenses.
- **Recipes:** every image keeps how it was made — prompt, references (with their roles), model, size, ratio, the gem and chat its prompt came from, and the version of the project's Tune for that gem (Tunes are versioned: `projects/{pid}/tunes/{gemId}@{v}`). The ⓘ on a card shows it; **Re-use** puts it back in Nano Banana or Swap to edit and run again.

## Prompting basics (full patterns in [playbook.md](playbook.md))
- Narrative sentences, not keyword lists. Name your subjects. State what to KEEP, then describe only the CHANGE. Use positive phrasing (describe what you want, not "no X").

Sources: [Google DeepMind — Nano Banana Pro](https://deepmind.google/models/gemini-image/pro/), [Google AI image pricing](https://ai.google.dev/gemini-api/docs/pricing), [fal.ai Gemini 3 Pro Image](https://fal.ai/models/fal-ai/gemini-3-pro-image-preview/edit).
