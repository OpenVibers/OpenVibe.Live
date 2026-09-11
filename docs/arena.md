# Arena — Battle Cam (pure mic)

The **Arena** tab (`/arena`) is streamer-vs-streamer shit talk with exactly one input: **what fighters say into the microphone**. The continuous audio transcription of every live cam (`stream_timeline_events`, see the AI timeline) is read every 15 seconds and judged. Nobody clicks "fight", nobody votes, nothing typed in chat counts. There is no board, no topics, no chat levels, no bounties, no check-ins — those were removed in v3 (2026-09-10) because they were not mic.

- **Callouts → beefs** — a fighter says another fighter's name while talking shit → the ears lock on, the judge scores it, the beef opens by itself, the target goes on the clock; silence is a forfeit. The mic judge can also open a beef without the name being in the transcript, when it decides the shit talk is clearly *aimed at* a roster fighter.
- **The feed** — everything else that is actually shit talk (at chat, the mods, other platforms, the game, the world) is judged, scored 0–10, VOD-linked and lands in the live feed. It pays Trash Level XP. Gameplay narration and small talk score nothing.
- **The ladder** — every fighter is rated on seven mic-only stats, as percentiles across the roster, plus an AI persona and portrait written from their transcripts.

**No personas, no portraits, no AI ring names** (removed 2026-09-11): fighters are the streamers, under their own names and avatars. The only AI on this page is the judge.

**Backfill** (`server/arena/backfill.js`): the listener only hears live cams, so past speech (last 7 days, ended streams) is judged by the job every 20 min (and 90 s after boot): chunks of ≥ 20 words, only the ones that look spicy or name a fighter go to a model (≤ 160 calls per run), name-drops become `callout` moments with the target attached (no clocks for old speech), the rest `trash` moments — dated when they were *said*, VOD-linked. A per-fighter cursor keeps it incremental. Admin: `POST /api/arena/backfill`.

With AI off everything still works: keyword judges, template headlines.

## Speech policy

The platform does not censor language. Offensive, provocative, taboo words — slurs included — are allowed, are never filtered, and are never a reason for the judge to score low. The only lines that don't count (`server/arena/arena-service.js` `isBannedText`, plus the judge's `flagged`) are **behaviour**: direct threats of violence (`kys`, "I'll kill you"), sexual content about minors, and doxxing (addresses, phone numbers). Those lines are dropped from the feed, quotes and scoring; nothing else is.

## The roster + ratings (`server/arena/arena-service.js`)

The roster is **whoever has been heard**: every streamer with transcribed speech in the last 45 days. A streamer with 9,000 viewers and no transcription is not a fighter. Ratings are 40–99 percentiles across the roster (a roster of one is a flat 70):

| Stat | From | Weight |
|---|---|---|
| **Heat** | average judge score of their mic moments (30 d) | 0.22 |
| **Aim** | callouts + beef hits per hour on mic (30 d) | 0.18 |
| **Kills** | beefs won | 0.16 |
| **Mouth** | share of stream time spent talking | 0.14 |
| **Clapback** | beefs answered on the clock ÷ beefs they were called out in | 0.12 |
| **Stamina** | minutes of speech heard (90 d) | 0.10 |
| **Pace** | words per minute on mic | 0.08 |

POWER = weighted sum + a **mouth bonus** (≤ +12: recent XP ÷ 25 + 3 per beef win in 7 days). Audience numbers (viewers, chat volume, followers, clips, tips) do not exist anywhere in the Arena.

**Persona** (`chat` role, 24 h TTL): fighter name, title, class, element, moves, weakness, `taunt` + three `taunts` (ragebait in *their speaking voice*), `typing_style` (how they talk), `spoken_as` (nicknames/mishearings, fed to name detection), six `custom_stats` unique to them and `stat_quips` — written from their transcript lines, their best judged shit talk, who they call out, who calls them out and what they rant at. **Quotes**: AI-picked lines from the transcripts, VOD-linked. **Portraits** (optional, `ai_image_enabled`): drawn from their own stream frames.

## The mic ledger (`server/arena/mic.js`)

`arena_mic_moments` — one row per judged line: `kind` (`trash` for free-standing shit talk, `beef_hit` when it fed a beef), `target_user_id` + `beef_id` for callouts, `aimed_at` (free text: "chat", "the mods", a name…), `text`, `about`, `quality`, `announcer`, VOD id + second, `said_at`. `feed()` is the live feed; `micStats(userId)` is what the ratings read.

**XP → Trash Level** (`arena_trash_levels`, level = 1 + XP ÷ 50): `trash` moment = quality × 0.8 · beef hit = quality · beef open +5 · beef win +40 (+20 upset) · hype received +1. Nothing else pays XP. The best line on record (highest quality) sticks to the profile.

## The ears (`server/arena/listener.js`)

Every 15 s, for every roster stream that is live **and** has a transcript line in the last 30 min:

1. New speech lines are read.
2. **Name detection** (`server/arena/names.js`) — every roster name (username, display name, fighter name, the persona's `spoken_as`) in the forms a transcriber produces (camelCase/snake split, digits/decorations dropped, leet undone, glued), matched exact → fuzzy → phonetic. The speaker never matches themselves.
3. **Focus lock** — a name-drop locks the ears on that fighter for 2 min; everything said afterwards goes to the **beef judge** with the context of what was already said (`about_target`, `aimed_at_target`, quality, best verbatim line, announcer call). A hit → `beef.recordHit()`; every hit extends the lock 3 min (cap 20 min without a fresh name-drop); two off-target chunks drop it; a different name switches targets.
4. **Free talk** — lines said while not locked pool for the **mic judge** (≥ 20 words, ≥ 30 s between calls per stream): `is_trash_talk`, quality, best line, `aimed_at`, announcer. Quality ≥ 4 → a `trash` moment in the feed. If `aimed_at` resolves to a roster fighter and quality ≥ 5 → it is a **callout** and feeds a beef exactly like a name-drop.
5. One judge call per stream per tick; keyword heuristics when AI is off.

`/arena/live/<username>` shows exactly what the ears hear: hot mic lines, the lock and its context, the last beef and mic judgements, their recent lines in the feed, open beefs.

## Beefs (`server/arena/beef.js`)

| Rule | Value |
|---|---|
| Opens when | the beef judge confirms ≥ 20 words aimed at a fighter after a name-drop, or the mic judge's `aimed_at` resolves to a fighter (quality ≥ 5) |
| Clock | the other side must answer on their own cam within **15 min if live**, **24 h if offline** (an offline clock tightens to 15 min the moment they go live) |
| Answer | any judged hit from the side on the clock; every hit flips the clock |
| Forfeit | clock runs out → the silent side loses |
| Hard end | 24 h after opening → higher **total** wins (`total = Σ hit quality + crowd hype (max 10)`), equal = draw |
| Upset | winner ranked ≥ 4 places below the loser (+20 XP) |
| Rematch | same pair again → flagged, with the rivalry's record and **receipts** (best lines from earlier beefs) |
| Crowd | `!hype` / Hype button: one per person per side — the only thing chat can do |

Every hit is also written to the mic ledger as a `beef_hit` moment. Headlines (open + result) are AI-written with templates as fallback; the announcer's one-liner per hit comes from the judge.

## Pages

`/arena` — Battle Cam: your beefs on the clock · **live cams** (thumbnail, lock indicator, last judged line, open beefs, pending words) · open + settled beefs · **the feed** (every judged line, newest first, aimed-at chips, ▶ to the VOD second, 🔊 in their voice) · the ladder (rows expand: the seven mic stats radar, taunts, quips) · rules.
`/arena/beef/<id>` — tale of the tape, tug-of-war, live clock, ringside feed, receipts, hype buttons.
`/arena/live/<username>` — the ears.
`/arena/<username>` — POWER, Trash Level card (judged lines, avg score, bangers, answered-when-called-out), the seven mic stats with drill-downs, their lines on record, characteristics radar, rap sheet, ragebait bubbles, on the mic (voice meters + quotes), rivalries, beefs.

Old `/arena/topic/*` and `/arena/chatter/*` links show a "this part is gone" note.

## Chat commands (`server/arena/arena-chat.js`)

`!hype` (the streamer's newest open beef) · `!beef` · `!arena [user]`. One command per person every 4 s. `!topic`, `!bounty` and `!board` no longer exist.

## API (`/api/arena`)

| Method | Path | Notes |
|---|---|---|
| GET | `/status` · `/fighters` · `/fighters/:user` · `/fighters/:user/stat/:stat` · `/live` | roster (`stats`, `stat_meta`, per-fighter `mic`, `last_line`), card (+ `beefs`, `rivalries`, `moments`, `best_lines`, `mic`), drill-down, live cams (`ears`, `last_moment`, `open_beefs`) |
| GET | `/feed?limit&since` | the shit-talk feed |
| POST | `/fighters/:user/refresh` | admin — regenerate persona (+ portrait) |
| GET | `/console/:user` | the ears: listener state, hot mic, level, mic stats, open beefs, recent moments |
| GET | `/beefs` · `/beefs/:id` · POST `/beefs/:id/hype {side}` | one hype per person per side; anonymous by hashed IP |
| GET | `/levels` | Trash Level ladder |
| GET | `/me` | signed in: fighter brief, level, record, mic stats, open beefs, beefs where you are on the clock, recent moments |
| GET | `/voice/:user?t=<text>` | the line in that user's chat TTS voice (cached on disk + a week in the browser) |

## Settings

| Key | Default | Effect |
|---|---|---|
| `arena_enabled` | `true` | `false` → API 404s |
| `ai_timeline_enabled` | `false` | the audio transcription the whole Arena runs on — must be on |
| `ai_image_enabled` / `ai_image_model` / `ai_image_quality` / `ai_image_cost_usd` | `false` / `gpt-image-1` / `low` / `0.011` | portraits |
| `arena_vote_salt` | `JWT_SECRET` | salt for anonymous hype hashing |

Background job (`server/arena/arena-job.js`): personas/portraits every 20 min (bounded, budget-aware) · listener every 15 s · beef clocks every 60 s.

Tests: `node test/arena.test.js` (roster, mic ratings, filter, quotes) · `node test/arena-mic.test.js` (ledger, beefs, listener tick, chat, API) · `node test/arena-voice.test.js` — all on a temp DB, no AI needed.

## Voice

Every 🔊 in the Arena calls `GET /api/arena/voice/<username>?t=<line>` (`server/arena/voice.js`): synthesized once in the streamer's equipped cosmetic chat voice (else their per-identity chat voice), cached on disk and for a week in the browser. `announcer` reads headlines in `arena_announcer_voice`. `arena_voice_daily_max` (2000) caps fresh syntheses per day; per-IP limits are 8/min anonymous, 30/min signed in.
