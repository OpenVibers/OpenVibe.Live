# The Rundown (2026-11-06)

**The Rundown** (`/rundown`) is what streamers talked about, written up: the topics, each streamer's take in their own words with a link to the moment, and every stream as an episode with a recap and chapters. It replaced the Arena (the competitive drama desk: viewer-crash stories, the Lolcow Index, Clout Rankings, mic ratings and beefs). In the owner's words: "gathers topics and stuff the streamers talk about and is less about competing with eachother and more about talking shit and fleshing out stories and creating content for people to look through".

- [The desk](#the-desk)
- [What is kept, and what never is](#what-is-kept-and-what-never-is)
- [Who sees it](#who-sees-it)
- [The recording decides first](#the-recording-decides-first)
- [Deleting](#deleting)
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
   - a 1–5 **score** for a reader who missed the stream (a 1 or 2 is filler and isn't kept; in-game reactions are a 2 at most). Play-by-play (kills, deaths, teammates, rounds as they happen) is not a segment: a game segment needs an opinion, a story, a plan, a bit or an argument, and the episode recap covers the rest;
   - up to two **quotes**, copied word for word, with an English translation when they spoke another language.
3. **Topics.** A segment joins the topic with the same slug, else a recent topic whose key words mostly match, else a new topic. A topic names a subject ("League autofill", "Boxing fight night"): a kind, a word for streaming or a name made only of words for a mood or the play ("Frustration and chaos in the match", "Talking with chat and teammates") is no topic (`filters.vagueTopic`), and those names are never offered back to the AI. A stream keeps its best 2 takes on one topic, and 2 with no topic: a better one replaces the weakest, the rest go. One night of League once filled a single mood topic with 106 takes of play-by-play. A topic with new takes (2 or more in all) gets its page rewritten by `live.rundown.topic`: a headline, plus a summary of who said what and where they agree or clash.
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
- **Nothing that places a person.** The prompts forbid writing or quoting where anyone is, lives or will be (named places, events, schools, towns, time zones), their school, workplace or family. After the AI, `filters.privateDetail` drops any segment, quote, quip, episode text or topic page that names a time zone, a school, a street address, a phone number or an email address. When someone seems to be under 18, the desk is kind: no roasting and nothing about school.
- **Kind, not cruel.** The prompts forbid mocking anyone's race, religion, sexuality, gender or disability, sexual content about anyone, threats and self-harm jokes. Describing people is fine (2026-10-31). Swearing is fine.
- **Names and pronouns.** Names are written exactly as given, and people are called by their name or "they".
- **Opting out.** A streamer can keep themselves out ("Keep me out of The Rundown" on their page, `PUT /api/rundown/opt-out`; the Arena's opt-outs carry over). The desk stops reading their streams, and what was written about them is set aside (status `out`). Coming back restores it, never anything staff took down.
- **Staff** take an item down with `POST /api/rundown/hide {type, id}` (segment, episode or topic).

## Who sees it

A streamer decides who sees their Rundown with the same Share sheet the rest of the network uses: **Everyone**, **Anyone with the link**, **Specific people**, **Only me** (`server/rundown/visibility.js`, `server/rundown/sharing.js`).

- **One setting per episode, not per take.** An episode is registered in the sharing system when the desk writes it up (`kind rundown-episode`, service `live`, the stream id as its resource), and its Share sheet changes it afterwards. **A segment follows its episode:** the pages read the episode's setting, never a second one. The share row goes when the episode is deleted (see [Deleting](#deleting)).
- **The default** is in **Your Rundown**, the box at the top of the streamer's own Rundown page (`/rundown/<username>#mine`; the line under the Rundown's title links to it when signed in) (`GET|PUT /api/rundown/settings`, `server/rundown/settings.js`): Everyone until the streamer changes it. It applies to the write-ups made from then on. An episode that already has its own setting keeps it; a default never overrules the sheet.
- **Each episode has its own Share sheet.** That is the only place its setting is changed (`/api/v1/<kind>/<id>/share`, the network's own share API, `server/rundown/sharing.js` and `shareRouterFor` in `server/index.js`); there is no second Rundown-only control. On their own episode the streamer sees **Who sees it** (and, when the recording is stricter, that the episode follows it and where to change that), **Share** and **Delete episode**; the episode and streamer reads answer `mine`, so these never wait for the page's signed-in state. An episode written up before the sharing system had no share row, so its owner's first visit registers it as Everyone, which it already was.
- **Keep me out** stays and is stronger: it means Only me for everything and no new write-ups at all while it is on. Coming back restores the write-ups, never anything staff took down.
- **The streamer sees all their own items everywhere**, each non-public one marked with a small chip ("Only me", "Link", "3 people").
- **A take that names another streamer** never reaches that streamer's page and never notifies them while it is not Everyone.

### Gathered pages show Everyone only

The pages that put many people's items together show Everyone items and nothing else:

- the front page and stream by stream, the topics index, topic pages, trending, who's been talking, the streamer list, and the "more from the streamer" on an episode page;
- the counts ("789 takes", "4 streamers") count Everyone items only;
- a topic whose takes are all non-public disappears from those pages, and its page answers 404;
- **the after-show report follows the same setting** (`/recap/:streamId`, `server/recap/routes.js`): a list of reports shows Everyone ones plus the streamer's own, and `GET /api/recap/:streamId` answers 404 to a reader the episode is not shared with.

Who may open one episode: Everyone and Anyone with the link are open to anybody; Specific people is the people on the list; Only me is the streamer.

## The recording decides first

An episode is the write-up of one stream, and its VOD is that same stream. They must not disagree in the direction that leaks, so **the recording decides first**.

- **The rule:** the episode's audience is the stricter of its own setting and its VOD's visibility. Order of strictness: **Only me**, then **Specific people**, then **Anyone with the link**, then **Everyone**. A segment, the whole episode and the after-show report all follow it.
- **Specific people on both sides:** the people on both lists.
- **A stricter VOD** (unlisted or private) takes the episode, its segments and its report with it at once, and the episode page says **"Following the VOD: unlisted"**.
- **A VOD that becomes public again** gives the episode back its own setting. It never becomes wider than the streamer chose for the episode.
- **Where the VOD's setting comes from** (`server/rundown/visibility.js`):
  - Live's own VOD pages apply it in the same request (`server/media-proxy/vods.js`, including bulk);
  - a change made elsewhere (MediaHub, openvibe.video) arrives as Media's `media.object.visibility_changed` event (`server/media-proxy/outcomes.js`);
  - until that event lands, the episode page re-checks through `media-client` when it is opened, cached 60 s.
- **Media's words** map onto the four: `public` → Everyone, `unlisted` → Anyone with the link, `private` → Only me. Media has no Specific people, so a VOD's people list is Live's own, and the two lists are intersected.
- **Segments with no VOD** (nothing was recorded) follow the episode alone. **A deleted VOD** removes its write-ups (Live #605, unchanged).

## Deleting

The streamer can delete their own items. Each delete asks first, in the page (a sheet on the phone, a card on a wide screen), and says what goes (`POST /api/rundown/delete/*`, `server/rundown/delete.js`):

| What | From where | What goes |
|---|---|---|
| **One take** | the bin button on the take, wherever it is listed | that take |
| **One episode** | **Delete episode** on the episode page, next to Share | the episode, all its takes, its after-show report; the page then offers **Write this stream up again** (`POST /api/rundown/restore`) |
| **All my Rundown** | **Delete my Rundown** in Your Rundown | every take and episode of theirs, and the after-show reports, plus an offer to also "Keep me out" from now on (`keep_out`) |

- **Deleted is deleted.** The rows are removed, not hidden. Topics recount and a topic left with nothing is removed, its page cleared. The sharing row goes with the episode.
- **The receipt:** "Deleted 1 episode and 12 takes".
- **The VOD stays.** Deleting a write-up never touches the recording.
- **The desk does not write that stream up again** unless the streamer asks: `POST /api/rundown/restore` ("Write this stream up again") lets the desk read that stream once more.
- **Staff hiding** (`status 'hidden'`) stays as it is, for moderation.

## Pages

- `/rundown`, the front page:
  - the masthead (date, counts) and the "On air now" strip, showing who is live and what they are talking about;
  - **Top take:** the best take of the last day (else the week), its quote set large;
  - **Stream by stream:** each stream the desk wrote about, newest first, with its episode title and logline (or, live, a Live now tag) and its 3 best takes on a timeline: the moment's timestamp (▶ to the VOD), the topic, the headline, the quote (else what they talked about), the desk's quip and reactions. "Read the episode" opens the rest. 8 streams a page (`/api/rundown/streams?before=`);
  - **Trending topics** this week (most streamers, then most takes);
  - **Who's been talking:** each streamer with their top topics, and how the desk works.
- `/rundown/topics` lists every topic, by most recent or most talked about, with a filter by kind.
- `/rundown/t/<slug>` is one topic: the desk's summary, every take (newest first), and the topics that came up in the same streams.
- `/rundown/e/<streamId>` is one episode: logline, recap, chapters, what they talked about, and more from the streamer. A live stream shows what the desk has heard so far.
- `/rundown/<username>` is a streamer's page: what they talk about (topics with counts), best lines, episodes and crossovers.
- **Everyone sees the same pages; what is on them differs.** A signed-out reader, or anybody but the streamer, gets Everyone items only (see [Who sees it](#who-sees-it)). The streamer sees their own items everywhere, each non-public one marked with its audience chip.
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
| GET | `/` | `on_air`, `lead`, `streams` (+ `streams_next`), `trending`, `voices`, `counts` |
| GET | `/streams?before=` | the next page of stream by stream |
| GET | `/topics?sort=recent\|most&kind=` | every topic |
| GET | `/t/:slug` | `topic`, `takes`, `related` |
| GET | `/e/:streamId` | `episode`, `stream`, `segments`, `more` |
| GET | `/s/:username` | `user`, `episodes`, `topics`, `lines`, `crossovers` (or `opted_out`) |
| POST | `/react {type, id, reaction}` | segment or episode; fire, lol, dead, cap, facts; the same again takes it back |
| POST | `/hide {type, id}` | staff |
| GET, PUT | `/opt-out {out}` | signed in: keep yourself out (or come back) |
| GET, PUT | `/settings` | signed in: "Your Rundown": the default audience for new write-ups, and whether you keep yourself out |
| POST | `/delete/take {id}` | signed in: delete one of your takes |
| POST | `/delete/episode {stream_id}` | signed in: delete one of your episodes with its takes |
| POST | `/delete/all {keep_out}` | signed in: delete all your Rundown, optionally keeping yourself out from now on |
| POST | `/restore {stream_id}` | signed in: "Write this stream up again" |
| GET | `/voice/:user?t=` | a line in the streamer's chat voice |

A person in any answer is `{ id, username, display_name, avatar_url, profile_color }`. A stream in `on_air` or `streams` also carries `thumbnail_url`: its public VOD's thumbnail once it has ended, its live frame while it is on air, and `null` for an NSFW stream or when Media has no picture.

## Data

Migration `0010_rundown.sql`:

- `rundown_topics`: slug, title, kind, the desk's headline and summary, counts, first and last seen.
- `rundown_segments`: stream, streamer, topic, seconds, headline, what, take, quip, score, verified quotes, named streamers (`mentions`), VOD, said at.
- `rundown_episodes`: one per stream, holding the title, logline, recap, chapters, VOD and minutes.
- `rundown_progress`: how far the desk has read each stream.
- `rundown_reactions`: readers' reactions.

Migration `0029_rundown_audiences.sql` (expand only, 2026-11-06) holds what the sharing system does not know:

- `rundown_visibility`: per stream, what the recording decides as the last thing Live heard about it (`vod_audience`, and `vod_members` for Specific people, which Media has no notion of). A stream with no row is Everyone.
- `rundown_prefs`: the streamer's default audience for new write-ups. No row is Everyone.
- `rundown_deleted`: a write-up the streamer deleted; the desk never writes that stream up again on its own.

An episode's own setting is not here: it is the sharing system's share row (`kind rundown-episode`, service `live`, `resource_id` the stream id), in the SDK's `shares` and `share_members` tables (Live's migration `0027`). `scripts/rundown-vod-backfill.js` fills `rundown_visibility` from Media for every stream already written up.

The Arena's tables are no longer written. Its pages, styles and readers are gone (the recap, the home digest, the star pick and the VOD stats read The Rundown); its server code and `/api/arena` went on 2026-10-19 (Live#264), and its tables with migration `0015_drop_arena` (applied after 2026-10-23 18:34 UTC). `arena_opt_outs` stays: it is The Rundown's list of streamers who keep themselves out.

## Chat

When an episode is written within 6 hours of its stream ending, it is announced in global chat as **THE RUNDOWN**, at most 3 an hour. Chat still forwards the Arena's commands: `!arena [user]` answers with the streamer's latest episode and topics plus a link, and `!hype` and `!beef` say beefs are gone and point to The Rundown.

## Settings and limits

| Key | Default | Effect |
|---|---|---|
| `rundown_enabled` | `true` | `false` stops the desk (pages keep what was written) |
| `ai_timeline_enabled` | `false` | the speech-to-text the desk reads: must be on |

Tests: `test/rundown.test.js` (filters, the desk on a stubbed AI, topics, episodes, opt-outs, the API and the redirects) and `test/rundown-audiences.test.js` (the four audiences and who may see each, the gathered pages and their counts, a non-public take never reaching the streamer it names, the recording's rule, and deleting). `test/recap-audience.test.js` covers the after-show report's setting.

## The bar: search and filters

The state of a view is its URL: `/rundown?streamer=goosely&topic=drake-and-objectives&when=week&q=baron`. Every
filter is in it, so a view can be shared and the back button works.

| Filter | In the URL | What it does |
|---|---|---|
| the search | `q` | the words, over the take titles, what was said, the desk's quips, the quotes, the episode titles and loglines and the topic names (a phrase in quotes is a phrase) |
| Streamer | `streamer` | one or more names, comma separated |
| Topic | `topic` | one topic's slug |
| When | `when` | `day`, `week` or `month` |
| Show | `show` | `takes`, `episodes` or `topics` (no `show` is the Latest view: takes and episodes) |
| Sort | `sort` | `newest`, `reacted` or `takes` |
| With video | `video=1` | only the takes that jump to a moment |
| Following | `following=1` | only the streamers the reader follows (signed in) |
| Mentions me | `mentions=1` | only the takes that name the reader (signed in, a streamer) |

- `GET /api/rundown/browse?q=&streamer=&topic=&when=&show=&sort=&video=&following=&mentions=` — the results the
  filters ask for, the counts (`"34 takes from 6 streamers"`), and, when nothing matches, the filter to drop and
  the closest topics by name.
- `GET /api/rundown/options` — the lists the pickers show: the streamers who have been talking, the topics (trending
  first).

The words come from the `search_tsv` columns migration `0030_rundown_search.sql` fills (a tsvector per row and a
GIN index, English configuration). A streamer's name is matched by prefix, not by word.

Only the plain front page, a single streamer's page and a single topic's page are indexable. Every filter
combination and every search is `noindex,follow`, with a canonical to the nearest of those, so a crawler never gets
an endless filter space.
