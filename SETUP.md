# OpenVibe.Live Setup

This document describes the OpenVibe.Live runtime setup, local development, and its integration points with the other OpenVibe services.

## Architecture at a glance

OpenVibe.Live (port **3000**) is the streaming front — ingest (RTMP / WHIP / WebRTC / JSMPEG), chat, channels, monetization (Vibes), moderation, and the SPA. Two sibling services do heavy lifting:

- **OpenVibe.Network** (`openvibe.network`, port **4000**) — SSO/OAuth2 identity provider (client id `live`), RS256 JWTs, URL registry, notifications, and the network-wide **OpenCoins wallet**. Live calls the wallet server-to-server via `OV_NETWORK_INTERNAL_URL` with `X-Internal-Key`.
- **OpenVibe.Media** (`openvibe.media`, port **4100**) — owns **VODs, clips, pastes, thumbnails, and file storage** (Media API v1). Live records streams by pointing Media at its ingest (RTMP pull / RTP ports 12000-12199), proxies the SPA's `/api/vods`, `/api/clips`, `/api/pastes`, `/api/thumbnails` calls to it (`server/media-client.js`), 302-redirects file payloads to `MEDIA_PUBLIC_URL`, and receives `vod.ready` / `clip.ready` webhooks at `POST /internal/media-webhook`.

Live keeps locally: live.db (users/streams/chat/channel state), Vibes (PayPal tipping/cashout), channel points, comments, stream memories + AI state for Media-hosted vods/clips (`vod_ai_state` / `clip_ai_state`), ephemeral live thumbnails, and the song-request queue.

The vendored shared package lives at `./vendor/openvibe-shared` (`"openvibe-shared": "file:./vendor/openvibe-shared"`); browser assets load from `https://openvibe.network/shared/*`.

## Prerequisites

- Node.js 18 or later, npm.
- FFmpeg (live thumbnails, frame extraction, AI jobs).
- A running **OpenVibe.Network** instance (auth + wallet).
- A running **OpenVibe.Media** instance (VODs/clips/pastes) — Live boots without it, but media features return 502 until it's up.
- Linux is recommended for production (`mediasoup` and `node-media-server` are most reliable there).

## Install dependencies

```bash
npm install
```

The shared package resolves from `./vendor/openvibe-shared` — no external workspace layout needed.

## Environment configuration

Copy the environment template into `.env` (production: `/etc/openvibe/live.env`, mode 0600):

```bash
cp .env.example .env
```

### Required values

- `BASE_URL` — public URL used by the browser client, e.g. `http://localhost:3000`.
- `JWT_SECRET` — app-specific secret for Live's own JWT operations.
- `OV_NETWORK_URL` — public SSO issuer (default `https://openvibe.network`).
- `OV_NETWORK_INTERNAL_URL` — internal Network base (default `http://127.0.0.1:4000`).
- `INTERNAL_API_KEY` — key for Network's `/internal/*` endpoints (header `X-Internal-Key`).
- `OV_OAUTH_CLIENT_ID` / `OV_OAUTH_CLIENT_SECRET` — OAuth client (`live`).
- `OV_NETWORK_PUBLIC_KEY` — path to the Network RS256 public key (offline JWT verification).
- `MEDIA_URL` — internal Media API base (default `http://127.0.0.1:4100`).
- `MEDIA_PUBLIC_URL` — public Media host (default `https://openvibe.media`).
- `MEDIA_APP_ID` (`live`) and `MEDIA_API_KEY` — Live's Media tenant credentials.
- `MEDIA_WEBHOOK_SECRET` — HMAC secret for Media → Live webhooks.

#### Public key for token verification

OpenVibe.Live verifies RS256 tokens from OpenVibe.Network using one of these paths:

1. `OV_NETWORK_PUBLIC_KEY` environment variable.
2. `./data/keys/openvibe-tools-public.pem`.
3. `/opt/openvibe/openvibe-tools/data/keys/public.pem`.

If the public key cannot be loaded, authentication will fail.

## Database initialization

```bash
npm run init-db
```

This creates the SQLite database at `data/live.db` from `server/db/schema.sql`. On normal startup, `server/index.js` also runs lightweight migrations (including the `vod_ai_state` / `clip_ai_state` tables), so existing databases recover automatically.

Note: the legacy `vods` / `clips` / `pastes` tables may still exist for the Media data migration to read — Live never writes them anymore.

## Storage directories

The server writes Live-local state under `data/`:

- `data/live-thumbs` — ephemeral live-stream thumbnails
- `data/emotes`, `data/avatars`, `data/offline`
- `data/media/cache` — song-request (watch-party) downloads
- `data/analytics.db`, `data/keys`

VOD/clip/paste **files** live in OpenVibe.Media's storage, not here.

## Local development setup

1. Start OpenVibe.Network locally (port 4000) and OpenVibe.Media (port 4100).
2. Configure `.env`:

```env
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
BASE_URL=http://localhost:3000
OV_NETWORK_URL=http://localhost:4000
OV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000
INTERNAL_API_KEY=your-shared-secret
OV_NETWORK_PUBLIC_KEY=./data/keys/openvibe-network-public.pem
MEDIA_URL=http://127.0.0.1:4100
MEDIA_PUBLIC_URL=http://127.0.0.1:4100
MEDIA_APP_ID=live
MEDIA_API_KEY=dev-live-key
MEDIA_WEBHOOK_SECRET=dev-webhook-secret
```

3. Run `npm run init-db`, then `npm run dev`.

Network's `local-dev` bootstrap seeds the `live` OAuth client with `http://localhost:3000/api/auth/callback`.

## Admin/bootstrap behavior

On startup, the server:

- refreshes URL registry values from OpenVibe.Network (needs `OV_NETWORK_INTERNAL_URL` + `INTERNAL_API_KEY`).
- initializes the database and schema.
- seeds/refreshes built-in themes (default theme slug: `vibe`).
- creates an admin user from `ADMIN_USERNAME` / `ADMIN_PASSWORD` if no admin exists (dev defaults `admin` / `changeme123`).

## Protocol-specific notes

### Recording (all protocols)

Server-side recording is delegated to OpenVibe.Media:

- **RTMP** — on publish, Live creates a VOD in Media and asks it to pull `rtmp://127.0.0.1:1935/live/<key>`.
- **WebRTC/WHIP** — Live creates a VOD, requests RTP ingest ports from Media (UDP 12000-12199), and points mediasoup PlainRtpTransports at them.
- **Browser MediaRecorder** — chunk uploads to `/api/vods/stream/:id/chunk` are forwarded to Media's chunks endpoints.
- **JSMPEG** — not recorded (no Media ingest for mpeg-ts push).

Completion arrives via the `vod.ready` / `clip.ready` webhooks.

### WebRTC / mediasoup

- `MEDIASOUP_LISTEN_IP`, `MEDIASOUP_ANNOUNCED_IP`, `MEDIASOUP_MIN_PORT` / `MEDIASOUP_MAX_PORT`, `WEBRTC_PORT`.
- `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` — required in production for reliable NAT traversal (default `turn:turn.openvibe.live`).
- `ALLOW_P2P_FALLBACK` — emergency rollback flag; leave `false` (legacy P2P relays can expose viewer IPs).

### WHIP

- `WHIP_PUBLIC_URL` — public ingest URL for WHIP (`https://whip.openvibe.live` in production).
- `WHIP_PUBLIC_URL_ENABLED` — boolean to enable or disable WHIP.

### RTMP

- `RTMP_PORT` (1935), `RTMP_CHUNK_SIZE`.
- `RTMP_HOST` — public ingest hostname shown to streamers (default `ingest.openvibe.live` → `rtmp://ingest.openvibe.live/live`).

### JSMPEG

- `JSMPEG_VIDEO_PORT`, `JSMPEG_AUDIO_PORT`, `JSMPEG_PUBLIC_URL` (TLS relay ports 9710-9789 via nginx stream in production).

### Optional production settings

- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE` for Vibes cashout (Vibes stay Live-local).
- `LIVE_THUMBS_PATH` for the live thumbnail directory.

## Troubleshooting

- **Auth fails**: `OV_NETWORK_PUBLIC_KEY` missing/invalid, or Network unreachable.
- **Invalid redirect_uri**: local callback URIs not registered on the `live` OAuth client in Network.
- **VOD/clip/paste endpoints return 502**: OpenVibe.Media is down or `MEDIA_URL`/`MEDIA_API_KEY` are wrong.
- **Webhook 401s in Media logs**: `MEDIA_WEBHOOK_SECRET` mismatch.
- **OpenCoins balance always 0 / spends fail**: `OV_NETWORK_INTERNAL_URL`/`INTERNAL_API_KEY` wrong, or the user has no linked Network account.
- **CORS rejects browser traffic**: `BASE_URL` set to localhost in production.
- **WebRTC fails**: `mediasoup` could not initialize or TURN is not configured.
- **RTMP fails to start**: port conflict on `RTMP_PORT`.

### How to verify local startup

1. Run `npm run dev`.
2. Confirm the server logs show `HTTP server` and WebSocket endpoints.
3. Confirm `Effective BASE_URL` and `Effective OV_NETWORK_URL` are correct.
4. Confirm the server created or migrated `data/live.db`.
5. `curl http://localhost:3000/api/health` returns `{"status":"ok", ...}`.

## What this setup does not cover

- production Nginx / Cloudflare deployment (see `deploy/`).
- real TLS certificate configuration.
- the OpenVibe.Media / OpenVibe.Network services themselves.

For stream-specific guidance, see `docs/broadcasting.md`.
