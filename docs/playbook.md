# Playbook — what actually works (our learnings)

_The gold: hard-won from real results in this studio. Each entry is a situation → what works → why.
Add to it whenever we discover something._

## Model choice: NB Pro vs NB2 for composites
- **NB Pro flips / re-orients subjects.** It reasons and "improves," so it turns a chair or a person to face the camera or the light. **NB2 keeps structure literally.** (Observed: placing a woman + armchair into a location — Pro flipped their direction, NB2 kept it.)
- Faithful placement → **NB2.** Sophisticated blend → **Pro + a hard orientation lock**: _"do NOT flip, mirror, rotate, or re-orient the woman / armchair; match image 2 exactly; only placement, scale, and lighting change."_
- Iterate on NB2 (cheap, literal); reach for Pro only when the blend looks pasted.

## Face swap
- **Go MINIMAL.** _"Replace the face in image 1 with the face from image 2. Keep everything else identical; blend it in naturally."_
- **Never** say _"match the new face's skin tone / lighting / angle to image 1"_ — that blends the transplant TOWARD image 1 and keeps the old face (the classic failure).
- Keep positional targeting minimal ("the woman on the left", no more). Run on **NB Pro** (holds swaps better than NB2). A single-person image 1 is the most reliable.

## Background replacement / composite (green screen OR a normal background)
- **A longer prompt is correct here** (the one edit where it is). Lock the subject, then spell out: replace the background with image 2's location; match perspective / camera / horizon; add contact shadows + ambient occlusion; wrap the scene's ambient light across the subject; clean edge spill. Photoreal, seamless.
- **Small-subject-in-huge-space** (scale illusion): make the subject small, place it precisely (e.g. centre of a spotlight), light it entirely by that source, and keep the rest of the location dim.

## Character reference sheet
- Build a **multi-view sheet on NB Pro at 2K** — NOT 1K. A 4-view sheet spreads pixels; at 1K each face is too small and likeness collapses (the "Danit came out awful" failure).
- Make view 1 a **large, dominant close-up**; every view must be an exact face match to the photos.
- Optional **wardrobe references**: take face/look from the person photos, clothes from a separate wardrobe upload.

## Photoreal skin / realism
- Capture from the reference: pores, vellus hair, subsurface scattering, wet reflective eyes, contact shadows, hair flyaways. **Match the reference's grain EXACTLY** (don't default to clean). **Never invent** marks (moles, scars, freckles) the reference doesn't have.

## Image numbering
- The app prefixes attachments `Image 1:` / `Image 2:` so the model knows which is which — otherwise it guesses from order and a swap can go the wrong way. Attach in the order the prompt refers to them (base first, source second).

## Kling prompts (the gems)
- The copyable code block = **only the ready-to-paste positive prompt**, ending in the mandatory suffix `, 8k, raw footage, high fidelity, cinema grade.` **No title, no Goal/Structure/Focus notes, and NO negative prompt** inside the block.
- Mode A = three single-shot archetype variations of ONE shot; Mode B = a numbered multi-shot sequence. Set by the app's toggle.

## Video prep for v2v (Kling input)
- Kling rejects any side > **2160 px**, and **non-square pixels** make a 2160-wide clip report as 2162 → also rejected.
- Fix (near-lossless, square pixels, safe margin under 2160):
  ```bash
  ffmpeg -y -i IN.mp4 \
    -vf "scale=2144:2144:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1" \
    -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -c:a copy OUT.mp4
  ```
  → 2144×1206, SAR 1:1, ~1–4 MB from a 4K source. Batch the whole folder with a `for` loop.

## Reference medium — the gem matches it (photo vs illustration)
- The analyzer + NB Frames gem are **medium-aware**. A photographic reference → camera body + lens + grade + grain (as before). A NON-photographic reference (storyboard, illustration, painting, 3D render, animation, comic, watercolour…) → the gem renders in THAT style (linework, shading, surface texture) and names **no camera or lens**.
- Before this, a storyboard illustration was analyzed as "Alexa Mini + Cooke lens." The tune panel now has a **Medium & style** field the analyzer fills; if it reads an illustrated medium, the frames come out illustrated, not photoreal.
- To deliberately turn a drawn reference into a photograph, set the **Medium** field to "Photograph / cinematic film still" by hand.

## Best model for a faithful character / face swap (NB is the wrong tool)
- Nano Banana is **generative** — it re-renders the whole frame, so it can never keep image 1 pixel-identical when swapping a character. This is inherent, not a prompt problem. NB2 drifts hard; NB Pro takes "creative" liberties.
- **Full character swap, keep the scene → Flux Kontext** (Black Forest Labs) — the leading in-context editor for "keep everything, change one thing"; preserves clothing/scene far better than NB. Via **fal.ai** (`fal-ai/flux-kontext`) or Replicate.
- **Face only, keep everything else → a dedicated face-swap model** (InsightFace / `inswapper`, ReActor) — operates on the real pixels (detect → swap the face → leave the rest untouched), so it's the most faithful to image 1. Face-only; weaker on stylized/extreme angles. Via fal.ai face-swap models or ReActor locally.
- **Full-body character swap → Higgsfield "Recast"** (higgsfield.ai). **Character consistency into new scenes → Ideogram Character** (the inverse need).
- App path: integrate Flux Kontext and/or a face-swap model via **fal.ai** (same aggregator the roadmap plans for Kling), as a dedicated "Swap" action — don't keep fighting NB for this. Verified via web benchmarks 2026-07-09.
- **Flux Kontext vs GPT Image 1.5 (`gpt-image-1`, ChatGPT's editor) — both are precise in-context editors, both beat NB decisively.** Flux Kontext wins preservation/consistency (~97% face / ~92% outfit retention, ~6% ahead on benchmarks) and is faster + cheaper; GPT Image 1.5 wins raw prompt-adherence (why it obeyed "keep everything, swap only the character" where NB didn't) but is slower + pricier and can drift on big changes. Decision for a production swap feature: **Flux Kontext** (best preservation + cost/speed + fal.ai-aligned); GPT Image 1.5 is the close premium fallback. User validated GPT Image on real content — A/B test Flux on the same image before committing. Verified 2026-07-09.

_Add new learnings here as we find them._
