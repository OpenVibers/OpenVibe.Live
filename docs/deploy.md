# Deploying OpenVibe.Live

Live deploys with `ovhost deploy live` (OpenVibe.Host, `/usr/local/bin/ovhost`, strategy
`release-layout`; roadmap WS-N task 11). `deploy/scripts/deploy.sh` is a thin wrapper that maps its old
flags onto ovhost, so the commands stay the same:

```bash
cd /opt/openvibe.live/current
sudo deploy/scripts/deploy.sh              # ovhost deploy live: origin/main if it moved
sudo deploy/scripts/deploy.sh --wait-idle  # ovhost deploy live --wait-idle: hold a restart until nobody is live
sudo deploy/scripts/deploy.sh --restart    # ovhost deploy live --restart
sudo deploy/scripts/deploy.sh --rollback   # ovhost rollback live: the release the current one replaced
DRY_RUN=1 deploy/scripts/deploy.sh         # ovhost plan live: print the plan only
```

The wrapper checks `ovhost capabilities live` (deploy API 1, strategy `release-layout`, managed).
If ovhost is unavailable or incompatible, the wrapper exits 1. `OVHOST=<path>` picks another ovhost.
`--force` has different semantics in ovhost, so the wrapper refuses it; run
`sudo ovhost deploy live --force` explicitly if needed. ovhost records each attempt in its release log
(`ovhost releases live`) and refuses a frozen service (`ovhost freeze`, exit 6).

## What each kind of change costs

| Files changed | Action | Interruption |
|---|---|---|
| `docs/`, `public/` (JS, CSS, HTML, fragments, images) | files switched in place; the running server re-reads documents and re-hashes assets within ~2 s | **none** — no restart |
| README, tests, scripts | files switched | none |
| `server/`, `vendor/`, `package.json` dependencies | restart, gated on `GET /api/ready` | new HTTP connections queue on the systemd socket; **established WebSocket, WHIP, WebRTC and RTMP sessions drop and reconnect** |
| `package-lock.json` | `npm ci` **before** anything is interrupted (release layout: into the new release) | as server |
| `migrations/` | a database backup (`ovhost backup live`), then restart; the release applies them at boot | as server |
| `deploy/systemd/` | units installed, `daemon-reload`, restart | as server |
| `deploy/nginx/` | **not installed** — the live nginx config is managed separately (see below); the script prints a notice | none |

Socket activation (`deploy/systemd/openvibe-live.socket`) protects *new* HTTP connections during a
restart. It does not keep existing WebSockets, RTMP publishers, WHIP sessions or mediasoup UDP flows.
Clients reconnect with jittered backoff and show "OpenVibe is updating" / "Reconnected"
(`ovConnectionPill` in `public/js/app.js`). Use `--wait-idle` when someone is streaming.

## Layouts

**Release layout (production):** deploy from `/opt/openvibe.live/current`.
The release directories are root-owned, so the manifest takes the release id from the directory name
(`<time>-<sha8>`), and the host inventory runs git for Live as root (`owner: root`, `runAs: ubuntu` for drills).

```
/opt/openvibe.live/repo                 git clone used to create releases
/opt/openvibe.live/releases/<time>-<sha> worktree + its own node_modules + data -> ../../shared/data
/opt/openvibe.live/current              -> releases/<id>   (atomic rename)
/opt/openvibe.live/shared/data          uploads and runtime files (never copied or reset)
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
- **Release notification.** After a deploy or `--rollback` that went live, ovhost announces it through OpenVibe.Host. It publishes `host.release.published` for the
  release `/release.json` now reports, once per release, to OpenVibe.Events. Open tabs (openvibe-shared
  1.17.0 release-watch) then check `/release.json` within about 20 s instead of at their next poll. It is
  best effort and does not change the exit code. A static-only switch keeps the running release, so there is
  nothing new to announce. The credentials and the setup are in OpenVibe.Host `docs/release-notifications.md`.

`test/deploy-wrapper.test.js` checks the wrapper's flag mapping and errors. ovhost's own tests
(OpenVibe.Host `test/strategy-release-layout.test.js`) cover release behavior and the socket rule.

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

`ovhost drill live` (OpenVibe.Host, `docs/restore-drills.md`) restores the latest backup of `ov_live` into a database of
its own and starts a second Live from this checkout on 127.0.0.1:13000 with `LIVE_DRILL=1`, `DATABASE_URL` and
`DATABASE_DIRECT_URL` on the copy and `DATA_DIR` in a directory of its own (without a database URL it uses an embedded
PGlite database under `DATA_DIR`). In that mode
(`server/drill.js`) Live:

- refuses to start when a database URL names production's `ov_live` (or names no database, or only one of the two
  URLs is set), and unless `DATA_DIR` is set and outside the checkout and
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
npm test                         # unit, security, migrations, size budgets
BASE=http://127.0.0.1:3000 npm run test:browser   # needs a running server and Chrome
deploy/scripts/post-deploy-check.sh                # on the host after a deploy
```

## N-1: the previous release against this one

For 24 hours after a deploy (ADR-016) open tabs run the previous release's client against the new
server, and a previous-release process may still be working on the database the new one migrated.
`test/n-1.test.js` (in `npm test`, so in CI) checks compatibility using fixtures recorded from
the release in production:

- `test/fixtures/n-1/client.json`: every call the previous release's client code makes, and every
  script, stylesheet and link of the shell and a channel page it served, with the status, JSON-ness
  and the response fields the client reads. This checkout boots in the drill sandbox (writes let
  through) on a migrated PGlite database, answers each call compatibly, and keeps every read
  field. The calls nginx sends to OpenVibe.Chat are Chat's N-1 test.
- `test/fixtures/n-1/worker.json`: the previous release's migration filenames and hashes. The
  test ensures each migration remains present and unchanged.

After each deploy, record the release now in production as the next release's N-1 and commit it:

```bash
npm run n-1:record               # from HEAD (the deployed commit)
npm run n-1:record -- <sha>      # or the release production's /release.json names
```
