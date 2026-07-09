# Pricing — every rate the studio pays

_Verified 2026-07-09. These match `server/usage.js` (the Expenses tracker) — update both together._

## Claude (Anthropic) — text / prompt calls
| Model | Input / 1M | Output / 1M |
|---|---|---|
| Haiku 4.5 (`claude-haiku-4-5`, what the app uses) | $1.00 | $5.00 |

Prompt caching (in use on the big NB Frames prompt): cache read ≈ $0.10/1M, cache write ≈ $1.25/1M.

## Nano Banana (Google) — per generated image
| Size | NB2 `gemini-3.1-flash-image` | Pro `gemini-3-pro-image` |
|---|---|---|
| 512 | $0.045 | $0.039 |
| 1K (1024²) | **$0.067** | $0.134 \* |
| 2K (2048²) | $0.101 | $0.134 |
| 4K (4096²) | $0.151 | $0.24 |

\* Pro "standard 1024" can bill at $0.039; the 1K–2K tier is $0.134. The app renders at **1K**.

## Kling video — per second (via fal.ai; not yet wired into the app)
| Tier | No audio | Audio | Voice control |
|---|---|---|---|
| Standard | ~$0.084/s | — | — |
| Pro (3.0) | $0.112/s | $0.168/s | $0.196/s |

## Where the money goes (as of 2026-07, ≈ $60 all-time)
- **Images are ~85% of spend** (~7¢ each at 1K). Claude prompts are ~1–2¢ each.
- Cost scales with **renders**, not chatting. Bumping to 2K ≈ $0.10/image, 4K ≈ $0.15.
- Live monthly split is in the in-app **💰 Expenses** tab (NB is exact per image; Claude is estimated).

Sources: [Google AI pricing](https://ai.google.dev/gemini-api/docs/pricing), [Anthropic pricing](https://www.anthropic.com/pricing), [fal.ai pricing](https://fal.ai/pricing).
