# OpenVibe.Live

**Open Live Streaming**: the streaming front of the OpenVibe network. OpenVibe.Live runs ingest (RTMP, WHIP, WebRTC, JSMPEG), viewer playback, channels, the watch page and its chat surface, streamer tools, moderation, restreaming, Vibes and channel points, and the Arena.

## Purpose

Live is where people go live and watch. It takes a streamer's video in, plays it to viewers, and gives the channel its page, chat, clips and tools. The pieces other services own well (identity, chat storage, recordings, pastes, comments, AI, money, search) are theirs; Live calls them and keeps the streaming, the watch experience and the streamer's controls.

---

## What this repo contains

- `server/` — Node/Express backend, WebSocket handling, streaming routes, chat, auth, monetization, and the Media/Network clients.
- `server/media-client.js` — OpenVibe.Media API v1 client (VODs/clips/pastes/files/thumbnails + public URL builders).
- `server/media-proxy/` — thin routers that preserve the SPA's `/api/vods`, `/api/clips`, `/api/pastes`, `/api/thumbnails` paths by forwarding to Media, plus the Media webhook receiver and clip-notify sweeper.
- `server/streaming/recorder.js` — Media-backed recorder (RTMP pull + RTP ingest wiring).
- `server/monetization/wallet-client.js` — OpenCoins wallet client (Network internal API).
- `public/` — static browser UI assets (no build step).
- `data/` — Live-local runtime files (live thumbnails, emotes, avatars, song-request cache). The database is PostgreSQL (`DATABASE_URL`, schema in `migrations/`).
- `node_modules/openvibe-shared/` — pinned OpenVibe.Shared release (`"openvibe-shared": "https://codeload.github.com/OpenVibers/OpenVibe.Shared/tar.gz/refs/tags/vX.Y.Z"`), served at `/shared/*`. Change it in OpenVibe.Shared and bump the tag; never edit `node_modules`.
- `deploy/` — nginx / systemd / fail2ban reference configs.
- `.env.example` — runtime configuration template.

---

## Runtime architecture

### Core server

`server/index.js` is the entrypoint (port **3000**). It loads environment configuration, initializes the database, and starts the HTTP server and WebSocket upgrade handler.

### Streaming support

- RTMP ingest using `node-media-server` (ports 1935 / 9935, public host `ingest.openvibe.live`, DNS-only: Cloudflare does not carry RTMP).
- optional WebRTC SFU via `mediasoup` (ports 11000-11300 in production).
- JSMPEG relay (TLS relay ports 9710-9789 via nginx stream).
- WHIP/HTTP ingestion support (`whip.openvibe.live`, behind Cloudflare; `ingest.openvibe.live` still answers for older encoder configs) — open CORS, so even a backend-less web page can publish; see [docs/whip.md → Publishing from a browser](docs/whip.md#publishing-from-a-browser) and the hosted [browser publisher](https://openvibe.live/whip-publisher.html).
- real-time broadcast and control channels.

### Media (VODs / clips / pastes / thumbnails)

The media subsystem lives in **OpenVibe.Media**:

- On stream start, Live creates a VOD in Media and starts ingest — RTMP streams are pulled by Media from `rtmp://127.0.0.1:1935/live/<key>`; WebRTC/WHIP streams are forwarded over RTP to ports Media allocates (UDP 12000-12199); browser MediaRecorder chunks are proxied to Media's chunks endpoints.
- The SPA's existing `/api/vods…`, `/api/clips…`, `/api/pastes…`, `/api/thumbnails/:filename` calls are preserved by thin proxies; big media files 302-redirect to `https://openvibe.media`.
- Media reports `vod.ready` / `clip.ready` (and failures, storage alerts) as `media.*` OpenVibe.Events events (`POST /internal/media-events`) and, during the transition, the direct webhook `POST /internal/media-webhook` (`X-OVMedia-Signature` HMAC) — driving recording state, AI jobs, and clip chat announcements. Each outcome is applied once; `MEDIA_EVENTS_AUTHORITY` picks the path (see [docs/architecture.md](docs/architecture.md#media-outcomes-over-events)).
- Live-owned AI/transcript state for Media-hosted content lives in `vod_ai_state` / `clip_ai_state` in Live's PostgreSQL database.

### Authentication & currencies

- User auth via OpenVibe.Network OAuth2 (client id `live`); RS256 tokens verified offline with the Network public key; local user records join Network identities via `linked_accounts`.
- **OpenCoins** (network-wide) — earn/spend goes through the Network wallet API (`/internal/coins/credit|debit|transfer`, idempotency keys `live:<event>:<id>`). The legacy local balance column is frozen for migration.
- **Vibes** (tips/cashout, PayPal) and per-streamer channel points stay Live-local.

### Data storage

- PostgreSQL `ov_live` (since 2026-10-08; `migrations/0001_analytics.sql`, `0002_live.sql`) — users, streams, channel state, AI state, request analytics. Chat storage is OpenVibe.Chat's. The SQLite files it replaced stay read-only next to the release for the rollback window.
- `data/live-thumbs` — ephemeral live-stream thumbnails.
- `data/emotes`, `data/avatars`, `data/offline` — Live-local assets.
- `data/media/cache` — song-request (watch-party) downloads.
- request analytics (the `analytics_*` tables; ADR-021, `openvibe-shared/analytics` since v1.4.0: no IPs or user ids, route templates, raw rows ≤ 30 days; a request with `Sec-GPC: 1` or `DNT: 1` is not recorded at all; `scripts/analytics-prune.js`; see [docs/architecture.md](docs/architecture.md#analytics-adr-021)).
- VOD/clip/paste **files** live in OpenVibe.Media's storage.

---

## Owns

- Streaming ingest and viewer playback: RTMP (`node-media-server`), WHIP and WebRTC (`mediasoup`), JSMPEG, and the broadcast page.
- Channels and streams: go-live, stream keys, managed streams, heartbeats, channel pages (`/@username`), offline screens, panels and goals.
- The watch experience: the SPA in `public/`, the chat surface and its effects (TTS, sounds, emotes, overlays), anonymous chat identities.
- Streamer tools: the dashboard, restreaming (via OpenRe for managed ingest), song requests (watch party), AI viewers (the context Live builds; the runs are OpenVibe.AI's).
- Channel points, Vibes tipping flows (the ledger moves to OpenVibe.Billing when `BILLING_AUTHORITY=billing`), moderation of Live's own surfaces, the Arena (Battle Cam) and after-show recaps.
- Live-local state: PostgreSQL `ov_live` (users' Live profiles, streams, channel state, AI state for Media-hosted recordings in `vod_ai_state` / `clip_ai_state`, request analytics).

## Does not own

- **Identity, sessions, follows, blocks, notifications, OpenCoins**: OpenVibe.Network. Live verifies its RS256 tokens offline and follows `network.user.*`, `network.follow.*` and deletion, export and merge events.
- **Chat, its messages and every chat table**: OpenVibe.Chat (since 2026-09-23). Live keeps no copy: reads and writes go through `server/chat/chat-reads.js` and `chat-delivery.js`, and the twelve tables it still held are dropped at boot by migration `007_drop_chat_tables`.
- **Recordings, clips, thumbnails, files**: OpenVibe.Media. The local `vods`/`clips`/`pastes` tables are frozen (`test/frozen-tables.test.js`).
- **Pastes and comments**: OpenVibe.Community.
- **AI**: OpenVibe.AI. Live calls no model provider itself. Every prompt is an AI template; streamers' own keys are stored there; VOD and clip transcripts run there. Only live-stream captions still use Live's whisper.cpp.
- **Search, events, tips, VIP, money ledger**: OpenVibe.Search, Events, Tips, VIP and Billing.

## Depends on

- **OpenVibe.Network**: sign-in (OAuth2 client `live`), the signing key, service tokens (`server/net/network-principal.js`), follows, notifications, the wallet, the OpenVibe Frame (`openvibe-shared`, served at `/shared/*`).
- **OpenVibe.Media**: VOD recording, storage (local, B2, R2), playback, clips, thumbnails, signed playback URLs. Outcomes arrive as `media.*` events at `POST /internal/media-events`.
- **OpenVibe.Chat**, **OpenVibe.Community**, **OpenVibe.AI**, **OpenVibe.Events**, **OpenRe.Stream**, **OpenVibe.Billing**, **OpenVibe.Tips**, **OpenVibe.VIP**, **OpenVibe.Tools**, **OpenVibe.Search**: through their APIs with Live's service token.
- **Libraries**: `openvibe-contracts` (pinned tag), `openvibe-sdk`, `openvibe-shared`; FFmpeg and whisper.cpp on the host.

## Capabilities

Live implements, for other services' tokens (manifest `manifests/services/live.json` in OpenVibe.Contracts): `live.chat_context.read`, `live.chat_effects.write`, `live.lineage.resolve`, `live.tips_delivery.write`, `live.channel.read`, `live.stream.read`, `live.discovery.read`, `live.owner.resolve`.

Live's own principal (`live`) holds grants to call:

- **Network**: `identity.subject.resolve`, `network.follows.read|write`, `network.modules.read|write`, `network.notifications.push`, `network.coins.credit|debit`, `network.analytics.creator.read`, `network.account.export.contribute`, `network.account.deletion.confirm`.
- **AI**: `ai.run.create|read` (namespaces `live.*`, `network.site_copy`, `media.analyze`), `ai.credential.manage`, `ai.quota.attribution.manage`.
- **Chat**: `chat.message.send`, `chat.event.publish`, `chat.moderation.write`, `chat.cache.invalidate`, `chat.presence.read`; `chat.live_bridge.write` for the call channels (`server/streaming/calls-authority.js`) and the one-off outbox delivery (`scripts/chat-bridge-outbox-drop.js`).
- **Community**: `community.paste.*`, `community.comment.*`, `community.pulse.write`.
- **Events**: `events.event.publish|read`, `events.subscription.manage`.
- **OpenRe**: `openre.stream.*`, `openre.key.rotate`, `openre.session.read`.
- **Billing**: `billing.*` (intents, transfers, subscriptions, cash-outs, balances, entitlements).
- **Elsewhere**: `tips.interaction.record`, `vip.entitlement.check`, `tools.tool.run`, `tools.job.read`.

**Chat ingress.** With `CHAT_AUTHORITY=chat`, every chat producer in Live goes through one seam, `server/chat/chat-delivery.js`, to OpenVibe.Chat's typed service-token ingress (`server/chat/chat-client.js`: `POST /internal/chat/messages|events|moderation|invalidate`, `GET /internal/chat/presence`) — the only path; the old `chat-remote.js` bridge is gone (T3 J2). Each operation carries one idempotency key, reused on every retry. A Chat 4xx is logged, counted and dropped; a 5xx or timeout is retried with the same key past Chat's five-minute delivery lease, then logged, counted and dropped. Neither is thrown into the caller. The old bridge's `chat_bridge_outbox` is dropped by an operator step once the release before is out of rollback range: `node scripts/chat-bridge-outbox-drop.js` (dry run), `--deliver` (hands Chat every queued write it never acknowledged), then `--apply` (backup, then `op_002_drop_chat_bridge_outbox`, which refuses while a chat write is still queued).

API writes are limited per person (`server/net/actor-limits.js`, `LIVE_LIMITS_MINUTE` / `_HOUR`).

**Bot panel embed (`LIVE_BOT_EMBED`, off by default).** A channel can show its OpenVibe.Bot robot's embeddable panel (`<LIVE_BOT_URL>/panel/<robot id>/embed`). With `LIVE_BOT_EMBED=1` the channel owner (not mods, not staff) binds a robot with `PUT /api/streams/channel/:username/bot` `{ "robot_id": "rob_…" | null }` (null or `""` unbinds; stored in `channels.bot_robot_id`; limited per person as `live.bot.bind`), and `GET /api/streams/channel/:username` carries `bot_embed: { enabled: true, robot_id, url }`. Live never calls Bot to bind: the robot owner's `embed_public` toggle in Bot is the gate, so binding someone else's robot shows nothing until its owner makes it public. With the flag off the route answers 404 and the channel JSON has no `bot_embed` key (the stored id is kept). Turn it on in this order: Bot deployed with `GET /panel/:id/embed` and its `BOT_EMBED_ORIGINS` including this site's origins → set `LIVE_BOT_EMBED=1` → bind a channel. The owner binds from the dashboard's Controls tab (a "Bot robot id" field shown only with the flag on), and a bound channel's page shows the panel in a sandboxed, lazy iframe under the player (`public/js/bot-embed.js`, its own `botEmbed` feature, loaded only for a bound channel; the frame is removed when the route ends). Unbound channels and the flag off load nothing new.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIVE_BOT_EMBED` | off | `1` turns on the channel ↔ Bot robot binding and `bot_embed` on the channel JSON (`server/bot/`) |
| `LIVE_BOT_URL` | `https://openvibe.bot` | Bot's origin for the embed URL; a bare https origin (http://localhost* outside production), else the default with a warning |

## Acceptance

`npm test` runs every file in `test/` (`test/run.js`), each in its own process against a temp database: 150 files covering auth and revocation, security crawls (stream keys, secrets, SSRF, open redirect, private objects), the frozen tables, chat bridging, AI (every run is an OpenVibe.AI template; nothing calls a provider directly), transcripts by window, per-actor limits, account export and deletion, drill mode, N-1 compatibility fixtures, and the home page's size budgets. The browser smoke is `BASE=http://127.0.0.1:3000 npm run test:browser` (add `-- --a11y` for axe).

## Security

See [SECURITY.md](SECURITY.md) and [SECURITY_AUDIT.md](SECURITY_AUDIT.md). The main rules:

- Tokens are verified offline with the Network key. Sessions end on `network.user.token_valid_after`, and API tokens (`hbt_`) are scoped.
- Stream keys never leave the owner's own pages; a crawler test checks every GET route as every role.
- User-chosen URLs are fetched only through `server/net/egress.js`.
- `/metrics` answers loopback only. Secrets come from `/etc/openvibe/live.env` and are never logged.
- Private recordings look missing, and IP bans cover CIDR ranges.

---

## Package scripts

- `npm install` — install dependencies.
- `npm start` — start the server.
- `npm run dev` — start in development mode (`NODE_ENV=development`).
- `npm run test:pg` — the tests on the PostgreSQL + PgBouncer containers.
- `npm test` — every test in `test/` (see Acceptance).

---

## Quick start

Requirements: Node.js 22, npm, FFmpeg, a running OpenVibe.Network, and (for media features) a running OpenVibe.Media. Linux preferred for production.

```bash
npm install
cp .env.example .env   # then edit — see SETUP.md (no DATABASE_URL: an embedded PGlite database under DATA_DIR)
npm run dev
```

Minimum `.env`: `BASE_URL`, `JWT_SECRET`, `OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET`, `OV_NETWORK_PUBLIC_KEY`, `MEDIA_URL`, `MEDIA_PUBLIC_URL`, `MEDIA_WEBHOOK_SECRET`. Media calls use Live's service token from that OAuth client (audience `openvibe.media`, namespace `live`, grants `media.object.read`/`list`/`upload`/`delete`).

---

## Deploy

- **Production**: release layout under `/opt/openvibe.live` (`current` → `releases/<time>-<sha>`); env `/etc/openvibe/live.env` (0600) plus the unit's `Environment=`; unit `openvibe-live.service` on the systemd socket `127.0.0.1:3000`.
- **Deploy on the host**: `sudo ovhost deploy live --wait-idle` (OpenVibe.Host, strategy `release-layout`; `deploy/scripts/deploy.sh` wraps it). Static-only changes do not restart; server changes restart behind the socket with readiness checks, and a failed release rolls back to the previous one. `ovhost` also announces the release on Events.
- **Rollback**: `sudo ovhost rollback live --wait-idle` (the previous release), or `--to <sha>` for a known one. Details: [docs/deploy.md](docs/deploy.md).
- **nginx**: `deploy/nginx/openvibe.live.conf` (`openvibe.live`, `www.openvibe.live`, `ingest.openvibe.live`, `whip.openvibe.live`).
- **After a deploy**: `npm run n-1:record` refreshes the N-1 compatibility fixtures from the release in production.

---

## Additional docs

- [SETUP.md](SETUP.md) — first-time setup, local development, and architecture details.
- [docs/broadcasting.md](docs/broadcasting.md) — streaming method and broadcast page guide.
- [docs/restream-branding.md](docs/restream-branding.md) — branding guide for restream channels.

<!-- versions:start -->
- openvibe-contracts: v0.112.0
- openvibe-sdk: v0.35.1
- openvibe-shared: v2.14.1
<!-- versions:end -->
