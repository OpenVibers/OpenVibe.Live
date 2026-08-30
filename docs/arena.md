# Arena — beefs, the board, and the ears

The **Arena** tab (`/arena`) is where the platform's culture gets weaponised into entertainment. Nobody clicks "fight". Everything runs off what streamers *say* on mic (the continuous audio transcription) and what viewers *do* in chat:

- **Beefs** — a streamer says another fighter's name while talking shit → a beef opens by itself, the target goes on the clock, silence is a forfeit.
- **The board** — topics, debates, phrase challenges and bounties that come from chat (`!topic`, `!bounty`) and from the **pulse** (the AI reads global chat, transcripts and the AI timeline every 30 min and writes what the community is on about). Streamers click a topic, talk on it, clear its angles → XP → **Trash Level**.
- **Fighters** — the roster is every streamer active in the last 45 days, rated on 7 stats (HYPE, GRIND, CHAT, LOYALTY, CLUTCH, VIBE, **MIC**) as percentiles across the roster, plus an AI persona and portrait. Recent Trash Level XP and beef wins add a *mouth bonus* (≤ +12) to POWER.

With AI off everything still works: template headlines, fallback angles, keyword judges.

## Speech policy

The platform does not censor language. Offensive, provocative, taboo words — slurs included — are allowed, are never filtered, and are never a reason for the judge to score low. The only lines that don't count (`server/arena/arena-service.js` `isBannedText`, plus the judge's `flagged`) are **behaviour**: direct threats of violence (`kys`, "I'll kill you"), sexual content about minors, and doxxing (addresses, phone numbers). Those lines are dropped from quotes, feeds and scoring; nothing else is.

## Beefs (`server/arena/beef.js`)

| Rule | Value |
|---|---|
| Opens when | the listener judges ≥ 20 words in the 45 s after a fighter's name was said as *aimed at them* (roast, callout, disrespect, brag over them) |
| Clock | the other side must answer on their own stream within **15 min if live**, **24 h if offline** (an offline clock is tightened to 15 min the moment they go live) |
| Answer | any judged hit from the side on the clock; every hit flips the clock to the other side |
| Forfeit | clock runs out → the silent side loses |
| Hard end | 24 h after opening → higher **total** wins (`total = Σ hit quality (0–10, judged) + crowd hype (max 10)`), equal = draw |
| Upset | winner ranked ≥ 4 places below the loser (+20 XP) |
| Rematch | same pair again → flagged, with the rivalry's record and **receipts** (best lines from earlier beefs) |
| XP | +5 open · +quality per hit (×2 while a bounty is on the target) · +40 win |
| Crowd | `!hype` / Hype button: one per person per side · `!side <name>`: pick who wins → **clout** when right |

Headlines (open + result) are AI-written (`chat` role) with templates as fallback; the announcer's one-liner per hit comes from the judge. Streaks, upsets and the head-to-head history are shown on every beef card.

## The board (`server/arena/board.js`)

| Kind | Comes from | Resolves |
|---|---|---|
| **topic** | chat (`!topic`), the page, the pulse | archived after 36 h idle; streamers clear its 3 AI-cut **angles** (brag / roast / bit) by talking; all 3 → *conquered* |
| **debate** (A vs B) | the pulse (arguments exploding in chat / transcripts) | after 24 h: `talk×2 + chat picks` per side; MVP +30 XP; right picks earn clout |
| **phrase** ("say X on stream") | the pulse (memes going round) | 6 h; no model needed — 15 XP first time it comes out of your mouth, 5 after |
| **bounty** (on a fighter) | chat (`!bounty <user>`), the page, the pulse | 6 h; every beef hit on the target pays double; top collector +40 XP |

**Heat** = judged hits×3 + hype + side picks + fighters talking×4 in the last hour; ≥ 12 is **HOT** and the board sorts by it. The **pulse** (`refreshPulse`, every 30 min, `summary` role) reads: the global chat AI summary, `chat_timeline_events`, recent chat, last-hour transcripts, stream memories, streamer overviews, VOD overviews, open beefs and the ladder — and posts up to 6 new typed events with tabloid headlines plus a one-line "pulse" sentence shown at the top of `/arena`. Templates seed the board when AI is off.

**Trash Level** = 1 + XP/50. XP: judged topic chunk (quality×0.8) · angle cleared +25 · topic conquered +60 · chat hype +2 · beef (above). The Trash Level ladder and the viewer **clout** ladder (right side picks, accuracy, streak) sit on `/arena`.

## The ears (`server/arena/listener.js`)

Every 15 s, for every roster stream that is live **and** has a transcript line in the last 30 min:

1. New `stream_timeline_events` speech lines are read. Every line is checked against open phrase challenges.
2. A fighter's name (username, display name, fighter name; `@name`; underscores/dots spoken as spaces; longest match first, never yourself) opens a **mention buffer**; lines in the following 45 s join it. At ≥ 20 words the **beef judge** runs (`aimed_at_target`, `quality`, `best_line` verbatim, `about`, `announcer`, `flagged`) → `beef.recordHit`.
3. Other lines pool for the **topic judge** against the streamer's active board topic (≥ 20 words, ≥ 30 s between calls): `angle_idx`, `quality`, `progress_gain` (0–60), `best_line`, `about`.
4. One judge call per stream per tick; keyword heuristics when AI is off.

`/arena/live/<username>` shows exactly what the ears hear for a fighter: hot mic lines, the last judgements, active topic progress, open beefs and any bounty on them (auto-refreshes; a level-up flashes).

## Pages

`/arena` — pulse · on the mic now · open + settled beefs · the board (start a topic, pick debate sides, hype, "Talk on this") · Trash Level ladder · clout ladder · power ladder (rows expand) · rules.
`/arena/beef/<id>` — tale of the tape, tug-of-war, live clock, ringside feed (every judged hit with ▶ to the VOD second and 🔊), receipts from earlier beefs, hype/side buttons.
`/arena/topic/<id>` — angles, who's talking and their per-angle progress, best lines (▶), debate sides, bounty target, join/leave.
`/arena/<username>` — stats drill-down, voice + quotes, Trash Level card, rivalries with receipts, beef history.

## Chat commands (`server/arena/arena-chat.js`)

`!topic <text>` (1 per 10 min) · `!bounty <user>` (1 per hour) · `!hype` (the streamer's newest open beef, else their active topic) · `!side <name|a|b>` · `!beef` · `!board` · `!arena [user]`. One command per person every 4 s; replies are private system lines, milestones go to the room.

## API (`/api/arena`)

| Method | Path | Notes |
|---|---|---|
| GET | `/status` · `/fighters` · `/fighters/:user` · `/fighters/:user/stat/:stat` · `/live` | roster, card (+ `beefs`, `rivalries`, `level`, `active_topic`), drill-down, live fighters (hot mic, active topic, open beefs) |
| POST | `/fighters/:user/refresh` | admin — regenerate persona (+ portrait) |
| GET | `/console/:user` | the ears: listener state, hot mic, active topic + my progress, open beefs, bounty |
| GET | `/board` | `open` (by heat), `resolved`, `pulse`, `levels`, `clout` |
| POST | `/board/topics {text}` · `/board/bounty {username}` | auth |
| GET | `/board/topics/:id` | detail incl. per-member progress and best lines |
| POST | `/board/topics/:id/join` · `/leave` (auth, roster) · `/side {side}` · `/hype {user_id}` | |
| POST | `/pulse/refresh` | admin — force a pulse read |
| GET | `/beefs` · `/beefs/:id` | |
| POST | `/beefs/:id/hype {side}` · `/beefs/:id/side {side}` | one per person; anonymous by hashed IP |
| GET | `/levels` · `/clout` | ladders |

## Settings

| Key | Default | Effect |
|---|---|---|
| `arena_enabled` | `true` | `false` → API 404s |
| `ai_image_enabled` / `ai_image_model` / `ai_image_quality` / `ai_image_cost_usd` | `false` / `gpt-image-1` / `low` / `0.011` | portraits |
| `arena_vote_salt` | `JWT_SECRET` | salt for anonymous voter hashing |

Background job (`server/arena/arena-job.js`): personas/portraits every 20 min (bounded, budget-aware) · listener every 15 s · clocks + expiries every 60 s · pulse every 30 min.

Tests: `node test/arena.test.js` (roster, ratings, filter, quotes) · `node test/arena-beef-board.test.js` (beefs, board, listener tick, chat commands, API) — both on a temp DB, no AI needed.
