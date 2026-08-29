# OpenVibe.Live

**Free & Open Live Streaming** — the streaming front of the OpenVibe network. OpenVibe.Live provides streaming ingest (RTMP / WHIP / WebRTC / JSMPEG), viewer playback, chat, channels, monetization (Vibes tipping + network OpenCoins), moderation, and restreaming.

This repository contains the OpenVibe.Live server, browser assets, and runtime configuration. It depends on two sibling services:

- **OpenVibe.Network** (`openvibe.network`) — SSO/OAuth2 identity provider, RS256 JWT verification, URL registry, notifications, and the network-wide **OpenCoins wallet**.
- **OpenVibe.Media** (`openvibe.media`) — owns **VODs, clips, pastes, thumbnails, and file storage** (Media API v1). Live proxies its media API surface there and delegates all stream recording to it.

---

## What this repo contains

- `server/` — Node/Express backend, WebSocket handling, streaming routes, chat, auth, monetization, and the Media/Network clients.
- `server/media-client.js` — OpenVibe.Media API v1 client (VODs/clips/pastes/files/thumbnails + public URL builders).
- `server/media-proxy/` — thin routers that preserve the SPA's `/api/vods`, `/api/clips`, `/api/pastes`, `/api/thumbnails` paths by forwarding to Media, plus the Media webhook receiver and clip-notify sweeper.
- `server/streaming/recorder.js` — Media-backed recorder (RTMP pull + RTP ingest wiring).
- `server/monetization/wallet-client.js` — OpenCoins wallet client (Network internal API).
- `public/` — static browser UI assets (no build step).
- `data/` — Live-local runtime storage (SQLite, live thumbnails, emotes, song-request cache, analytics).
- `vendor/openvibe-shared/` — vendored shared package (`"openvibe-shared": "file:./vendor/openvibe-shared"`).
- `deploy/` — nginx / systemd / fail2ban reference configs.
- `.env.example` — runtime configuration template.

---

## Runtime architecture

### Core server

`server/index.js` is the entrypoint (port **3000**). It loads environment configuration, initializes the database, and starts the HTTP server and WebSocket upgrade handler.

### Streaming support

- RTMP ingest using `node-media-server` (ports 1935 / 9935, public host `ingest.openvibe.live`).
- optional WebRTC SFU via `mediasoup` (ports 11000-11300 in production).
- JSMPEG relay (TLS relay ports 9710-9789 via nginx stream).
- WHIP/HTTP ingestion support (`ingest.openvibe.live`) — open CORS, so even a backend-less web page can publish; see [docs/whip.md → Publishing from a browser](docs/whip.md#publishing-from-a-browser) and the hosted [browser publisher](https://openvibe.live/whip-publisher.html).
- real-time broadcast and control channels.

### Media (VODs / clips / pastes / thumbnails)

The media subsystem lives in **OpenVibe.Media**:

- On stream start, Live creates a VOD in Media and starts ingest — RTMP streams are pulled by Media from `rtmp://127.0.0.1:1935/live/<key>`; WebRTC/WHIP streams are forwarded over RTP to ports Media allocates (UDP 12000-12199); browser MediaRecorder chunks are proxied to Media's chunks endpoints.
- The SPA's existing `/api/vods…`, `/api/clips…`, `/api/pastes…`, `/api/thumbnails/:filename` calls are preserved by thin proxies; big media files 302-redirect to `https://openvibe.media`.
- Media calls back at `POST /internal/media-webhook` (`X-OVMedia-Signature` HMAC) on `vod.ready` / `clip.ready` — driving recording state, AI jobs, and clip chat announcements.
- Live-owned AI/transcript state for Media-hosted content lives in `vod_ai_state` / `clip_ai_state` in live.db.

### Authentication & currencies

- User auth via OpenVibe.Network OAuth2 (client id `live`); RS256 tokens verified offline with the Network public key; local user records join Network identities via `linked_accounts`.
- **OpenCoins** (network-wide) — earn/spend goes through the Network wallet API (`/internal/coins/credit|debit|transfer`, idempotency keys `live:<event>:<id>`). The legacy local balance column is frozen for migration.
- **Vibes** (tips/cashout, PayPal) and per-streamer channel points stay Live-local.

### Data storage

- `data/live.db` — primary SQLite database (users, streams, chat, channel state, AI state).
- `data/live-thumbs` — ephemeral live-stream thumbnails.
- `data/emotes`, `data/avatars`, `data/offline` — Live-local assets.
- `data/media/cache` — song-request (watch-party) downloads.
- `data/analytics.db` — analytics tracker.
- VOD/clip/paste **files** live in OpenVibe.Media's storage.

---

## Ownership and dependencies

### OpenVibe.Live owns

- streaming ingest and viewer playback.
- chat, moderation, and anonymous chat support.
- channels, streamer controls, admin endpoints, restream management.
- Vibes (PayPal tipping/cashout), channel points, comments.
- the song-request/watch-party queue.
- live-stream thumbnails and AI stream memories.

### OpenVibe.Live depends on OpenVibe.Network for

- SSO/OAuth2 provider + JWT public key verification.
- the OpenCoins wallet.
- internal URL registry overrides (`BASE_URL`, `WEBRTC_PUBLIC_URL`, `WHIP_PUBLIC_URL`, …).
- notifications and the shared browser assets (`/shared/*`).

### OpenVibe.Live depends on OpenVibe.Media for

- VOD recording, storage, playback, and health.
- clip cutting (async — completion via webhook).
- pastes (incl. screenshots/avatars) and VOD/clip thumbnails.
- B2/R2 storage tiering.

---

## Package scripts

- `npm install` — install dependencies.
- `npm start` — start the server.
- `npm run dev` — start in development mode (`NODE_ENV=development`).
- `npm run init-db` — initialize the SQLite database schema.

---

## Quick start

Requirements: Node.js 18+, npm, FFmpeg, a running OpenVibe.Network, and (for media features) a running OpenVibe.Media. Linux preferred for production.

```bash
npm install
cp .env.example .env   # then edit — see SETUP.md
npm run init-db
npm run dev
```

Minimum `.env`: `BASE_URL`, `JWT_SECRET`, `OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`, `INTERNAL_API_KEY`, `OV_NETWORK_PUBLIC_KEY`, `MEDIA_URL`, `MEDIA_PUBLIC_URL`, `MEDIA_API_KEY`, `MEDIA_WEBHOOK_SECRET`.

---

## Deployment

- Production path `/opt/openvibe.live`, env file `/etc/openvibe/live.env` (0600), unit `openvibe-live.service` (see `deploy/systemd/`).
- nginx reference config at `deploy/nginx/openvibe.live.conf` (`openvibe.live`, `www.openvibe.live`, `ingest.openvibe.live`; certs `/etc/letsencrypt/live/openvibe.live/`).

---

## Additional docs

- [SETUP.md](SETUP.md) — first-time setup, local development, and architecture details.
- [docs/broadcasting.md](docs/broadcasting.md) — streaming method and broadcast page guide.
- [docs/restream-branding.md](docs/restream-branding.md) — branding guide for restream channels.
