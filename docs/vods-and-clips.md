# VODs & Clips

## Finished media analysis

`LIVE_MEDIA_ANALYSIS=local` is the default: Live's existing frame and transcript jobs produce
VOD and clip overviews and timed transcripts. Set `LIVE_MEDIA_ANALYSIS=ai` to send each finished
VOD or clip's signed Media URL to OpenVibe.AI's `media.analyze` workflow (AI runs one analysis at a time at nice 15).
Live fills a missing overview (an overview it already has is kept), derives the short overview, and stores timed speech
segments in `vod_ai_state` or `clip_ai_state`. Live waits up to a minute for the run
(`LIVE_MEDIA_ANALYSIS_WAIT_MS`, 60000); a longer analysis is re-joined 15 minutes later by its idempotency key
(`live.media.analyze:<kind>:<id>:<attempt>`), so the same recording is never analysed twice at once and no loop waits
for it.
AI's signals, scenes, and highlights have no Live state columns and are not stored. Failed or
unavailable analyses retry with backoff; Live does not run its VOD/clip decoder in this mode.
Live stream captions and sound events continue using their real-time paths. The
`live_media_analysis_retry_total` metric counts deferred analyses by media kind.

Until a VOD's full transcript is in, `GET /api/vods/:id` serves the captions heard while it was live (the timeline rows
stamped with that VOD, moved into its own time) with `transcript_source: "live"`; the full pass replaces them. The full
pass runs after the stream and waits while the machine is busy, so a part that ended minutes ago used to show no
transcript at all (VOD 6026, 2026-10-26).

> Written before the media split. Storage, cutting, thumbnails and files now live in OpenVibe.Media;
> Live proxies to it (`server/media-proxy/`) and starts/stops recordings (`server/streaming/recorder.js`).
> Pastes live in OpenVibe.Community. Live's old local `vods`/`clips`/`pastes` tables are frozen: nothing
> writes or reads them ([below](#live-reads-nothing-from-the-frozen-tables)); the PostgreSQL
> schema has no copies of them. Implementation details below may be out of date.

## Recording System

OpenVibe.Live automatically records your streams as VODs (Video on Demand).

### Protocol-Specific Recording

| Protocol | Recording Method | Format |
|----------|-----------------|--------|
| **WebRTC (Browser, WHIP)** | Server-side: the SFU forwards the broadcaster's video and audio as RTP to OpenVibe.Media, which copies them | WebM (VP8 + Opus), MP4 (H.264 + AAC) from phones |
| **RTMP** | Server-side: OpenVibe.Media pulls the local RTMP endpoint and copies it | MP4 (H.264 + AAC) |
| **JSMPEG** | Not recorded (Media has no MPEG-TS ingest) | — |

A browser produces its audio a moment after its video. The recorder waits up to 5 s for it (`VOD_AUDIO_WAIT_MS`):
VOD 5986 (2026-10-25) was recorded silent because the recorder asked for the audio in the same instant the video
arrived, just before the microphone did. A stream with no microphone records video only after the wait. A microphone
that comes later, or a new one after the recorded one stopped, rolls the recording to a new part that has the sound.

A browser encoder sends a keyframe only when something asks for one, and the recording grows a keyframe at a time: until
the next keyframe, the newest footage is not in the file. Stream 2795 (2026-10-26) went up to 100 s between keyframes,
so a live clip of the last 30 s was cut from footage 80 s old and the live rewind moved in minute-long steps. The
recording now asks the broadcaster for a keyframe every 4 s (`VOD_KEYFRAME_SEC`, 0 turns it off), like an OBS
keyframe interval; viewers who lose a packet recover sooner too.

### Recording Lifecycle

1. **Start**: Recording begins when the stream goes live
2. **Live DVR**: A seekable sidecar file is generated periodically (every 60s for server-side, every 2 chunks for browser uploads) so viewers can rewind
3. **Finalize**: When the stream ends, the recording is remuxed for proper seeking, duration is probed, and a thumbnail is generated
4. **Auto-cleanup**: Recordings shorter than 10 seconds are automatically deleted (test streams, accidental go-lives)

### A stream that changes shape

A broadcaster who turns their phone, or whose connection makes WebRTC lower the resolution, sends frames of another
size partway through. The recording keeps them as they came. OpenVibe.Media's playback copy (its HLS timeline) is cut in
one part per shape, each with its own size, and the player switches between them, so a portrait part plays portrait.
Before 2026-10-26 it was squeezed into the first part's 16:9 (VOD 6017). A lowered resolution is not a new part: it is
scaled up to that part's size. A clip whose window crosses a turn shows its main shape, with bars for the rest.

The live player does the same for viewers: the box takes the picture's own ratio (`public/js/player-shape.js`), eases
to a new one when the broadcaster turns, keeps its size when only the resolution drops, and opens on the channel's last
shape. A blurred copy of the picture fills the sides of a tall picture.

### Browser Tab Close Safety

If you close the browser tab during a WebRTC stream, `sendBeacon` attempts to upload any remaining chunks. The server will auto-finalize when it detects the stream has ended.

## DVR / Live Seeking

Viewers can seek backwards in a live stream using the DVR controls:
- **Click/drag** the progress bar to seek
- **Arrow Left** — Rewind 5 seconds
- **Arrow Right** — Forward 5 seconds
- **LIVE button** — Jump back to the live edge

DVR availability appears after ~30 seconds of recording.

The bar spans the whole stream, not only the part being recorded. A broadcaster who reconnects (a phone dropping its
connection, a browser tab reloading) is recorded in parts, each its own VOD ("BIRD DRAMA (Part 2)"); the player reads
the stream's history and plays an earlier part from its own VOD when you seek into it, then carries on into the next.
Rewinding across a phone turn shows each stretch at its own shape: Media's DVR playlist starts a new period, with its
own init segment, at each change of shape.

## A stream's history

While a stream is live, Live keeps what happened to it, in stream time (seconds since it started), in
`stream_history` (`server/streaming/stream-history.js`):

| Kind | What | Kept from |
|------|------|-----------|
| `part` | a recording part: its VOD, where it starts and stops, why it rolled | the recorder |
| `shape` | the picture the broadcaster sends changed size (`WxH`) | the studio's outbound video stats |
| `reconnect` | the broadcaster came back, and how long it was gone | the broadcast socket |

`GET /api/streams/:id/history` answers `{ started_at, is_live, now_sec, parts, shapes, reconnects }`; a part whose
VOD the viewer cannot see is listed without it. Stream time minus a part's start is that part's own time, and that is
how the history is used:

- **Clips from the go-live studio**: the clip panel's marks are stream time; the server cuts the part that recorded the
  moment, in that part's time (`POST /api/vods/clips` with `stream_id`, `stream_time: true`, `start_time`, `end_time`).
  Stream 2795's studio sent those times to part 1 and Media refused them ("Start time exceeds video duration").
- **Transcripts, the Rundown, Vibe's voice clips and AI moments** move stream-time lines into the VOD's own time. The
  speech capture's offsets are stream time across a capture restart (they used to fall behind by every gap).
- **The rewind** above.

## Clips

Viewers can create clips from live streams:
1. Click the **Clip** button during a stream
2. Set the clip duration (default: 30 seconds)
3. The clip is saved from the server-side recording

Clips are **unlisted by default** — the stream owner can publish or delete them from the dashboard.

### Naming a clip

Naming is optional everywhere. Right after a clip is made without a name (the phone studio's **Clip** button, or the
dashboard's **Create Clip** with the name left empty), a card offers **Save name** or **Skip**. It closes by itself
after 20 seconds and never covers the stream's controls. Viewers name their clip in the trim editor when its cut is
ready.

A clip left unnamed (still "Untitled Clip", "Clip from stream" or "Clip: <stream title>") is named by the AI once its
overview exists: 3-6 words about what happens, never about what anyone looks like, and no slurs or strong profanity
(`server/ai/clip-title.js`). A name a person gives always wins, even one given while the AI was writing. The clip's
"clipped: …" line in chat waits up to 3 minutes for the AI's name.

## VOD Management

From the dashboard:
- Toggle VODs between **public** and **private**
- **Bulk delete** old media by age (e.g., delete VODs older than 30 days)
- Every delete (one, bulk, by age, or from the admin storage page) ends in `server/media-proxy/purge.js`
  once Media confirmed it: the comment thread is hidden, Live's own rows about the item go
  (`vod_ai_state`/`clip_ai_state`, `content_views`) and its Search document is re-read at once
- **Thumbnails** are auto-generated; broken thumbnails auto-regenerate on load

## Recordings and clips are watched on OpenVibe.Video

Every recording and clip has its page on OpenVibe.Video (`https://openvibe.video/v/<id>`, `/c/<id>`;
`server/web/video-url.js`, `VIDEO_PUBLIC_URL` overrides the origin): the player, AI chapters and captions, the chat
replay, comments, clipping, and the owner's visibility and delete, for private items too (to their owner). Live's old
`/vod/<id>` and `/clip/<id>` URLs answer a 301 there (`server/web/video-handover.js`, mounted before the SEO renderer
like the paste handover; a `?t=` start time goes along as seconds). Every watch link Live renders points there: the
SPA through `videoHref()` (the shell's `ov-video-base` meta names the origin), the server through `videoUrl()`. Live's
sitemap leaves recordings and clips out (Video's lists them), and the documents Live sends to OpenVibe.Search link
there. `/vods` and `/clips` stay on Live as the Content feed with a filter, linking out. Live keeps the recording
pipeline, the API (`/api/vods`, `/api/clips`) that OpenVibe.Video reads, and the owner's manager on the dashboard.

## Playback URLs

Every VOD and clip row Live answers (`/api/vods`, `/api/vods/:id`, `/api/clips`, `/api/clips/:id` and the per-user
lists) carries three URLs, set by `setPlaybackUrls()` in `server/media-client.js`:

- `playback_url`: Media's HLS master playlist (`…/o/<object>/master.m3u8`) when the object has a timeline, otherwise
  the byte route (`openvibe.media/v/<id>`, `/c/<id>`) for old and MP4-only objects.
- `hls_url`: the playlist alone, absent until Media has one. A private object's playlist is signed for
  `MEDIA_HLS_PLAYLIST_TTL_S` (Media's setting, 6 h by default): it is read from Media for each response and never
  stored or cached by Live (a private item's detail answer is `private, no-store`; a public object's playlist is unsigned).
- `file_url`: always the byte route, for anything that needs a real file (downloads, ffmpeg, previews).
  `GET /api/vods/:id/file` and `/api/clips/:id/file` redirect to it.

The watch pages play `hls_url` when there is one and fall back to the file. The server-rendered pages name no
playback URL at all: their schema.org `contentUrl` is the page and their `og:video` tags carry only the duration.

To save the file, `GET /api/vods/:id/download-url?name=…` and `/api/clips/:id/download-url?name=…` answer
`{ url, expires_at }`: the byte route with `?download=1&name=…`, which Media answers as an attachment named after
`name` (its real extension added), so a browser saves it instead of playing it. A private item (for whoever may see it)
gets a signed URL valid for 15 minutes. OpenVibe.Video's Download menu uses these.

## Views

A view is one `content_views` row per item and address: Live's detail read (`GET /api/vods/:id`, `GET /api/clips/:id`)
adds it. openvibe.video reads those over loopback, so its watch page counts its viewers with a beacon instead:
`POST /api/views/vod/:id` or `/api/views/clip/:id` (`server/media-proxy/view-beacon.js`), sent from the viewer's browser
when playback starts. It answers only `https://openvibe.video`'s origin, reads no cookie, counts only a public or
unlisted finished item (Live's visibility rule, remembered for a minute), is limited to 60 a minute per address, and
answers 204 whether or not it counted.

## Who sees a private VOD or clip

A private item (visibility `private`, or a legacy row with no visibility and `is_public = 0`) is visible only to its owners — the uploader or clipper, the clipped channel's streamer, the streamer whose stream it came from — and to staff (admin, global mod). Everyone else gets exactly the answer an unknown id gets: the same 404 and body on `/api/vods/:id` and its `live-info`/`memories`/`context`, `/api/clips/:id`, comments (including a comment's replies, edit and delete), thumbnail regeneration and the write routes (a 403 would confirm the id exists). It is also left out of `/api/chat-ai/vod-transcripts`, the server-rendered `/vod/:id` and `/clip/:id` pages, and `/api/streams/recent`. The rule lives in `server/media-proxy/access.js`; Media applies the same rule to `openvibe.media/v/:id` and `/c/:id`. Unlisted items stay reachable by direct link.

## Comments are OpenVibe.Community threads

Comments on a VOD or clip live in OpenVibe.Community, not in Live (roadmap Wave 5: Live and a second product share one Community thread). The thread of a VOD is the one Community keeps for the EntityRef `{ service: 'live', type: 'vod', id: '<vod id>' }` (`type: 'clip'` for clips). `/api/comments` keeps its paths and response shapes; `server/media-proxy/comments.js` is an adapter over `server/comments-client.js`:

- **Who sees them.** Live checks the VOD/clip with `access.js` first (a private item's comments are missing like the item), then resolves the thread with its service token (`community.comment.write`, audience `openvibe.community`) and remembers the thread id in `comment_thread_refs`. Community refuses browsers that try to open live/vod or live/clip threads themselves, so a private item's thread is reachable only through Live.
- **Who writes.** Signed-in people only, as before (Community refuses anonymous comments on these threads too). Live sends the person's Network subject (`X-OV-Subject`, from `linked_accounts.subject_id`); an account without one gets 409 "sign in again". Community's own limits apply (10 s between comments, 5 a minute, no repeats) and come back as the error message.
- **Edit** — the author only. **Delete** — the author (as themselves), staff (admin/global mod, as themselves with `X-OV-Staff: 1`, which needs `community.comment.moderate`), or the item's owners (uploader or clipper, the clipped channel, the streamer whose stream it came from — Live deletes for them as itself with `community.comment.moderate`). A top-level comment with replies stays as a tombstone (`deleted: true`).
- **Deleting** a VOD or clip (the player, the dashboard bulk actions, the admin storage page) hides its thread.
- **Moderation in Community** shows here: a thread Community's moderators hid answers `404 { code: "comments_hidden" }` on Live too, and a locked one refuses new comments with Community's message.
- **Community down** — every `/api/comments` route answers `503 { error: "Comments are unavailable right now", code: "comments_unavailable" }` and the player says so; it never shows an empty list. `comment_count` on `/api/vods/:id` and `/api/clips/:id` is `null` then (short timeout, skipped for 30 s after a failure).
- **The same thread elsewhere.** For public and unlisted items the list carries `thread: { id, url }` — the thread's page on OpenVibe.Community (`https://openvibe.community/c/<access id>`), linked under the comments as "View this thread on OpenVibe.Community". Comments made there show on Live and the other way round.

Live's old `comments` table is read-only (`test/frozen-tables.test.js` fails if server code writes it). Its rows were moved with OpenVibe.Community's `scripts/import-live-comments.js`: dry run by default, `--apply` only with `--backup` of Community's database, a ledger so re-runs import nothing twice, authors mapped to Network subjects (unmapped ones held and listed), and a reconciliation `read = imported + held + excluded`. The exact production commands are in OpenVibe.Community's README ("Live's VOD and clip comments").

## Chat Replay

VODs include synchronized chat replay. Messages are stored in the database with timestamps relative to the stream start. Deleted messages are automatically excluded from replay (soft-delete with `is_deleted` flag).

## AI moments: pastes and clips never overlap

Two jobs turn stream moments into content: `server/ai/ai-moments-job.js` (image **pastes** for the home hero + pastes tab, every 6 h) and `server/ai/auto-clip-job.js` (live chat-spike **clips** + a VOD backfill). They used to pick the same second of the same VOD with the same title. Now:

- **One shared registry** — `server/ai/moment-registry.js` (`ai_used_moments` state) records every paste/clip (`vod_id`, `stream_id`, `offset`, scene signature, title). Both jobs ask it before creating anything: a moment is refused if it is within **2 min** of a used moment on the same VOD/stream, or if its scene signature (first five words of the description) was used in the last two weeks. Legacy logs are imported once.
- **Flavoured picks** — `findBestMoment(vod, { flavor, avoid })`: `paste` asks for a frame that is striking on its own (a face, a gag, something odd on screen); `clip` asks for a beat that plays out over 25 s (a line, a reaction, a sound, chat exploding). The prompt lists the already-used timestamps and the model is told to stay away from them; if it still lands next to one, the objective signals (viewer clips, chat spikes, richest scene notes) pick a free spot.
- The paste job no longer clips the paste's own moment; it asks for a **second, different beat** from the same VOD for the clip. The clip backfill avoids every offset a paste used.
- **Live pastes** — the stream-memory vision call now also answers "is this frame screenshot-worthy?" with a caption (no extra call). When it says yes, `stream-memory-job` posts the frame as an image paste right away (≤ 1 per stream per 90 min, dark-frame and registry checks, setting `ai_live_pastes_enabled`, default on). These pastes carry `metadata.live = true` and no VOD link.
- **Only good live clips, cut on sentences** — a live chat spike is not enough on its own. `server/ai/clip-score.js` scores the moment from 0 to 1: the spike (how far above the window's average and how big), how many people reacted, what was heard (laughter, cheering, a bang; music and speech alone count for nothing), how much was said, and the AI's yes or no (a no is a veto; with the AI off its part is neutral and both bars rise by 0.1). Below **0.40** no clip is cut, the log says why ("a weak chat spike (10 messages, 3.1× the average)"). From 0.40 the clip is made **unlisted**: the streamer can find it and make it public. Calibrated by the production audit (C01, `scripts/diagnostics/clip-audit-*.sql`: the old rule made 99.6 % of automatic clips public and 29 % were never watched in 30 days): a moment needs **evidence** to be kept at all (a spike of at least 3× the average and 10 messages, a strong sound, or 20 spoken words; the AI's yes alone is not enough), and it is cut **public** only at **0.70** or more **and** in the reacted bucket: at least 12 messages in the peak from at least 3 people (`chatReads.recentChatters`; unknown means unlisted). Every cut logs its bucket (A no chat, B 1–5, C 6–11, D 12+ with 3+ people), peak and chatters for the next audit. `server/ai/clip-trim.js` then moves the fixed 16 s before / 9 s after window onto the speech rows: the start goes back to where the sentence being spoken began (so the setup is in), at most 25 s before the moment; the end goes on to where the sentence ends, at most 20 s after, never past the recording's flushed edge. A snap that would make the clip shorter than 12 s or longer than 45 s is not taken. Both are pure, with their cases in `test/clip-score-trim.test.js`.
- **Fewer tokens** — VOD showcase scores are cached for 7 days (`home_hero_moments.rankCache`); a run only scores VODs it has never scored. Every `llm.complete` call keeps its `kind` so `ai_usage` shows exactly where the budget goes (`moment_vod_rank`, `moment_pick`, `moment_frame`, `stream_memory`, `auto_clip_confirm`).

## AI-inferred category

Go-live used to default every stream to `irl`, so every AI prompt (AI viewers, streamer overviews, VOD overviews, the Arena, sound detection) assumed everyone is an IRL streamer. Now the category selector defaults to **Auto** (stored as `NULL`), and the stream-memory rollup — the same summarise call that already runs — returns `{ overview, category, tags }` with `category` from the fixed taxonomy (`outdoors, travel, building, music, gaming, robot, desktop, irl, other`). It is stored on `streams.ai_category` / `streams.ai_tags` and the channel inherits the latest read (`channels.ai_category`).

Everything reads the effective value: listing queries return `COALESCE(ai_category, category) AS category` (the self-selected value is still there as `chosen_category`), `stream_category` on VODs/clips, the AI viewers' session block ("judged from the stream itself"), streamer overviews, sound detection and the Arena all prefer `ai_category`. A streamer can still pick a category manually; the AI read wins once it exists.

## Live reads nothing from the frozen tables

Live's local `vods`, `clips`, `pastes`, `paste_likes` and `paste_comments` tables stopped at the Media
split: nothing recorded, clipped or pasted since then was ever in them, and OpenVibe.Media (VODs and clips,
same ids) and OpenVibe.Community (pastes, by slug) hold the old rows too. Since
register item C-73 step 2, no Live code reads them. `test/frozen-tables.test.js` fails on any write or read
of these tables in `server/` or `scripts/` (SQL text, split over lines too, and `table: '…'` registries). Its
allow-list of kept reads is empty. A read that has to stay goes into that list with a reason, and into this
page.

What used to read them, and what answers now (most of it in `server/media-proxy/lookups.js`):

| Page or job | Now asks | Hidden items |
|---|---|---|
| Recently ended streams (`/api/streams/recent`): VOD id, thumbnail, duration | Media, per stream (cached 5 min) | never: public VODs only |
| Recently online cards: slot thumbnail | Media `GET /vods/latest-thumbs` (the route already did) | never |
| Channel page badges: pastes, clips taken | Community (pastes), Media (clips, `hide_self`) | owner and staff only |
| Channel offline screen: top VOD and clip per week, month, all time | Media, newest 100 plus most-viewed | never |
| Workspace session history: each session's VOD | Media by slot (`managed_stream_id`) | owner only (private and recording included) |
| Setup hub: "Publish a paste" | Community, as the person | the person's own |
| Settings: avatar history | Community, as the person (screenshots tagged `metadata.kind = 'avatar'`) | the person's own |
| AI timeline (channel AI tab): each session's VOD link | Media by user, public only; not cached while Media is down | never |
| Transcript view: the stream's VOD | Media (the old local fallback is gone) | never |
| Home hero, kiosk, SEO snapshot: VOD, clip, hour and paste counts | Media `/stats`; pastes from Community `/api/pastes/admin/stats` | counts only |
| Home "over time" charts for VODs, clips, hours | Media `/stats/series/*` (the route already did) | counts only |
| Admin dashboard: VOD totals | Media list totals (null when Media is down) | staff |
| Admin AI explorer and the streamer overview job: VODs, clips, pastes | Media and Community | staff: any visibility (the overview job reads public VODs) |
| AI moments and auto-clip jobs: VOD pool, VOD source, where viewers clipped | Media (no local fallback: Media down means no run) | internal signal only |
| Stream analytics: clips per stream | Media, written into `stream_analytics.clips_created` right after the stream ends | internal |
| Arena portraits: VOD thumbnails | Media, public VODs | never |

Removed from `server/db/database.js`: 45 exported helpers that had no caller (VOD health, public VOD and clip
lists, the old paste API, paste comments and likes, filtered channel lists), the 11 whose callers now ask Media
or Community, and the boot-time migrations that still rewrote rows of the frozen `vods`/`clips` tables (short
overviews, transcript status) along with the indexes that only served the removed listings. The streamer
overview job now only considers streamers with stream memories; the frozen `vods` table was its other signal,
and its rows moved to Media at the split.

### API additions that would help (not blocking)

- **Media: `GET /vods?stream_ids=1,2,3`** (a batch filter). `/api/streams/recent` asks once per stream now, up
  to 100 calls on a cold cache.
- **Media: `created_after` on `GET /vods` and `GET /clips`.** The offline screen's week and month windows are
  cut from the newest 100 items; a streamer with more than 100 in a month loses that month's oldest.
- **Media: `order=peak_viewers` for real.** It is an alias of `views` in Media. Live has `streams.peak_viewers`
  but cannot sort Media's list by it.
- **Community: list by owner subject** (`GET /api/pastes?owner=usr_…`). Live lists a person's pastes by
  username, which relies on Community's projection cache knowing that username.
- **Community: a metadata filter** (`GET /api/pastes?metadata.kind=avatar`). Avatar history lists up to 200 of
  the person's screenshots and keeps the avatar-tagged ones.
- **Community: a public paste count.** The hero reads Community's staff-only `/api/pastes/admin/stats` with
  Live's `community.paste.moderate` grant. Media's `/stats` and `/stats/series/pastes` still count Media's
  frozen paste copies; the hero's paste chart does too.
