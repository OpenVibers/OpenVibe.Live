# VODs & Clips

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
- **Thumbnails** are auto-generated; broken thumbnails auto-regenerate on load

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
