# Arena — streamer vs streamer

The **Arena** tab (`/arena`) turns the analytics and AI data OpenVibe.Live already keeps about every streamer into a fighting-game roster: a ranked leaderboard, a character-select profile per streamer, live head-to-head matchups, and daily battles that the crowd finishes with a vote.

Everything is opt-in on the AI side — with AI off the tab still works from stats alone (templated lore and commentary, avatar cards instead of portraits).

## What each streamer gets

| Piece | Source | Cost |
|---|---|---|
| **Ratings** — HYPE, GRIND, CHAT, LOYALTY, CLUTCH, VIBE (40–99) and overall **POWER** | `streams` + `stream_analytics` (last 90 days), `follows`, `transactions` (tips). Each rating is the streamer's *percentile* on that metric across the active roster (streamed in the last 45 days), so a 99 means "best on the site", never an absolute number. | none |
| **Persona** — fighter name, title, class, element, signature move, special, weakness, taunt, lore, catchphrase, entrance music, a quip per stat | AI (`summary` role) from the streamer's AI overview, stream memories, chat-AI notes, recent VOD titles/overviews and the numbers. Cached 24 h. | ~1 LLM call / streamer / day |
| **Portrait** — stylised character-select art | AI image model (OpenAI-compatible `/images/generations`). The prompt is built from the persona, category, profile colour and a *scene* description of the latest thumbnail (setting, objects, mood — the vision model is told never to describe faces or identity). It is deliberately **not a likeness** of the person. Cached 7 days. | 1 image / streamer / week, only when enabled |
| **Record** — W–L | `arena_battles` | none |

## Battles

`/arena/battle/<a>/<b>` — the same pair on the same day always gets the same four rounds (Hype Check, Chat War, Endurance, Clutch Time), simulated from the ratings with a seeded random so the underdog sometimes lands an upset. The **crowd vote** is the fifth round: one vote per user (per IP when anonymous), changeable until midnight UTC, and it breaks 2–2 ties (Power breaks a tie with no votes). The announcer commentary is AI (`chat` role, cached per battle) with a templated fallback.

Live streamers are paired by neighbouring Power on the leaderboard ("Live battles"), with their live thumbnails, refreshed every 30 s.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/arena/fighters` | leaderboard |
| GET | `/api/arena/fighters/:username` | full card; generates a stale persona synchronously and kicks off a portrait in the background (`image_pending`) |
| POST | `/api/arena/fighters/:username/refresh` | admin — regenerate persona (+ portrait unless `{ "image": false }`) |
| GET | `/api/arena/battle/:a/:b` | today's battle (created on first view); `?generate=0` skips AI |
| POST | `/api/arena/battle/:a/:b/vote` | `{ "side": "a" \| "b" }` |
| GET | `/api/arena/live` | live matchups |
| GET | `/api/arena/status` | roster size, AI / image-generation state, counts |

## Settings (site settings, admin → Settings)

| Key | Default | Effect |
|---|---|---|
| `arena_enabled` | `true` | `false` hides the API (404) — the nav link should be removed too |
| `ai_image_enabled` | `false` | allow portrait generation (needs AI enabled + an OpenAI-shaped provider) |
| `ai_image_model` | `gpt-image-1` | image model; `dall-e-*` models are handled too |
| `ai_image_quality` | `low` | passed to `gpt-image-*` |
| `ai_image_cost_usd` | `0.011` | per-image cost recorded into `ai_usage` so the AI budget stays honest |
| `arena_vote_salt` | `JWT_SECRET` | salt for anonymous voter hashing |

Portraits are written to `data/arena/` (override with `ARENA_IMAGE_PATH`) and served from `/data/arena/`.

## Guard rails

- Persona and commentary prompts forbid mocking appearance, body, voice, disability, age, ethnicity, gender, religion, health or money; everything is framed as Arena lore, PG-13.
- Portraits never use the streamer's face: only the persona and an identity-free scene description feed the image model.
- The background job (`server/arena/arena-job.js`) refreshes at most 6 personas and 2 portraits per 20-minute tick, top of the leaderboard first, and stops when the AI budget is exhausted.
- All AI text is rendered escaped; nothing from a model is inserted as HTML.

Tests: `node test/arena.test.js` (ratings, seeded battles, votes, roster on a temp DB — no AI needed).
