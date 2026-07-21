# AI Video Studio — Cloud + Multi-User + Video Spec & Roadmap

_Date: 2026-06-16 · Owner: Yossi · Users: Yossi + Liran (2 total)_

This document is the spec we build against. Nothing here is built yet — it's for sign-off.

---

## 1. Executive summary

Two missions:

1. **Make this a real web app** — hosted, with login, with all data (text, images, videos) in the
   cloud, shared between exactly two people (Yossi + Liran), with the code on GitHub and
   auto-deployed.
2. **Pick the best Kling video API** to bring video generation _into_ the app (today the app only
   writes Kling _prompts_; you render them manually in OpenArt).

**Decisions reached from research (Mission 2):**

- ❌ **OpenArt cannot be integrated.** OpenArt has **no public API** (confirmed on their own Help
  Center) and their terms prohibit automated access. It stays a manual tool only. It is out as an
  integration target.
- ⚠️ **Kling's official API is real but has friction**, and — critically — **your annual Kling
  membership credits do NOT power it.** The official API bills through _separate prepaid developer
  "resource packages,"_ not your consumer subscription. Its docs are also geo/bot-blocked outside
  China (HTTP 446), which signals signup/region/business-verification friction.
- ✅ **Recommended (hybrid): keep rendering Kling 3.0 / Omni on your existing Kling subscription**
  (cheapest, flat-rate, and the full native Omni feature set — synced audio, lip-sync, multi-ref).
  The app **builds the prompts + source images and archives the finished videos** in your Drive, so
  the workspace is A-Z with **$0 per-call video cost**. A pay-as-you-go API (fal.ai / PiAPI /
  Kling-direct) stays **pre-wired behind a swappable adapter** as an optional future toggle — only
  worth flipping if a clean Kling 3.0 API ever undercuts your subscription for one-click final renders.

**Sequencing (your call):** Phase 1 = cloud + 2-user login on your Google Drive (prompts + images,
what works today). Phase 2 = in-app **video library + frictionless Kling handoff** (you render
3.0/Omni in Kling; the app stores and links the results — API generation optional, later).

_Workflow-automation ideas (one-click gem chaining, batch generate, etc.) are specced separately in
`WORKFLOW-AUTOMATION.md` — a prioritized backlog, explicitly **not** part of the current build._

---

## 2. Current state (what we actually have)

| Area | Today |
|---|---|
| App | Node + Express server, vanilla-JS frontend, no build step |
| Runs | `localhost:4505` only — not hosted |
| Storage | **Local disk** — `projects-data/<project>/{project.json, images/, uploads/}` |
| Auth | **None** — single local user |
| Providers | Claude (text gems), Gemini (Nano Banana 2/Pro images) |
| Video | **None in-app** — the "Kling" gem only writes text prompts you paste into OpenArt |
| Secrets | Real API keys sit in `.env` in the working folder |

**Implication:** both missions are genuine engineering, not config. And before anything goes to
GitHub/public, **the API keys currently in `.env` must be rotated and moved to host secrets** — they
must never be committed.

---

## 3. Provider research (Mission 2) — findings & decision

> Full method: 5 search angles, 20 sources fetched, 88 claims extracted, 25 adversarially
> verified (2-of-3 votes to kill a claim). Only confirmed numbers are quoted below.

### 3.1 OpenArt — DEAD END for integration
- **No public API.** OpenArt Help Center: _"No public API is available currently."_ Independent
  review (Fritz AI, Jan 2026): _"no API available, and their terms prohibit automated access."_
- Web-UI / subscription only (Free $0 → Wonder $240/mo; credits per generation).
- **Verdict:** can't be wired into the app. Keep using it manually if you like; it's not a build target.

### 3.2 Kling official API — real, but friction + separate billing
- ✅ Genuine key-authed REST API; current top model family is **Kling 3.0** (Feb 2026; succeeded
  1.6 / 2.0 / 2.1 / 2.5). _(Your brief said "2.5" — that's already a generation behind.)_
- 💳 Bills via **prepaid credit "resource packages,"** **no documented USD-per-call.** Failed
  generations don't bill.
- 🚩 **Billed entirely separately from consumer memberships** — so the **annual plan you're paying
  for "max credits" will not fund API calls.** Budget API spend on its own.
- 🌐 Official docs return **HTTP 446** (geo/anti-bot block) → friction for signup outside China;
  business verification likely (not confirmed, flagged as risk).
- Exact per-clip prices could not be confirmed from the source (client-rendered + 446). Indicative
  only (do **not** treat as quotes): ~6–12 credits/sec for 3.0; ≈ $0.90–1.00 per 10s pro clip.

### 3.3 Aggregators — same official Kling models, clean pay-as-you-go REST
Confirmed prices (vendor pages, June 2026):

| Provider | Model | 5s | 10s | Notes |
|---|---|---|---|---|
| **PiAPI** | Kling 2.1 **Standard** | **$0.26** | ~$0.46* | cheapest standard tier |
| **PiAPI** | Kling 2.1 **Pro** | **$0.46** | — | |
| **fal.ai** | Kling **2.5 Turbo Pro** (i2v) | **$0.35** | **$0.70** | $0.07/extra sec |
| **PiAPI** | Kling 2.1 **Master** | **$0.96** | — | |
| **fal.ai** | Kling **2.1 Master** (i2v) | **$1.40** | **$2.80** | $0.28/extra sec; premium fidelity |
| **Replicate** | official `kwaivgi/kling-v2.1` | — | — | runs Kuaishou's real backend; price not confirmed |

\*PiAPI Pro/Master rest on a single live fetch; only $0.26 Standard was independently re-confirmed.

- **fal.ai / Replicate** proxy the **official** Kling models (highest fidelity, simplest REST).
- **PiAPI** is cheapest at the standard tier.
- All are **pay-as-you-go, no prepaid commitment, no region block.**

### 3.4 Cost at your volume (~a few hundred clips/month, 5s image-to-video)

| Path | 200 clips/mo | 300 clips/mo |
|---|---|---|
| PiAPI 2.1 Standard ($0.26) | ~$52 | ~$78 |
| fal.ai 2.5 Turbo Pro ($0.35) | ~$70 | ~$105 |
| fal.ai 2.1 Master ($1.40) | ~$280 | ~$420 |

### 3.5 Recommendation — hybrid (render on your subscription, archive in-app)
Yossi mostly uses **Kling 3.0 / Omni** — the newest, top-tier models. That tilts the decision decisively:

- On any API, 3.0/Omni sit at the **most expensive** end, and a clean per-call price for them wasn't
  even confirmable (one cited "3.0 = $0.09/sec" figure failed verification). Aggregators may also
  expose only a **subset** of Omni's native controls (synced audio, lip-sync, multi-reference).
- The **Kling subscription already gives 3.0/Omni at flat rate with the full feature set** — and the
  workflow is **iteration-heavy** (many throwaways per keeper), which metered per-call pricing
  punishes hardest.

**So: render 3.0/Omni in Kling's own UI (cheapest + most capable), and make the app the place that
prepares the inputs and archives the outputs.** Keep a `videoProvider` adapter seam in the codebase so
an API path can be switched on later for one-click final renders **if** the economics ever flip. We do
**not** build or pay for API video now.

**Open items to confirm at Phase 2 kickoff:** exact Kling 3.0 price on fal.ai/Replicate; whether you
need 3.0 specifically vs 2.5 Turbo; whether any must-have feature forces Kling-direct.

---

## 4. Target architecture (Mission 1)

```
            GitHub (code + CI)  ──auto-deploy──►  Render (Node/Express app)
                                                      │
   Browser ──"Sign in with Google"──► Supabase Auth (allowlist: 2 emails)
       │                                              │
       │                                       Supabase Postgres  ← project/image/video METADATA
       │                                              │
       └──────────── media (images, videos) ──────────┴──►  Google Drive (your 2 TB)
                                                                ▲
   AI providers:  Claude (text) · Gemini (images) · fal.ai → Kling (video, Phase 2)
```

**Auth — "Sign in with Google", allowlisted to 2 emails.** Nobody but you and Liran can log in (so
nobody can burn your API credits). Google login is natural since the storage is Google Drive.

**Storage — your Google Drive 2 TB (ample; you're at ≤500 GB est., ~4× headroom).**
- All heavy files (images, videos, uploads) live in **one shared Drive folder** the app owns.
- To use _your 2 TB_ (consumer Google One), the app writes as the **owner Google account** via a
  stored OAuth token — files are owned by that account and count against its 2 TB, and the folder is
  **shared with Liran** so you both see everything in Drive directly.
- _Honest tradeoff:_ Drive is a file store, not a media CDN — fine for a 2-person internal tool at
  this volume. Storage sits behind a `storage` interface, so if Drive ever feels clunky we can swap
  to Cloudflare R2 / S3 with no app rewrite.

> **Update (2026-07-18) — public portfolio video moved to a CDN.** The Drive tradeoff bit
> exactly where predicted: the public landing page proxied every showcase video out of Drive
> through Render (no CDN, and the proxy had no HTTP-range support), so the portfolio was slow to
> load and videos were slow to start / couldn't scrub. **Showcase videos + poster thumbnails now
> live in Cloudflare R2** (`server/r2.js`, gated by the `R2_*` env vars) and stream straight from
> Cloudflare's edge — free egress, range built in. Posters are captured client-side at upload (a
> canvas frame → JPEG; no server ffmpeg) and the grid is now poster-first + lazy (`preload="none"`,
> src attached on hover) so it shows instant thumbnails and fetches no video bytes until you play.
> **Only the public showcase moved; generated images + uploads stay on Drive** (small, cached, and
> the point of the 2 TB). If `R2_*` is unset the app falls back to the Drive proxy unchanged.
> One-time move of already-uploaded clips: `scripts/migrate-showcase-to-r2.js`.

**Metadata — Supabase Postgres (free tier).** Project list, image/video records, prompts, favorites,
gem settings — moved out of `project.json` files into a real DB so two people can use it at once
without file conflicts. (Supabase also gives us the Google login, so it's one vendor for auth + DB.)

**Hosting — Render** (free tier, or $7/mo always-on). Pushes to GitHub `main` auto-deploy.

**GitHub — code + deploy only.** This is the right use of GitHub. **Media never goes in git.**

---

## 5. Phased plan

### Phase 0 — Foundations & safety (prereq, ~0.5 day)
- `git init`, push to a **private** GitHub repo; add `.gitignore` (exclude `.env`, `projects-data/`).
- **Rotate the API keys currently in `.env`** (they've been sitting in plaintext) and move all
  secrets to host env vars.
- Stand up Supabase project + Render service; wire GitHub → Render auto-deploy.
- **Deliverable:** the current app, unchanged in behavior, running at a private URL behind a Google
  login that only admits you + Liran.

### Phase 1 — Cloud + 2 users on your Drive (the chosen first step, ~2–4 days)
- Add Supabase Google auth + 2-email allowlist; gate all API routes.
- Replace local-disk storage:
  - metadata (`project.json`, image records, chats, gem settings) → Postgres tables;
  - media files (`images/`, `uploads/`) → shared Google Drive folder via the storage interface.
- One-time **migration** of your existing local projects/images into Drive + Postgres.
- **Deliverable:** you and Liran log in from anywhere, see the same projects, generate prompts +
  images, everything saved to your Drive. Full feature parity with today, but shared + cloud.

### Phase 2 — In-app video library + Kling handoff (~2–3 days, after Phase 1)
- New **Video** area in each project: from any generated image, one click to **copy its Kling prompt
  + download the source image**, ready to drop into Kling's UI (the handoff).
- A **drop-zone / upload** to bring the finished `.mp4` back in → saved to Drive + a record in
  Postgres, **linked to its project, prompt, and source image** → plays in a library, downloadable,
  favoritable, shared with Liran.
- `videoProvider` **adapter stub** in place (interface:
  `generate({model, image, prompt, duration, ratio}) → job → poll → mp4`) but **no API wired** — it's
  the seam we flip later.
- **Deliverable:** the full brief → prompt → image → **video archive** lives in one shared app; the
  only manual hop is render-in-Kling + drag-back, made as frictionless as possible. **$0 API spend.**

---

## 6. Cost summary

| Item | Cost |
|---|---|
| GitHub (private repo) | $0 |
| Render hosting | $0 (sleeps) or **$7/mo** always-on (recommended) |
| Supabase (auth + Postgres) | $0 (free tier; plenty for metadata) |
| Google Drive 2 TB | already paying (~$10/mo, sunk) |
| Claude + Gemini | usage-based (already paying) |
| **Kling video (Phase 2, hybrid)** | **$0 API — you render on your existing Kling subscription.** _(Optional API later: ~$0.35–1.40 per 5s clip, standard→master; 3.0/Omni higher & unconfirmed.)_ |
| **New fixed infra** | **≈ $0–7/mo** |

---

## 7. Risks & open questions
- **Kling-direct vs aggregator** — recommending fal.ai; confirm you're OK not using the official API
  initially (your annual membership credits don't apply to _any_ API path anyway).
- **Google Drive as app store** — sound for 2 users/medium volume; abstracted so it's swappable.
- **Service-account gotcha** — to bill against _your_ 2 TB we must act as the owner Google account
  (OAuth), not a service account (which has its own tiny quota). Handled in Phase 1.
- **Exact Kling 3.0 / Replicate prices** — unconfirmed; resolve at Phase 2 kickoff.
- **Key rotation** — the keys in `.env` should be considered compromised once code goes to GitHub;
  rotate in Phase 0.

---

## 8. What I need from you to start
1. **Approve this plan** (and the fal.ai recommendation, or tell me to go Kling-direct).
2. A **GitHub account** to own the private repo (or confirm I should set up the repo locally first).
3. The **Google account** that holds the 2 TB (it becomes the storage owner) + **Liran's email**
   (for the allowlist + folder share).
4. Willingness to create **free Render + Supabase** accounts (I'll script/guide every step).
5. For Phase 2 later: a **fal.ai** account + API key.
