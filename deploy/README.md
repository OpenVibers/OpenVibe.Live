# Deploy Assets

This folder contains production deployment examples for OpenVibe.Live.

Included:

- `nginx/openvibe.live.conf` — reverse proxy, request limiting, basic cache headers
- `systemd/openvibe-live.service` — hardened service unit (EnvironmentFile=/etc/openvibe/live.env)
- `fail2ban/jail.local.example` — starter fail2ban config for SSH and Nginx abuse
- `cloudflare/checklist.md` — edge security and bandwidth checklist

Before using these files:

1. Replace domain names.
2. Replace the Linux user in the systemd service.
3. Review which ports you actually need open.
4. Keep RTMP, HTTP-FLV, and JSMPEG disabled unless you need them.
