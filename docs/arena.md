# Arena — beefs, the board, and the ears

The **Arena** tab (`/arena`) is where the platform's culture gets weaponised into entertainment. Nobody clicks "fight". Everything runs off what streamers *say* on mic (the continuous audio transcription) and what viewers *do* in chat:

- **Beefs** — a streamer says another fighter's name while talking shit → a beef opens by itself, the target goes on the clock, silence is a forfeit.
- **The board** — living lore profiles of the subjects the site is actually on about, discovered from global chat + live transcripts; every chat line or on-mic line about a subject becomes a moment, the AI rewrites the lore as it escalates. Streamers talk on a subject → judged moments → XP → **Trash Level**. No voting anywhere.
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
| Crowd | `!hype` / Hype button: one per person per side (no voting) |

Headlines (open + result) are AI-written (`chat` role) with templates as fallback; the announcer's one-liner per hit comes from the judge. Streaks, upsets and the head-to-head history are shown on every beef card.

## The board (`server/arena/board.js`) — living lore

No voting anywhere. The board is a list of **subjects** the community is actually on about, each a lore profile that writes itself:

- **Discovery** — every 5 min (only when ≥ 8 new lines exist, so a dead room costs nothing) the AI reads the last 30 min of global + stream chat and live transcripts and returns the subjects people are really on about (a person, a group, a joke, a drama…) with a tabloid headline, a tagline, the **keywords/slang** people use for it, and optionally one **bounty** on a streamer the community keeps naming. Without AI, a word ≥ 3 people said ≥ 4 times becomes a subject. New subjects are **backfilled** with every matching line from the last 2 h so they never start empty.
- **Moments** — every minute new `chat_messages` are scanned; any line matching a subject's keywords becomes a chat **moment** on it. The listener does the same for transcript lines (an on-mic moment with a VOD deep link, one per stream per 45 s) and **auto-joins** the fighter to the subject. Judged chunks (≥ 20 words, AI quality 0–10) are moments with a score → XP (quality × 0.8) → Trash Level.
- **Lore** — when a subject has ≥ 3 new moments (and ≥ 8 min since the last rewrite) the AI rewrites its lore: who started it, who said what (verbatim, with usernames), who is on which end, escalations. Templated when AI is off. Lore stays in the archive after the subject cools off (36 h idle).
- **User subjects** — signed-in only, **one per person and one per IP per 24 h**. The AI rewrites what was typed into a subject + headline + keywords (`submitTopic`, one small call) and backfills moments. `!topic <text>` in chat does the same.
- **Heat** = on-mic moments ×3 + chat moments + hype + fighters talking (last hour); ≥ 12 is HOT; the hottest subject is featured at the top.
- **Ladders** — Trash Level (XP) and **yappers** (chatters with the most moments in 7 days).

## The ears (`server/arena/listener.js`)

Every 15 s, for every roster stream that is live **and** has a transcript line in the last 30 min:

1. New `stream_timeline_events` speech lines are read.
2. **Name detection** (`server/arena/names.js`) — every roster name (username, display name, fighter name, plus the persona's AI-written `spoken_as` nicknames/mishearings) is expanded into the forms a transcriber produces: camelCase/snake/kebab split (`JapaneseOldGuy` → "japanese old guy"), digits and `_tv`/`xX_` decorations dropped (`lofi_dan99` → "lofi dan"), leet undone, glued forms. Lines are matched exact → **fuzzy** (edit distance scaled by length, same word count only: "Matticus", "japanese old gai") → **phonetic** (compact metaphone key: "goose lee", "Goosley", "mattie cuss", "pixel queen"). Single common words can never be aliases, prefixes don't count, the speaker never matches themselves.
3. **Focus lock** — a name-drop locks the ears on that fighter for 2 min; everything said afterwards goes to the beef judge together with what was already said about them, and the judge decides `about_target` (still on them via "he", "her chat", "that guy", the same story) and `aimed_at_target`. Every hit extends the lock 3 min (hard cap 20 min without a fresh name-drop); neutral talk keeps it a bit; two chunks about something else drop it. A different name-drop switches targets (the pending chunk is judged first). The console (`/arena/live/<user>`) shows the lock, its context and whether the last hit was a continuation.
4. Lines matching a board subject's keywords become on-mic moments (and auto-join the fighter). Other lines pool for the **subject judge** against the streamer's active subject — or the one they just brought up (≥ 20 words, ≥ 30 s between calls): `on_topic`, `quality`, `best_line`, `about`.
5. One judge call per stream per tick; keyword heuristics when AI is off (pronouns + spice count as a continuation).

`/arena/live/<username>` shows exactly what the ears hear for a fighter: hot mic lines, the last judgements, active topic progress, open beefs and any bounty on them (auto-refreshes; a level-up flashes).

## Pages

`/arena` — pulse (what the site is on about + live counters) · on the mic now · open + settled beefs · the board (featured subject with lore + latest moments, then a feed of subjects, lore archive) · Trash Level ladder · yappers · power ladder (rows expand) · rules.
`/arena/beef/<id>` — tale of the tape, tug-of-war, live clock, ringside feed (every judged hit with ▶ to the VOD second and 🔊), receipts from earlier beefs, hype/side buttons.
`/arena/topic/<id>` — headline, subject, lore, keywords, the full moment timeline (chat + on-mic with ▶ to the VOD second), fighters on it with their best line, loudest chatters, join/leave.
`/arena/<username>` — stats drill-down, voice + quotes, Trash Level card, rivalries with receipts, beef history.

## Chat commands (`server/arena/arena-chat.js`)

`!topic <text>` (signed in; 1 per person + per IP per 24 h; AI rewrites it) · `!bounty <user>` (1 per hour, same 24 h rule) · `!hype` (the streamer's newest open beef, else their active subject) · `!beef` · `!board` · `!arena [user]`. One command per person every 4 s; replies are private system lines, milestones go to the room.

## API (`/api/arena`)

| Method | Path | Notes |
|---|---|---|
| GET | `/status` · `/fighters` · `/fighters/:user` · `/fighters/:user/stat/:stat` · `/live` | roster, card (+ `beefs`, `rivalries`, `level`, `active_topic`), drill-down, live fighters (hot mic, active topic, open beefs) |
| POST | `/fighters/:user/refresh` | admin — regenerate persona (+ portrait) |
| GET | `/console/:user` | the ears: listener state, hot mic, active topic + my progress, open beefs, bounty |
| GET | `/board` | `open` (by heat, each with lore/keywords/mentions/fighters/last + best moment), `archive`, `pulse`, `levels`, `yappers` |
| POST | `/board/topics {text}` · `/board/bounty {username}` | auth; 1 per person + per IP per 24 h; the AI rewrites the text |
| GET | `/board/topics/:id` | detail incl. `moments` (80), `best_lines`, `top_chatters`, fighters with their best moment |
| POST | `/board/topics/:id/join` · `/leave` (auth, roster) · `/hype {user_id}` | |
| POST | `/pulse/refresh` · `/board/topics/:id/lore` | admin — force discovery + lore sweep / rebuild one subject's lore |
| GET | `/beefs` · `/beefs/:id` | |
| POST | `/beefs/:id/hype {side}` | one per person per side; anonymous by hashed IP |
| GET | `/levels` · `/yappers` | ladders |

## Settings

| Key | Default | Effect |
|---|---|---|
| `arena_enabled` | `true` | `false` → API 404s |
| `ai_image_enabled` / `ai_image_model` / `ai_image_quality` / `ai_image_cost_usd` | `false` / `gpt-image-1` / `low` / `0.011` | portraits |
| `arena_vote_salt` | `JWT_SECRET` | salt for anonymous voter hashing |

Background job (`server/arena/arena-job.js`): personas/portraits every 20 min (bounded, budget-aware) · listener every 15 s · clocks + bounty expiries + chat scan every 60 s · discovery ≤ 1 AI call / 5 min and only with new material · lore rewrites only for subjects with ≥ 3 new moments (≤ 3 per minute).

Personas: the voice comes from their **chat history first** — their own chat lines with the room they typed in, the chat AI's profile of them as a chatter (overview, long-term memory, timeline), then the streaming profile as flavor. Output: `taunt` + three more `taunts` (ragebait in that exact typing style), `typing_style`, `spoken_as` (how people say/mishear the name — fed to name detection) and `custom_stats` (six stats unique to them, e.g. "Alt Accounts 91", drawn as their own radar on the ladder row and profile).

Tests: `node test/arena.test.js` (roster, ratings, filter, quotes) · `node test/arena-beef-board.test.js` (beefs, board, listener tick, chat commands, API) — both on a temp DB, no AI needed.

## Voice + portraits

- **Hear it in their voice** — every 🔊 in the Arena calls `GET /api/arena/voice/<username>?t=<line>` (`server/arena/voice.js`): the line is synthesized in the streamer's **equipped cosmetic chat voice** (else the same per-identity auto voice chat gives `user:<username>`), written once to `data/tts-cache/<sha(voice+text)>.<mp3|wav>` and served with `Cache-Control: max-age=604800` — a repeat click never re-synthesizes (server cache + browser cache). `announcer` reads headlines/lore in `arena_announcer_voice` (default `tts_default_voice`). Cloud engines are metered into `ai_usage` (kind `tts`); `arena_voice_daily_max` (2000) caps fresh syntheses per day and per-IP limits are 8/min anonymous, 30/min signed in. Browser speech is only the fallback when the engine is down.
- **Portraits from their own frames** — `generateImage` now feeds up to 3 real frames (live thumbnail, AI-moment frames the vision job persisted, VOD thumbnails — frames whose description mentions a person first) to `images/edits`, asking for a character-select caricature that keeps their setup, gear, lighting, silhouette and the vibe of their scene; text-only generation is only the fallback for streamers with no frames yet. Custom stats and the persona shape the costume/props.

## Yappers — profiles for everyone who chats (`server/arena/chatters.js`)

One polymorphic key per chatter — `user:<id>`, `anon:<N>` (the site's IP-derived `anon<N>` identity) or `relay:<platform>:<name>` (chat relayed from Twitch/Kick/YouTube/RobotStreamer) — so anonymous viewers and relayed chatters get profiles too. No extra AI calls for XP: it falls out of the board pipeline.

| XP | for |
|---|---|
| +3 / +6 | a chat line that lands as a moment on a subject (double when the subject is HOT) |
| +4 | the first time you touch a subject |
| +15 | starting a subject (`!topic` / the page) |
| +10 | being quoted in a subject's lore (name appears in the rewritten lore) |
| +1 | hyping a fighter on a subject |
| +5 × streak (≤ 7) | the first moment of each day; streak = consecutive days |

Level = `1 + floor(√(XP / 25))` (the game's curve). Titles: Lurker → Chatter (2) → Yapper (3) → Instigator (5) → Ragebaiter (7) → Menace (9) → Main Character (12) → Community Consciousness (15) → Final Boss (20). **OpenVibe accounts bank `level × 10` OpenCoins on every level-up** through the network wallet (idempotent key `live:arena_yap_level:<user>:<level>`; unlinked accounts are simply skipped); anons/relay chatters keep the level and the title. Level-ups are announced in the room the moment happened in.

**Yap card** — at level ≥ 3, at most once a day and only when ≥ 25 XP changed, the AI writes a card (title, blurb, catchphrase in their typing style, "known for", archetype) from the chat AI's existing profile of them (`chat_ai_summaries` user/anon/relay) + their best lines and subjects; ≤ 4 cards per housekeeping minute.

Where it shows: the Yappers block on `/arena` (podium with level rings, streak flames, cards; weekly movers), `/arena/chatter/<key>` (card, XP bar, titles ladder, moments, subjects, what the chat AI has on them), and the chat context menu (click a name → yap level + title + bar, linking to the page). API: `GET /api/arena/yappers`, `GET /api/arena/chatter/:key`, `GET /api/arena/chatter/by-user/:username`, admin `POST /api/arena/chatter/:key/card`.
