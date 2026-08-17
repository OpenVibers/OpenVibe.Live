# Cloudflare Checklist

Recommended free-tier settings for OpenVibe.Live:

## DNS

- Proxied: `openvibe.live`
- Proxied: `www.openvibe.live`
- DNS only: `rtmp.openvibe.live`
- DNS only: any raw media hostnames used for JSMPEG or advanced WebRTC routing

## SSL/TLS

- SSL mode: **Full (strict)**
- Always Use HTTPS: **On**
- Automatic HTTPS Rewrites: **On**

## Security

- Browser Integrity Check: **On**
- WAF managed rules: **On**
- Bot protection / Bot Fight Mode: **On**

## Rate Limits

Good candidates:

- `/api/auth/login`
- `/api/auth/register`
- `/api/vods/upload`
- `/api/thumbnails/live/*`
- `/ws/chat`
- `/ws/call`

## Cache Suggestions

Safe to cache aggressively:

- frontend static assets
- `/data/avatars/*`
- `/api/thumbnails/*`

Do not cache:

- `/api/auth/*`
- personalized API responses
- `/ws/*`
- raw media ports

## Origin Protection

- Restrict `80/443` to Cloudflare IPs if your host allows it
- Restrict SSH to your admin IP if possible
- Do not publish the origin IP in public docs or dashboards
