# VODs & Clips

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
| **WebRTC (Browser)** | Browser-side MediaRecorder, chunks uploaded to server | WebM (VP8/VP9 + Opus) |
| **RTMP** | Server-side FFmpeg capture | WebM (VP8 + Vorbis) |
| **JSMPEG** | Server-side FFmpeg via WebSocket relay | WebM (VP8 + Vorbis) |

### Recording Lifecycle

1. **Start**: Recording begins when the stream goes live
2. **Live DVR**: A seekable sidecar file is generated periodically (every 60s for server-side, every 2 chunks for browser uploads) so viewers can rewind
3. **Finalize**: When the stream ends, the recording is remuxed for proper seeking, duration is probed, and a thumbnail is generated
4. **Auto-cleanup**: Recordings shorter than 10 seconds are automatically deleted (test streams, accidental go-lives)

### Browser Tab Close Safety

If you close the browser tab during a WebRTC stream, `sendBeacon` attempts to upload any remaining chunks. The server will auto-finalize when it detects the stream has ended.

## DVR / Live Seeking

Viewers can seek backwards in a live stream using the DVR controls:
- **Click/drag** the progress bar to seek
- **Arrow Left** — Rewind 5 seconds
- **Arrow Right** — Forward 5 seconds
- **LIVE button** — Jump back to the live edge

DVR availability appears after ~30 seconds of recording.

## Clips

Viewers can create clips from live streams:
1. Click the **Clip** button during a stream
2. Set the clip duration (default: 30 seconds)
3. The clip is saved from the server-side recording

Clips are **unlisted by default** — the stream owner can publish or delete them from the dashboard.

## VOD Management

From the dashboard:
- Toggle VODs between **public** and **private**
- **Bulk delete** old media by age (e.g., delete VODs older than 30 days)
- Every delete (one, bulk, by age, or from the admin storage page) ends in `server/media-proxy/purge.js`
  once Media confirmed it: the comment thread is hidden, Live's own rows about the item go
  (`vod_ai_state`/`clip_ai_state`, `content_views`) and its Search document is re-read at once
- **Thumbnails** are auto-generated; broken thumbnails auto-regenerate on load

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
