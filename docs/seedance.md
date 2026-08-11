# Seedance (ByteDance) on OpenArt — video generation via reference-driven prompts

_Verified 2026-08-11 against OpenArt's Seedance 2.0 Handbook + model pages and ByteDance's official
Seedance 2.5 prompt guide (via Segmind's annotated copy). Re-verify after ~2 months._

## Versions on OpenArt

| | Seedance 2.5 (newest) | Seedance 2.0 |
|---|---|---|
| Max clip length | **30s** single pass | **15s** (extend past it via Extend) |
| Reference files | **50 total** — 30 images (<4K each) · 10 videos (≤30s combined) · 10 audio (≤30s combined) | **12 total** — 9 images · 3 videos (≤15s combined) · 3 audio (≤15s combined) |
| Aspect ratios | 1:1, 3:4, 4:3, 16:9, 21:9, 9:16 | same family |
| Audio | native, co-generated in the same pass (music/SFX/dialogue, lip sync) | native audio + lip sync |
| Extras | ~20% better prompt adherence, region-level editing, faster | — |

Both take text + tagged references ("All-in-One Reference") or a **first-frame image** (then the
aspect ratio is LOCKED to that image). Editing an existing video locks BOTH ratio and duration
(±0.3s) to the input; extension locks ratio but the added duration is free. Generate in the target
format from the start — you cannot reframe later.

## The @-tag reference system

Upload files, then tag them inline in the prompt: type `@` in OpenArt's prompt box and pick the
file — tags are per-file (`@image1`, `@video2`, `@audio1`-style), numbered by upload order. Tell
the model what each reference is FOR, and also what NOT to take from it:

- "Exact face and identity from @image1 — appearance only, not its background."
- "Use the composition from @image2. Do not use its sky or the parked cars."
- "Match the camera movement and pacing of @video1 — camera reference only, no content."
- "@image3 is a style and color-grade reference ONLY — match its film stock, grade, and
  lighting; take no character, object, or location from it."

Multi-element compositing works: "the face from @image1, the overalls from @image3, the shirt
from @image4." Stability sweet spot is **1–8 distinct subjects** per generation; it degrades above.

## Official ByteDance prompt formula (order matters)

**Subject + Action** (required) → Scene/Environment → Visual style → Camera work/cuts → Audio.
Fill only the slots you care about — 2–3 dense sentences is the sweet spot for a simple shot.

### Audio & text routing brackets (2.5 grammar)

| Bracket | Routes | Example |
|---|---|---|
| `( )` | music / ambient bed | `(low cello drone)` |
| `< >` | sound effects | `<door latch, rain on glass>` |
| `{ }` | spoken dialogue | `He whispers in English: {We should go.}` |
| `【 】` | on-screen subtitles | `【We should go.】` |

Dialogue and subtitles are separate channels — declare language and delivery OUTSIDE the braces,
and repeat the line in `【 】` only if you want burned-in text. On 2.0 use plain prose sound
direction + a trailing "SFX only: …" list instead (the bracket grammar is 2.5's).

### 30-second clips (2.5): staged structure

```
[Generation Goal] video type + central event.
[Stage 1] initial state → primary event → end state.
[Stage 2] continues from that end state → new event → new end state.
[Stage 3] closing event → final state.
[Maintain Consistency] what must never change across stages.
```
One main change and one clear end state per stage.

## Techniques that matter (from OpenArt's own handbook)

- **Transcript trick (lip sync):** when tagging an audio file for lip sync, ALSO write the spoken
  words in the prompt. Omitting the transcript measurably garbles speech.
- **Duration matching:** set the clip duration to the audio file's real length, or timing stretches.
- **Voice cloning:** upload ~15s of the voice, tag it as a VOICE reference (not lip sync), write the
  new dialogue in the prompt + pacing notes. Pacing direction matters as much as the sample.
- **Performance direction:** "says it excitedly," "whispers nervously" — steers body language too.
- **Video+audio conflict:** a reference video's own audio BEATS a separately tagged audio file.
  Strip the video's audio before upload if your music/VO must win.
- **Single takes:** open with "continuous single take," describe the camera path, close with
  "no cuts, seamless transition, cinematic, high definition."
- **Anti-morph guardrails:** "no morphing, no ghosting, no camera cuts" when scenes drift.
- **Motion transfer:** tag a video and take only its motion/camera language for new content.
- **Storyboard animation:** upload a comic-panel grid; the model animates panel-to-panel — but
  spell out the narrative order in words, and add "no captions on screen."
- **Camera language it knows:** tracking shot, crane shot, whip pan, genre framing ("neo-noir
  thriller," "gritty war film").
- **Extend / Edit:** extend forward or backward past the cap by describing the added beat; edit an
  existing clip by stating what's there and what changes.

## The look-lock workflow (keeping one look across a whole film)

Two layers, both needed:

1. **A locked TECHNICAL block** repeated verbatim in every prompt — film stock + grade + finish
   ("Kodak 500T film grain, organic color, soft contrast, filmic look. NO CGI."), duration, ratio,
   shot/cut count ("exactly N shots and N−1 cuts"), and sound policy. This is most of what makes
   every generation come out matched.
2. **A style reference asset** — one graded still (or short clip) uploaded with EVERY generation
   and tagged as style/grade reference ONLY. Assets (sheets, plates) generated in the same look
   reinforce it further.

Position locks keep geography stable across cuts: name an establishing reference as "exact parked
position and orientation lock," pin characters to spots ("this stop-line position is locked for the
rest of the video; she never moves from it"), and give reflective surfaces explicit rules.

## In this app

- **Assets tab** builds the reference sheets (NB Pro 2K): characters, vehicles, products, props,
  location plates, look frames — each with an `@tag` name.
- **Seedance tab** (Claude gem → paste into OpenArt) writes the full three-block prompt —
  REFERENCE DEFINITIONS / TECHNICAL / PROMPT — with `@imageN` tags matching a stated upload order.
- **Seedance ⚙ Tune gem** works like NB Frames' tune: attach a graded look frame → Analyze reads it
  into structured VIDEO look fields (locked film/style line, grade, lighting, lens family, movement
  energy) → compiled into the project direction the gem folds into every TECHNICAL block.
- OpenArt field limits: no per-shot character cap seen so far (unlike Kling multi-shot's 512).
  If OpenArt ever truncates, measure and enforce in code like `capKlingShots()` — not in the gem.

Sources: openart.ai/blog/seedance-2-0-handbook · openart.ai/ai-model/seedance-2-5 ·
blog.segmind.com "The Official Seedance 2.5 Prompt Guide" · higgsfield.ai/blog/ai-car-commercial-youtube-guide
