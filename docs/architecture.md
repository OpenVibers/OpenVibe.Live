# System Architecture

## Overview

OpenVibe.Live is a self-hosted live streaming platform, one of the OpenVibe services:

- **Express.js** (CommonJS) — HTTP API, HTML documents, static assets
- **SQLite** (better-sqlite3) — users, channels, streams, chat, tokens, AI state (`data/live.db`)
- **WebSocket** (`ws`) — chat, broadcast signaling, calls, hardware controls
- **mediasoup** — WebRTC SFU; **werift** — WHIP ingest; **Node-Media-Server** — RTMP ingest
- **FFmpeg** — recording hand-off, restreams, thumbnails, audio capture for transcription
- **OpenVibe.Network** — SSO/OAuth2 (RS256 JWTs), OpenCoins wallet, shared browser modules (`vendor/openvibe-shared`)
- **OpenVibe.Media** — VODs, clips, pastes, thumbnails and files. Live proxies to it
  (`server/media-client.js`, `server/media-proxy/`); the local `vods`/`clips`/`pastes` tables are frozen, read-only.

## Authentication

- Network-issued RS256 JWTs, verified with the Network public key (`server/auth/auth.js`).
- API tokens (`hbt_…`) stored as SHA-256 hashes; **scopes are enforced** — reads need any scope,
  writes need the area's scope, and money/staff/credential routes refuse tokens.
- WebSockets start anonymous or authenticated; `join` can upgrade an anonymous connection, and a
  change of identity rebuilds the socket (`openvibe-auth-changed` in `public/js/chat.js`).

## Frontend loading

The SPA is plain JavaScript with no build step. What loads is decided per route:

```
public/index.html        shell: navbar, home page, empty <section id="page-*"> shells, core scripts
public/features.json     registry: feature → fragment, stylesheets, scripts, dependencies, stubs, idle prefetch
                         routes: URL pattern → features
public/fragments/*.html  page markup for channel, VOD/clip players, dashboard, broadcast, chat, documentation
public/css/features/*.css rules used only by one feature (split out of style.css / broadcast.css / i18n-star.css)
public/js/ov-loader.js   ov.load(feature), ov.route(path), ov.prefetch(), route generations, scopes, stubs
public/js/app.js         core: router, auth, API helper, shared renderers, connection pill
public/js/app-*.js       route code split out of app.js: home, channel, media, chatpage, docs
```

- **First paint.** `server/web/assets.js` renders `index.html` for the requested path: the route's
  stylesheets go in `<head>` (right after `style.css`), its scripts after the core scripts, and its
  fragment is inlined into the section shell. A direct visit needs no extra round trip.
- **Navigation.** `routeFromURL()` calls `whenRouteReady(page, render)`: the loader inserts the
  feature's markup first (modules bind to it on load), then dependencies, stylesheets and scripts in
  order, runs the feature's `after` hook once, and renders only if the route generation is still
  current (a slow bundle can no longer start the broadcast desk on the page you moved to).
- **Stubs.** Inline handlers such as `onclick="openSetupHub()"` work before a feature is loaded: the
  stub loads the feature, then calls the real function.
- **Prefetch.** Hover or keyboard focus on an in-site link prefetches that route's files
  (`<link rel=prefetch>`, download only); a route's `idle` list is prefetched after load. Skipped on
  Save-Data, 2G and low-memory devices.
- **Lifecycle.** `teardownRoute()` starts a new generation and disposes `ov.scope()` (timers,
  listeners, observers, AbortSignal), and stops the players, sockets and polls each page owns.
  `test/browser/smoke.js` navigates a nine-route lap three times and fails if timers, sockets,
  window/document listeners or DOM nodes keep growing.
- **Page events.** `showPage()` dispatches `ov:page`; the loader dispatches `ov:fragment` when markup
  arrives. Modules listen to these instead of observing every section.
- **Assets.** Every asset URL is content-hashed at serve time (see [deploy.md](deploy.md#assets-and-caching)).
- **Cached-first rendering.** `apiSWR()` (public/js/app-home.js) paints the home page's public data
  from `localStorage` (versioned records, keyed by user id) and reconciles with the fresh response.
- **Budgets.** `scripts/perf/check-budgets.js` (in `npm test`) fails if the home page's HTML, eager
  JavaScript or blocking CSS grow past recorded limits, or if route code returns to the home page.

## Streaming Protocols

### WebRTC (browser broadcast)
```
Browser → mediasoup Router → Consumers → Viewers     (viewer sockets only for live streams)
```

### WHIP
```
OBS / browser → POST /whip/:slot (slot key) → werift → mediasoup → Viewers
```

### RTMP
```
OBS → Node-Media-Server :1935 → HTTP-FLV (127.0.0.1 only) → Viewers via /api/streams/rtmp-proxy
```

### JSMPEG
```
FFmpeg → WebSocket relay → Canvas viewers
```

Recording, VODs and clips are produced by OpenVibe.Media from the live session
(`server/streaming/recorder.js` starts and stops Media recordings).

## Chat
```
Client WS → chat-server.js → SQLite (saveChatMessage) → room broadcast (stream / channel / global)
```
The room is derived from the stream the client joined; offline channel chat applies the channel's
bans and chat rules. Reconnects are jittered; a `server_restart` notice shows "OpenVibe is updating"
and refills history on reconnect.

## Server runtime

| Module | Path | Purpose |
|--------|------|---------|
| Entry | `server/index.js` | Express, security headers + report-only CSP, static mounts, WS upgrade, boot, shutdown |
| Assets | `server/web/assets.js` | content hashes, HTML rewriting, route assets, fragments, previous-release serving |
| Serializers | `server/web/serializers.js` | public shapes for streams, slots, channels, profiles (secrets off by default) |
| Egress | `server/net/egress.js` | fetching user-chosen URLs: address policy, redirects, loopback proxy for yt-dlp/ffmpeg |
| Jobs | `server/utils/jobs.js` | single-flight, jittered background loops; stopped on shutdown; stats for diagnostics |
| Limits | `server/utils/limit.js` | semaphores for CPU-heavy work (offline encodes, stream-memory captures) |
| Diagnostics | `server/diagnostics.js` | event-loop delay, memory, sockets, jobs, queues, migrations → `GET /api/admin/diagnostics` |
| Log redaction | `server/utils/redact.js` | stream keys and credentials in log lines |
| Database | `server/db/database.js` | queries and inline table setup |
| Migrations | `server/db/migrations.js` | versioned, transactional migrations with a ledger (`schema_migrations`) |
| Chat | `server/chat/chat-server.js`, `server/chat/routes.js` | WebSocket chat, history, moderation |
| Streams | `server/streaming/routes.js` | stream and slot CRUD, channel pages |
| Media proxy | `server/media-proxy/*.js` | VODs, clips, pastes, thumbnails via OpenVibe.Media |
| Auth | `server/auth/auth.js`, `server/auth/permissions.js` | JWT/API tokens, scopes, role ranks |

### Migrations

Schema changes that are not idempotent `CREATE … IF NOT EXISTS` go into `server/db/migrations.js`.
Each migration runs once, inside a transaction that records it; `adopt()` marks databases that already
have the change; a migration waiting for a table another module creates returns `DEFER` and is retried.
A failing `critical` migration stops the boot. `test/migrations.test.js` covers fresh, repeated,
adopted, failing and deferred cases.

## OpenVibe Integration

SSO and wallet come from OpenVibe.Network; media storage and processing from OpenVibe.Media. Binding
inter-service contracts are in `../CONTRACTS.md` (OpenVibers workspace). Deployment:
[deploy.md](deploy.md). Security posture: [../SECURITY_AUDIT.md](../SECURITY_AUDIT.md). Measurements:
[performance-audit.md](performance-audit.md).
