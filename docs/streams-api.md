# Stream slots API

Everything the Go live screen does is an API call: list your slots, make one, change its title or settings, get its
server and key, ask for title ideas, see its past streams, and end a stream. A phone app, a bot or a tool of your own
goes live the same way the page does.

A **slot** is one stream of yours. It holds the title, the link (`openvibe.live/@you/<slug>`), how it goes out (your
browser, OBS over RTMP, WHIP or FFmpeg), its restreams and its recording settings. Each slot has its own stream key.

## Signing in

Send `Authorization: Bearer <token>` with every call.

- The token is an OpenVibe.Network sign-in, or an API token made under Settings → API tokens (see
  [API tokens](api-tokens.md)).
- An API token needs the `read` scope for reads and the `stream` scope for changes.
- `GET …/profile` answers with the slot's `stream_key`. A token that can read it can publish to the slot, so keep that
  token as safe as the key itself.

Every path below starts with `https://openvibe.live/api/streams`.

In JavaScript, [`openvibe-sdk/live`](https://github.com/OpenVibers/OpenVibe.SDK) wraps these calls:
`live.slots.list()`, `live.slots.create()`, `live.slots.update()`, `live.slots.profile()`, `live.slots.history()`,
`live.slots.quality()`, `live.slots.titleIdeas()`, `live.goLive()`, `live.streams.end()` and the WHIP helpers.

## Slots

| Call | What it does |
|------|--------------|
| `GET /managed` | Your slots: `{ managed_streams: [{ id, title, slug, description, is_nsfw, streaming_method, browser_mode, … }] }` |
| `POST /managed` | Make a slot: `{ title, description?, slug?, is_nsfw?, streaming_method? }` → `{ managed_stream }`. The number of slots per account is limited; the error says the limit. |
| `PUT /managed/:id` | Change a slot. Send only what changes: `title`, `description`, `slug`, `is_nsfw`, `streaming_method` (`browser`, `rtmp`, `whip`, `cli`), `browser_mode` (`camera`, `camera_only`, `mic_only`, `screen`), `default_vod_visibility` and `default_clip_visibility` (`public`, `unlisted`, `private`), `slot_vod_recording_enabled`, `slot_clip_recording_enabled`, `slot_clip_notify_enabled` (`1` or `0`), `weather_zip` and `weather_detail`. |
| `DELETE /managed/:id` | Delete a slot. A live slot cannot be deleted (409): end its stream first. |
| `GET /managed/:id/profile` | All of a slot in one call: the slot, its quality settings (`broadcast_settings`), its restreams, its RTMP server (`rtmp_url`), its WHIP base (`whip_url_base`) and its `stream_key`. |
| `PUT /broadcast-settings` | A slot's quality: `{ managed_stream_id, settings: { resolution: "1080", fps: "30", bitrate: 4500 } }` (the bitrate is in kbps). |
| `POST /managed/:id/regenerate-key` | A new stream key for the slot. The old one stops working at once. |
| `GET /managed/:id/history` | The slot's past streams, newest first: `{ sessions: [{ id, title, started_at, duration_seconds, peak_viewers, vod_id, … }] }` |
| `POST /managed/:id/title-ideas` | Three title ideas for the next stream, written from the slot's last streams: `{ weekday?: "Sunday", hour?: 21, title?: "what is typed now" }` → `{ titles: ["…", "…", "…"] }`. A few calls a minute at most (429 says to wait). It uses your own AI allowance, and nothing is stored. |

## Going live

How a slot goes live depends on its `streaming_method`.

- **Starting a session from a slot:** `POST /` with `{ managed_stream_id, title? }` returns `{ stream, endpoint }`.
  This is what the Go live button does before your browser connects. An encoder that connects by itself starts one on
  its own.

- **WHIP:** `POST https://openvibe.live/whip/<slot id>` with the slot's key as the Bearer token and your SDP offer.
  It works from any WHIP client, including a browser page of your own. The [WHIP guide](whip.md) has the whole
  session: the endpoint, its lifecycle, errors and CORS.
- **RTMP:** point OBS, Streamlabs or IRL Pro at the slot's `rtmp_url`, with its `stream_key` as the key. The slot goes
  live when the app connects and ends when it stops. Nothing is pressed here.
- **FFmpeg / CLI:** the Go live page's "Stream from an app instead" row shows the commands for the slot, with its key.
  Most tools are simplest over RTMP or WHIP.
- **Browser:** the Go live page itself, with your camera, microphone or screen. A program that wants to publish from a
  browser uses WHIP.

`GET /mine` lists your streams, newest first. A live one has `is_live: true`, and its `id` is the stream's.

## Ending a stream

- `DELETE /:streamId` ends a live stream. The recording is finished and kept, following the slot's recording
  settings.
- An encoder can also just stop. A WHIP client sends `DELETE` to the session URL its `POST` returned.
- A stream whose broadcaster drops stays live for five minutes, so a phone that loses signal comes back to the same
  stream.

## Errors

Errors come back as `{ "error": "…" }` in plain words:

| Code | Meaning |
|------|---------|
| 400 | A field is not valid (the message says which). |
| 401 | No sign-in, or it expired. |
| 403 | Not your slot, or the token's scopes do not allow the call. |
| 404 | No such slot or stream. |
| 409 | That short link is taken on your account, or the slot is live and cannot be deleted. |
| 429 | Too many calls: wait a little. |
