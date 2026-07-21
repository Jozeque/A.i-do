# SHYOW — Wordmark

The **Threefold Y** wordmark: **SHYOW** set in a thin monoline construction, with a
custom **Y** built from paired lines on three directions (two upper branches + lower
stem) converging at a clean centre. The Y is the only symbolic element.

All artwork is true vector — pure filled paths, **no fonts and no raster** — so it scales
and opens cleanly in Illustrator, Figma, Affinity and browsers.

## Master
- `shyow-wordmark-master.svg` — `viewBox="0 0 1200 260"`, outlined filled paths.
- `build-logo.mjs` — editable source. Regenerate everything with `node brand/build-logo.mjs`
  (requires the project's `sharp`). Adjust geometry there, never by editing the SVGs by hand.

## Colour versions (transparent SVG)
| File | Colour | Use on |
|---|---|---|
| `shyow-wordmark-primary-ivory.svg` | `#F1EDE4` ivory | dark / black backgrounds (primary) |
| `shyow-wordmark-white.svg` | `#FFFFFF` | maximum contrast |
| `shyow-wordmark-dark.svg` | `#0A0A0B` | warm-white / light backgrounds |
| `shyow-wordmark-black.svg` | `#000000` | universal print |

Single colour only — never gradients or multiple colours inside the mark.

## Raster exports (transparent PNG, sRGB)
- Ivory: `…-primary-ivory-{4096,2048,1024,512}.png`
- Dark:  `…-dark-{4096,2048,1024,512}.png`
- Widths → heights: 4096→887, 2048→444, 1024→222, 512→111 (identical 1200:260 ratio).
- `shyow-wordmark-preview-dark-background.png` — 2400×920, ivory on `#0A0A0B`, padded.

## Clear space
Minimum clear space on **every** side = **4 × the H stem width**.
The H stem is **7 units** in the master viewBox → **28 units** of clear space all around.
Keep other elements, type and edges outside that margin.

## Minimum size
- Digital: **160 px** wide minimum.
- Print: **30 mm** wide minimum.

The Y's paired-line slot is 10 units (≈0.8 % of width); below ~180 px it goes sub-pixel and
the Y reads as a single solid form (still legible). If the mark must appear smaller than that
as a recognisable detail, produce a dedicated small-size Y with a wider slot — **do not**
alter the master.

## Don't
No shadows, glows, gradients, outlines, rotation, added texture, or recolouring inside the mark.
