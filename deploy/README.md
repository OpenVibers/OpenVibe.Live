# Deploy Assets

How deploys work: [../docs/deploy.md](../docs/deploy.md).

- `scripts/deploy.sh` — classifies a change (static / server / dependencies / schema / units) and does the least disruptive thing; `--wait-idle`, `--rollback`, `DRY_RUN=1`
- `scripts/migrate-to-releases.sh` — one-time move to the release layout (`releases/`, `current`, `shared/data`)
- `scripts/post-deploy-check.sh` — smoke checks on the host
- `systemd/openvibe-live.service` + `.socket` — current (git checkout) layout, socket activation
- `systemd/release/` — units for the release layout (`OV_APP_ROOT=/opt/openvibe.live/current`)
- `nginx/openvibe.live.conf` — what production runs: limits, static cache for hashed assets, gzip, query-less logs. Apply by hand (`nginx -t`, reload)
- `fail2ban/jail.local.example` — starter fail2ban config for SSH and nginx abuse
- `cloudflare/checklist.md` — edge security and bandwidth checklist (firewall the origin to Cloudflare)

Keep RTMP, HTTP-FLV and JSMPEG disabled unless you need them.
