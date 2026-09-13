# After-show reports (`/recap/:streamId`)

Every stream that ran at least 8 minutes gets a report a couple of minutes after it ends
(`server/recap/recap.js`, job every 2 min, streams that ended in the last 12 h):

- **Grade + headline + summary + moment + tags** — written by the shared LLM (`role: summary`,
  kind `stream_recap`) from the real numbers; template copy when AI is off or the call fails.
- **Numbers** — peak/avg viewers (from `viewer_snapshots`), chat lines and unique chatters, top 5
  chatters (the host excluded), busiest 5-minute window, sound commands, new follows during the
  stream, tips (`transactions` type donation), Arena mic moments, clips + the VOD (from Media).
- **The room, minute by minute** — viewer curve with chat bars, peak marker.
- Announced in the channel's chat room when it lands. Stored in `stream_recaps` (one JSON row per
  stream). Owner/admin can rebuild it (`POST /api/recap/:id/regenerate`).
- Crawlable: `/recap/:id` gets OG/Twitter meta + Article JSON-LD (`server/seo/seo.js`), so a
  shared link previews with the headline and the VOD thumbnail.

API: `GET /api/recap/:streamId` (builds on first view if missing), `GET /api/recap/channel/:username`.
Client: `public/js/recap.js`, `public/css/recap.css`. The home digest's "streamed" chips link to
the latest report with a 📋 button. Test: `node test/recap.test.js`.
