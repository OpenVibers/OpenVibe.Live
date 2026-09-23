# Deploying OpenVibe.Live

`deploy/scripts/deploy.sh` decides what a change needs and does the least disruptive thing.

```bash
sudo /opt/openvibe.live/deploy/scripts/deploy.sh              # deploy origin/main if it moved
sudo /opt/openvibe.live/deploy/scripts/deploy.sh --wait-idle  # hold a restart until nobody is live
sudo /opt/openvibe.live/deploy/scripts/deploy.sh --rollback   # release layout: previous release
DRY_RUN=1 /opt/openvibe.live/deploy/scripts/deploy.sh         # print the plan only
```

## What each kind of change costs

| Files changed | Action | Interruption |
|---|---|---|
| `docs/`, `public/` (JS, CSS, HTML, fragments, images) | files switched in place; the running server re-reads documents and re-hashes assets within ~2 s | **none** — no restart |
| README, tests, scripts | files switched | none |
| `server/`, `vendor/`, `package.json` dependencies | restart, gated on `GET /api/ready` | new HTTP connections queue on the systemd socket; **established WebSocket, WHIP, WebRTC and RTMP sessions drop and reconnect** |
| `package-lock.json` | `npm ci` **before** anything is interrupted (release layout: into the new release) | as server |
| `server/db/migrations.js`, `schema.sql` | online SQLite backup to `data/backups/`, then restart | as server |
| `deploy/systemd/` | units installed, `daemon-reload`, restart | as server |
| `deploy/nginx/` | **not installed** — the live nginx config is managed separately (see below); the script prints a notice | none |

Socket activation (`deploy/systemd/openvibe-live.socket`) protects *new* HTTP connections during a
restart. It does not keep existing WebSockets, RTMP publishers, WHIP sessions or mediasoup UDP flows.
Clients reconnect with jittered backoff and show "OpenVibe is updating" / "Reconnected"
(`ovConnectionPill` in `public/js/app.js`). Use `--wait-idle` when someone is streaming.

## Layouts

**Legacy (current production):** `/opt/openvibe.live` is a git checkout. Static-only changes no longer
restart. A rollback resets the checkout but cannot restore previous `node_modules`.

**Release layout** (set up once with `deploy/scripts/migrate-to-releases.sh`, one restart):

```
/opt/openvibe.live/repo                 git clone used to create releases
/opt/openvibe.live/releases/<time>-<sha> worktree + its own node_modules + data -> ../../shared/data
/opt/openvibe.live/current              -> releases/<id>   (atomic rename)
/opt/openvibe.live/shared/data          live.db, analytics.db, uploads (never copied or reset)
/opt/openvibe.live/data                 -> shared/data     (old absolute DB_PATH values keep working)
```

- A deploy builds the new release while the old one serves; unchanged lockfiles hard-link
  `node_modules` (instant), changed ones get `npm ci` inside the new release.
- The service unit (`deploy/systemd/release/`) runs `current/server/index.js` with
  `OV_APP_ROOT=/opt/openvibe.live/current`, so static files and docs are read through the symlink and
  a static-only switch needs no restart.
- If the restarted release never becomes ready, `current` is switched back and restarted (exit 3).
  "Ready" is `GET /api/ready` → 200: boot finished and the database answers. The WebRTC SFU,
  OpenVibe.Media and the Network signing key are optional checks: when one is missing the answer is
  still 200 with `"status": "degraded"` and the check named in `degraded`, never a silent pass.
- `GET /metrics` (Prometheus text: requests by route template, latency, in-flight, process,
  `release_info`, live streams, WebSocket connections per server, outbox) answers only
  `curl http://127.0.0.1:3000/metrics` on the host; through nginx it is a 404.
- `--rollback` selects the previous release with **its own** `node_modules`.
- The last 5 releases are kept.
- Content-hashed assets from the previous release are still served under their old hashes, so a page
  rendered before the switch never loads JavaScript from after it.

`test/deploy-sim.test.js` runs the script against a simulated host (real git, fake systemctl) and
checks each of these behaviours.

## Assets and caching

- HTML documents are rewritten at serve time: every `/js`, `/css`, `/shared` and `/fragments`
  reference gets `?v=<sha256 prefix of the file>`. Nobody edits version numbers.
- A request whose `?v=` matches the current bytes is `public, max-age=31536000, immutable` (browser and
  Cloudflare). A previous release's hash is served from that release. Anything else is `no-cache`.
- HTML is `no-cache`. Public API responses set their own short caches; authenticated responses are not cacheable.
- nginx (`deploy/nginx/openvibe.live.conf`) caches static responses only when Node marked them
  cacheable, gzips text for the hop to Cloudflare, and logs requests without query strings (WebSocket
  URLs carry session tokens).

## nginx

`deploy/nginx/openvibe.live.conf` is what production runs; it was identical to
`/etc/nginx/sites-enabled/openvibe.live.conf` on 2026-09-17. OpenVibe.Network's generator
(`server/deploy/nginx-generator.js`) now carries the same WHIP/ingest hostnames, connection budgets,
static cache, gzip and log format for Live, enforced by that repo's `test/nginx-generator-live.test.js`.
Apply nginx changes by hand: copy the file, `nginx -t`, `systemctl reload nginx`.

## Checks

```bash
npm test                         # unit, security, migrations, deploy simulation, size budgets
BASE=http://127.0.0.1:3000 npm run test:browser   # needs a running server and Chrome
deploy/scripts/post-deploy-check.sh                # on the host after a deploy
```
