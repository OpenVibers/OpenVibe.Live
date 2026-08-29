# Arena — streamer vs streamer

The **Arena** tab (`/arena`) turns the analytics and AI data OpenVibe.Live already keeps about every streamer into a fighting-game roster: a ranked leaderboard, a character-select profile per streamer, live head-to-head matchups, and daily battles that the crowd finishes with a vote.

Everything is opt-in on the AI side — with AI off the tab still works from stats alone (templated lore and commentary, avatar cards instead of portraits).

## What each streamer gets

| Piece | Source | Cost |
|---|---|---|
| **Ratings** — HYPE, GRIND, CHAT, LOYALTY, CLUTCH, VIBE, **MIC** (40–99) and overall **POWER** | `streams` + `stream_analytics` (last 90 days), `follows`, `transactions` (tips). **MIC** comes from the continuous audio transcription (`stream_timeline_events`): share of stream time spent talking, words per minute, hype words per hour, laughs per hour (sound events). Each rating is the streamer's *percentile* on that metric across the active roster (streamed in the last 45 days), so a 99 means "best on the site", never an absolute number. Streamers without transcript data tie at the MIC floor. | none |
| **Quotes** — "things they actually said", each with a ▶ that jumps to the VOD at that second, plus a walkout line, mic style and a one-line voice verdict | Transcript lines (25–220 chars, last 90 days) pre-scored for hype/punctuation, then the AI picks the most quotable and harmless ones. Heuristic pick when AI is off. Cached 24 h. Needs ≥ 20 lines. | ~1 LLM call / streamer / day |
| **Persona** — fighter name, title, class, element, signature move, special, weakness, taunt, lore, catchphrase, entrance music, a quip per stat | AI (`summary` role) from the streamer's AI overview, stream memories, chat-AI notes, recent VOD titles/overviews and the numbers. Cached 24 h. | ~1 LLM call / streamer / day |
| **Portrait** — stylised character-select art | AI image model (OpenAI-compatible `/images/generations`). The prompt is built from the persona, category, profile colour and a *scene* description of the latest thumbnail (setting, objects, mood — the vision model is told never to describe faces or identity). It is deliberately **not a likeness** of the person. Cached 7 days. | 1 image / streamer / week, only when enabled |
| **Record** — W–L | `arena_battles` | none |

## Battles

`/arena/battle/<a>/<b>` — the same pair on the same day always gets the same five rounds (Hype Check, Chat War, Endurance, Clutch Time, **Mic Drop**), simulated from the ratings with a seeded random so the underdog sometimes lands an upset. The **crowd vote** is the fifth round: one vote per user (per IP when anonymous), changeable until midnight UTC, and it breaks 2–2 ties (Power breaks a tie with no votes). The announcer commentary is AI (`chat` role, cached per battle; it gets both walkout lines) with a templated fallback. Every round line expands to show the ratings and rolls behind it; **Tale of the tape** compares the raw numbers; the all-time head-to-head record is shown above the commentary.

**Main event** — one featured battle per day, seeded from the top 8 of the ladder, pinned to the top of `/arena` with its own vote buttons.

Live streamers are paired by neighbouring Power on the leaderboard ("Live battles"), with their live thumbnails, refreshed every 30 s.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/arena/fighters` | leaderboard |
| GET | `/api/arena/fighters/:username` | full card incl. `voice`, `quotes`, `recent_battles`, `rivalry`; generates a stale persona/quotes synchronously and kicks off a portrait in the background (`image_pending`) |
| GET | `/api/arena/fighters/:username/stat/:stat` | drill-down: per-stream series (last 14 streams), rank on that stat, top 3 of the ladder |
| GET | `/api/arena/main-event` | today's featured battle |
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

## Interaction

- Leaderboard rows expand in place (radar, quips, signature move, fight/profile buttons); every stat on a profile opens a sparkline of the last 14 streams with the roster's top 3; the portrait opens a lightbox that explains how it was painted (and shows the prompt).
- 🔊 buttons read taunts, quotes and the announcer's call aloud with the browser's own speech synthesis (no server cost); ▶ on a quote jumps to the VOD at that moment so you hear the real thing.
- Live matchups show the **hot mic** — the last line the transcription heard on each live stream.

## Guard rails

- Persona and commentary prompts forbid mocking appearance, body, voice, disability, age, ethnicity, gender, religion, health or money; everything is framed as Arena lore, PG-13.
- Portraits never use the streamer's face: only the persona and an identity-free scene description feed the image model.
- The background job (`server/arena/arena-job.js`) refreshes at most 6 personas and 2 portraits per 20-minute tick, top of the leaderboard first, and stops when the AI budget is exhausted.
- All AI text is rendered escaped; nothing from a model is inserted as HTML.

Tests: `node test/arena.test.js` (ratings, seeded battles, votes, roster on a temp DB — no AI needed).
