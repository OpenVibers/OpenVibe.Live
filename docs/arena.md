# Arena — ARENA ALERT (v4, 2026-10-16)

The **Arena** tab (`/arena`) is the site's drama desk and competitive board, in the owner's words "drama alert type competitive shit … based on streamer activity". It replaced the mic-only Battle Cam home (v3, 2026-09-10): the mic still feeds it (beefs, the judged lines), and now so does everything else streamers measurably do.

- **ARENA ALERT** (`server/arena/drama.js`, `public/js/arena-alert.js`) — every 5 min the desk reads the last 3 hours of activity and writes one story per event (`arena_drama`, deduped): **rage quits** (a stream over in < 15 min from someone who usually goes 45+), **viewer crashes** (halved within 20 min, from 3+) and **spikes** (doubled, to 4+), **chat explosions** (3× the stream's usual rate, 15+ in 5 min), **meltdowns** (3+ yells/screams/shouts within 2 min on the sound timeline AND a heated line of the streamer's own beside them, which is quoted: the sound timeline hears a game's or a match's crowd too, so noise alone is no story, and there are no tears stories), **marathons** (8 h+), **ghost towns** (an hour+ to 0-1 viewers and no chat), **comebacks** (14+ days away), **title drama**, **new personal peaks**; once a day **fell off** (4+ streams the month before, none for 7 days), **no days off** (every 7 days in a row) and the **quote of the day**; beefs report their opening, win and forfeit (a forfeit story only when the side that went silent was live while on the clock). A story gets a template headline at once (facts and numbers only) and an AI rewrite from OpenVibe.AI's `live.arena.drama` (≤ 20 an hour): drama-news voice, roast what happened on stream, never invent an event or accuse (a rewrite that adds an accusing word the template does not use, such as a threat or an attack, is dropped and the template stays), no identity slurs, sexual content, threats, doxxing or self-harm jokes; quotes are the streamer's own words. Alert level 1-5 (🚨). A subject with alert ≥ 3 is notified, and the story is announced in chat as **ARENA ALERT** (their stream room, mirrored to global chat, while they are live; else global chat; at most 6 an hour).
- **Reactions** — 🔥 💀 🤡 W L, one per viewer per story (`arena_drama_reactions`; the person, else a salted address hash).
- **Lolcow Index** — cow points from stories over the last 7 days (newer counts more; rage quits, crashes, meltdowns, ghost towns, dramatic titles, falling off, ducking a beef), 0-100 against the top cow, who wears the 🐄.
- **Clout Rankings** — the last 7 days: hours live ×2 + average viewers ×10 + peak ×3 + chat messages ÷ 50 + new followers ×5 + the clout points of their stories (spikes, records, comebacks, streaks, beef wins) + beef wins ×10 − half their cow points. This week's moves against the snapshot taken each Monday (`arena_clout_weeks`); tags COOKED (cow meter 70+), ON THE RISE, FALLING, UNDEFEATED.
- **Rap sheet** (`/arena/<username>`, above the fighter page) — cow meter, clout rank, beef W–L, every story about them.
- **Opting out** — `PUT /api/arena/opt-out {out}` (the "keep themselves out" link): no new stories about them, the old ones hidden; they can come back. Staff hide a story with `POST /api/arena/drama/:id/hide`.
- **Beefs and the ears** (below) are unchanged: a fighter's whole name said on mic opens a beef, the other side is on the clock, silence is a forfeit.

API: `GET /api/arena/drama?limit&before&user`, `/drama/:id`, `POST /drama/:id/react {reaction}`, `GET /lolcow`, `/clout`, `/rap/:user`, `GET|PUT /opt-out`. Pages: `/arena`, `/arena/drama/<id>`, `/arena/<username>`, `/arena/beef/<id>`, `/arena/live/<username>`.

The transcripts all of this reads come from Parakeet TDT 0.6B v3 since 2026-10-16 (`server/ai/transcribe.js`; whisper for other languages).

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

POWER = weighted sum + a **mouth bonus** (≤ +12: recent XP ÷ 25 + 3 per beef win in 7 days). These mic ratings (the fighter page's POWER) use no audience numbers; the Clout Rankings above are where viewers, chat and followers count.

**Persona** (`chat` role, 24 h TTL): fighter name, title, class, element, moves, weakness, `taunt` + three `taunts` (ragebait in *their speaking voice*), `typing_style` (how they talk), `spoken_as` (nicknames/mishearings, fed to name detection), six `custom_stats` unique to them and `stat_quips` — written from their transcript lines, their best judged shit talk, who they call out, who calls them out and what they rant at. **Quotes**: AI-picked lines from the transcripts, VOD-linked. **Portraits**: the ones drawn earlier from their own stream frames stay; no new ones are drawn (the image provider was called with the shared key, and Live calls no model provider itself since roadmap WS-O task 2).

## The mic ledger (`server/arena/mic.js`)

`arena_mic_moments` — one row per judged line: `kind` (`trash` for free-standing shit talk, `beef_hit` when it fed a beef), `target_user_id` + `beef_id` for callouts, `aimed_at` (free text: "chat", "the mods", a name…), `text`, `about`, `quality`, `announcer`, VOD id + second, `said_at`. `feed()` is the live feed; `micStats(userId)` is what the ratings read.

**XP → Trash Level** (`arena_trash_levels`, level = 1 + XP ÷ 50): `trash` moment = quality × 0.8 · beef hit = quality · beef open +5 · beef win +40 (+20 upset) · hype received +1. Nothing else pays XP. The best line on record (highest quality) sticks to the profile.

## The ears (`server/arena/listener.js`)

Every 15 s, for every roster stream that is live **and** has a transcript line in the last 30 min:

1. New speech lines are read.
2. **Name detection** (`server/arena/names.js`) — a fighter is named only when their **whole** username or display name is said as it is spelled (camelCase/snake split, leet undone and spacing are fine: "mnss 22741", "grizzly bear"); pieces of a handle ("fix it" of finditfixit, "mnss"), nicknames (fighter name, `spoken_as`, a handle's first word) and fuzzy or phonetic sound-alikes never count (`findMentions(…, { wholeOnly: true })`). On 2026-10-18, 46 of the first 51 beefs had no whole name said (a League stream's "Minions" had matched mnss22741 phonetically); they were voided (`status = 'void'`, out of every record). The speaker never matches themselves.
3. **Focus lock** — a name-drop locks the ears on that fighter for 2 min; everything said afterwards goes to the **beef judge** with the context of what was already said (`about_target`, `aimed_at_target`, quality, best verbatim line, announcer call). A hit → `beef.recordHit()`; every hit extends the lock 3 min (cap 20 min without a fresh name-drop); two off-target chunks drop it; a different name switches targets.
4. **Free talk** — lines said while not locked pool for the **mic judge** (≥ 20 words, ≥ 30 s between calls per stream): `is_trash_talk`, quality, best line, `aimed_at`, announcer. Quality ≥ 4 → a `trash` moment in the feed. An `aimed_at` that is a roster fighter is dropped (nobody named them; a whole name said would have locked the ears instead), so free talk never opens a beef.
5. One judge call per stream per tick; keyword heuristics when AI is off.

`/arena/live/<username>` shows exactly what the ears hear: hot mic lines, the lock and its context, the last beef and mic judgements, their recent lines in the feed, open beefs.

## Beefs (`server/arena/beef.js`)

| Rule | Value |
|---|---|
| Opens when | the beef judge confirms ≥ 20 words aimed at a fighter after their whole name was said |
| Clock | the other side must answer on their own cam within **15 min if live**, **24 h if offline** (an offline clock tightens to 15 min the moment they go live) |
| Answer | any judged hit from the side on the clock; every hit flips the clock |
| Forfeit | clock runs out → the silent side loses |
| Hard end | 24 h after opening → higher **total** wins (`total = Σ hit quality + crowd hype (max 10)`), equal = draw |
| Upset | winner ranked ≥ 4 places below the loser (+20 XP) |
| Rematch | same pair again → flagged, with the rivalry's record and **receipts** (best lines from earlier beefs) |
| Crowd | `!hype` / Hype button: one per person per side — the only thing chat can do |

Every hit is also written to the mic ledger as a `beef_hit` moment. Headlines (open + result) are AI-written with templates as fallback; the announcer's one-liner per hit comes from the judge.

## Pages

`/arena` — ARENA ALERT: masthead and BREAKING ticker · the cams on air · the top story of the day · BREAKING (every story, reactions, ▶ to the moment, 🔊 the quote in their voice) · Lolcow Index · Clout Rankings · Beef Watch · Hot Mic (the latest judged lines) · how the desk works.
`/arena/drama/<id>` — one story with its receipts (the measured facts) and more on the same streamer.
`/arena/beef/<id>` — tale of the tape, tug-of-war, live clock, ringside feed, receipts, hype buttons.
`/arena/live/<username>` — the ears.
`/arena/<username>` — the rap sheet (cow meter, clout rank, beef W–L, their stories), then POWER, Trash Level card (judged lines, avg score, bangers, answered-when-called-out), the seven mic stats with drill-downs, their lines on record, characteristics radar, rap sheet, ragebait bubbles, on the mic (voice meters + quotes), rivalries, beefs.

Old `/arena/topic/*` and `/arena/chatter/*` links show a "this part is gone" note.

## Chat commands (`server/arena/arena-chat.js`)

`!hype` (the streamer's newest open beef) · `!beef` · `!arena [user]`. One command per person every 4 s. `!topic`, `!bounty` and `!board` no longer exist.

## API (`/api/arena`)

| Method | Path | Notes |
|---|---|---|
| GET | `/status` · `/fighters` · `/fighters/:user` · `/fighters/:user/stat/:stat` · `/live` | roster (`stats`, `stat_meta`, per-fighter `mic`, `last_line`), card (+ `beefs`, `rivalries`, `moments`, `best_lines`, `mic`), drill-down, live cams (`ears`, `last_moment`, `open_beefs`) |
| GET | `/feed?limit&since` | the shit-talk feed |
| POST | `/fighters/:user/refresh` | admin — regenerate persona |
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
| `arena_vote_salt` | `JWT_SECRET` | salt for anonymous hype hashing |

Background job (`server/arena/arena-job.js`): personas/portraits every 20 min (bounded, budget-aware) · listener every 15 s · beef clocks every 60 s.

Tests: `node test/arena.test.js` (roster, mic ratings, filter, quotes) · `node test/arena-mic.test.js` (ledger, beefs, listener tick, chat, API) · `node test/arena-voice.test.js` — all on a temp DB, no AI needed.

## Voice

Every 🔊 in the Arena calls `GET /api/arena/voice/<username>?t=<line>` (`server/arena/voice.js`): synthesized once in the streamer's equipped cosmetic chat voice (else their per-identity chat voice), cached on disk and for a week in the browser. `announcer` reads headlines in `arena_announcer_voice`. `arena_voice_daily_max` (2000) caps fresh syntheses per day; per-IP limits are 8/min anonymous, 30/min signed in.
