# System Architecture

## Overview

OpenVibe.Live is a self-hosted live streaming platform, one of the OpenVibe services:

- **Express.js** (CommonJS) — HTTP API, HTML documents, static assets
- **SQLite** (better-sqlite3) — users, channels, streams, chat, tokens, AI state (`data/live.db`)
- **WebSocket** (`ws`) — chat, broadcast signaling, calls, hardware controls
- **mediasoup** — WebRTC SFU; **werift** — WHIP ingest; **Node-Media-Server** — RTMP ingest
- **FFmpeg** — recording hand-off, restreams, thumbnails, audio capture for transcription
- **OpenVibe.Network** — SSO/OAuth2 (RS256 JWTs), OpenCoins wallet, shared browser modules (`openvibe-shared`, a pinned OpenVibe.Shared release served at `/shared/*` from `node_modules`)
- **OpenVibe.Media** — VODs, clips, pastes, thumbnails and files. Live proxies to it
  (`server/media-client.js`, `server/media-proxy/`); the local `vods`/`clips`/`pastes` tables are frozen, read-only.
- **OpenVibe.Community** — pastes (`server/pastes-client.js`) and VOD/clip comments: `/api/comments` is an adapter over Community comment threads
  (`server/comments-client.js`, [vods-and-clips.md](vods-and-clips.md#comments-are-openvibecommunity-threads)); the local `comments` table is frozen, read-only.

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
- **Featured live stream.** `public/js/home-featured.js` (feature `featured`) loads only when someone is
  live: `GET /api/home/featured` picks and rotates the stream; playback is FLV (RTMP) or the JSMPEG relay,
  live frames for WebRTC. Off switch remembered in `localStorage` (`ov_home_featured_off`).
- **Voice channels.** `public/js/call.js` + `voice-channels.js` (feature `voice`, chat route): full-mesh
  WebRTC, signalling over `/ws/call` (`server/streaming/call-server.js`). The newcomer offers, existing
  members answer; the server pushes the channel list to every chat socket (`voice-channels` message);
  TURN credentials come from `server/net/turn.js` (short-lived with `TURN_AUTH_SECRET`).
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
| Analytics | `server/analytics/*.js` | request analytics in `data/analytics.db` within ADR-021 (see [Analytics](#analytics-adr-021)) |

### Migrations

Schema changes that are not idempotent `CREATE … IF NOT EXISTS` go into `server/db/migrations.js`.
Each migration runs once, inside a transaction that records it; `adopt()` marks databases that already
have the change; a migration waiting for a table another module creates returns `DEFER` and is retried.
A failing `critical` migration stops the boot. `test/migrations.test.js` covers fresh, repeated,
adopted, failing and deferred cases.

### Analytics (ADR-021)

`server/analytics/` records one row per finished request in `data/analytics.db` (separate from `live.db`)
and rolls rows up hourly and daily for the Network admin dashboards. What a raw row may carry is bound by
ADR-021 (OpenVibe.Contracts `docs/adr/ADR-021-analytics.md`):

- **Stored:** event type, service, **route template** (the matched Express route, else `privacy.normalisePath`:
  no query string, ids/hashes/ULIDs → `:id`, the segment after words like `vod`, `p`, `u`, `users` → `:param`,
  `/@name` → `/@:user`), method, status, response time, a **rotating session id**, country (CDN header),
  **user-agent class** (`chrome/windows/desktop`, `bot:googlebot`) plus browser/os/device, referer
  **origin** only, bot flags, a signed-in flag, timestamp.
- **Never stored:** IP address, user or subject id, city/precise location, the user-agent string, full
  referer URLs. The `ip`, `user_id`, `city` columns remain for compatibility and are always NULL.
- **Session id:** 16 random hex chars kept in memory against the visitor hash; new after 30 minutes idle
  and at every UTC midnight. Not derived from any id.
- **Bot rate check:** per-IP hit counters for the current and previous minute, in memory only (dropped
  after 2 idle minutes). `analytics_rate_tracking` is emptied at boot and no longer written.
- **Unique visitors:** `HMAC-SHA256(day salt, ip + "\n" + user agent)`, truncated to 16 hex chars. The salt is
  random per UTC day (`analytics_day_salts`; deleted once the day is over). Hashes live only in
  `analytics_visitor_days`, never in raw events, and are deleted by the first hourly aggregation after
  their day ends — right after that day's final rollup — so none outlives its day by more than about an
  hour. Rollups keep counts only, and a recompute never lowers a stored unique count. Raw-event
  dashboards (sub-48 h summaries, realtime, top pages) count distinct sessions instead of IPs; "new vs
  returning visitors" and daily `new_users` are no longer measured (NULL).
- **Retention:** raw events older than 30 days are deleted nightly in batches of 5000 (job
  `analytics-prune`, `server/analytics/retention.js`); rollups are kept.
- **Operator CLI:** `scripts/analytics-prune.js` — dry run by default (counts only). `--apply` needs
  `--backup <new file>` (verified sqlite online backup) or an explicit `--no-backup`; `--scrub` also
  rewrites rows written before ADR-021 (personal columns → NULL, path → template, referer → origin, user
  agent → class, legacy session ids → NULL) and the rollups' top-path/referer lists (counts unchanged).
  Rollup totals are compared before and after; the run ends with a VACUUM unless `--no-vacuum`.
  Space: the backup needs about the size of `analytics.db` + its WAL; VACUUM about twice the size.

## OpenVibe Integration

SSO and wallet come from OpenVibe.Network; media storage and processing from OpenVibe.Media. Binding
inter-service contracts are in `../CONTRACTS.md` (OpenVibers workspace). Deployment:
[deploy.md](deploy.md). Security posture: [../SECURITY_AUDIT.md](../SECURITY_AUDIT.md). Measurements:
[performance-audit.md](performance-audit.md).

### Durable events (OpenVibe.Events)

Live publishes through one transactional outbox (`event_outbox`, [server/events/stream-events.js](../server/events/stream-events.js);
off unless `EVENTS_URL` and `OV_OAUTH_CLIENT_SECRET` are set). Every event is queued in the same SQLite
transaction as the change it describes.

| event | when | subject |
|---|---|---|
| `live.stream.started` / `live.stream.ended` | a `streams` row goes live / ends | `stream <id>` |
| `live.release.deployed` | the first boot that runs new commits ([server/events/release-events.js](../server/events/release-events.js)), queued with the `deploy_last_announced` update; payload: `service`, `release`, `commit`, `previous`, `commit_count`, `commits[]` (≤ 40), `deployed_at`, `notes_url` | `release <head sha>` |

The chat deploy notice itself is unchanged: stored in `chat_messages` (local chat) or handed to
OpenVibe.Chat over the bridge (`CHAT_AUTHORITY=chat`). Once Chat consumes `live.release.deployed`, the
bridge's `deployNotice` hop can be deleted.

Live consumes, each on its own endpoint with its own subscription secret, signature v2 only, applied once
through the SDK inbox (`idempotency_receipts`):

| topics | endpoint | secret | subscribe with |
|---|---|---|---|
| `openre.session.*` | `/internal/openre-events` | `OPENRE_EVENTS_SECRET` | OpenRe's `scripts/subscribe-live-events.js` |
| `media.vod.*`, `media.clip.*`, `media.storage.*` | `/internal/media-events` | `MEDIA_EVENTS_SECRET` | `scripts/subscribe-media-events.js` |

#### Media outcomes over Events

Media reports `vod.ready|failed`, `clip.ready|failed` and `storage.alert|recovered` both as the signed
webhook (`POST /internal/media-webhook`, `MEDIA_WEBHOOK_SECRET`) and as `media.*` events. Media writes the
event in the state change's transaction and puts its `event_id` in the webhook body, so
[server/media-proxy/outcomes.js](../server/media-proxy/outcomes.js) applies each outcome once, whichever
copy arrives first (receipt `media:<object type>:<object id>:<event id>`, consumer
`live-media-outcomes`). Only Live's tenant (`MEDIA_APP_ID`) counts; `media.object.uploaded` is ignored.
`MEDIA_EVENTS_AUTHORITY` picks the path that acts:

- `webhook` (default): the webhook acts; Events deliveries are acknowledged and dropped.
- `both`: the transition window; either acts, the other copy is a no-op.
- `events`: Events acts; a webhook with an `event_id` is acknowledged and dropped (one without, from a
  Media whose outbox is off, has no durable twin and still acts).

Removing the webhook, once `events` has run clean (every recording and clip since the switch has its
`vod_ai_state`/`clip_ai_state` row and `live-media-outcomes` receipts, and Events shows no DLQ entries for
Live's subscriptions): clear Live's `webhook_url` in Media's `apps` row (then Media sends Live nothing
directly), wait a release, and delete `/internal/media-webhook`, `server/media-proxy/webhook.js`,
`MEDIA_WEBHOOK_SECRET` and the `webhook`/`both` modes. Rollback before that step: set
`MEDIA_EVENTS_AUTHORITY=webhook` (or `scripts/subscribe-media-events.js --disable`).
