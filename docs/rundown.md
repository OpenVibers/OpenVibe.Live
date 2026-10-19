# The Rundown (2026-10-19)

**The Rundown** (`/rundown`) is what streamers talked about, written up: the topics, each streamer's take in their own words with a link to the moment, and every stream as an episode with a recap and chapters. It replaced the Arena (the competitive drama desk: viewer-crash stories, the Lolcow Index, Clout Rankings, mic ratings and beefs). In the owner's words: "gathers topics and stuff the streamers talk about and is less about competing with eachother and more about talking shit and fleshing out stories and creating content for people to look through".

- [The desk](#the-desk)
- [What is kept, and what never is](#what-is-kept-and-what-never-is)
- [Pages](#pages)
- [API](#api)
- [Data](#data)
- [Chat](#chat)
- [Settings and limits](#settings-and-limits)

## The desk

`server/rundown/desk.js` runs every 5 minutes. It reads streams' speech-to-text (`stream_timeline_events`, kind `speech`, from Parakeet; whisper for other languages) a stretch at a time:

1. **A stretch.** The unread speech of one stream, game announcer lines left out, at most ~2,400 words (about 15 minutes of talk). A live stream is read once the stretch holds 700 words or spans 10 minutes with 150 words; an ended stream is read to the end.
2. **Segments.** OpenVibe.AI's `live.rundown.segment` gets the stretch with the stream's title and category, the 50 most recent topic names (so the same subject keeps one topic) and what the stream covered so far. It returns up to 4 segments, each with:
   - a **topic**, concrete ("Supermarket fridges hacked in France", never "news"), and its kind (news, games, tech, life, music, sports, money, internet, chat, other);
   - a **headline**, **what** they talked about and **their take**;
   - the desk's **quip**, a dry late-night-host line about the take or the situation;
   - a 1–5 **score**;
   - up to two **quotes**, copied word for word, with an English translation when they spoke another language.
3. **Topics.** A segment joins the topic with the same slug, else a recent topic whose key words mostly match, else a new topic. A topic with new takes (2 or more in all) gets its page rewritten by `live.rundown.topic`: a headline, plus a summary of who said what and where they agree or clash.
4. **Episodes.** When an ended stream is read to the end, `live.rundown.episode` writes it up from its segments: title, logline, a recap in 2–3 short paragraphs and chapters (VOD timestamps). A stream with no segments gets no episode.
5. **Crossovers.** A segment records the streamers it named. Only a whole username or display name said as it is spelled counts (`server/arena/names.js`, `wholeOnly`), never a sound-alike or a nickname. Naming someone is talking, not a fight: there are no beefs, scores or winners.

The first deploy reads back the last 7 days, newest streams first. At most 4 AI calls a tick and 40 an hour, only while AI is on and within budget. All calls go to the `live.creative` route.

## What is kept, and what never is

Speech-to-text hears a stream's whole audio track. On 2026-10-18 the Arena's "quote of the day" was League of Legends' announcer ("You have slain an enemy"), credited to a streamer. The desk's rules (`server/rundown/filters.js` and the prompts in OpenVibe.AI):

- **Game lines** (League, Counter-Strike and Valorant announcer and system lines) never reach the AI and are never a quote. Neither does a line heard word for word on 3 or more different streams in 30 days: a game's voice lines ("Wanna see a trick?"), speech-to-text's hallucinations on silence ("Thanks for watching, and I'll see you in the next video.") and stock filler. The prompt tells the AI that announcers, characters, lyrics, ads, video narration and articles read aloud are never the streamer; a reaction to them is the take.
- **Other languages.** A line in a language the streamer doesn't speak never reaches the AI. Their languages are those in 10% or more of their lines over 30 days, the top one always: iZoR_One speaks Greek and English, so a Portuguese clip playing in the background isn't theirs.
- **Who speaks each line.** The AI first returns `others`, the times of the lines that aren't the streamer (game characters, videos, songs, other people). A quote from one of those lines is dropped, and so is a segment whose lines are mostly theirs. A game character's boasts ("Kneel before me or bleed out.") are the game even in English.
- **A quote** is kept only when it is in the streamer's own lines the AI read, word for word.
- **No invented accusations.** A headline, account or take that uses an accusing word (threat, attack, scam, hacked…) the transcript never used drops the whole segment; in a quip, only the quip goes. Episodes and topic pages follow the same rule.
- **No looks, ever.** Every text passes `db.noLooks()`, and the prompts forbid jokes about looks, body, clothing, age, race, religion, sexuality, gender or disability, sexual content about anyone, threats and self-harm jokes. Swearing is fine.
- **Names and pronouns.** Names are written exactly as given, and people are called by their name or "they".
- **Opting out.** A streamer can keep themselves out ("Keep me out of The Rundown" on their page, `PUT /api/rundown/opt-out`; the Arena's opt-outs carry over). The desk stops reading their streams, and what was written about them is set aside (status `out`). Coming back restores it, never anything staff took down.
- **Staff** take an item down with `POST /api/rundown/hide {type, id}` (segment, episode or topic).

## Pages

- `/rundown`, the front page:
  - the masthead (date, counts) and the "On air now" strip, showing who is live and what they are talking about;
  - **The latest:** episodes and the best takes (score 3 and up, or naming someone), newest first;
  - **Trending topics** this week (most streamers, then most takes);
  - **Who's been talking:** each streamer with their top topics, and how the desk works.
- `/rundown/topics` lists every topic, by most recent or most talked about, with a filter by kind.
- `/rundown/t/<slug>` is one topic: the desk's summary, every take (newest first), and the topics that came up in the same streams.
- `/rundown/e/<streamId>` is one episode: logline, recap, chapters, what they talked about, and more from the streamer. A live stream shows what the desk has heard so far.
- `/rundown/<username>` is a streamer's page: what they talk about (topics with counts), best lines, episodes and crossovers.
- **Every card:**
  - reactions (🔥 😂 💀 🧢 💯), one per reader;
  - ▶ to the moment in the VOD;
  - 🔊 to hear a quote in the streamer's chat voice (`/api/rundown/voice/<user>?t=`, server/arena/voice.js).
- **Search:** the front page and topic index are indexed. Topic, episode and streamer pages are AI-written text about real people, so they are `noindex,follow` (server/seo/pages.js).
- **Old links:** `/arena` and its pages redirect (301) to `/rundown`, and a fighter's `/arena/<username>` goes to `/rundown/<username>`.

## API

`/api/rundown` (server/rundown/routes.js):

| Method | Path | Notes |
|---|---|---|
| GET | `/` | `on_air`, `latest` (+ `next`), `trending`, `voices`, `counts` |
| GET | `/latest?before=` | the next page of the latest |
| GET | `/topics?sort=recent\|most&kind=` | every topic |
| GET | `/t/:slug` | `topic`, `takes`, `related` |
| GET | `/e/:streamId` | `episode`, `stream`, `segments`, `more` |
| GET | `/s/:username` | `user`, `episodes`, `topics`, `lines`, `crossovers` (or `opted_out`) |
| POST | `/react {type, id, reaction}` | segment or episode; fire, lol, dead, cap, facts; the same again takes it back |
| POST | `/hide {type, id}` | staff |
| GET, PUT | `/opt-out {out}` | signed in |
| GET | `/voice/:user?t=` | a line in the streamer's chat voice |

A person in any answer is `{ id, username, display_name, avatar_url, profile_color }`.

## Data

Migration `0010_rundown.sql`:

- `rundown_topics`: slug, title, kind, the desk's headline and summary, counts, first and last seen.
- `rundown_segments`: stream, streamer, topic, seconds, headline, what, take, quip, score, verified quotes, named streamers (`mentions`), VOD, said at.
- `rundown_episodes`: one per stream, holding the title, logline, recap, chapters, VOD and minutes.
- `rundown_progress`: how far the desk has read each stream.
- `rundown_reactions`: readers' reactions.

The Arena's tables are no longer written; their code goes in a later change.

## Chat

When an episode is written within 6 hours of its stream ending, it is announced in global chat as **THE RUNDOWN**, at most 3 an hour. Chat still forwards the Arena's commands: `!arena [user]` answers with the streamer's latest episode and topics plus a link, and `!hype` and `!beef` say beefs are gone and point to The Rundown.

## Settings and limits

| Key | Default | Effect |
|---|---|---|
| `rundown_enabled` | `true` | `false` stops the desk (pages keep what was written) |
| `ai_timeline_enabled` | `false` | the speech-to-text the desk reads: must be on |

Tests: `test/rundown.test.js` (filters, the desk on a stubbed AI, topics, episodes, opt-outs, the API and the redirects).
