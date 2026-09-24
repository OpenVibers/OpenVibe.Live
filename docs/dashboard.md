# Streamer Dashboard

The dashboard is your control center for managing your channel. Access it by logging in and clicking your username.

## Stream Key

Your RTMP stream key is shown (hidden by default) for use with OBS, Streamlabs, or other RTMP software. You can regenerate it at any time — this invalidates the old key.

## API Tokens

Create long-lived API tokens for bots and integrations. Tokens authenticate via the `Authorization: Bearer hbt_...` header for REST API and chat WebSocket connections.

Available scopes: `chat`, `read`, `stream`, `control`.

See [API Tokens](api-tokens.md) for full details.

## Chat Logs

View and manage chat messages from your streams:
- **Search** by message content or username
- **Filter** by date range
- **Purge** messages in a time range (soft-delete — excluded from future replay)

Purged messages are broadcast to live chat clients and excluded from VOD chat replay automatically.

## Emotes

Upload custom channel emotes (PNG, GIF, WebP, AVIF, up to 256KB). Toggle emote sources:
- Custom (your uploads)
- Defaults (built-in)
- FFZ, BTTV, 7TV (third-party)

## VODs & Clips

- **My Videos** — All your recorded streams. Toggle public/private, bulk delete by age.
- **My Clips** — Clips you've taken from other streams. Only clips a person made: the AI's clips of your stream are never listed as yours.
- **Clips of My Stream** — Clips people have taken from your streams. Publish or delete.
- **AI Moments** — Clips OpenVibe's AI cut from your streams when chat reacted, with a count on the tab. They are labelled "AI clip · from your stream" everywhere, credited to no one, and kept out of search. Publish, unlist or delete them here.

## AI Moments from my streams

On the **Home** tab, *Let OpenVibe's AI make Moments from my streams* (on by default) is the channel's switch for everything the AI derives from your streams and publishes: auto-clips, the frames it posts as AI notes (from VODs and "caught live") and the AI-written after-show report. Turned off, none of those jobs touch your channel and your after-show report is the stats-only one. Moments already made stay until you delete them. The stream's AI overview, captions and the AI chat bot are separate settings. A category the AI inferred for your stream is shown as "Gaming · inferred" on your channel and on VOD and clip pages.

## Currency System

- **Vibes** — Real money donations. Cash out when ready.
- **OpenVibe Nickels** — Free loyalty currency earned by viewers for watching and chatting.
- **Coin Rewards** — Create custom rewards viewers can redeem with Nickels (TTS, sound effects, chat highlights, etc.)
- **Redemption Queue** — Fulfill or reject viewer reward redemptions.

## Camera Controls (ONVIF PTZ)

Add ONVIF-compatible cameras for viewer-controlled pan/tilt/zoom. Supports discovery and manual configuration.

## Donation Goals

Create funding goals visible to viewers during your stream.
