# Deploy Assets

How deploys work: [../docs/deploy.md](../docs/deploy.md).

- `scripts/deploy.sh` — runs `ovhost deploy|rollback|plan live`; requires ovhost and a managed release-layout service
- `scripts/post-deploy-check.sh` — smoke checks on the host
- `systemd/openvibe-live.service` + `.socket` — socket activation template
- `systemd/release/` — units for the release layout (`OV_APP_ROOT=/opt/openvibe.live/current`)
- `nginx/openvibe.live.conf` — what production runs: limits, static cache for hashed assets, gzip, query-less logs. Apply by hand (`nginx -t`, reload)
- `fail2ban/jail.local.example` — starter fail2ban config for SSH and nginx abuse
- `cloudflare/checklist.md` — edge security and bandwidth checklist (firewall the origin to Cloudflare)

Keep RTMP, HTTP-FLV and JSMPEG disabled unless you need them.
