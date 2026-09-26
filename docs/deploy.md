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

**Release layout (production since 2026-09-24 05:51 UTC;** set up once with
`deploy/scripts/migrate-to-releases.sh`, one restart). Deploy with
`cd /opt/openvibe.live/current && sudo deploy/scripts/deploy.sh`: the files left in `/opt/openvibe.live`
from the old checkout are stale, including their copy of this script. The release directories are
root-owned, so the manifest takes the release id from the directory name (`<time>-<sha8>`), and the
host inventory runs git for Live as root (`owner: root`, `runAs: ubuntu` for drills).

**Legacy (before 2026-09-24):** `/opt/openvibe.live` was a git checkout. A rollback reset the checkout
but could not restore previous `node_modules`.

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
  `release_client_updates_total{outcome,reason}` counts what open tabs did with a new release
  (applied, reloaded, deferred, failed); they report it to `POST /release-metrics`, which
  `/release.json` names in `metrics_url` (openvibe-shared `release.mount`).
- `--rollback` selects the previous release with **its own** `node_modules`.
- The last 5 releases are kept.
- Content-hashed assets from the previous release are still served under their old hashes, so a page
  rendered before the switch never loads JavaScript from after it.
- **Release notification.** After a deploy or `--rollback` that went live, the script runs
  `ovhost announce live` (OpenVibe.Host, WS-P task 9). ovhost publishes `host.release.published` for the
  release `/release.json` now reports, once per release, to OpenVibe.Events. Open tabs (openvibe-shared
  1.17.0 release-watch) then check `/release.json` within about 20 s instead of at their next poll. It is
  best effort: skipped when `ovhost` is missing or has no `announce` (set `OVHOST` for another path), 20 s at
  most, and it never changes the exit code. A static-only switch keeps the running release, so there is
  nothing new to announce. The credentials and the setup are in OpenVibe.Host `docs/release-notifications.md`.

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

## Restore drills

`ovhost drill live` (OpenVibe.Host, `docs/restore-drills.md`) restores `live.db` from the latest
backup into a directory of its own and starts a second Live from this checkout on 127.0.0.1:13000
with `LIVE_DRILL=1`, `DB_PATH` on the copy and `DATA_DIR` in that directory. In that mode
(`server/drill.js`) Live:

- refuses to start unless `DB_PATH` and `DATA_DIR` are set and outside the checkout and
  `/opt/openvibe.live`, `HOST` is loopback, `PORT` is not 3000 and no socket was handed over by systemd;
- writes nothing outside `DATA_DIR` and the copy's directory (`server/paths.js`: the per-location
  `*_PATH` variables from the env file are ignored);
- starts only its HTTP server: no job, WebSocket server, RTMP, SFU, JSMPEG, WHIP, TURN credential,
  restream or relay resume, AI job, Media reconciler, Events outbox, chat bridge, identity sync,
  deploy notice or registry refresh;
- connects to nothing and runs no program but `git`: other services look down to it, so a route that
  asks Media or Community answers as it does when they are down;
- answers 403 to every method but GET, HEAD and OPTIONS, and to every WebSocket upgrade;
- reports `"mode": "drill"` in `/api/ready`.

`test/drill-mode.test.js` boots the real server that way and checks each point.

## Checks

```bash
npm test                         # unit, security, migrations, deploy simulation, size budgets
BASE=http://127.0.0.1:3000 npm run test:browser   # needs a running server and Chrome
deploy/scripts/post-deploy-check.sh                # on the host after a deploy
```

## N-1: the previous release against this one

For 24 hours after a deploy (ADR-016) open tabs run the previous release's client against the new
server, and a previous-release process may still be working on the database the new one migrated.
`test/n-1.test.js` (in `npm test`, so in CI) checks both from fixtures recorded from the release in
production:

- `test/fixtures/n-1/client.json`: every call the previous release's client code makes, with the
  status, JSON-ness and the response fields it reads. This checkout boots in the drill sandbox on a
  database created with the previous schema, answers each call compatibly, and keeps every read field.
- `test/fixtures/n-1/worker.json`: the previous schema, migration ledger and every SQL statement that
  release ran or has as a literal. After this release's migrations each must still prepare, and no
  old INSERT may miss a new NOT NULL column.

After each deploy, record the release now in production as the next release's N-1 and commit it:

```bash
npm run n-1:record               # from HEAD (the deployed commit)
npm run n-1:record -- <sha>      # or the release production's /release.json names
```
